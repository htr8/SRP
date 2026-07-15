// AudioWorklet granular pitch-shifter. Own implementation, no external dependencies.
//
// Technique: overlap-add granular resampling. Each channel keeps a ring buffer of recent input and
// is read at a rate of 2^(semitones/12). FOUR overlapping grains (75% overlap) with a Hann window
// cross-fade to hide grain-boundary discontinuities — markedly less amplitude modulation and comb
// artifact than the previous 2-grain/50% version. Channels are processed independently, so stereo
// is preserved (the old version dropped every channel but the first).
//
// This shifts pitch WITHOUT changing tempo (tempo is handled separately). It remains the FALLBACK
// path; the primary tempo+pitch engine is Signalsmith Stretch (see AudioStretchQuality.md).

const GRAIN = 2048;            // grain size in samples
const GRAIN_COUNT = 4;         // simultaneous grains
const STEP = GRAIN / GRAIN_COUNT; // 75% overlap

function hann(i, n) {
    return 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
}

class PitchShiftProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._ratio = 1;      // 2^(semitones/12)
        this._channels = [];  // one ring buffer per channel
        this._writePos = 0;
        this._readPos = 0;
        this._grainPos = 0;
        // Preallocated per-render scratch + Hann table: the render callback must not allocate
        // or call Math.cos per sample — GC pauses on the audio thread cause audible dropouts.
        this._weights = new Float64Array(GRAIN_COUNT);
        this._positions = new Float64Array(GRAIN_COUNT);
        this._hann = new Float32Array(GRAIN);
        for (let i = 0; i < GRAIN; i++) this._hann[i] = hann(i, GRAIN);
        this.port.onmessage = (e) => {
            if (e.data && typeof e.data.ratio === 'number') {
                this._ratio = e.data.ratio > 0 ? e.data.ratio : 1;
            }
        };
    }

    _ensureChannels(count) {
        while (this._channels.length < count) {
            this._channels.push(new Float32Array(GRAIN * 4));
        }
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || input.length === 0) return true;

        const channelCount = Math.min(input.length, output.length) || input.length;
        this._ensureChannels(channelCount);
        const n = input[0].length;
        const size = this._channels[0].length;

        // Write incoming samples into each channel's ring buffer (shared write cursor).
        for (let c = 0; c < channelCount; c++) {
            const src = input[c];
            const buf = this._channels[c];
            let w = this._writePos;
            for (let i = 0; i < n; i++) {
                buf[w] = src[i];
                w = (w + 1) % size;
            }
        }
        this._writePos = (this._writePos + n) % size;

        // Pass-through when no shift (ratio == 1) to avoid any granular artifacts.
        if (Math.abs(this._ratio - 1) < 1e-4) {
            for (let c = 0; c < output.length; c++) {
                output[c].set(input[Math.min(c, input.length - 1)]);
            }
            // Keep read position tracking so switching back in is seamless.
            this._readPos = this._writePos;
            this._grainPos = 0;
            return true;
        }

        const weights = this._weights;
        const positions = this._positions;
        const hannTable = this._hann;
        for (let i = 0; i < n; i++) {
            // GRAIN_COUNT grains offset by STEP, cross-faded with Hann windows (table lookup —
            // no allocation or trig inside the render loop).
            let weightSum = 0;
            for (let g = 0; g < GRAIN_COUNT; g++) {
                const p = (this._grainPos + g * STEP) % GRAIN;
                const w = hannTable[p];
                positions[g] = this._readPos + p * this._ratio;
                weights[g] = w;
                weightSum += w;
            }
            const denom = weightSum || 1;

            for (let c = 0; c < channelCount; c++) {
                const buf = this._channels[c];
                let sample = 0;
                for (let g = 0; g < GRAIN_COUNT; g++) {
                    sample += this._sample(buf, positions[g]) * weights[g];
                }
                output[c][i] = sample / denom;
            }

            this._grainPos++;
            if (this._grainPos >= GRAIN) {
                this._grainPos = 0;
                // Advance the read window by one grain of source material.
                this._readPos = (this._readPos + GRAIN * this._ratio) % size;
                if (this._readPos < 0) this._readPos += size;
            }
        }

        // Mirror the last processed channel to any extra output channels.
        for (let c = channelCount; c < output.length; c++) {
            output[c].set(output[channelCount - 1]);
        }
        return true;
    }

    _sample(buf, pos) {
        const size = buf.length;
        let idx = pos % size;
        if (idx < 0) idx += size;
        const i0 = Math.floor(idx);
        const i1 = (i0 + 1) % size;
        const frac = idx - i0;
        return buf[i0] * (1 - frac) + buf[i1] * frac;
    }
}

registerProcessor('pitch-shift-processor', PitchShiftProcessor);
