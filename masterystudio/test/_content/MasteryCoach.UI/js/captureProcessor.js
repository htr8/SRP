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
        chunk.set(input[0]);
        this.port.postMessage({ type: 'chunk', samples: chunk }, [chunk.buffer]);
        return true;
    }
}

registerProcessor('capture-processor', CaptureProcessor);
