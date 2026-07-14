class StereoCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this._started = false;
        this._captureAudio = options?.processorOptions?.captureAudio !== false;
        this.port.onmessage = event => {
            if (event.data?.type === 'setCaptureAudio') {
                this._captureAudio = event.data.enabled === true;
            }
        };
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) return true;

        if (!this._started) {
            this._started = true;
            this.port.postMessage({
                type: 'start',
                time: currentTime,
                inputChannels: input.length,
                sampleRate,
            });
        }

        // Measure only the channels that are actually present. A mono source has input.length === 1;
        // measuring input[0] twice would report a phantom second channel in the health readout.
        const channelStats = input.length > 1
            ? [measure(input[0]), measure(input[1])]
            : [measure(input[0])];
        if (!this._captureAudio) {
            this.port.postMessage({
                type: 'chunk',
                inputChannels: input.length,
                channelStats,
            });
            return true;
        }

        const left = new Float32Array(input[0].length);
        const right = new Float32Array(input[0].length);
        left.set(input[0]);
        right.set(input[1] || input[0]);
        this.port.postMessage({
            type: 'chunk',
            left,
            right,
            inputChannels: input.length,
            channelStats,
        }, [left.buffer, right.buffer]);
        return true;
    }
}

function measure(samples) {
    let peak = 0;
    let sumSquares = 0;
    let clipped = 0;
    for (let i = 0; i < samples.length; i++) {
        const abs = Math.abs(samples[i]);
        if (abs > peak) peak = abs;
        sumSquares += samples[i] * samples[i];
        if (abs >= 0.999) clipped++;
    }

    return { peak, sumSquares, samples: samples.length, clipped };
}

registerProcessor('stereo-capture-processor', StereoCaptureProcessor);
