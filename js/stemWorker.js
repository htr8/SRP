// stemWorker.js — the inference half of the in-browser stem separator (Tier 3 Phase 1). A module
// worker so the 21 s session init and the ~7 s-per-chunk model runs never block the UI thread
// (StemSeparationPlan.md §4b). Spawned per job by stemSeparation.js and terminated the moment the
// job finishes (or is cancelled — the main thread terminates rather than signalling, so there is
// no in-worker cancellation path), which frees the ~900 MB ort wasm heap deterministically.
//
// The session options are LAW from the 2026-07-12 spike: ort-web's IN-BROWSER graph optimizer
// blows the wasm32 4 GB cap constant-folding this 24,819-node graph, so optimization MUST stay
// 'disabled' (and the model must be the original 136 MB export, never a pre-optimized graph).
import * as ort from '../lib/ort/ort.wasm.min.mjs';
import {
    SAMPLE_RATE, SEGMENT_SAMPLES, STEM_LABELS, OverlapAddWriter, chunkStarts, classifyError,
} from './stemSeparationCore.js';

self.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'run') {
        run(msg).catch((err) => {
            self.postMessage({ type: 'error', message: (err && (err.message || String(err))), kind: classifyError(err) });
        });
    }
};

async function run(msg) {
    // Absolute wasmPaths (spike gotcha: relative URLs resolve against the ort MODULE's URL, which
    // differs between bundled and dev serving — compute from this worker's own URL instead).
    ort.env.wasm.wasmPaths = new URL('../lib/ort/', import.meta.url).href;
    ort.env.wasm.numThreads = msg.threads;
    ort.env.wasm.proxy = false; // we ARE the off-main thread; no second hop
    ort.env.logLevel = 'warning';

    const t0 = performance.now();
    const session = await ort.InferenceSession.create(new Uint8Array(msg.model), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'disabled', // LAW — see module header
        enableCpuMemArena: false,
        enableMemPattern: false,
        executionMode: 'sequential',
    });
    self.postMessage({ type: 'status', stage: 'sessionReady', ms: performance.now() - t0 });

    const left = new Float32Array(msg.left);
    const right = new Float32Array(msg.right);
    const totalFrames = msg.frames;
    // Stem layout comes with the job (Phase 3: 6-source and 4-source models share this worker) —
    // the model's "stems" output is [1, labels.length, 2, SEGMENT_SAMPLES] in label order.
    const labels = msg.labels || STEM_LABELS;
    const writer = new OverlapAddWriter(totalFrames, SAMPLE_RATE, labels.length);
    const starts = chunkStarts(totalFrames);
    const chunkMs = [];
    const inferenceStart = performance.now();

    for (let c = 0; c < starts.length; c++) {
        const chunkStart = starts[c];
        // A FRESH input per chunk (spike doctrine: ort can take ownership of/transfer the buffer;
        // 2.75 MB per chunk of GC churn is nothing next to a 7 s model run).
        const input = new Float32Array(2 * SEGMENT_SAMPLES);
        const copyLen = Math.min(SEGMENT_SAMPLES, totalFrames - chunkStart);
        input.set(left.subarray(chunkStart, chunkStart + copyLen), 0);
        input.set(right.subarray(chunkStart, chunkStart + copyLen), SEGMENT_SAMPLES);
        // (the remainder stays zero — the model contract's zero-padding)

        const t1 = performance.now();
        const res = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, SEGMENT_SAMPLES]) });
        const stems = await res.stems.getData();
        const ms = performance.now() - t1;
        chunkMs.push(ms);

        const flushedFrames = writer.addChunk(stems, chunkStart);
        if (res.stems.dispose) res.stems.dispose();

        self.postMessage({
            type: 'chunk',
            index: c + 1,
            count: starts.length,
            ms,
            flushedFrames,
            totalFrames,
        });
    }

    const buffers = writer.wavBuffers();
    self.postMessage({
        type: 'done',
        wavs: buffers,
        labels,
        chunkCount: starts.length,
        meanChunkMs: chunkMs.reduce((a, b) => a + b, 0) / Math.max(1, chunkMs.length),
        elapsedMs: performance.now() - inferenceStart,
    }, buffers);

    try { if (session.release) await session.release(); } catch { /* worker is terminated anyway */ }
}
