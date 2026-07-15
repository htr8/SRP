// AudioWorklet mic-capture processor. Forwards mono PCM chunks to the main thread and reports the
// AudioContext time of the FIRST captured sample — the recorder's anchor on the shared clock.

class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._started = false;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) return true;

        if (!this._started) {
            this._started = true;
            // currentTime is the context time of the first frame in THIS block.
            this.port.postMessage({ type: 'start', time: currentTime });
        }

        // Mono: channel 0 (mic constraints request a single channel). Copy — the input
        // buffer is reused by the audio thread.
        const chunk = new Float32Array(input[0].length);
        let sumSquares = 0;
        let peak = 0;
        let clipped = 0;
        for (let i = 0; i < input[0].length; i++) {
            const value = input[0][i];
            const abs = Math.abs(value);
            chunk[i] = value;
            sumSquares += value * value;
            if (abs > peak) peak = abs;
            if (abs >= 0.999) clipped++;
        }
        this.port.postMessage({
            type: 'chunk',
            samples: chunk,
            channelStats: [{ channel: 1, peak, sumSquares, samples: chunk.length, clipped }],
        }, [chunk.buffer]);
        return true;
    }
}

registerProcessor('capture-processor', CaptureProcessor);
