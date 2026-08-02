// stemSeparation.js — main-thread orchestrator for the in-browser stem separator (Tier 3 Phase 1,
// StemSeparationPlan.md §4b). Consumed by WebOnnxDemucsSeparator via JS interop:
//
//   beginSeparate(audioStreamRef, options, dotnetCb) → jobId   (reads the stream, returns fast)
//   waitSeparate(jobId)  → outcome { ok, cancelled, error, errorKind, labels, threads, ... }
//   cancelSeparate(jobId)                                       (fetch abort + worker terminate, resolves NOW)
//   getStemWav(jobId, i) → Blob                                 (.NET streams it as IJSStreamReference)
//   disposeJob(jobId)                                           (terminates the worker → frees ~900 MB)
//
// Division of labor: THIS thread decodes audio (OfflineAudioContext is main-thread API), acquires
// the model (OPFS cache → configurable URL, SHA-256 verified both ways), and narrates progress;
// stemWorker.js owns the ort session and the chunk loop so the UI stays live.
//
// Node-import safe: no browser globals at module scope; the cross-module imports (engineCommon,
// opfsStore) are dynamic at call time because their _content/ URLs only resolve when served.

import {
    estimateSecondsPerChunk, formatDuration, chunkStarts, classifyError, sha256Hex, STEM_LABELS,
    assessFeasibility, formatGb, SAMPLE_RATE, engineSpeedFactor,
    feasibleClipFrames, clipFramesFromSeconds, isIosClassDevice,
} from './stemSeparationCore.js';

const jobs = new Map();
let nextJobId = 1;

// Dev/ops escape hatch: point the model fetch somewhere else (local mirror, E2E server) without a
// rebuild. Kept in localStorage so it survives reloads; absent → the options default (HuggingFace).
// With two web engines (Phase 3) the key is per-engine ("<key>.<modelId>"); the plain legacy key
// keeps working ONLY for the engine it was documented against (§4b — the 6-source flagship,
// options.legacyModelUrlOverride): applied to any other engine it would point it at the WRONG
// file and fail its SHA check (review finding — a P1-era plain key silently broke the 4-source
// engine's download).
const MODEL_URL_OVERRIDE_KEY = 'masterycoach.stem-model-url';

// User escape hatch for the device gate (Phase 3, ladder step 4): any non-empty value suppresses
// the "unverified on this device" advisory — set it for the plan-mandated physical iPhone
// measurement run (§4e), or after deciding the risk is acceptable on a given device.
const DEVICE_FORCE_KEY = 'masterycoach.stem-web-force';

/// The pre-split device warning for this browser, or null when none applies (or the user set the
/// force key). Surfaced by the Studio in the split prompt via ISeparationDeviceAdvisory — a
/// WARNING, not a block: separation on iOS/iPadOS is untested hardware territory (the §2 physical
/// gate), not known-broken.
export function deviceAdvisory() {
    try { if (localStorage.getItem(DEVICE_FORCE_KEY)) return null; } catch { }
    return isIosClassDevice(navigator.userAgent, navigator.platform, navigator.maxTouchPoints)
        ? 'Stem separation is unverified on this device — it may run out of memory. Shorter songs are safer.'
        : null;
}

export async function beginSeparate(audioStreamRef, options, dotnetCb) {
    // Pull the song bytes NOW — the DotNetStreamReference is disposed when this call returns.
    const { readStreamRefBytes } = await import(new URL('../_content/MasteryCoach.UI/js/engineCommon.js', import.meta.url));
    const audioBytes = await readStreamRefBytes(audioStreamRef);

    const job = {
        id: nextJobId++,
        cancelled: false,
        abort: new AbortController(),
        worker: null,
        wavs: null,
        cb: dotnetCb,
        options,
        resolveDone: null,
    };
    job.done = new Promise((resolve) => { job.resolveDone = resolve; });
    jobs.set(job.id, job);

    // Fire and return — the .NET side awaits waitSeparate(jobId) so it can cancel concurrently.
    runJob(job, audioBytes).catch((err) => {
        finishJob(job, job.cancelled
            ? { ok: false, cancelled: true }
            : {
                ok: false,
                error: (err && (err.message || String(err))),
                errorKind: jsErrorKind(err),
                // Ladder step 2: an infeasible refusal may carry the bounded-clip counter-offer.
                feasibleClipSeconds: (err && err.feasibleClipSeconds) || 0,
            });
    });
    return job.id;
}

export function waitSeparate(jobId) {
    const job = jobs.get(jobId);
    if (!job) throw new Error(`no such separation job ${jobId}`);
    return job.done;
}

export function cancelSeparate(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    job.cancelled = true;
    try { job.abort.abort(); } catch { }
    // Resolve the outcome NOW instead of waiting for the worker's next chunk boundary (7–25 s
    // mid-chunk, ~21 s mid-session-init — review finding: pressing Cancel left the UI "splitting"
    // that whole time). The worker holds nothing the main thread still needs on a cancel, so
    // finishJob terminates it outright (freeing the ort heap immediately) and the .NET side
    // unwinds at once. Phases that run before a worker exists (decode, model download/hash) check
    // job.cancelled at their next await boundary; finishJob is idempotent, so their late calls
    // are no-ops.
    finishJob(job, { ok: false, cancelled: true });
}

export function getStemWav(jobId, index) {
    const job = jobs.get(jobId);
    if (!job || !job.wavs || !job.wavs[index]) throw new Error(`no stem ${index} for job ${jobId}`);
    // The Blob snapshots the bytes (File API semantics), so drop our reference immediately: the
    // save loop reads each stem exactly once, and releasing as we go keeps the sustained JS heap
    // at ONE stem's WAV (~53 MB for a 5-minute song) instead of all six (~320 MB) while .NET
    // streams them out (review finding).
    const blob = new Blob([job.wavs[index]], { type: 'audio/wav' });
    job.wavs[index] = null;
    return blob;
}

export function disposeJob(jobId) {
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.worker) {
        try { job.worker.terminate(); } catch { }
        job.worker = null;
    }
    job.wavs = null;
    jobs.delete(jobId);
}

// ---------------------------------------------------------------------------------------------

/// Job-level error classification on top of core's classifyError: the wrapper knows the phases
/// (model acquisition, fetch abort, decode) that core's message-text heuristic can't. Exported for
/// the Node unit tests.
export function jsErrorKind(err) {
    if (err && err.infeasible) return 'infeasible';
    if (err && err.modelUnavailable) return 'model';
    if (err && (err.name === 'AbortError')) return 'cancelled';
    if (err && err.name === 'EncodingError') return 'input';
    return classifyError(err);
}

async function runJob(job, audioBytes) {
    const report = (fraction, detail) => {
        // Gate + observe: once the job is finished (cancelSeparate resolves it immediately), the
        // .NET side unwinds and disposes the progress sink — a fire-and-forget invokeMethodAsync
        // would then REJECT asynchronously, which the sync try/catch can't see, and the
        // window.unhandledrejection funnel would paint the error bar (the known
        // disposed-DotNetObjectReference class). Skip once finished, and swallow the promise so a
        // straggler can never surface.
        if (job.cancelled || !job.resolveDone) return;
        try {
            const p = job.cb.invokeMethodAsync('Report', fraction, detail ?? null);
            if (p && typeof p.catch === 'function') p.catch(() => { });
        } catch { }
    };

    // --- 1. Decode at EXACTLY 44.1 kHz --------------------------------------------------------
    // OfflineAudioContext pinned to the model's rate: decodeAudioData resamples to the CONTEXT
    // rate, so decoding at the device rate (48 k) would feed the model off-pitch audio — the
    // proven resample-corruption bug class in this repo. Never decode at ctx-rate here.
    report(0.01, 'Preparing audio…');
    const decodeCtx = new OfflineAudioContext(2, 44100, 44100);
    const audioBuf = await new Promise((resolve, reject) => {
        // Callback form: Safari's OfflineAudioContext.decodeAudioData promise support lagged.
        decodeCtx.decodeAudioData(audioBytes, resolve, (e) => reject(e || new Error('decodeAudioData failed')));
    });
    const songFrames = audioBuf.length;
    if (!songFrames) {
        const err = new Error('Stem separation input contains no audio samples.');
        err.name = 'EncodingError';
        throw err;
    }

    // --- 1a. Bounded-clip mode (Phase 3, fallback ladder step 2) -------------------------------
    // A retry accepted from a refusal's counter-offer: split only the song's opening clipSeconds,
    // aligned DOWN to the chunk grid so the excerpt's chunks sit exactly where a full-song run
    // would put them. The stems come out shorter than the song — the Studio labels them partial.
    const stemLabels = job.options.stemLabels || STEM_LABELS;
    const spec = {
        stemCount: stemLabels.length,
        ortHeapBytes: job.options.ortHeapBytes,
        modelBufferBytes: job.options.modelBufferBytes,
    };
    let totalFrames = songFrames;
    if (job.options.clipSeconds > 0) {
        const clipFrames = clipFramesFromSeconds(job.options.clipSeconds);
        if (clipFrames > 0 && clipFrames < songFrames) totalFrames = clipFrames;
    }
    job.clippedSeconds = totalFrames < songFrames ? totalFrames / SAMPLE_RATE : 0;

    // Copy out (transferring getChannelData's live buffer would detach the AudioBuffer's guts).
    const left = audioBuf.getChannelData(0).slice(0, totalFrames);
    const right = (audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : audioBuf.getChannelData(0)).slice(0, totalFrames);
    if (job.cancelled) { finishJob(job, { ok: false, cancelled: true }); return; }

    // --- 1b. Proactive memory guard (Phase 2) --------------------------------------------------
    // Refuse a run that projects past what this device can give the tab, BEFORE the 136 MB model
    // download and the ~900 MB worker spin-up — dying mid-run was the Phase 1 behavior, kept only
    // as the reactive backstop (classifyError → 'memory') for what the projection can't foresee.
    // A bounded retry re-runs the same guard against its shorter frame count.
    const feasibility = assessFeasibility(totalFrames, navigator.deviceMemory, spec);
    job.projectedGb = formatGb(feasibility.projectedBytes);
    if (!feasibility.feasible) {
        const minutes = Math.round(totalFrames / SAMPLE_RATE / 60);
        const basis = feasibility.basis === 'deviceMemory'
            ? `this device reports ${navigator.deviceMemory} GB of memory, of which a browser tab can realistically use ~${formatGb(feasibility.budgetBytes)}`
            : `a browser tab tops out near ${formatGb(feasibility.budgetBytes)}`;
        // Ladder step 2: before refusing outright, work out whether a grid-aligned opening excerpt
        // WOULD fit — if so the refusal carries the counter-offer and the Studio turns it into a
        // "Split the first m:ss instead" choice rather than a dead end.
        const offerFrames = feasibleClipFrames(feasibility.budgetBytes, totalFrames, spec);
        const err = offerFrames > 0
            ? new Error(
                `Splitting this ${minutes >= 1 ? `${minutes}-minute ` : ''}song needs roughly ${job.projectedGb} of browser memory, but ${basis}.`)
            : new Error(
                `Splitting this ${minutes >= 1 ? `${minutes}-minute ` : ''}song needs roughly ${job.projectedGb} of browser memory, but ${basis}. ` +
                'Stem separation is not supported for this song on this device — try a shorter song, or split it on a desktop browser ' +
                'or the Windows app and bring the stems over with library export/import.');
        err.infeasible = true;
        if (offerFrames > 0) err.feasibleClipSeconds = offerFrames / SAMPLE_RATE;
        throw err;
    }

    // --- 2. Model: OPFS cache, else download + verify + cache ---------------------------------
    const model = await ensureModel(job, report);
    if (job.cancelled) { finishJob(job, { ok: false, cancelled: true }); return; }

    // --- 3. Threads: SharedArrayBuffer (crossOriginIsolated) unlocks wasm threads -------------
    const isolated = !!globalThis.crossOriginIsolated;
    const threads = isolated ? Math.min(navigator.hardwareConcurrency || 1, job.options.maxThreads || 8) : 1;
    job.threads = threads;
    const chunkCount = chunkStarts(totalFrames).length;
    const estimate = formatDuration(
        (chunkCount * estimateSecondsPerChunk(threads) + 21) * engineSpeedFactor(navigator.userAgent));
    // A bounded run says so up front — the stems will cover only the song's opening.
    const clipNote = job.clippedSeconds > 0 ? ` · first ${formatDuration(job.clippedSeconds)} of the song only` : '';
    report(0.10, isolated
        ? `Loading model — ${threads} threads, ≈${estimate} · ~${job.projectedGb} peak memory expected${clipNote}…`
        : `Loading model — single-threaded (no cross-origin isolation), ≈${estimate} · ~${job.projectedGb} peak memory expected${clipNote}…`);

    // --- 4. Inference in the worker ------------------------------------------------------------
    const worker = new Worker(new URL('./stemWorker.js', import.meta.url), { type: 'module' });
    job.worker = worker;
    const inferenceStart = performance.now();

    // Mobile guardrails (2026-07-31, operator report: "stops processing abruptly, no error").
    // (a) Screen wake lock: a phone dimming mid-run suspends the tab and silently freezes the
    //     worker. Hold the lock for the run; re-acquire on visibility return (the OS drops it
    //     whenever the tab hides). Best-effort - engines without the API just skip it.
    const acquireWakeLock = async () => {
        try { job.wakeLock = await navigator.wakeLock?.request('screen'); } catch { }
    };
    acquireWakeLock();
    // (b) Stall watchdog: when iOS kills this worker for memory it often fires NO error event -
    //     the job froze at its last chunk forever. Silence beyond any plausible chunk time turns
    //     into an honest memory-kind failure through the normal path. The threshold is deliberately
    //     huge (5 min; worst measured single-thread chunk ~26 s on Chromium, Safari unmeasured),
    //     and activity resets on every worker message AND on visibility return, so a tab that was
    //     suspended (timers frozen with it) gets a full fresh window to resume before judgment.
    job.lastWorkerActivity = performance.now();
    job.onVisible = () => {
        if (document.visibilityState === 'visible') {
            job.lastWorkerActivity = performance.now();
            acquireWakeLock();
        }
    };
    document.addEventListener('visibilitychange', job.onVisible);
    const STALL_LIMIT_MS = 5 * 60 * 1000;
    job.stallTimer = setInterval(() => {
        if (!job.worker || job.cancelled) return;
        if (document.visibilityState !== 'visible') return; // suspended tabs are judged on return
        if (performance.now() - job.lastWorkerActivity > STALL_LIMIT_MS) {
            finishJob(job, {
                ok: false,
                error: 'Separation stopped responding - this device most likely ran out of memory '
                    + 'mid-run. Try the 4-source model, a shorter clip, or split on a desktop and '
                    + 'bring the stems over with library export/import.',
                errorKind: 'memory',
            });
        }
    }, 30 * 1000);

    worker.onerror = (e) => {
        finishJob(job, { ok: false, error: `separation worker failed: ${(e && e.message) || 'load error'}`, errorKind: 'runtime' });
    };
    worker.onmessage = (e) => {
        job.lastWorkerActivity = performance.now();
        const msg = e.data;
        if (msg.type === 'status' && msg.stage === 'sessionReady') {
            report(0.14, `Model ready (${(msg.ms / 1000).toFixed(0)} s) — separating ${chunkCount} chunks…`);
        } else if (msg.type === 'chunk') {
            const elapsed = (performance.now() - inferenceStart) / 1000;
            const meanChunkSec = elapsed / msg.index; // includes session init amortized — honest ETA
            const remaining = meanChunkSec * (msg.count - msg.index);
            report(
                0.14 + 0.83 * (msg.flushedFrames / msg.totalFrames),
                `Chunk ${msg.index}/${msg.count} · ${formatDuration(elapsed)} elapsed · ~${formatDuration(remaining)} left` +
                (threads > 1 ? ` · ${threads} threads` : ' · single-threaded'));
        } else if (msg.type === 'done') {
            job.wavs = msg.wavs;
            report(0.97, 'Saving stems…');
            finishJob(job, {
                ok: true,
                cancelled: false,
                labels: msg.labels,
                threads,
                chunkCount: msg.chunkCount,
                meanChunkMs: msg.meanChunkMs,
                elapsedMs: msg.elapsedMs,
            });
        } else if (msg.type === 'error') {
            finishJob(job, { ok: false, error: msg.message, errorKind: msg.kind });
        }
    };

    worker.postMessage(
        { type: 'run', model, left: left.buffer, right: right.buffer, frames: totalFrames, threads, labels: stemLabels },
        [model, left.buffer, right.buffer]);
}

function finishJob(job, outcome) {
    if (job.stallTimer) { clearInterval(job.stallTimer); job.stallTimer = null; }
    if (job.onVisible) { document.removeEventListener('visibilitychange', job.onVisible); job.onVisible = null; }
    if (job.wakeLock) { try { job.wakeLock.release(); } catch { } job.wakeLock = null; }
    if (job.worker) {
        // Free the ~900 MB ort heap the moment the outcome is known — success included (review
        // finding: keeping the worker until disposeJob held that heap through the whole
        // save-stems phase, exactly when the main thread is at ITS memory peak). Safe on success
        // too: the stem WAVs arrived TRANSFERRED with the 'done' message, so nothing of theirs
        // still lives in the worker.
        try { job.worker.terminate(); } catch { }
        job.worker = null;
    }
    if (job.resolveDone) {
        job.resolveDone({
            ok: false, cancelled: false, error: null, errorKind: null,
            labels: outcome.ok ? ((job.options && job.options.stemLabels) || STEM_LABELS) : null,
            threads: job.threads || 0,
            chunkCount: 0, meanChunkMs: 0, elapsedMs: 0, feasibleClipSeconds: 0,
            clippedSeconds: job.clippedSeconds || 0,
            ...outcome,
        });
        job.resolveDone = null;
    }
}

// Model acquisition: OPFS cache OUTSIDE data/library (so library exports never ship 136 MB), else
// download from the configured URL. SHA-256 verified on BOTH paths — a cached file that fails the
// hash is discarded and re-fetched once.
async function ensureModel(job, report) {
    const options = job.options;
    const cachePath = options.modelCachePath;
    const expectedSha = (options.expectedSha256 || '').toLowerCase();

    let opfs = null;
    try {
        if (navigator.storage && navigator.storage.getDirectory) {
            opfs = await import(new URL('../_content/MasteryCoach.UI/js/opfsStore.js', import.meta.url));
        }
    } catch { opfs = null; /* no OPFS → no cache; the download still works */ }

    // Cached?
    if (opfs) {
        try {
            const cached = await opfs.readFile(cachePath);
            if (cached) {
                report(0.04, 'Loading cached model…');
                const buf = await cached.arrayBuffer();
                if ((await sha256Hex(buf)) === expectedSha) {
                    report(0.09, 'Model ready from cache.');
                    return buf;
                }
                await opfs.deleteEntry(cachePath, false); // corrupt/stale — refetch below
            }
        } catch { /* treat any cache failure as a miss */ }
    }

    // Download (abortable; progress by bytes). Per-engine override key first; the legacy plain
    // key only for the engine it historically named (two web engines can't share one URL — the
    // SHA check pins each to its own model, so the plain key must never leak onto the other).
    let url = options.modelUrl;
    try {
        const override = (options.modelId && localStorage.getItem(`${MODEL_URL_OVERRIDE_KEY}.${options.modelId}`))
            || (options.legacyModelUrlOverride ? localStorage.getItem(MODEL_URL_OVERRIDE_KEY) : null);
        if (override) url = override;
    } catch { }

    const sizeMb = Math.round((options.expectedBytes || 0) / 1048576);
    report(0.04, `Downloading separation model (${sizeMb} MB)…`);
    let resp;
    try {
        resp = await fetch(url, { signal: job.abort.signal, mode: 'cors' });
    } catch (err) {
        if (job.cancelled) throw err;
        throw modelError(`the model download failed (${(err && err.message) || err}). Check the connection and try again.`);
    }
    if (!resp.ok) {
        throw modelError(`the model isn't available right now (HTTP ${resp.status} from the model host).`);
    }

    const totalBytes = Number(resp.headers.get('Content-Length')) || options.expectedBytes || 0;
    const reader = resp.body.getReader();
    const parts = [];
    let received = 0;
    let lastPct = -1;
    for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.byteLength;
        // Clamped: a gzip-transferring host reports the COMPRESSED length, so raw bytes/total
        // can pass 100% — never narrate more than that.
        const pct = totalBytes ? Math.min(100, Math.floor((received / totalBytes) * 100)) : 0;
        if (pct !== lastPct) {
            lastPct = pct;
            report(0.04 + 0.04 * Math.min(1, totalBytes ? received / totalBytes : 0),
                `Downloading separation model (${sizeMb} MB)… ${pct}%`);
        }
    }
    const model = new Uint8Array(received);
    {
        let offset = 0;
        for (const p of parts) { model.set(p, offset); offset += p.byteLength; }
        parts.length = 0;
    }

    report(0.085, 'Verifying model…');
    if ((await sha256Hex(model.buffer)) !== expectedSha) {
        throw modelError('the downloaded model failed its integrity check (SHA-256 mismatch) — it will not be used.');
    }

    // Cache for next time (write-through the shared OPFS worker; Blob → the module copies, so the
    // in-memory model stays usable). A quota failure only costs the NEXT run a re-download.
    if (opfs) {
        try {
            report(0.09, 'Caching model for next time…');
            await opfs.writeFile(cachePath, new Blob([model.buffer]));
        } catch (err) {
            try { console.warn('[stemSeparation] model cache write failed:', err); } catch { }
        }
    }

    return model.buffer;
}

function modelError(message) {
    const err = new Error(message);
    err.modelUnavailable = true;
    return err;
}
