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

function supported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

async function ensureGraph(deviceId) {
    ctx = getSharedContext();
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { /* resumes on the next gesture */ }
    }

    if (!stream) {
        const constraints = {
            audio: {
                // Tuning needs the RAW signal: browser voice processing would distort pitch/level.
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
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
    if (source) { try { source.disconnect(); } catch (e) { } source = null; }
    analyser = null;
    if (stream) {
        for (const t of stream.getTracks()) { try { t.stop(); } catch (e) { } }
        stream = null;
    }
    // The shared AudioContext is app-lifetime — never close it here (others depend on it).
}
