// A small cross-engine cache of DECODED audio, keyed by content hash. decodeAudioData on a
// ~49 MB / ~1 Mbps m4a costs 17-59 s in the WebView (measured), and it was paid MORE THAN ONCE:
//  - switching songs A→B→A re-decoded A (the stretch node holds only one track's PCM);
//  - opening the Original-mix MIXER re-decoded the very song the backing player had just decoded,
//    because audioPlayer.js and stemPlayer.js are separate modules (and audioPlayer.js even uses its
//    own AudioContext).
//
// Decoded PCM is a set of channel Float32Arrays, which are CONTEXT-INDEPENDENT — a decode done on one
// engine's context can be handed to the other engine's stretch node via addBuffers with no re-decode.
// So both engines share this one cache: whoever decodes a hash first fills it; the other reuses it.
//
// Keyed by ContentHash so a re-imported file (same song id, new bytes → new hash) is a miss, never a
// stale hit; identical bytes are safely reused. clearAll() flushes on library import (C# ClearAll).
//
// Cap is small: each entry is the full PCM (~138 MB for a 6-min stereo track), so a couple of entries
// covers A↔B toggling and mixer open/close without unbounded phone memory.

const MAX_ENTRIES = 2;
const cache = new Map(); // key -> { channels, duration, sampleRate, length, peaks, flux, fluxFrameSeconds, leadingSilence }

export function has(key) {
    return !!key && cache.has(key);
}

// Return the cached record for `key` (refreshing its LRU recency), or null on a miss / no key.
export function get(key) {
    if (!key) return null;
    const hit = cache.get(key);
    if (hit) {
        cache.delete(key);
        cache.set(key, hit); // move to newest
    }
    return hit || null;
}

// Store `record` under `key`, evicting the oldest entry past the cap. No-op without a key.
export function put(key, record) {
    if (!key) return;
    cache.delete(key);
    cache.set(key, record);
    while (cache.size > MAX_ENTRIES) {
        cache.delete(cache.keys().next().value); // evict oldest
    }
}

// Drop every cached decode (library import replaced files under our feet). Safe to call anytime.
export function clearAll() {
    cache.clear();
}
