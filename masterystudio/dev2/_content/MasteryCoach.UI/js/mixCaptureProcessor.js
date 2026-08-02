// AudioWorklet STEREO capture processor for mix export (realtime bounce). Forwards interleaved-free
// stereo PCM chunks (two Float32Arrays per block) to the main thread. Separate from the mono
// capture-processor (recorder.js) so the mic-recording hot path stays untouched.
//
// The node is tapped on the stem mixer's master panner, so what it captures IS the live mix the user
// hears — every per-stem volume/pan/mute-solo, the master pan, tempo/pitch, and the click. No second
// graph to keep in sync: this records the literal output.

class MixCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) return true;

        // Copy both channels — the audio thread reuses the input buffers after process() returns.
        // Mono upstream (input.length === 1) duplicates channel 0 into both, so the output is always
        // stereo and the encoder never has to special-case channel count.
        const left = new Float32Array(input[0].length);
        left.set(input[0]);
        const right = new Float32Array(input[0].length);
        right.set(input.length > 1 ? input[1] : input[0]);

        this.port.postMessage({ type: 'chunk', left, right }, [left.buffer, right.buffer]);
        return true;
    }
}

registerProcessor('mix-capture-processor', MixCaptureProcessor);
