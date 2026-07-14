// Backing-track playback driven from Blazor via IJSRuntime. Runs in the standalone web app and
// every MAUI BlazorWebView, so behavior is identical on all platforms.
//
// TWO engines (see docs/08_Audio_Engine/AudioStretchQuality.md):
//
//  1. PRIMARY — Signalsmith Stretch (vendored WASM AudioWorklet, MIT): the file is decoded to an
//     AudioBuffer and played by the stretch node itself, which does tempo (rate), pitch
//     (semitones), seeking (input) and GAPLESS section looping (loopStart/loopEnd) in one
//     high-quality engine. No <audio> element involved.
//
//  2. FALLBACK — the previous mechanism, kept for URI loads and for when the worklet or decode is
//     unavailable: <audio> element with playbackRate+preservesPitch for tempo and a granular
//     worklet (pitchShiftProcessor.js) for pitch. Loop windows enforced via timeupdate.
//
// The exported API is identical for both engines; C# (JsAudioPlayer) needs no changes.

import SignalsmithStretch from './vendor/SignalsmithStretch.js';
import * as countInCore from './countIn.js';
import * as engineCommon from './engineCommon.js';
import * as decodeCache from './decodeCache.js';

const state = {
    engine: 'element', // which engine owns the currently loaded media: 'stretch' | 'element'
    dotnet: null,      // DotNetObjectReference for playback-ended notifications
    ctx: null,
    tempoRatio: 1,
    pitchSemitones: 0,
    pan: 0,            // -1 (full left) … 0 (center) … +1 (full right)
    panner: null,      // shared master StereoPannerNode both engines route through
    range: null,       // { start, end, loop }
    countIn: { beats: 0, entryBeats: 0, secondsPerBeat: 0.5 }, // beats = clicks heard; entryBeats = where music enters (fractional)
    countInNodes: [],  // scheduled click oscillators (cancelled on pause/stop/seek)
    countInTimer: null, // element-fallback deferred start

    // Stretch engine.
    stretch: {
        node: null,
        ready: null,   // Promise while the node is being created
        duration: 0,
        position: 0,   // mirrored from the node's inputTime updates
        playing: false,
        flux: null,         // decimated onset-flux envelope for beat-phase snapping (count-in v2)
        fluxFrameSeconds: 0, // seconds per envelope frame
        leadingSilence: 0,  // seconds of quiet at the song start, trimmed by the count-in when no grid
    },

    // Element fallback.
    audio: null,
    objectUrl: null,
    sourceNode: null,
    pitchNode: null,

    // Waveform peaks, computed once from the decoded buffer at load. { min, max, rms } Float32Arrays.
    peaks: null,
};

// Peaks for the current track, resampled to the requested bucket count as the flat
// [min…, max…, rms…] array .NET expects (see engineCommon.resamplePeaksFlat for the interop note).
// startSeconds/endSeconds (optional) restrict the buckets to a sub-window, so a zoomed view resamples
// full detail from the fine cache across that window instead of stretching a few whole-track buckets.
export function getPeaks(buckets, startSeconds, endSeconds) {
    return engineCommon.resamplePeaksFlat(state.peaks, buckets, state.stretch.duration || 0, startSeconds, endSeconds);
}

// Register a .NET callback (with an OnPlaybackEnded JSInvokable) so C# state stays in sync when the
// audio stops on its own (track end, or a non-looping section reaching its end).
export function setEndedCallback(dotnetRef) {
    state.dotnet = dotnetRef;
}

// Detach the .NET callback — MUST be called by JsAudioPlayer.DisposeAsync BEFORE it disposes its
// DotNetObjectReference. This module keeps its own app-lifetime AudioContext, so its state (and any
// pending OnPlaybackEnded notify) outlives the scoped JsAudioPlayer; without this, a disposed
// reference in state.dotnet throws "no tracked object with id N" when the track later ends. Same
// singleton-vs-scoped bug and fix as stemPlayer.clearEndedCallback (2026-07-12).
export function clearEndedCallback() {
    state.dotnet = null;
}

function notifyEnded() {
    if (state.dotnet) {
        state.dotnet.invokeMethodAsync('OnPlaybackEnded');
    }
}

function ensureCtx() {
    if (!state.ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        state.ctx = new Ctor();
        // See audioContext.js: hand this (separate) backing-track context to the gesture unlock too,
        // so iOS resumes it from a real gesture rather than our async play() path.
        window.__audioUnlock?.register(state.ctx);
        watchResumeReprime(state.ctx); // wobble FIX (#77): re-prime the stretch worklet on resume
    }
    return state.ctx;
}

// WOBBLE FIX (#77) — mirror of stemPlayer.watchResumeReprime for the backing-track engine. When iOS
// suspends this WebView AudioContext and resumes it, the stretch worklet's phase-vocoder pipeline holds
// stale state and warbles as it refills. On the suspended->running edge while the stretch node is
// playing, re-seek it to its current position (applyStretchSchedule flushes + re-primes cleanly, the
// same thing a seek does), so the resume is clean instead of warbling. Once per context; guarded to the
// resume edge so it can't thrash; skips a pending count-in (its deferred start must stay scheduled).
function watchResumeReprime(ctx) {
    if (!ctx || !ctx.addEventListener) return;
    let wasInterrupted = false;
    ctx.addEventListener('statechange', () => {
        try {
            const st = ctx.state;
            if (st === 'suspended' || st === 'interrupted') { wasInterrupted = true; return; }
            if (st === 'running' && wasInterrupted) {
                wasInterrupted = false;
                if (state.engine === 'stretch' && state.stretch.node && state.stretch.playing
                    && !countInPending()) {
                    const at = state.stretch.position || 0;
                    applyStretchSchedule({ input: at });
                    console.warn(`[perf:count-in] resume re-prime: re-seek backing to ${at.toFixed(3)}s to flush the warble`);
                }
            }
        } catch (e) { /* never throw out of a state event */ }
    });
}

// Shared master panner both engines connect INTO (instead of straight to destination), so L/R pan
// works the same regardless of which engine owns the media (engineCommon owns the mechanism).
function ensurePanner() {
    return engineCommon.ensureMasterPanner(ensureCtx(), state);
}

// ---------------------------------------------------------------------------------------------
// Count-in: clicks scheduled on the SAME context as playback, so the handoff into the audio is
// sample-accurate. Interval = musical beat / tempo ratio (matches the practiced tempo).
// ---------------------------------------------------------------------------------------------

// The core lives in countIn.js, shared with the stem player; thin wrappers bind this module's state.
function countInIntervalSeconds() {
    return countInCore.countInIntervalSeconds(state.countIn, state.tempoRatio);
}

function scheduleClicks(ctx, startAt) {
    countInCore.scheduleCountInClicks(
        ctx, startAt, state.countIn.beats, countInIntervalSeconds(), state.countInNodes, 'track');
}

function cancelCountIn() {
    countInCore.cancelCountInNodes(state.countInNodes, 'track');
    // Track-player extra: the element-fallback engine defers its start on a timer.
    if (state.countInTimer) {
        clearTimeout(state.countInTimer);
        state.countInTimer = null;
    }
}

// True while a count-in's deferred start is still ahead of us (element timer armed, or the stretch
// node scheduled for a future output). seek/setLoop/setTempoAndPitch must abandon the count then:
// any schedule() call pops the pending future segment in the vendor node — the music would start
// immediately, mid-count, at a derived position — so the clicks must not keep firing over it.
function countInPending() {
    return state.countInTimer != null ||
        (state.ctx != null && state.ctx.currentTime < (state.stretch.holdEndCheckUntil || 0));
}

function cancelPendingCountIn() {
    if (!countInPending()) return;
    cancelCountIn();
    state.stretch.holdEndCheckUntil = 0; // re-arm the watchdog: the deferred start no longer exists
}

// Count-in v2: find where the SONG's beats fall near the start point, so the count-in hands off
// onto the song's own downbeat even when the section marker was set between beats. A comb of the
// beat interval is slid across an onset-flux envelope; the phase that collects the most flux is
// where the beats live. The envelope is computed ONCE at load (~80 KB for a 4-minute track) so
// the decoded PCM does not have to stay resident.

const FLUX_HOP = 512;

function fluxEnvelope(channel, sampleRate, startSample, frames) {
    const flux = new Float32Array(frames);
    let previous = 0;
    for (let f = 0; f < frames; f++) {
        let sum = 0;
        const offset = startSample + f * FLUX_HOP;
        for (let i = 0; i < FLUX_HOP; i++) {
            const s = channel[offset + i];
            sum += s * s;
        }
        const energy = Math.sqrt(sum / FLUX_HOP);
        flux[f] = Math.max(0, energy - previous);
        previous = energy;
    }
    return flux;
}

// Leading-silence detection for the count-in flow. When a song has no beat grid, the count-in has
// nothing to align the music to, so the clicks end and then a beat of dead air plays before the first
// note — an audible gap (user report, 2026-07-11). Measuring how much silence sits at the very start
// lets the count-in skip it so the first note lands on the downbeat (see play(): used as the
// firstBeatOffset fallback). CONSERVATIVE by design: a low threshold (~-45 dB) so an intentional quiet
// intro/swell isn't clipped, a short sustained-above-threshold requirement so a lone tick/pop doesn't
// count as "music started", and a hard cap so we never skip more than a bar or two of a slow fade-in.
const SILENCE_THRESHOLD = 0.0056;   // ~-45 dB peak — below this is "silence"
const SILENCE_BLOCK_SECONDS = 0.01; // scan in 10 ms blocks (a raw sine dips below threshold at every
                                    //   zero crossing, so per-sample runs never sustain — use block peak)
const SILENCE_SUSTAIN_BLOCKS = 3;   // this many consecutive loud blocks = the music genuinely started
const SILENCE_MAX_SKIP_SECONDS = 3.0; // never trim more than this, whatever the file does

export function leadingSilenceSeconds(channels, sampleRate) {
    if (!sampleRate || !channels.length || !channels[0]?.length) return 0;
    const block = Math.max(1, Math.floor(SILENCE_BLOCK_SECONDS * sampleRate));
    const maxSample = Math.floor(SILENCE_MAX_SKIP_SECONDS * sampleRate);
    const len = Math.min(channels[0].length, maxSample + block * SILENCE_SUSTAIN_BLOCKS);
    let run = 0;        // consecutive loud blocks
    let firstLoud = -1; // sample index where the current loud run began
    for (let start = 0; start < len; start += block) {
        const end = Math.min(start + block, len);
        let peak = 0;
        for (let i = start; i < end; i++) {
            for (let c = 0; c < channels.length; c++) {
                const a = Math.abs(channels[c][i]);
                if (a > peak) peak = a;
            }
        }
        if (peak >= SILENCE_THRESHOLD) {
            if (run === 0) firstLoud = start;
            run++;
            // The music has genuinely started (held loud for SUSTAIN blocks) — trim up to the onset of
            // that loud run, clamped to the cap. Never negative.
            if (run >= SILENCE_SUSTAIN_BLOCKS) {
                return Math.min(SILENCE_MAX_SKIP_SECONDS, Math.max(0, firstLoud / sampleRate));
            }
        } else {
            run = 0;
        }
    }
    return 0; // no sustained sound within the cap window — trim nothing
}

function phaseFromFlux(flux, frameSeconds, intervalSeconds) {
    const windowSeconds = flux.length * frameSeconds;
    if (!(intervalSeconds > 0) || windowSeconds < intervalSeconds * 2) return 0;

    const steps = Math.max(16, Math.floor(intervalSeconds / 0.005));
    let bestPhase = 0, bestScore = -1;
    for (let s = 0; s < steps; s++) {
        const phase = (s / steps) * intervalSeconds;
        let score = 0;
        for (let t = phase; t < windowSeconds; t += intervalSeconds) {
            const f = Math.round(t / frameSeconds);
            if (f >= 0 && f < flux.length) score += flux[f];
        }
        if (score > bestScore) { bestScore = score; bestPhase = phase; }
    }
    return bestPhase; // seconds after the envelope window's start of the song's first beat
}

// Sample-based wrapper (exported for the Node test harness; behavior unchanged).
export function estimateBeatPhaseSeconds(channel, sampleRate, startSeconds, intervalSeconds) {
    const available = channel.length / sampleRate - startSeconds;
    const windowSeconds = Math.min(8, available);
    if (!(intervalSeconds > 0) || windowSeconds < intervalSeconds * 2) return 0;

    const startSample = Math.max(0, Math.floor(startSeconds * sampleRate));
    const frames = Math.floor(windowSeconds * sampleRate / FLUX_HOP) - 1;
    return phaseFromFlux(fluxEnvelope(channel, sampleRate, startSample, frames), FLUX_HOP / sampleRate, intervalSeconds);
}

// Snap an input position forward to the song's next beat, using the envelope stored at load.
function snapToSongBeat(input, intervalSeconds) {
    const s = state.stretch;
    if (!s.flux || !(s.fluxFrameSeconds > 0)) return input;

    const startFrame = Math.max(0, Math.floor(input / s.fluxFrameSeconds));
    const windowFrames = Math.min(Math.floor(8 / s.fluxFrameSeconds), s.flux.length - startFrame);
    if (windowFrames < 4) return input;

    const phase = phaseFromFlux(s.flux.subarray(startFrame, startFrame + windowFrames), s.fluxFrameSeconds, intervalSeconds);
    let snapped = startFrame * s.fluxFrameSeconds + phase;
    while (snapped < input - 1e-6) snapped += intervalSeconds;
    return snapped;
}

// ---------------------------------------------------------------------------------------------
// Stretch engine
// ---------------------------------------------------------------------------------------------

async function ensureStretchNode() {
    if (state.stretch.node) return state.stretch.node;
    if (!state.stretch.ready) {
        state.stretch.ready = (async () => {
            const ctx = ensureCtx();
            // Library-default node shape (1 input, 1 output, stereo). The input is never
            // connected — we only use buffer playback — and an unconnected input is silence.
            const node = await SignalsmithStretch(ctx);
            node.connect(ensurePanner());
            // Position mirror + end-of-media detection (shared watchdog, carrying the loop-wrap
            // and deferred-start guards — see engineCommon.makeEndWatchdog). 100 ms matches the
            // old timeupdate feel.
            node.setUpdateInterval(0.1, engineCommon.makeEndWatchdog(node, state, notifyEnded));
            state.stretch.node = node;
            return node;
        })();
    }
    return state.stretch.ready;
}

// Decoded-audio reuse is backed by the SHARED decodeCache.js (keyed by content hash) so the stem
// engine's Original-mix load can reuse the decode this player already paid for, and vice versa — see
// that module for the why. These thin wrappers keep the existing exported names (C# calls hasDecoded/
// activateDecoded; the load path calls cacheGet/cachePut).
export function hasDecoded(key) {
    return decodeCache.has(key);
}

// Drop every cached decode (library import replaced files). Delegates to the shared cache.
export function clearDecodeCache() {
    decodeCache.clearAll();
}

const cacheGet = decodeCache.get;
const cachePut = decodeCache.put;

// Compute the backing player's DERIVED fields (waveform peaks, beat-phase flux, leading silence) from
// a record's raw channels. The shared decodeCache may hold a MINIMAL record authored by the stem engine
// (channels only — the mixer doesn't need peaks/flux), so a hit here fills in whatever's missing rather
// than reading `undefined`. The channels are the expensive part (the decode); these are cheap.
function ensureDerived(rec) {
    if (rec.peaks && rec.flux) return rec; // already a full (backing-player-authored) record
    const targetBuckets = Math.min(6000, Math.max(1000, Math.floor(rec.duration * 60)));
    const peaks = engineCommon.computePeaks(rec.channels, rec.length, targetBuckets);
    const channel0 = rec.channels[0];
    const frames = Math.max(0, Math.floor(channel0.length / FLUX_HOP) - 1);
    const flux = fluxEnvelope(channel0, rec.sampleRate, 0, frames);
    // Backfill the shared record in place so a later reuse (or the stem engine) benefits too.
    rec.peaks = peaks;
    rec.flux = flux;
    rec.fluxFrameSeconds = FLUX_HOP / rec.sampleRate;
    if (rec.leadingSilence === undefined) rec.leadingSilence = leadingSilenceSeconds(rec.channels, rec.sampleRate);
    return rec;
}

// Wire a decoded record (freshly decoded OR pulled from the cache) into the stretch node + player
// state. Splitting this out lets a cache hit skip decodeAudioData/computePeaks/fluxEnvelope entirely.
async function applyDecoded(rec) {
    rec = ensureDerived(rec); // fill in peaks/flux if this came from a minimal (stem) cache entry
    const node = await ensureStretchNode();
    node.stop();
    await node.dropBuffers();
    await node.addBuffers(rec.channels);

    state.peaks = rec.peaks;
    state.stretch.duration = rec.duration;
    state.stretch.position = 0;
    state.stretch.playing = false;
    state.stretch.flux = rec.flux;
    state.stretch.fluxFrameSeconds = rec.fluxFrameSeconds;
    state.stretch.leadingSilence = rec.leadingSilence || 0;
    state.engine = 'stretch';
    state.range = null;
    applyStretchSchedule({ input: 0, active: false });
}

// Re-activate an already-decoded track from the cache with NO file read and NO decode. Returns true
// if the key was resident (host can skip streaming the bytes); false if it must fall back to a full
// stretchLoad. Silences the outgoing engine first, mirroring loadFromStream's ownership handoff.
export async function activateDecoded(key) {
    const rec = cacheGet(key);
    if (!rec) return false;
    cancelCountIn();
    silenceStretch();
    silenceElement();
    await applyDecoded(rec);
    return true;
}

async function stretchLoad(arrayBuffer, key) {
    // Cache hit: reuse the decoded PCM (skips the 17-59 s decodeAudioData). Only reachable when the
    // host streamed the bytes anyway (didn't take the activateDecoded fast path); still a big win.
    const cached = cacheGet(key);
    if (cached) {
        await applyDecoded(cached);
        return;
    }

    const ctx = ensureCtx();
    // decodeAudioData detaches the buffer; keep the original intact for the element fallback.
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));

    const channels = [];
    for (let c = 0; c < Math.max(1, decoded.numberOfChannels); c++) {
        channels.push(decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1)));
    }
    if (channels.length === 1) channels.push(channels[0]); // mono → both ears

    // Pre-bucket the waveform once at a fine resolution; getPeaks() resamples from this cheaply.
    const targetBuckets = Math.min(6000, Math.max(1000, Math.floor(decoded.duration * 60)));
    const peaks = engineCommon.computePeaks(channels, decoded.length, targetBuckets);

    // Precompute the beat-phase envelope so the decoded PCM does not stay resident just for
    // count-in snapping (the stretch node holds its own copy of the audio).
    const channel0 = channels[0];
    const frames = Math.max(0, Math.floor(channel0.length / FLUX_HOP) - 1);
    const flux = fluxEnvelope(channel0, decoded.sampleRate, 0, frames);
    const fluxFrameSeconds = FLUX_HOP / decoded.sampleRate;
    const leadingSilence = leadingSilenceSeconds(channels, decoded.sampleRate);

    const rec = {
        channels, duration: decoded.duration, sampleRate: decoded.sampleRate,
        length: decoded.length, peaks, flux, fluxFrameSeconds, leadingSilence,
    };
    cachePut(key, rec);
    await applyDecoded(rec);
}

// Single funnel for schedule() so tempo/pitch/loop state is always re-asserted together
// (engineCommon owns the loop/open-ended-end semantics).
function applyStretchSchedule(extra) {
    engineCommon.applyStretchSchedule(
        state.stretch.node, state.range, state.stretch.duration, state.tempoRatio, state.pitchSemitones, extra);
}

// Silence + detach whichever engine is being switched away from, so two engines never sound at
// once and a failed decode cannot leave uncontrollable audio running (found in review).
function silenceStretch() {
    const s = state.stretch;
    if (s.node) {
        try { s.node.stop(); } catch { /* not started */ }
    }
    s.playing = false;
    s.position = 0;
}

function silenceElement() {
    if (state.audio) {
        state.audio.pause();
        state.audio.removeAttribute('src');
        state.audio.load();
    }
    revokeObjectUrl();
}

// ---------------------------------------------------------------------------------------------
// Element fallback (previous mechanism, unchanged in behavior)
// ---------------------------------------------------------------------------------------------

function ensureAudio() {
    if (state.audio) return state.audio;
    const audio = new Audio();
    audio.preload = 'auto';
    audio.addEventListener('timeupdate', () => {
        const r = state.range;
        if (!r || state.engine !== 'element') return;
        if (r.end != null && audio.currentTime >= r.end) {
            if (r.loop) {
                audio.currentTime = r.start;
            } else {
                audio.pause();
                notifyEnded();
            }
        }
    });
    audio.addEventListener('ended', () => { if (state.engine === 'element') notifyEnded(); });
    audio.crossOrigin = 'anonymous';
    state.audio = audio;
    return audio;
}

// Build the fallback Web Audio graph once: media element -> granular pitch node -> destination.
// Falls back to a direct element->destination connection if AudioWorklet is unavailable (pitch
// then no-ops, tempo still works via playbackRate).
async function ensureElementGraph() {
    if (state.sourceNode) return;
    const ctx = ensureCtx();
    const audio = ensureAudio();
    state.sourceNode = ctx.createMediaElementSource(audio);

    if (ctx.audioWorklet) {
        try {
            await ctx.audioWorklet.addModule('./_content/MasteryCoach.UI/js/pitchShiftProcessor.js');
            state.pitchNode = new AudioWorkletNode(ctx, 'pitch-shift-processor');
            state.sourceNode.connect(state.pitchNode).connect(ensurePanner());
            applyElementPitch();
            return;
        } catch {
            // Fall through to direct connection if the worklet fails to load.
        }
    }
    state.sourceNode.connect(ensurePanner());
}

function applyElementPitch() {
    if (state.pitchNode) {
        const ratio = Math.pow(2, state.pitchSemitones / 12);
        state.pitchNode.port.postMessage({ ratio });
    }
}

// ---------------------------------------------------------------------------------------------
// Exported API (engine-dispatching)
// ---------------------------------------------------------------------------------------------

// Load from a URL string — element engine (no stream to decode up front).
export function load(uri) {
    cancelCountIn();
    silenceStretch(); // switching engines must not leave the stretch node playing
    const audio = ensureAudio();
    revokeObjectUrl();
    audio.src = uri;
    audio.load();
    state.range = null;
    state.engine = 'element';
    state.peaks = null; // element engine has no decoded buffer → drop the previous track's peaks
}

// Map file extensions to audio MIME types. A blob's type must be a concrete type — a wildcard like
// 'audio/*' or an empty/garbage type gives the <audio> element "no supported sources".
const AUDIO_MIME = {
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', mp4: 'audio/mp4',
    wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
    flac: 'audio/flac', weba: 'audio/webm', webm: 'audio/webm',
};

function resolveMime(mimeType, fileName) {
    // Trust a concrete provided type; reject empty and wildcard types.
    if (mimeType && mimeType.includes('/') && !mimeType.includes('*')) return mimeType;
    const ext = (fileName || '').split('.').pop().toLowerCase();
    return AUDIO_MIME[ext] || '';
}

// Load from a .NET stream (Blazor DotNetStreamReference of an IBrowserFile). Tries the stretch
// engine first (decode to buffer); if decode or the worklet fails, falls back to the previous
// blob-URL <audio> mechanism so nothing regresses. Returns the engine it landed on: 'stretch' (full
// waveform + tempo/pitch) or 'element' (play-only, no waveform) — so the host can react (e.g. transcode
// a file WebView2's decodeAudioData rejected). Returns '' when nothing loaded.
// NATIVE path — and, with the OPFS store, the web's STORED-audio path too (MEMFS File.OpenRead →
// DotNetStreamReference). engineCommon.readStreamRefBytes tries the native-proven one-shot
// arrayBuffer() first and falls back to the properly-AWAITED chunked reader that works on WASM —
// the resolution of the attach saga (a8a5b99 → 573c50a → d59facb): native keeps its fast path
// untouched, WASM reads that arrayBuffer() rejects still succeed.
export async function loadFromStream(streamRef, mimeType, fileName, key) {
    let buffer;
    try {
        buffer = await engineCommon.readStreamRefBytes(streamRef);
    } catch (e) {
        const detail = e && (e.stack || e.message || e.name) || String(e);
        throw new Error(`Could not read the picked file "${fileName}": ${detail}`);
    }
    return await loadDecodedBuffer(buffer, mimeType, fileName, key);
}

// WEB path: read the picked file DIRECTLY from the <input type=file>'s own JS File (element.files[0]),
// no .NET round-trip. On the WASM build reading a picked file back through a DotNetStreamReference threw
// "TypeError: Failed to fetch"; the browser already owns the File, so this bypasses the interop entirely.
//
// Three steps because the <input> element is EPHEMERAL: it lives inside a busy-spinner @if, so the
// first re-render after the change handler sets its busy flag removes it from the DOM — and its
// files list with it ("No file on the input element"). captureInputFile must therefore be the FIRST
// await in the handler; the stashed File then feeds both consumers with no element dependency:
// capturedFileBlob() streams the bytes to .NET for the OPFS media store (JS→.NET streaming — the
// interop direction that works on WASM), and loadCapturedFile() decodes into the player via the
// SAME decode path as native, so behavior is identical.
let capturedInputFile = null;
let inputCaptureInstalled = false;

// Belt-and-braces stash: a document-level CAPTURE-phase listener grabs files[0] the instant the
// change event fires — before Blazor's own listener even dispatches to .NET, and with zero
// dependence on ElementReference resolution (which goes through document.querySelector and returns
// null the moment a re-render replaces the element). Opt-in per input via data-mc-capture so the
// stem-slot pickers and any future inputs are untouched.
export function initInputCapture() {
    if (inputCaptureInstalled) return;
    inputCaptureInstalled = true;
    document.addEventListener('change', (ev) => {
        const t = ev.target;
        if (t && t.matches && t.matches('input[type=file][data-mc-capture]')) {
            capturedInputFile = (t.files && t.files[0]) || null;
        }
    }, true);
}

export function captureInputFile(inputElement) {
    const file = inputElement && inputElement.files && inputElement.files[0];
    if (file) capturedInputFile = file; // never clobber the event-listener stash with a null
    return capturedInputFile != null;
}

export function hasCapturedFile() {
    return capturedInputFile != null;
}

// The File IS a Blob → .NET receives an IJSStreamReference and streams it. Does NOT release the
// stash — loadCapturedFile still needs it after the store save.
export function capturedFileBlob() {
    return capturedInputFile;
}

export async function loadCapturedFile(fileName) {
    const file = capturedInputFile;
    capturedInputFile = null; // last consumer — release the reference
    if (!file) {
        throw new Error(`No captured file for "${fileName}".`);
    }
    const buffer = await file.arrayBuffer(); // native File.arrayBuffer — no interop, no fetch
    // The web pick has no content-hash key (no stable identity yet) → null, same as loadFromStream("").
    return await loadDecodedBuffer(buffer, file.type || '', file.name || fileName, null);
}

// Shared: turn a raw ArrayBuffer into a playing engine. Tries the stretch engine (decode + worklet) and
// falls back to the play-only <audio> element. Used by BOTH the native stream path and the web
// input-element path so the two never diverge.
async function loadDecodedBuffer(buffer, mimeType, fileName, key) {
    // Silence BOTH engines up front: whichever one loses ownership must not keep playing the
    // previous track (a failed decode below must not leave the old stretch buffers running).
    cancelCountIn();
    silenceStretch();
    silenceElement();

    try {
        await stretchLoad(buffer, key);
        return 'stretch';
    } catch (e) {
        // Decode/worklet unavailable — fall back to the play-only <audio> element below. The host
        // detects the 'element' result and transcodes to WAV so the waveform can come back.
        console.warn(`[audio] decode failed (${fileName}), using element fallback: ${e?.name || e?.message || e}`);
    }

    const type = resolveMime(mimeType, fileName);
    // An empty type is valid and lets the browser sniff the content; a wildcard is not.
    const blob = type ? new Blob([buffer], { type }) : new Blob([buffer]);
    const audio = ensureAudio();
    revokeObjectUrl();
    state.objectUrl = URL.createObjectURL(blob);
    audio.src = state.objectUrl;
    audio.load();
    state.range = null;
    state.engine = 'element';
    state.peaks = null; // element fallback has no decoded buffer → no waveform
    return 'element';
}

export async function play() {
    const ctx = ensureCtx();
    if (ctx.state === 'suspended') await ctx.resume(); // iOS gesture

    cancelCountIn();

    if (state.engine === 'stretch' && state.stretch.node) {
        const s = state.stretch;
        const r = state.range;
        let input = s.position;
        if (r && (input < r.start || (r.end != null && input >= r.end))) input = r.start;
        // Replay after ending: a stopped take parks near the media end (or at a range end beyond
        // the media), which would otherwise re-trigger the end watchdog immediately.
        if (s.duration > 0 && input >= s.duration - 0.1) input = r ? r.start : 0;

        if (state.countIn.beats > 0) {
            // Phase alignment: when C# supplied the tracked-grid gap to the song's first beat
            // (firstBeatOffset), countInMusicAlignment starts the file early / skips it forward
            // so the song's beat — not the raw file position — lands on the entry beat. The offset
            // was MEASURED at the section start (or 0 for a whole-song/set run), so anchor the
            // entry there too: the parked position can be somewhere else entirely (a loop cleared
            // while stopped leaves it at the old section start), and applying the offset to it
            // would shift the music by a gap that belongs to a different spot — worse than no
            // alignment. The flux estimate measures phase at the ACTUAL position, so it keeps the
            // parked-position entry and stays the no-grid fallback only.
            // A grid gives the exact gap to the first tracked beat. Without one, fall back to leading-
            // silence trimming: if we're starting at the very head of the song (or section start) and
            // the file opens with quiet, treat that quiet as the gap so the FIRST NOTE — not the raw
            // 0:00 — lands on the entry beat, via the same countInMusicAlignment path the grid uses.
            // That removes the dead-air pause between the last click and the music (user report,
            // 2026-07-11). Off the song head (a mid-song start/replay), there's no leading silence to
            // trim, so keep the v2 beat-phase snap as the fallback.
            let alignCountIn = state.countIn;
            if (state.countIn.firstBeatOffset == null) {
                const atHead = input <= (r ? r.start : 0) + 0.05;
                const silence = atHead ? (state.stretch.leadingSilence || 0) : 0;
                if (silence > 0.02) {
                    // Synthesize the grid gap from the measured silence. CRUCIAL: leading silence locates
                    // the song's first strong onset — its DOWNBEAT (beat 1) — so anchor that onset to the
                    // count's beat 1 (the classic full-count entry), NOT to the user's off-beat entry.
                    // If we aligned the onset to "& of 3", the downbeat would land an 8th late and any
                    // real pickup before it would be pinned onto the off-beat or trimmed — the song's
                    // first 8th note going missing (user report, 2026-07-11). Anchoring to the downbeat
                    // instead lets a genuine pickup play under the closing clicks, exactly as the grid
                    // path does. The user's off-beat entry still governs the CLICKS (scheduled below from
                    // state.countIn); only the music-start anchor uses the full count here.
                    alignCountIn = { ...state.countIn, entryBeats: state.countIn.beats, firstBeatOffset: silence };
                } else {
                    // No trimmable silence — snap the start forward to the song's own next beat.
                    input = snapToSongBeat(input, state.countIn.secondsPerBeat);
                }
            } else {
                input = r ? r.start : 0;
            }

            const startAt = ctx.currentTime + 0.08;
            scheduleClicks(ctx, startAt);
            // Clicks fire for the full count (beats); the music ENTERS at entryBeats — a fractional
            // beat within the count (e.g. 2.5 = "and of 3"), so it can come in on an off-beat while
            // the clicks keep going. The skip is bounded by what remains playable before the
            // section/media end (minus a musically-useful margin) — past that, alignment degrades
            // to the plain entry rather than starting where the watchdog would instantly end it.
            const endBound = r && r.end != null ? r.end : s.duration;
            const align = countInCore.countInMusicAlignment(
                alignCountIn, state.tempoRatio, endBound - input - 0.3);
            input += align.skipSeconds;
            // LATENCY COMPENSATION (music-comes-in-late-after-the-count bug, user report 2026-07-13):
            // the clicks are plain oscillators (sound at their scheduled time); the song plays through
            // the stretch worklet, whose audible output emerges ~node.latency() AFTER its scheduled
            // output — so scheduling the music AT the entry-beat click made it sound that late (a gap
            // after the last click). Pull the scheduled output EARLIER by the latency so the audible
            // song lands ON the click. Clamped so it never schedules before now. Same fix as stemPlayer.
            // node.latency() is an async worklet-port promise — await it (NaN into the schedule silences
            // the worklet, the 2026-07-12 bug).
            const musicClickTime = startAt + align.delaySeconds;
            let latency = 0;
            const snode = state.stretch.node;
            if (snode && typeof snode.latency === 'function') {
                try { const l = await snode.latency(); if (typeof l === 'number' && isFinite(l)) latency = l; }
                catch { /* cold node — no compensation, pre-fix behavior */ }
            }
            const musicAt = Math.max(ctx.currentTime + 0.02, musicClickTime - latency);
            applyStretchSchedule({ input, active: true, output: musicAt });
            // Deferred start: the node reports its STALE previous position until the scheduled
            // output time — seed the mirror and hold the end watchdog off (same hazard as stems:
            // a stale at-the-end position would false-fire "ended" during the count-in pre-roll).
            s.position = input;
            s.holdEndCheckUntil = musicAt + 0.2;
        } else {
            applyStretchSchedule({ input, active: true });
            s.holdEndCheckUntil = 0; // immediate start — no deferred-start window to hold for
        }

        s.playing = true;
        return;
    }

    const audio = ensureAudio();
    if (!audio.src) {
        throw new Error('No backing track loaded. Choose an audio file before playing.');
    }
    await ensureElementGraph();
    const r = state.range;
    if (r && (audio.currentTime < r.start || (r.end != null && audio.currentTime >= r.end))) {
        audio.currentTime = r.start;
    }

    if (state.countIn.beats > 0) {
        // Fallback path: clicks on the context, deferred element start. The element starts from
        // INSIDE the timer (not an awaited promise) so cancelling the count-in just clears the
        // timer — an awaited resolver would be orphaned and hang the C# PlayAsync (found in review).
        scheduleClicks(ctx, ctx.currentTime + 0.08);
        // Clicks fire for the full count; the element starts when the music ENTERS (entryBeats,
        // pulled earlier / skipped forward by a grid-supplied first-beat offset — see
        // countInCore.countInMusicAlignment). Grid alignment anchors at the section start (or 0),
        // where the offset was measured; the seek happens INSIDE the timer as an absolute
        // position, so a cancelled count-in leaves the element untouched instead of ratcheting
        // currentTime forward by the skip on every attempt.
        const hasGrid = state.countIn.firstBeatOffset != null;
        const entryFrom = hasGrid ? (r ? r.start : 0) : audio.currentTime;
        const endBound = r && r.end != null ? r.end : (Number.isFinite(audio.duration) ? audio.duration : Infinity);
        const align = countInCore.countInMusicAlignment(
            state.countIn, state.tempoRatio, endBound - entryFrom - 0.3);
        const startFrom = entryFrom + align.skipSeconds;
        state.countInTimer = setTimeout(() => {
            state.countInTimer = null;
            if (hasGrid) audio.currentTime = startFrom;
            // Warn (not swallow): a play() rejection here (autoplay policy, aborted load) would
            // otherwise be fully silent — console.warn reaches the diagnostics funnel.
            audio.play().catch((err) => console.warn(`[audio] deferred element play failed: ${err?.message ?? err}`));
        }, Math.round((0.08 + align.delaySeconds) * 1000));
        return;
    }

    await audio.play();
}

export function pause() {
    cancelCountIn();
    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.playing = false;
        state.stretch.holdEndCheckUntil = 0; // any deferred start is being cancelled right here
        applyStretchSchedule({ active: false });
        return;
    }
    if (state.audio) state.audio.pause();
}

export function stop() {
    cancelCountIn();
    const startAt = state.range ? state.range.start : 0;
    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.playing = false;
        state.stretch.holdEndCheckUntil = 0; // any deferred start is being cancelled right here
        state.stretch.position = startAt;
        applyStretchSchedule({ active: false, input: startAt });
        return;
    }
    if (!state.audio) return;
    state.audio.pause();
    state.audio.currentTime = startAt;
}

export function seek(seconds) {
    // A seek abandons a pending count-in (per the countInNodes contract): the schedule() below
    // pops the deferred start anyway, so the clicks must not keep firing over the seeked music.
    cancelPendingCountIn();
    if (state.engine === 'stretch' && state.stretch.node) {
        state.stretch.position = seconds;
        applyStretchSchedule({ input: seconds });
        return;
    }
    if (state.audio) state.audio.currentTime = seconds;
}

// Count-in settings — semantics live in countInCore.clampCountIn (the one statement of the
// beats/entryBeats/secondsPerBeat/firstBeatOffset contract, shared with the stem player).
export function setCountIn(beats, entryBeats, secondsPerBeat, firstBeatOffsetSeconds) {
    state.countIn = countInCore.clampCountIn(beats, entryBeats, secondsPerBeat, firstBeatOffsetSeconds);
}

export function setLoop(start, end, loop) {
    cancelPendingCountIn(); // schedule() below would pop the deferred start out from under the clicks
    state.range = start == null ? null : { start, end, loop };
    if (state.engine === 'stretch' && state.stretch.node) {
        const s = state.stretch;
        const jump = state.range && s.position < state.range.start ? { input: state.range.start } : {};
        if (jump.input != null) s.position = jump.input;
        applyStretchSchedule(jump); // re-asserts loopStart/loopEnd from state.range
        return;
    }
    if (state.range) {
        const audio = ensureAudio();
        if (audio.currentTime < start) audio.currentTime = start;
    }
}

// Independent tempo and pitch. Stretch engine: both in one pass, one high-quality algorithm.
// Element fallback: playbackRate (pitch preserved) + granular worklet.
export function setTempoAndPitch(tempoRatio, pitchSemitones) {
    cancelPendingCountIn(); // schedule() below would pop the deferred start out from under the clicks
    state.tempoRatio = tempoRatio > 0 ? tempoRatio : 1;
    state.pitchSemitones = pitchSemitones || 0;

    if (state.engine === 'stretch' && state.stretch.node) {
        applyStretchSchedule({});
        return;
    }

    const audio = ensureAudio();
    audio.preservesPitch = true;
    audio.playbackRate = state.tempoRatio;
    applyElementPitch();
}

// L/R balance, -1 (left) … 0 (center) … +1 (right). Applies live via the shared master panner.
export function setPan(pan) {
    engineCommon.setMasterPan(state, pan);
}

export function getPosition() {
    if (state.engine === 'stretch') return state.stretch.position;
    return state.audio ? state.audio.currentTime : 0;
}

export function getDuration() {
    if (state.engine === 'stretch') return state.stretch.duration;
    const d = state.audio ? state.audio.duration : 0;
    return Number.isFinite(d) ? d : 0;
}

export function isPlaying() {
    if (state.engine === 'stretch') return state.stretch.playing;
    return !!state.audio && !state.audio.paused && !state.audio.ended;
}

function revokeObjectUrl() {
    if (state.objectUrl) {
        URL.revokeObjectURL(state.objectUrl);
        state.objectUrl = null;
    }
}
