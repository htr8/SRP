import { getSharedContext } from './audioContext.js';
import { encodeWavStereo } from './recorder.js';

const state = {
    stream: null,
    sourceNode: null,
    captureNode: null,
    monitorGain: null,
    midiAccess: null,
    midiHandlers: [],
    chunksLeft: [],
    chunksRight: [],
    recording: false,
    monitoring: false,
    startCtxTime: null,
    endCtxTime: null,
    sampleRate: 44100,
    inputChannels: 0,
    midiEvents: [],
    clockOffsetSeconds: 0,
    health: null,
    healthChannels: [],
    lastAudio: null,
    lastMidiJson: '[]',
    workletReady: null,
};

function audioConstraints(deviceId) {
    return {
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    };
}

function mediaGetUserMedia(constraints) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Audio capture is not available in this WebView.');
    }
    return navigator.mediaDevices.getUserMedia(constraints);
}

function audioClockOffset(ctx) {
    if (typeof ctx.getOutputTimestamp === 'function') {
        const stamp = ctx.getOutputTimestamp();
        if (stamp && Number.isFinite(stamp.contextTime) && Number.isFinite(stamp.performanceTime)) {
            return stamp.contextTime - stamp.performanceTime / 1000;
        }
    }
    return ctx.currentTime - performance.now() / 1000;
}

function eventAudioTime(performanceTimeMs) {
    return performanceTimeMs / 1000 + state.clockOffsetSeconds;
}

function ampToDb(value) {
    return value > 0 ? 20 * Math.log10(value) : -120;
}

function resetHealth() {
    state.health = null;
    state.healthChannels = [];
}

function updateHealth(channelStats) {
    if (!channelStats || !channelStats.length) return;
    for (let i = 0; i < channelStats.length; i++) {
        const stat = channelStats[i];
        if (!stat) continue;
        const current = state.healthChannels[i] || { channel: i + 1, peak: 0, sumSquares: 0, samples: 0, clipped: 0 };
        current.peak = Math.max(current.peak, stat.peak || 0);
        current.sumSquares += stat.sumSquares || 0;
        current.samples += stat.samples || 0;
        current.clipped += stat.clipped || 0;
        state.healthChannels[i] = current;
    }
    state.health = buildHealth();
}

function buildHealth() {
    const channels = state.healthChannels
        .filter(ch => ch && ch.samples > 0)
        .map(ch => {
            const rms = Math.sqrt(ch.sumSquares / ch.samples);
            return {
                channel: ch.channel,
                peakDb: ampToDb(ch.peak),
                rmsDb: ampToDb(rms),
                clippedSampleCount: ch.clipped,
            };
        });
    if (channels.length === 0) return null;

    const peakDb = Math.max(...channels.map(ch => ch.peakDb));
    const totalSamples = state.healthChannels.reduce((sum, ch) => sum + (ch ? ch.samples : 0), 0);
    const totalSquares = state.healthChannels.reduce((sum, ch) => sum + (ch ? ch.sumSquares : 0), 0);
    const clippedSampleCount = state.healthChannels.reduce((sum, ch) => sum + (ch ? ch.clipped : 0), 0);
    const rmsDb = ampToDb(Math.sqrt(totalSquares / Math.max(1, totalSamples)));
    const nearSilent = rmsDb < -55 || peakDb < -45;
    let recommendedAction = 'Level looks healthy.';
    if (clippedSampleCount > 0 || peakDb >= -0.2) {
        recommendedAction = 'Input is clipping. Lower the TD-27, interface, pedal, mic preamp, or phone input level.';
    } else if (nearSilent) {
        recommendedAction = 'Input is very quiet. Raise the source or input level before recording.';
    } else if (peakDb < -18) {
        recommendedAction = 'Input is usable but quiet. Consider raising the source or input level.';
    } else if (peakDb > -3) {
        recommendedAction = 'Input is strong and close to clipping. Leave headroom or lower the source slightly.';
    }

    return { peakDb, rmsDb, clippedSampleCount, nearSilent, recommendedAction, channels };
}

async function attachMidiInputs() {
    state.midiHandlers = [];
    state.midiAccess = null;
    if (!navigator.requestMIDIAccess) {
        return;
    }

    state.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
    for (const input of state.midiAccess.inputs.values()) {
        const handler = event => {
            if (!state.recording) return;
            state.clockOffsetSeconds = audioClockOffset(getSharedContext());
            const performanceTime = event.timeStamp;
            const deliveryJitterMs = performance.now() - performanceTime;
            state.midiEvents.push({
                audioContextTime: eventAudioTime(performanceTime),
                performanceTime,
                deliveryJitterMs,
                data: Array.from(event.data || []),
            });
        };
        input.addEventListener('midimessage', handler);
        state.midiHandlers.push({ input, handler });
    }
}

function detachMidiInputs() {
    for (const { input, handler } of state.midiHandlers) {
        try { input.removeEventListener('midimessage', handler); } catch { /* ignore */ }
    }
    state.midiHandlers = [];
}

async function ensureWorklet(ctx) {
    if (ctx.state === 'suspended') await ctx.resume();
    if (!state.workletReady) {
        state.workletReady = ctx.audioWorklet
            .addModule('./_content/MasteryCoach.UI/js/stereoCaptureProcessor.js')
            .catch(err => { state.workletReady = null; throw err; });
    }
    await state.workletReady;
}

async function openAudioGraph(ctx, audioDeviceId, captureAudio) {
    state.stream = await mediaGetUserMedia({ audio: audioConstraints(audioDeviceId) });
    state.sourceNode = ctx.createMediaStreamSource(state.stream);
    state.captureNode = new AudioWorkletNode(ctx, 'stereo-capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        outputChannelCount: [2],
        processorOptions: { captureAudio },
    });
    state.monitorGain = ctx.createGain();
    state.monitorGain.gain.value = 0.00001;
    state.captureNode.port.postMessage({ type: 'setCaptureAudio', enabled: captureAudio });
    state.captureNode.port.onmessage = handleCaptureMessage;
    state.sourceNode.connect(state.captureNode).connect(state.monitorGain).connect(ctx.destination);
}

function handleCaptureMessage(event) {
    const msg = event.data;
    if (msg.type === 'start') {
        state.startCtxTime = msg.time;
        state.inputChannels = msg.inputChannels || 0;
        state.sampleRate = msg.sampleRate || state.sampleRate;
        return;
    }

    if (msg.type !== 'chunk') {
        return;
    }

    updateHealth(msg.channelStats);
    state.inputChannels = Math.max(state.inputChannels, msg.inputChannels || 0);
    if (state.recording && msg.left && msg.right) {
        state.chunksLeft.push(msg.left);
        state.chunksRight.push(msg.right);
    }
}

export async function start(audioDeviceId) {
    if (state.recording) return;
    if (state.monitoring) cancel();

    const ctx = getSharedContext();
    await ensureWorklet(ctx);

    state.chunksLeft = [];
    state.chunksRight = [];
    state.midiEvents = [];
    state.startCtxTime = null;
    state.endCtxTime = null;
    state.sampleRate = ctx.sampleRate;
    state.inputChannels = 0;
    state.clockOffsetSeconds = audioClockOffset(ctx);
    resetHealth();
    state.lastAudio = null;
    state.lastMidiJson = '[]';

    try {
        await attachMidiInputs();
        await openAudioGraph(ctx, audioDeviceId, true);
        state.recording = true;
    } catch (err) {
        state.recording = false;
        cleanupGraph();
        throw err;
    }
}

export async function startMonitoring(audioDeviceId) {
    if (state.recording || state.monitoring) return;

    const ctx = getSharedContext();
    await ensureWorklet(ctx);

    state.inputChannels = 0;
    state.startCtxTime = null;
    resetHealth();
    try {
        state.monitoring = true;
        await openAudioGraph(ctx, audioDeviceId, false);
    } catch (err) {
        state.monitoring = false;
        cleanupGraph();
        throw err;
    }
}

function concatChunks(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
    }
    return samples;
}

function cleanupGraph() {
    detachMidiInputs();
    if (state.captureNode) {
        try { state.captureNode.port.onmessage = null; state.captureNode.disconnect(); } catch { /* ignore */ }
        state.captureNode = null;
    }
    if (state.sourceNode) {
        try { state.sourceNode.disconnect(); } catch { /* ignore */ }
        state.sourceNode = null;
    }
    if (state.monitorGain) {
        try { state.monitorGain.disconnect(); } catch { /* ignore */ }
        state.monitorGain = null;
    }
    if (state.stream) {
        for (const track of state.stream.getTracks()) track.stop();
        state.stream = null;
    }
}

export function stop() {
    if (!state.recording) {
        throw new Error('No instrument capture is in progress.');
    }

    const ctx = getSharedContext();
    state.recording = false;
    state.endCtxTime = ctx.currentTime;
    cleanupGraph();

    const left = concatChunks(state.chunksLeft);
    const right = concatChunks(state.chunksRight);
    state.chunksLeft = [];
    state.chunksRight = [];
    state.lastAudio = encodeWavStereo(left, right, state.sampleRate);
    state.lastMidiJson = JSON.stringify(state.midiEvents, null, 2);

    const durationSeconds = left.length / state.sampleRate;
    const maxJitter = state.midiEvents.reduce((max, event) => Math.max(max, Math.abs(event.deliveryJitterMs || 0)), 0);
    return {
        durationSeconds,
        sampleRate: state.sampleRate,
        channels: Math.max(1, state.inputChannels || 2),
        audioContextStartTime: state.startCtxTime ?? 0,
        audioContextEndTime: state.endCtxTime ?? 0,
        midiClockOffsetSeconds: state.clockOffsetSeconds,
        midiDeliveryJitterMaxMs: maxJitter,
        midiEvents: state.midiEvents,
        health: state.health,
    };
}

export function cancel() {
    state.recording = false;
    state.monitoring = false;
    cleanupGraph();
    state.chunksLeft = [];
    state.chunksRight = [];
    state.midiEvents = [];
}

export function stopMonitoring() {
    if (!state.monitoring) return;
    cancel();
}

export function inputHealth() {
    return state.health;
}

export function audioWavBlob() {
    return new Blob([state.lastAudio || new Uint8Array(0)], { type: 'audio/wav' });
}

export function midiEventsJson() {
    return state.lastMidiJson || '[]';
}

function downloadBlob(bytesOrText, fileName, type) {
    const blob = new Blob([bytesOrText], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export function downloadLastAudio(fileName) {
    downloadBlob(audioWavBlob(), fileName || 'capture.wav', 'audio/wav');
}

export function downloadLastMidi(fileName) {
    downloadBlob(midiEventsJson(), fileName || 'midi-events.json', 'application/json');
}

export function isRecording() {
    return state.recording;
}
