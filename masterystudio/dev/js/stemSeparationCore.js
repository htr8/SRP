// stemSeparationCore.js — pure logic for the in-browser stem separator (Tier 3 Phase 1,
// docs/08_Audio_Engine/StemSeparationPlan.md §4b). This module is the JS twin of the native
// WindowsOnnxDemucsSeparator's chunk/overlap-add contract, ported from the proven spike harness
// (prototypes/WebOnnxSeparationSpike/harness.mjs):
//
//   input  "mix"   float32 [1, 2, 343980]   (44.1 kHz stereo, ~7.8 s segment, zero-padded)
//   output "stems" float32 [1, 6, 2, 343980] (drums, bass, other, vocals, guitar, piano)
//   hop = 171990 (50% overlap), linear-ramp overlap-add with weight normalization.
//
// Node-import safe (tests/js/stem-separation-core.test.mjs): no browser/worker globals anywhere —
// this is pure math + buffer layout, shared by stemWorker.js (hot loops) and stemSeparation.js
// (estimates/format).

export const SAMPLE_RATE = 44100;
export const SEGMENT_SAMPLES = 343980;
export const STEP_SAMPLES = SEGMENT_SAMPLES / 2; // 171990
export const STEM_COUNT = 6;
export const CHANNEL_COUNT = 2;
export const PCM16_BYTES_PER_SAMPLE = 2;
export const STEM_LABELS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

/// Chunk start offsets for a song of `totalFrames` frames — one model run per entry.
/// Mirrors the native loop: for (start = 0; start < totalFrames; start += STEP).
export function chunkStarts(totalFrames) {
    const starts = [];
    for (let start = 0; start < totalFrames; start += STEP_SAMPLES) starts.push(start);
    return starts;
}

/// Faithful port of WindowsOnnxDemucsSeparator.WindowWeight: linear fade-in over the first half
/// (except the first chunk) and fade-out over the second half (except the last chunk), floored so
/// normalization never divides by zero.
export function windowWeight(i, chunkStart, totalFrames) {
    let w = 1.0;
    if (chunkStart > 0 && i < STEP_SAMPLES) w = Math.min(w, i / STEP_SAMPLES);
    if (chunkStart + STEP_SAMPLES < totalFrames && i >= STEP_SAMPLES) {
        w = Math.min(w, (SEGMENT_SAMPLES - i) / STEP_SAMPLES);
    }
    return Math.max(w, 0.000001);
}

/// Measured steady-state seconds per chunk from the 2026-07-12 spike (Core Ultra 7, wasm EP,
/// opt=disabled): 8 threads 7.2 s, 4 threads ~9.3 s, 1 thread ~25.5 s. Piecewise — only used for
/// the up-front duration estimate; the live ETA re-derives from actual chunk times.
export function estimateSecondsPerChunk(threads) {
    if (threads >= 8) return 7.2;
    if (threads >= 4) return 9.3;
    if (threads >= 2) return 14;
    return 25.5;
}

/// Engine speed factor for the up-front duration estimate (Tier 3 Phase 2 Firefox pass): the
/// per-chunk numbers above are Chromium-measured, but Gecko runs this graph ~6.3x slower at the
/// SAME thread count (measured 2026-07-12 via the production worker: 45.2 s vs 7.2 s per chunk at
/// 8 threads, 161.7 s vs 25.5 s at 1 — threads engage fine, the per-core wasm execution is just
/// slower). Without this the narrated estimate was ~6x optimistic on Firefox; the live ETA
/// self-corrects either way. Unrecognized engines (Safari…) stay at 1 — unmeasured.
export function engineSpeedFactor(userAgent) {
    return /\bFirefox\/\d/.test(userAgent || '') ? 6.3 : 1;
}

/// "m:ss" (or "h:mm:ss" past an hour) for status lines.
export function formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/// Clamp a normalized float sample into 16-bit PCM. Web splits are saved for playback/practice, not
/// further model input; 16-bit halves the end-of-job memory peak on phones versus float32 WAV.
export function floatToPcm16(sample) {
    const s = Math.max(-1, Math.min(1, sample || 0));
    return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

/// Allocate a complete 16-bit PCM stereo WAV: 44-byte header + interleaved int16 LE data. Returns
/// the buffer plus an Int16Array view over the data region so callers write samples with no final
/// copy; the header offset (44) is 2-byte aligned by construction.
export function allocPcm16StereoWav(frames, sampleRate) {
    const dataBytes = frames * CHANNEL_COUNT * PCM16_BYTES_PER_SAMPLE;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const ascii = (pos, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(pos + i, text.charCodeAt(i));
    };
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);                                // PCM
    view.setUint16(22, CHANNEL_COUNT, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * CHANNEL_COUNT * PCM16_BYTES_PER_SAMPLE, true);
    view.setUint16(32, CHANNEL_COUNT * PCM16_BYTES_PER_SAMPLE, true);
    view.setUint16(34, 16, true);
    ascii(36, 'data');
    view.setUint32(40, dataBytes, true);
    return { buffer, samples: new Int16Array(buffer, 44, frames * CHANNEL_COUNT) };
}

/// Streaming overlap-add straight into the stem WAVs (stemCount of them — 6 for htdemucs_6s,
/// 4 for htdemucs; Tier 3 Phase 3 parameterized the count for the 4-source engine). One instance
/// per job:
///   for each chunk: addChunk(flat stems tensor data, chunkStart)
/// and when the last chunk lands, `wavBuffers()` are complete files. Port of the native
/// AddChunk → FlushFrames → ShiftLeft cycle (same accumulator/weight window semantics), except
/// flushed frames land in the WAV sample views instead of NAudio writers.
export class OverlapAddWriter {
    constructor(totalFrames, sampleRate = SAMPLE_RATE, stemCount = STEM_COUNT) {
        this.totalFrames = totalFrames;
        this.stemCount = stemCount;
        this.flushedFrames = 0;
        this.wavs = Array.from({ length: stemCount }, () => allocPcm16StereoWav(totalFrames, sampleRate));
        // acc[stem][channel] — a rolling SEGMENT window, like the native accumulation buffers.
        this.acc = Array.from({ length: stemCount },
            () => [new Float32Array(SEGMENT_SAMPLES), new Float32Array(SEGMENT_SAMPLES)]);
        this.weights = new Float32Array(SEGMENT_SAMPLES);
    }

    /// stemsFlat: the "stems" output tensor's flat data, laid out [1, stemCount, 2, SEGMENT_SAMPLES].
    /// Returns the total frames flushed so far (monotonic; equals totalFrames after the last chunk).
    addChunk(stemsFlat, chunkStart) {
        const totalFrames = this.totalFrames;
        const stemCount = this.stemCount;

        // AddChunk: weighted accumulate over the window.
        for (let i = 0; i < SEGMENT_SAMPLES; i++) {
            if (chunkStart + i >= totalFrames) break;
            const w = windowWeight(i, chunkStart, totalFrames);
            this.weights[i] += w;
            for (let stem = 0; stem < stemCount; stem++) {
                this.acc[stem][0][i] += stemsFlat[(stem * 2 + 0) * SEGMENT_SAMPLES + i] * w;
                this.acc[stem][1][i] += stemsFlat[(stem * 2 + 1) * SEGMENT_SAMPLES + i] * w;
            }
        }

        // FlushFrames: the first STEP frames of the window are final once this chunk landed
        // (the next chunk starts at chunkStart + STEP) — normalize and write them out.
        const nextChunkStart = chunkStart + STEP_SAMPLES;
        const framesToFlush = Math.min(nextChunkStart, totalFrames) - chunkStart;
        for (let stem = 0; stem < stemCount; stem++) {
            const out = this.wavs[stem].samples;
            const accL = this.acc[stem][0], accR = this.acc[stem][1];
            let pos = this.flushedFrames * 2;
            for (let i = 0; i < framesToFlush; i++, pos += 2) {
                const w = this.weights[i] <= 0 ? 1 : this.weights[i];
                out[pos] = floatToPcm16(accL[i] / w);
                out[pos + 1] = floatToPcm16(accR[i] / w);
            }
        }
        this.flushedFrames += framesToFlush;

        // ShiftLeft: slide the window down by the flushed frames.
        const remaining = SEGMENT_SAMPLES - framesToFlush;
        this.weights.copyWithin(0, framesToFlush);
        this.weights.fill(0, remaining);
        for (let stem = 0; stem < stemCount; stem++) {
            for (let ch = 0; ch < 2; ch++) {
                this.acc[stem][ch].copyWithin(0, framesToFlush);
                this.acc[stem][ch].fill(0, remaining);
            }
        }

        return this.flushedFrames;
    }

    /// The stemCount finished WAV files (in the model's stem-label order), transferable ArrayBuffers.
    wavBuffers() {
        return this.wavs.map((w) => w.buffer);
    }
}

// --- Proactive memory guard (Tier 3 Phase 2, StemSeparationPlan.md §4c) ------------------------
// Refuse a split that is going to die of OOM BEFORE the 136 MB model download and the ~900 MB
// worker spin-up, instead of mid-run. The numbers are the §4b spike measurements, not guesses.

/// Measured flat ort-web wasm heap for this model with optimization disabled (§4b: 868 MB peak,
/// rounded up — it includes the copied-in weights).
export const ORT_HEAP_BYTES = 900 * 1048576;

/// The model's ArrayBuffer stays alive in the worker beside the ort heap for the whole run
/// (ort copies it into wasm memory at session create; JS-side GC of the source is not guaranteed).
export const MODEL_BUFFER_BYTES = 137 * 1048576;

/// wasm32-class ceiling: independent of how much RAM the device has, a single tab cannot hold a
/// multi-GB working set reliably (the ort heap lives inside a 4 GiB wasm32 address space, and V8
/// per-allocation limits bite near there too). Anything projected past this is refused outright.
export const ABSOLUTE_CEILING_BYTES = 4 * 1024 * 1024 * 1024;

/// Fraction of reported device RAM a background-heavy tab can realistically claim: OS + browser +
/// the Blazor runtime already own the rest. Heuristic, deliberately conservative only below 8 GB
/// (navigator.deviceMemory caps its report at 8, where the budget meets the absolute ceiling).
export const DEVICE_MEMORY_BUDGET_FRACTION = 0.5;

/// Per-model memory-projection inputs (Tier 3 Phase 3: the 4-source engine has fewer stems and a
/// bigger weights file, so the math takes a spec instead of assuming htdemucs_6s). Callers that
/// pass nothing get the original 6-source numbers — the Phase 2 behavior, bit for bit.
export const DEFAULT_MODEL_SPEC = Object.freeze({
    stemCount: STEM_COUNT,
    ortHeapBytes: ORT_HEAP_BYTES,
    modelBufferBytes: MODEL_BUFFER_BYTES,
});

/// Normalize a (possibly partial) spec against the 6-source defaults.
function modelSpec(spec) {
    return {
        stemCount: (spec && spec.stemCount) || DEFAULT_MODEL_SPEC.stemCount,
        ortHeapBytes: (spec && spec.ortHeapBytes) || DEFAULT_MODEL_SPEC.ortHeapBytes,
        modelBufferBytes: (spec && spec.modelBufferBytes) || DEFAULT_MODEL_SPEC.modelBufferBytes,
    };
}

/// Projected peak bytes for a song of `totalFrames` frames — the WORKER's peak near the end of the
/// run, which is the high-water mark of the whole pipeline: ort heap + model buffer + transferred
/// input (L+R float32) + all finished 16-bit stereo stem WAVs (~53 MB/stem for a 5-min song)
/// + the rolling overlap-add accumulators.
export function projectedPeakBytes(totalFrames, spec) {
    const { stemCount, ortHeapBytes, modelBufferBytes } = modelSpec(spec);
    const inputBytes = totalFrames * CHANNEL_COUNT * 4;
    const stemWavBytes = stemCount * (44 + totalFrames * CHANNEL_COUNT * PCM16_BYTES_PER_SAMPLE);
    const accumulatorBytes = (stemCount * CHANNEL_COUNT + 1) * SEGMENT_SAMPLES * 4;
    return ortHeapBytes + modelBufferBytes + inputBytes + stemWavBytes + accumulatorBytes;
}

/// Feasibility verdict for a song, given `navigator.deviceMemory` (GB; undefined outside
/// Chromium — then only the absolute ceiling applies and the reactive OOM classifier stays the
/// backstop). Returns { projectedBytes, budgetBytes, basis: 'ceiling'|'deviceMemory', feasible }.
export function assessFeasibility(totalFrames, deviceMemoryGb, spec) {
    const projectedBytes = projectedPeakBytes(totalFrames, spec);
    let budgetBytes = ABSOLUTE_CEILING_BYTES;
    let basis = 'ceiling';
    if (typeof deviceMemoryGb === 'number' && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0) {
        const deviceBudget = deviceMemoryGb * DEVICE_MEMORY_BUDGET_FRACTION * 1073741824;
        if (deviceBudget < budgetBytes) {
            budgetBytes = deviceBudget;
            basis = 'deviceMemory';
        }
    }
    return { projectedBytes, budgetBytes, basis, feasible: projectedBytes <= budgetBytes };
}

// --- Bounded-clip fallback (Tier 3 Phase 3, fallback ladder step 2) -----------------------------
// When the full song is refused, the same math run BACKWARD says how much song WOULD fit: invert
// projectedPeakBytes for frames, align down to the chunk grid, and offer that excerpt instead of a
// flat refusal (StemSeparationPlan.md §1 "shorter-clip / chunked processing").

/// A practice excerpt shorter than this isn't worth offering (one chunk is only 7.8 s; a usable
/// riff-practice loop needs a real opening stretch of the song).
export const MIN_CLIP_SECONDS = 30;

/// The largest `totalFrames` for which projectedPeakBytes(frames, spec) <= budgetBytes — exact
/// algebraic inversion (the projection is affine in frames), clamped at 0 when even the fixed
/// costs (ort heap + model buffer) don't fit.
export function maxFeasibleFrames(budgetBytes, spec) {
    const { stemCount, ortHeapBytes, modelBufferBytes } = modelSpec(spec);
    const fixedBytes = ortHeapBytes + modelBufferBytes
        + stemCount * 44
        + (stemCount * CHANNEL_COUNT + 1) * SEGMENT_SAMPLES * 4;
    const perFrameBytes = CHANNEL_COUNT * 4 + stemCount * CHANNEL_COUNT * PCM16_BYTES_PER_SAMPLE;
    return Math.max(0, Math.floor((budgetBytes - fixedBytes) / perFrameBytes));
}

/// Align a frame count DOWN to the chunk grid (whole hops), so a bounded excerpt's chunks land on
/// exactly the same grid positions a full-song run would use (the P2 A/B excerpt technique).
export function alignedClipFrames(frames) {
    return Math.floor(frames / STEP_SAMPLES) * STEP_SAMPLES;
}

/// Frames for a clip bound that crossed the C# seam in SECONDS (the offer went out as
/// frames / SAMPLE_RATE; the accept comes back through TimeSpan). Round to the nearest frame
/// BEFORE grid alignment: the double round-trip (and TimeSpan's sub-millisecond rounding) can land
/// a hair BELOW the exact k·STEP the offer named, and flooring that first re-read it as
/// k·STEP − 1 — which alignedClipFrames then dropped to k−1 hops, splitting a whole 3.9 s hop
/// LESS than the user accepted (review finding: 27 of 193 realistic offer sizes came back short).
/// The seam's error is bounded well under half a hop, so nearest-frame rounding restores the
/// exact offered grid point; the feasibility guard re-checks the result regardless.
export function clipFramesFromSeconds(clipSeconds) {
    return alignedClipFrames(Math.round(clipSeconds * SAMPLE_RATE));
}

/// The clip (in frames) to OFFER when a song of `totalFrames` was refused under `budgetBytes`:
/// grid-aligned, at least MIN_CLIP_SECONDS, and strictly shorter than the song (a clip the length
/// of the song means the song was feasible — no offer). 0 = nothing worth offering.
export function feasibleClipFrames(budgetBytes, totalFrames, spec) {
    const aligned = alignedClipFrames(maxFeasibleFrames(budgetBytes, spec));
    if (aligned < MIN_CLIP_SECONDS * SAMPLE_RATE || aligned >= totalFrames) return 0;
    return aligned;
}

// --- Device gating (Tier 3 Phase 3, fallback ladder step 4) -------------------------------------

/// iOS/iPadOS detection — THE one place the app decides "this is the device class where separation
/// is still physically untested" (StemSeparationPlan.md §2: no iPhone support claim without a
/// physical-device run; until that gate passes these devices get a WARNING, not a block).
/// iPadOS 13+ masquerades as macOS ("MacIntel" platform, desktop Safari UA) — the multi-touch
/// check catches it; real Macs report maxTouchPoints 0 (or 1 on some touch-bar models).
export function isIosClassDevice(userAgent, platform, maxTouchPoints) {
    if (/\b(iPhone|iPad|iPod)\b/.test(userAgent || '')) return true;
    if (/^(iPhone|iPad|iPod)/.test(platform || '')) return true;
    return platform === 'MacIntel' && (maxTouchPoints || 0) > 1;
}

/// "1.8 GB" — narration/refusal formatting for byte counts.
export function formatGb(bytes) {
    return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/// SHA-256 of a buffer as lowercase hex (WebCrypto — present in browsers, workers, and Node 18+).
export async function sha256Hex(buffer) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// Classify a failure for the .NET side's user-facing message: 'memory' failures get the plan's
/// "not supported on this device" treatment instead of a raw bad_alloc string.
export function classifyError(err) {
    const text = `${err && err.name}: ${err && (err.message || String(err))}`;
    // \bOOM\b, not bare OOM: unanchored it matches any word CONTAINING "oom" case-insensitively
    // ("zoom", "boom"…) and would tell the user an ordinary runtime error was their device
    // running out of memory (unit-test finding).
    if (/bad_alloc|out of memory|allocation failed|RangeError|Aborted\(|\bOOM\b|memory access out of bounds/i.test(text)) {
        return 'memory';
    }
    return 'runtime';
}
