// Incremental SHA-256 (FIPS 180-4), because the platform does not offer one.
//
// WHY THIS FILE EXISTS AT ALL. WebCrypto's `crypto.subtle.digest()` is ONE-SHOT: it takes the entire
// message as a single BufferSource and there is no streaming/update API anywhere in SubtleCrypto. For
// a multi-hundred-megabyte video that means materialising the whole asset as one ArrayBuffer, which
// VideoLibraryAndStudioSourcePlan.md §2.10 forbids outright and §6.2 names explicitly:
// "WebCrypto digest() over one whole ArrayBuffer is forbidden for video-sized inputs." So the hash
// has to be computed incrementally, one bounded chunk at a time, and that requires a real
// implementation of the compression function.
//
// SIZE/AUDITABILITY. ~90 lines of arithmetic transcribed from FIPS 180-4 §6.2, no dependencies, no
// dynamic allocation per chunk beyond a 64-byte block buffer and the 64-word message schedule. It is
// pinned against the NIST published SHA-256 test vectors plus a chunk-boundary equivalence property
// in tests/js/sha256-incremental.test.mjs — the boundary property is the one that actually matters
// here, because the caller feeds it whatever sizes the file reader produces.
//
// Node-import safe (module-imports smoke test): no browser globals touched at module scope.

// FIPS 180-4 §4.2.2: first 32 bits of the fractional parts of the cube roots of the first 64 primes.
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/// Streaming SHA-256: construct, `update(bytes)` any number of times with any sizes, then `hex()`.
/// The instance is single-use — `hex()` applies the length padding, after which further updates would
/// silently produce a wrong digest, so it throws instead.
export class Sha256 {
    constructor() {
        // FIPS 180-4 §5.3.3: first 32 bits of the fractional parts of the square roots of the first
        // 8 primes.
        this._h = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]);
        this._block = new Uint8Array(64);
        this._blockLength = 0;   // bytes buffered in _block awaiting a full 64-byte block
        this._totalLength = 0;   // total message length in bytes (for the length padding)
        this._w = new Uint32Array(64);
        this._finalized = false;
    }

    /// Absorb the next slice of the message. Chunk sizes need not align to the 64-byte block: leftover
    /// bytes are buffered and completed by the following update. That is the whole point — the caller
    /// feeds whatever the reader produced.
    update(bytes) {
        if (this._finalized) throw new Error('Sha256.update after hex(): the digest is already finalized');
        const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        this._totalLength += input.length;

        let offset = 0;

        // Top off a partially filled block first.
        if (this._blockLength > 0) {
            const need = 64 - this._blockLength;
            const take = Math.min(need, input.length);
            this._block.set(input.subarray(0, take), this._blockLength);
            this._blockLength += take;
            offset = take;
            if (this._blockLength === 64) {
                this._compress(this._block, 0);
                this._blockLength = 0;
            }
        }

        // Whole blocks straight out of the input, no copy.
        while (offset + 64 <= input.length) {
            this._compress(input, offset);
            offset += 64;
        }

        // Buffer the remainder for the next update (or for the padding in hex()).
        if (offset < input.length) {
            this._block.set(input.subarray(offset), 0);
            this._blockLength = input.length - offset;
        }
        return this;
    }

    /// Apply FIPS 180-4 §5.1.1 padding and return the lowercase hex digest. Single-use.
    hex() {
        if (this._finalized) throw new Error('Sha256.hex called twice: the digest is already finalized');
        this._finalized = true;

        const bitLength = this._totalLength * 8;
        // 0x80, then zeroes, then a 64-bit big-endian bit length. One block when 55 bytes or fewer
        // remain buffered, otherwise two.
        const padded = new Uint8Array(this._blockLength <= 55 ? 64 : 128);
        padded.set(this._block.subarray(0, this._blockLength), 0);
        padded[this._blockLength] = 0x80;

        // JS numbers hold the bit length exactly up to 2^53, i.e. ~1 PiB of message — far past any
        // file this runs on. The high 32 bits are written from the same number rather than dropped,
        // so a >512 MiB message (bitLength > 2^32) still pads correctly.
        const view = new DataView(padded.buffer);
        view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false);
        view.setUint32(padded.length - 4, bitLength >>> 0, false);

        for (let offset = 0; offset < padded.length; offset += 64) {
            this._compress(padded, offset);
        }

        let out = '';
        for (let i = 0; i < 8; i++) out += this._h[i].toString(16).padStart(8, '0');
        return out;
    }

    // FIPS 180-4 §6.2.2, one 64-byte block starting at `offset`.
    _compress(bytes, offset) {
        const w = this._w;
        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const w15 = w[i - 15];
            const w2 = w[i - 2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        const h = this._h;
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];

        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            hh = g; g = f; f = e;
            e = (d + temp1) | 0;
            d = c; c = b; b = a;
            a = (temp1 + temp2) | 0;
        }

        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
}
