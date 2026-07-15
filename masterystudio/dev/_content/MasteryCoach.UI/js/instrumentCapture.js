import { getSharedContext } from './audioContext.js';
import { encodeWavStereo } from './recorder.js';
import {
    buildHealthFromAccumulators,
    resetWindowedAccumulators,
    updateChannelAccumulators,
} from './inputMonitorCore.js';

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
    // Synchronous in-flight latch. `recording`/`monitoring` only flip true AFTER the getUserMedia +
    // addModule awaits, so two rapid start() calls (double-click / Enter during that window) would
    // both pass the recording/monitoring guards and both open a graph — orphaning the first graph's
    // MediaStream tracks (a leaked live mic/USB stream). This latch is set before any await so the
    // second entry bails immediately.
    starting: false,
    startCtxTime: null,
    endCtxTime: null,
    sampleRate: 44100,
    inputChannels: 0,
    midiEvents: [],
    // Live offset, re-measured per MIDI event so each event's timeline position tracks any clock
    // drift. `startClockOffsetSeconds` is a STABLE reference captured once at record start — persisted
    // as the representative offset, since the live one would otherwise report only the last event's
    // sample (meaningless as "the" offset).
    clockOffsetSeconds: 0,
    startClockOffsetSeconds: 0,
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

export async function listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
    }

    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
        try {
            const unlock = await mediaGetUserMedia({ audio: true });
            for (const track of unlock.getTracks()) track.stop();
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch {
            // Permission denied or unavailable: return the partial list.
        }
    }

    return devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }));
}

// Exported for unit testing (tests/js/instrument-capture-timing.test.mjs). Pure given its ctx arg.
export function audioClockOffset(ctx) {
    if (typeof ctx.getOutputTimestamp === 'function') {
        const stamp = ctx.getOutputTimestamp();
        // Browsers return {contextTime:0, performanceTime:0} until audio actually flows to the
        // output device. That pair passes Number.isFinite but is NOT a real calibration: mapping an
        // event.timeStamp (a performance.now() value in the 1e5–1e7 ms range) through a zero offset
        // yields a hit time of thousands of seconds, which the overlay then silently drops — so the
        // first ~100 ms of MIDI hits vanish. Require a positive contextTime before trusting the pair;
        // otherwise fall through to the always-valid currentTime/performance.now() offset.
        if (stamp && Number.isFinite(stamp.contextTime) && stamp.contextTime > 0
            && Number.isFinite(stamp.performanceTime) && stamp.performanceTime > 0) {
            return stamp.contextTime - stamp.performanceTime / 1000;
        }
    }
    return ctx.currentTime - performance.now() / 1000;
}

function eventAudioTime(performanceTimeMs) {
    return performanceTimeMs / 1000 + state.clockOffsetSeconds;
}

// Jitter = the SPREAD of per-event delivery delay (max − min), not the max delay. A constant delivery
// latency (e.g. a steady 8 ms) has ZERO jitter and must not fail the Phase-1 acceptance bar; only
// variation in when callbacks land relative to system-receive time matters, because the timeline
// position itself is anchored to event.timeStamp. With ≤1 event there's no spread → 0. Exported for
// unit testing (tests/js/instrument-capture-timing.test.mjs).
export function midiDeliveryJitterSpreadMs(events) {
    if (!events || events.length < 2) {
        return 0;
    }
    let minDelay = Infinity;
    let maxDelay = -Infinity;
    for (const event of events) {
        const delay = event.deliveryDelayMs || 0;
        if (delay < minDelay) minDelay = delay;
        if (delay > maxDelay) maxDelay = delay;
    }
    return maxDelay - minDelay;
}

function resetHealth() {
    state.health = null;
    state.healthChannels = [];
}

// Per channel we keep two kinds of accumulator:
//  - session-retained: `peak` (peak-HOLD, so the "loudest part" check reports the loudest instant
//    over its whole window) and `clipped` (did it EVER clip during the check);
//  - windowed: `sumSquares`/`samples`, reset every time inputHealth() snapshots, so RMS reflects the
//    RECENT level rather than a lifetime average that dilutes transients (and can't grow unbounded).
function updateHealth(channelStats) {
    updateChannelAccumulators(state.healthChannels, channelStats);
    state.health = buildHealthFromAccumulators(state.healthChannels);
}

// Reset the windowed RMS accumulators after a snapshot, keeping the retained peak-hold + clip count.
function resetHealthWindow() {
    resetWindowedAccumulators(state.healthChannels);
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
            // Per-event DELIVERY DELAY: how long after the system received the message this callback
            // ran. This does NOT feed the event's timeline position (that comes from event.timeStamp
            // via eventAudioTime) — it's raw material for the jitter metric computed in stop(). Jitter
            // is the SPREAD of this delay across events, not any single value.
            const deliveryDelayMs = performance.now() - performanceTime;
            state.midiEvents.push({
                audioContextTime: eventAudioTime(performanceTime),
                performanceTime,
                deliveryDelayMs,
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
    if (state.recording || state.starting) return;
    if (state.monitoring) cancel();
    state.starting = true;

    try {
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
        state.startClockOffsetSeconds = state.clockOffsetSeconds;
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
    } finally {
        state.starting = false;
    }
}

export async function startMonitoring(audioDeviceId) {
    if (state.recording || state.monitoring || state.starting) return;
    state.starting = true;

    try {
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
    } finally {
        state.starting = false;
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
    const midiDeliveryJitterMaxMs = midiDeliveryJitterSpreadMs(state.midiEvents);
    return {
        durationSeconds,
        sampleRate: state.sampleRate,
        channels: Math.max(1, state.inputChannels || 2),
        audioContextStartTime: state.startCtxTime ?? 0,
        audioContextEndTime: state.endCtxTime ?? 0,
        midiClockOffsetSeconds: state.startClockOffsetSeconds,
        midiDeliveryJitterMaxMs,
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
    const health = state.health;
    // Live metering wants a RECENT level, so window the RMS by resetting the accumulators after each
    // snapshot. During RECORDING we deliberately DON'T reset: stop() returns state.health as the
    // whole-take summary, which should aggregate the entire recording (peak-hold + total clip count +
    // take-wide RMS), not just the last 200 ms window.
    if (state.monitoring && !state.recording) {
        resetHealthWindow();
    }
    return health;
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

// True only when the WebView can actually open an audio input. The .NET IsSupported flag reports
// that the JS bridge is WIRED UP (always true on a JS host), but iOS WKWebView can lack
// navigator.mediaDevices entirely — so the page also gates its capture/level buttons on this real
// runtime check to avoid enabling controls that throw the moment they're used.
export function isCaptureSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
