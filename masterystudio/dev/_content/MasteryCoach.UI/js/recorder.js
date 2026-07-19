// Mic recorder on the SHARED AudioContext (the metronome's clock), driven from Blazor via
// IJSRuntime. Captures mono PCM through an AudioWorklet, stamps the first sample's context time,
// and — when the metronome is running — returns the EXACT offset of the metronome's beat 0
// relative to the recording start. That offset is what makes measured rush/drag real
// (TimingAnalysis.md §6.2): no estimation, no click-detection, one clock.
//
// Music-recording constraints: echo cancellation / noise suppression / auto gain are disabled —
// browser voice-call processing would duck and gate instruments.

import { getSharedContext } from './audioContext.js';
import { getGrid } from './metronome.js';
import {
    buildHealthFromAccumulators,
    monoStats,
    resetWindowedAccumulators,
    scaledMeterLevel,
    updateChannelAccumulators,
} from './inputMonitorCore.js';

const state = {
    stream: null,
    sourceNode: null,
    gainNode: null,
    captureNode: null,
    chunks: [],        // Float32Array chunks from the worklet
    startCtxTime: null,
    syncStartCtxTime: null, // shared-ctx time the stems begin, when recording OVER stems (else null)
    sampleRate: 44100,
    recording: false,
    workletReady: null,
    gridAtStart: null, // metronome grid captured when recording begins (see stop())
    lastTake: null,    // { samples: Float32Array, sampleRate, durationSeconds, gridOffsetSeconds, gridSecondsPerBeat }
    health: null,
    healthChannels: [],
};

function clampGainDb(gainDb) {
    const value = Number(gainDb);
    return Number.isFinite(value) ? Math.min(24, Math.max(0, value)) : 0;
}

function gainDbToLinear(gainDb) {
    return Math.pow(10, clampGainDb(gainDb) / 20);
}

// navigator.mediaDevices is UNDEFINED in some WebView contexts (notably iOS WKWebView without a
// secure context / when mic capture isn't available), so `navigator.mediaDevices.getUserMedia` threw
// the cryptic "undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')" and left
// an undismissable error on the mic row (user bug report, 2026-07-11). Throw a clean, recognizable
// error instead — the UI shows it as "microphone not available here" rather than a JS crash.
function micGetUserMedia(constraints) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone recording isn’t available on this device.');
    }
    return navigator.mediaDevices.getUserMedia(constraints);
}

// ONE long-lived mic stream, shared by the recorder, the calibrator, and the level meter. iOS
// re-shows its capture prompt on every FRESH getUserMedia (the WKUIDelegate grant isn't persisted
// per-origin), so fully tearing the stream down and re-acquiring per action made iOS re-prompt on
// every record/calibrate (user report 2026-07-11). Keeping ONE stream alive across actions means no
// fresh getUserMedia between them → no re-prompt. The stream is only released on a device change or
// an explicit release (releaseSharedMic). Keyed by deviceId so switching inputs re-acquires.
const shared = { stream: null, deviceId: undefined };

async function getSharedMicStream(deviceId) {
    const key = deviceId ?? '';
    // Reuse the live stream when it's for the same device AND still usable (a track can end if the OS
    // revokes it or the device is unplugged — re-acquire in that case).
    if (shared.stream && (shared.deviceId ?? '') === key
        && shared.stream.getTracks().some(t => t.readyState === 'live')) {
        return shared.stream;
    }
    releaseSharedMic(); // device changed or the old stream died — drop it before acquiring a new one
    shared.stream = await micGetUserMedia({ audio: micConstraints(deviceId) });
    shared.deviceId = deviceId;
    return shared.stream;
}

// Fully stop and drop the shared stream (device change / page teardown). The NEXT getSharedMicStream
// will re-acquire — which on iOS costs one prompt, so callers avoid this between consecutive actions.
export function releaseSharedMic() {
    if (shared.stream) {
        for (const track of shared.stream.getTracks()) track.stop();
        shared.stream = null;
    }
    shared.deviceId = undefined;
}

// Shared mic constraints (music recording: no voice-call processing). deviceId narrows to the
// user's picked input; undefined lets the OS default win.
function micConstraints(deviceId) {
    return {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // ideal, not exact: a persisted device id whose hardware is unplugged must fall back to
        // the system default, never fail the whole recording (OverconstrainedError) — the picker
        // may not even be visible to fix it (feature flag off).
        ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    };
}

// The available audio inputs for the mic picker. Labels are blank until the mic permission has
// been granted once — briefly open (then immediately stop) a stream to unlock them.
export async function listInputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return []; // no media device API here (e.g. iOS WebView) — no inputs to list
    }
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
        try {
            const unlock = await micGetUserMedia({ audio: true });
            for (const track of unlock.getTracks()) track.stop();
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch { /* permission denied — return what we have (blank labels) */ }
    }
    return devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

export async function start(deviceId, inputGainDb = 0) {
    if (state.recording) return;

    const ctx = getSharedContext();
    if (ctx.state === 'suspended') await ctx.resume(); // user-gesture requirement

    // Record-over-stems alignment is set LATER, via setSyncStart(), once the stems have actually been
    // started and their true start time is known — we must NOT predict it here, because the awaited
    // getUserMedia() below can take hundreds of ms (or seconds, on a first-run permission prompt), which
    // would make any pre-guessed instant wildly wrong.
    state.syncStartCtxTime = null;

    if (!state.workletReady) {
        // Reset the cache on failure — a transient load error must not poison every future
        // recording until page reload (review finding).
        state.workletReady = ctx.audioWorklet
            .addModule('./_content/MasteryCoach.UI/js/captureProcessor.js')
            .catch((err) => { state.workletReady = null; throw err; });
    }
    await state.workletReady;

    // Capture the grid NOW as well as at stop: if the metronome stops before the recording does
    // (timed-run auto-stop, or the user stops it first), the run's grid must not be lost —
    // it was valid for the take the whole time it played (review finding).
    state.gridAtStart = getGrid();

    // Reuse the shared, already-granted stream (no fresh getUserMedia → no iOS re-prompt).
    state.stream = await getSharedMicStream(deviceId);

    state.chunks = [];
    state.startCtxTime = null;
    state.sampleRate = ctx.sampleRate;
    resetHealth();

    state.sourceNode = ctx.createMediaStreamSource(state.stream);
    state.gainNode = ctx.createGain();
    state.gainNode.gain.value = gainDbToLinear(inputGainDb);
    state.captureNode = new AudioWorkletNode(ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
    });
    state.captureNode.port.onmessage = (e) => {
        if (e.data.type === 'start') {
            state.startCtxTime = e.data.time;
        } else if (e.data.type === 'chunk' && state.recording) {
            state.chunks.push(e.data.samples);
            updateHealth(e.data.channelStats);
        }
    };

    // The worklet must be pulled by the graph; route it to destination through a monitor gain. Keep the
    // gain effectively silent but NON-zero (~ -100 dB): on iOS/WebKit a gain node at exactly 0 can let
    // the engine prune the upstream capture branch as inaudible, so the worklet stops running.
    const silent = ctx.createGain();
    silent.gain.value = 0.00001;
    state.sourceNode.connect(state.gainNode).connect(state.captureNode).connect(silent).connect(ctx.destination);
    state.recording = true;
}

// Record-over-stems: the ACTUAL shared-context time the stems began (returned by stemPlayer.playAt),
// so stop() trims the take to align its sample 0 with that instant. Called after the stems are started,
// so it reflects any clamping/latency — no prediction. No-op if recording already stopped.
export function setSyncStart(ctxTime) {
    if (state.recording && typeof ctxTime === 'number' && isFinite(ctxTime)) {
        state.syncStartCtxTime = ctxTime;
    }
}

// Stops capture and returns take metadata. The WAV bytes are fetched separately (takeWavBytes)
// so the metadata trip stays small.
export function stop() {
    if (!state.recording) return null;
    state.recording = false;

    // Metronome grid offset BEFORE tearing anything down: beat0Time - recordingStartTime.
    // Negative = the metronome started before the recording (the normal Studio flow).
    // Prefer the grid that is running NOW (the metronome may have been (re)started mid-take);
    // fall back to the grid captured at recording start if it stopped since.
    const grid = getGrid() || state.gridAtStart;
    state.gridAtStart = null;
    // Offset relative to the recording's ORIGINAL sample 0; re-anchored below if the take is trimmed
    // for record-over-stems, so it always matches whatever samples we actually return.
    let gridOffsetSeconds = grid && state.startCtxTime != null
        ? grid.startTime - state.startCtxTime
        : null;

    if (state.captureNode) {
        try { state.captureNode.port.onmessage = null; state.captureNode.disconnect(); } catch { /* ignore */ }
        state.captureNode = null;
    }
    if (state.sourceNode) {
        try { state.sourceNode.disconnect(); } catch { /* ignore */ }
        state.sourceNode = null;
    }
    if (state.gainNode) {
        try { state.gainNode.disconnect(); } catch { /* ignore */ }
        state.gainNode = null;
    }
    // Disconnect our graph nodes but DO NOT stop the stream's tracks — the shared mic stream stays alive
    // so the next record/calibrate reuses it without a fresh getUserMedia (no iOS re-prompt). The stream
    // is released only on a device change or releaseSharedMic().
    state.stream = null;

    const total = state.chunks.reduce((n, c) => n + c.length, 0);
    let samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of state.chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
    }
    state.chunks = [];

    // Record-over-stems alignment: shift the take so its sample 0 == the stems' ACTUAL start instant
    // (setSyncStart, called after the stems were started, so it reflects real latency — not a guess).
    // The mic is armed before the stems begin, so the shift is normally positive (trim the lead); if
    // the stems somehow started first, pad with leading silence instead. Whatever the shift, the take's
    // origin moves by shiftSeconds, so the metronome grid offset is re-anchored by the same amount.
    if (state.syncStartCtxTime != null && state.startCtxTime != null) {
        const shiftSamples = Math.round((state.syncStartCtxTime - state.startCtxTime) * state.sampleRate);
        // The grid re-anchor must track what ACTUALLY happened to the samples: when the shift is
        // skipped (a sub-second take stopped before the sync instant — shiftSamples >= length),
        // adjusting the grid anyway made the metadata claim a trimmed origin the samples don't
        // have (review finding).
        let applied = 0;
        if (shiftSamples > 0 && shiftSamples < samples.length) {
            samples = samples.subarray(shiftSamples); // drop lead captured before the stems began
            applied = shiftSamples;
        } else if (shiftSamples < 0) {
            const padded = new Float32Array(samples.length - shiftSamples); // -shift = pad count
            padded.set(samples, -shiftSamples);
            samples = padded;
            applied = shiftSamples;
        }
        if (gridOffsetSeconds != null && applied !== 0) {
            gridOffsetSeconds -= applied / state.sampleRate; // keep the grid aligned to the new origin
        }
    }
    state.syncStartCtxTime = null;

    state.lastTake = {
        samples,
        sampleRate: state.sampleRate,
        durationSeconds: samples.length / state.sampleRate,
        gridOffsetSeconds,
        gridSecondsPerBeat: grid ? grid.secondsPerBeat : null,
    };

    return {
        durationSeconds: state.lastTake.durationSeconds,
        gridOffsetSeconds,
        gridSecondsPerBeat: state.lastTake.gridSecondsPerBeat,
    };
}

// Returns the last take as 16-bit PCM mono WAV bytes (Uint8Array → IJSStreamReference on .NET
// side), releasing the float samples afterwards — .NET persists the WAV to disk, so keeping a
// 10-minute take's ~115 MB of floats in the WebView heap serves nothing (review finding).
export function takeWavBytes() {
    if (!state.lastTake) return new Uint8Array(0);
    const bytes = encodeWavMono(state.lastTake.samples, state.lastTake.sampleRate);
    state.lastTake = null;
    return bytes;
}

export function isRecording() {
    return state.recording;
}

// ---------------------------------------------------------------------------------------------
// Input level meter: shown while a recording track is armed, so the player can see the mic is
// alive and leveled BEFORE recording (a silent take is the worst outcome). Owns its own mic
// stream (independent of a capture in progress — browsers allow both) and draws entirely in JS
// (requestAnimationFrame onto a canvas), so there is zero per-frame interop.
// ---------------------------------------------------------------------------------------------

const meter = {
    stream: null,
    analyser: null,
    ctxSrc: null,
    gainNode: null,
    raf: 0,
    canvas: null,
    peakHold: 0,
    gen: 0,
    health: null,
    healthChannels: [],
};

export async function startInputMeter(canvas, deviceId, inputGainDb = 0) {
    await startInputMonitor(canvas, deviceId, inputGainDb);
}

export async function startMonitoring(deviceId, inputGainDb = 0) {
    if (state.recording) return;
    await startInputMonitor(null, deviceId, inputGainDb);
}

export function setMonitorGain(inputGainDb = 0) {
    if (meter.gainNode) {
        meter.gainNode.gain.value = gainDbToLinear(inputGainDb);
    }
}

async function startInputMonitor(canvas, deviceId, inputGainDb = 0) {
    stopInputMeter(); // re-arm cleanly on device change

    // Generation token: getUserMedia can take seconds (permission prompt), during which another
    // start or a stop may run. A resolution from a superseded call must stop ITS stream and bail —
    // otherwise that stream is orphaned with no reference and the mic stays hot until page reload.
    const gen = ++meter.gen;

    const ctx = getSharedContext();
    if (ctx.state === 'suspended') await ctx.resume();

    // Pull from the SHARED mic stream (see getSharedMicStream) so arming the meter, then calibrating,
    // then recording all reuse one granted stream — no per-action getUserMedia, no iOS re-prompt.
    const stream = await getSharedMicStream(deviceId);
    if (gen !== meter.gen) {
        return; // superseded — leave the shared stream alone (a later start/stop owns its lifecycle)
    }

    meter.stream = stream;
    meter.ctxSrc = ctx.createMediaStreamSource(meter.stream);
    meter.gainNode = ctx.createGain();
    meter.gainNode.gain.value = gainDbToLinear(inputGainDb);
    meter.analyser = ctx.createAnalyser();
    meter.analyser.fftSize = 1024;
    meter.ctxSrc.connect(meter.gainNode).connect(meter.analyser); // analyser has no output — nothing reaches the speakers
    meter.canvas = canvas;
    meter.peakHold = 0;
    resetMeterHealth();

    const data = new Float32Array(meter.analyser.fftSize);
    const draw = () => {
        if (!meter.analyser) return;
        meter.analyser.getFloatTimeDomainData(data);
        const stats = monoStats(data);
        if (!stats) return;
        updateMeterHealth([stats]);
        const rms = Math.sqrt(stats.sumSquares / stats.samples);
        meter.peakHold = Math.max(stats.peak, meter.peakHold * 0.95); // decaying peak-hold marker

        if (meter.canvas) {
        const g = meter.canvas.getContext('2d');
        const w = meter.canvas.width, h = meter.canvas.height;
        g.clearRect(0, 0, w, h);
        // RMS bar with soft-knee scaling so quiet signals still move; green → amber → red zones.
        const level = scaledMeterLevel(rms);
        const zones = [[0.6, '#7fc97f'], [0.85, '#f0c35a'], [1.0, '#c0524a']];
        let from = 0;
        for (const [to, color] of zones) {
            const end = Math.min(level, to);
            if (end > from) {
                g.fillStyle = color;
                g.fillRect(from * w, 0, (end - from) * w, h);
            }
            from = to;
            if (level <= to) break;
        }
        const peakX = Math.min(1, Math.pow(meter.peakHold * 2.2, 0.6)) * w;
        g.fillStyle = '#f2f4f5';
        g.fillRect(Math.max(0, peakX - 1), 0, 2, h);
        }

        meter.raf = requestAnimationFrame(draw);
    };
    meter.raf = requestAnimationFrame(draw);
}

export function stopInputMeter() {
    meter.gen++; // invalidate any start whose getUserMedia is still pending (it self-stops)
    if (meter.raf) { cancelAnimationFrame(meter.raf); meter.raf = 0; }
    if (meter.ctxSrc) { try { meter.ctxSrc.disconnect(); } catch { /* ignore */ } meter.ctxSrc = null; }
    if (meter.gainNode) { try { meter.gainNode.disconnect(); } catch { /* ignore */ } meter.gainNode = null; }
    meter.analyser = null;
    // Drop our reference and release the shared stream when the monitor is the only owner. Keeping it
    // open after the visible monitor stops makes the browser report that the mic is still in use.
    meter.stream = null;
    if (!state.recording) {
        releaseSharedMic();
    }
    if (meter.canvas) {
        try { meter.canvas.getContext('2d').clearRect(0, 0, meter.canvas.width, meter.canvas.height); } catch { /* gone */ }
        meter.canvas = null;
    }
}

export function stopMonitoring() {
    stopInputMeter();
}

export function inputHealth() {
    if (state.recording) {
        return state.health;
    }

    const health = meter.health;
    if (meter.analyser) {
        resetWindowedAccumulators(meter.healthChannels);
    }
    return health;
}

function resetHealth() {
    state.health = null;
    state.healthChannels = [];
}

function updateHealth(channelStats) {
    updateChannelAccumulators(state.healthChannels, channelStats);
    state.health = buildHealthFromAccumulators(state.healthChannels);
}

function resetMeterHealth() {
    meter.health = null;
    meter.healthChannels = [];
}

function updateMeterHealth(channelStats) {
    updateChannelAccumulators(meter.healthChannels, channelStats);
    meter.health = buildHealthFromAccumulators(meter.healthChannels);
}

// 16-bit PCM mono WAV encoder (exported for the Node test harness).
export function encodeWavMono(samples, sampleRate) {
    const dataLength = samples.length * 2;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (pos, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);            // block align
    view.setUint16(34, 16, true);           // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    let pos = 44;
    for (let i = 0; i < samples.length; i++, pos += 2) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(pos, Math.round(clamped * 32767), true);
    }

    return new Uint8Array(buffer);
}

// Interleaved 16-bit PCM STEREO WAV (mix export). `left`/`right` are equal-length Float32Arrays; the
// twin of encodeWavMono with the channel-count/blockAlign/byteRate fields set for 2 channels and the
// samples interleaved L,R,L,R. Kept beside the mono encoder so the WAV writer lives in one place.
export function encodeWavStereo(left, right, sampleRate) {
    const frames = Math.min(left.length, right.length);
    const dataLength = frames * 2 /*channels*/ * 2 /*bytes*/;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    const writeAscii = (pos, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
    };

    writeAscii(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeAscii(8, 'WAVE');
    writeAscii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                // PCM
    view.setUint16(22, 2, true);                // stereo
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);   // byte rate = sampleRate * channels * bytesPerSample
    view.setUint16(32, 4, true);                // block align = channels * bytesPerSample
    view.setUint16(34, 16, true);               // bits per sample
    writeAscii(36, 'data');
    view.setUint32(40, dataLength, true);

    let pos = 44;
    for (let i = 0; i < frames; i++) {
        const l = Math.max(-1, Math.min(1, left[i]));
        const r = Math.max(-1, Math.min(1, right[i]));
        view.setInt16(pos, Math.round(l * 32767), true); pos += 2;
        view.setInt16(pos, Math.round(r * 32767), true); pos += 2;
    }

    return new Uint8Array(buffer);
}
