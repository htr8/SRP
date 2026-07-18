// Live microphone capture for the guitar tuner (docs/08_Audio_Engine/GuitarTunerPlan.md).
//
// Deliberately self-contained: it uses the app's shared AudioContext (audioContext.js) but its OWN
// getUserMedia + AnalyserNode, so it doesn't couple to recorder.js internals. The analyser has NO
// output connection, so nothing the mic hears ever reaches the speakers (no feedback).
//
// Two consumers, both feeding the C# TuningAnalyzer:
//   - live mono tuner: pushes a time-domain frame to C# every ~POLL_MS via getFloatTimeDomainData.
//   - strum check: captures ~1s of samples into one buffer and hands it back for a one-shot analysis.
//
// The C# side owns all DSP (pitch/cents/strum) — this module only moves PCM. Best-effort throughout:
// a denied mic or an engine that lacks the API leaves the tuner inert rather than throwing.

import { getSharedContext } from './audioContext.js';

// A larger FFT window than the input meter's 1024: the tuner needs enough samples for a stable
// low-string estimate (~8192 @ 44.1k ≈ 186 ms, which comfortably spans several cycles of low E).
const FRAME_SIZE = 8192;
const POLL_MS = 60; // live-tuner frame cadence — smooth enough for a needle, cheap on interop

let ctx = null;
let stream = null;
let source = null;
let analyser = null;
let timer = null;
let dotnet = null;
let frame = null;
let currentDeviceId = null; // the deviceId the open stream was built with, to detect a switch

function supported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function releaseGraph() {
    if (source) { try { source.disconnect(); } catch (e) { } source = null; }
    analyser = null;
    if (stream) {
        for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { } }
        stream = null;
    }
}

async function ensureGraph(deviceId) {
    ctx = getSharedContext();
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { /* resumes on the next gesture */ }
    }

    // Switching microphones (device picker, 2026-07-18): rebuild the stream for the new device.
    if (stream && (deviceId ?? null) !== currentDeviceId) {
        releaseGraph();
    }

    if (!stream) {
        const constraints = {
            audio: {
                // Tuning needs the RAW signal: browser voice processing would distort pitch/level.
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                // `ideal` (not `exact`): a stale persisted device falls back to the default mic instead
                // of failing capture outright — same policy as instrumentCapture.js.
                ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
            },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentDeviceId = deviceId ?? null;
    }

    if (!analyser) {
        source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = FRAME_SIZE;
        // No downstream connection — the analyser taps the signal without routing it anywhere audible.
        source.connect(analyser);
        frame = new Float32Array(analyser.fftSize);
    }
}

// Enumerate audio inputs for the mic picker. Labels are only populated once mic permission is granted,
// so this briefly opens (and immediately closes) a default stream if labels are missing — the same
// unlock pattern as instrumentCapture.js (kept self-contained here on purpose; see the module header).
export async function listInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];

    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some(d => d.kind === 'audioinput' && !d.label)) {
        try {
            const unlock = await navigator.mediaDevices.getUserMedia({ audio: true });
            for (const t of unlock.getTracks()) { try { t.stop(); } catch (e) { } }
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch (e) { /* permission denied: return the label-less list */ }
    }

    return devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}

// Start the live mono tuner: push a time-domain frame to C# every POLL_MS. dotNetRef must expose the
// [JSInvokable] `OnTunerFrame(float[] samples, int sampleRate)`.
export async function start(dotNetRef, deviceId) {
    if (!supported()) return false;
    dotnet = dotNetRef;
    try {
        await ensureGraph(deviceId);
    } catch (e) {
        return false; // mic denied / unavailable
    }

    stop_timer();
    timer = setInterval(() => {
        if (!analyser || !dotnet) return;
        analyser.getFloatTimeDomainData(frame);
        try {
            // Copy into a plain array for interop (the reused Float32Array must not be detached).
            const p = dotnet.invokeMethodAsync('OnTunerFrame', Array.from(frame), ctx.sampleRate);
            if (p && p.catch) p.catch(() => { });
        } catch (e) { /* disposed ref mid-teardown */ }
    }, POLL_MS);
    return true;
}

// (The one-shot AudioWorklet strum capture that used to live here was removed — Strum Check is now
// continuous, analyzing each live frame via OnTunerFrame, so no separate capture path is needed.)

function stop_timer() {
    if (timer) { clearInterval(timer); timer = null; }
}

// Stop the live tuner and release the mic. Called on leaving the page.
export function stop() {
    stop_timer();
    dotnet = null;
    releaseGraph();
    currentDeviceId = null;
    // The shared AudioContext is app-lifetime — never close it here (others depend on it).
}
