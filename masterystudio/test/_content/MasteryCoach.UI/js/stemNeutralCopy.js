// Pure copy-window math for the stem player's NEUTRAL pass-through (StemNeutralBypassPlan.md).
//
// At neutral settings (tempo 100%, pitch 0) the Signalsmith stretch worklet still runs the phase
// vocoder over the stored PCM, whose cold STFT warm-up is the audible first-~10s "warble". The fix
// plays the stored PCM straight through instead. THIS module is the pure, Node-testable statement of
// the sample-copy the worklet does in that neutral branch: given the stored audio buffers and the
// desired input position, produce the `outputBlockSize`-long output slice, zero-filled outside the
// stored PCM.
//
// IMPORTANT (CV-4): the vendored worklet is stringified into a Blob URL and cannot import this file,
// so `SignalsmithStretch.js` carries a HAND-INLINED copy of `fillNeutralBlock`. Keep the two in sync —
// this file exists so the math is unit-tested (tests/js/stem-neutral-copy.test.mjs); the worklet is
// where it actually runs. Any change here must be mirrored there, and vice versa.

// Copy the window [inputSamplesEnd - outputBlockSize, inputSamplesEnd) of the stored PCM into
// `outChannels` (an array of `outputBlockSize`-long Float32Arrays), zero-filling any part of the
// window that falls before the first stored sample or after the last. Mirrors the worklet's
// stored-buffer traversal (SignalsmithStretch.js `process()`), but emits exactly one output block
// (CV-2) with NO input-latency offset (CV-3 — the caller passes the raw inputSamplesEnd).
//
//   audioBuffers      list of segments; each segment is an array of channel Float32Arrays. Our stem
//                     player uses exactly one segment (a single addBuffers), but the traversal handles
//                     the general list the way the worklet does.
//   audioBuffersStart sample index of the first stored sample (0 in our single-segment layout).
//   inputSamplesEnd   sample index one past the last sample to emit (== round(inputTime*sampleRate)).
//   outChannels       destination Float32Arrays, all of length outputBlockSize; written in place.
//
// Channel fold matches the worklet: output channel c reads segment channel `c % segment.length`, so a
// mono segment feeds both output channels and a stereo pair maps straight through.
export function fillNeutralBlock(audioBuffers, audioBuffersStart, inputSamplesEnd, outChannels) {
    const outputBlockSize = outChannels.length ? outChannels[0].length : 0;
    if (outputBlockSize === 0) return;

    // The absolute sample index of the FIRST output sample in this block.
    const windowStart = inputSamplesEnd - outputBlockSize;

    // Start clean: everything is silence until proven otherwise (before the PCM, in a gap, past EOF).
    for (const ch of outChannels) ch.fill(0);

    // Walk the segments, copying the overlap of each with [windowStart, inputSamplesEnd) into the
    // right offset of the output. `segStart` tracks the absolute index of each segment's first sample.
    let segStart = audioBuffersStart;
    for (let s = 0; s < audioBuffers.length; s++) {
        const segment = audioBuffers[s];
        const segLen = segment[0] ? segment[0].length : 0;
        const segEnd = segStart + segLen;

        // Overlap of this segment with the output window, in absolute sample indices.
        const copyFrom = Math.max(windowStart, segStart);
        const copyTo = Math.min(inputSamplesEnd, segEnd);
        if (copyTo > copyFrom) {
            const outOffset = copyFrom - windowStart;   // where in the output block this lands
            const inOffset = copyFrom - segStart;        // where in the segment we read from
            const count = copyTo - copyFrom;
            for (let c = 0; c < outChannels.length; c++) {
                const srcChannel = segment[c % segment.length];
                outChannels[c].set(srcChannel.subarray(inOffset, inOffset + count), outOffset);
            }
        }
        segStart = segEnd;
        if (segStart >= inputSamplesEnd) break; // remaining segments are entirely past the window
    }
}
