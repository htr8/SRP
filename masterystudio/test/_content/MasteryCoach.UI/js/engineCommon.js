// Shared engine plumbing for BOTH players (audioPlayer.js single-file track, stemPlayer.js stem
// mix). Like countIn.js, these were byte-identical twins living in two files — the deferred-start
// hold gate in the end watchdog had to be fixed twice, once per copy. Everything takes its inputs
// as parameters (no module state); the players bind their own `state` through thin wrappers.

// ---------------------------------------------------------------------------------------------
// DotNetStreamReference reading
// ---------------------------------------------------------------------------------------------

/// Read a Blazor DotNetStreamReference to an ArrayBuffer, robust on BOTH runtimes. History (the
/// attach saga, a8a5b99→573c50a→d59facb): the one-shot `.arrayBuffer()` works on native WebViews
/// but has thrown a bare "TypeError: Failed to fetch" on the WASM build for some streams; the
/// chunked `stream()` reader works on WASM but stalled native when `.getReader()` was called on the
/// UN-AWAITED result (stream() returns a Promise there). So: arrayBuffer first (native's proven fast
/// path — the fallback never runs there), and on failure the chunked reader with stream() AWAITED
/// (awaiting a plain ReadableStream is a no-op, so this is safe on WASM too).
export async function readStreamRefBytes(streamRef) {
    try {
        return await streamRef.arrayBuffer();
    } catch (arrayBufferError) {
        if (typeof streamRef.stream !== 'function') throw arrayBufferError;
        const stream = await streamRef.stream(); // Promise on native, plain stream on WASM — await covers both
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            total += value.byteLength;
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
        return out.buffer;
    }
}

// ---------------------------------------------------------------------------------------------
// Waveform peaks
// ---------------------------------------------------------------------------------------------

/// Downsample decoded PCM (channel arrays averaged to mono) into `buckets` columns of min/max/rms —
/// enough to draw a detailed mirrored waveform without shipping raw samples to .NET.
export function computePeaks(channels, frames, buckets) {
    const min = new Float32Array(buckets);
    const max = new Float32Array(buckets);
    const rms = new Float32Array(buckets);
    const chCount = channels.length;
    const per = frames / buckets;
    for (let b = 0; b < buckets; b++) {
        const start = Math.floor(b * per);
        const end = Math.min(frames, Math.floor((b + 1) * per));
        let lo = 1, hi = -1, sumSq = 0, n = 0;
        for (let i = start; i < end; i++) {
            let s = 0;
            for (let c = 0; c < chCount; c++) s += channels[c][i];
            s /= chCount;
            if (s < lo) lo = s;
            if (s > hi) hi = s;
            sumSq += s * s;
            n++;
        }
        min[b] = n ? lo : 0;
        max[b] = n ? hi : 0;
        rms[b] = n ? Math.sqrt(sumSq / n) : 0;
    }
    return { min, max, rms };
}

/// Map a requested time window onto a [lo, hi) slice of a pre-bucketed peak cache of `src` columns
/// (src >= 1); no/invalid window = the whole cache. `hi > lo` is guaranteed — a degenerate window,
/// including one starting at/past the duration (an in-flight zoom racing a reload), clamps to the
/// last column instead of yielding an empty or negative span. Returns { lo, hi, span }.
export function peaksWindow(src, durationSeconds, startSeconds, endSeconds) {
    let lo = 0, hi = src;
    if (durationSeconds > 0 && startSeconds != null && endSeconds != null && endSeconds > startSeconds) {
        lo = Math.min(src - 1, Math.max(0, Math.floor((startSeconds / durationSeconds) * src)));
        hi = Math.min(src, Math.ceil((endSeconds / durationSeconds) * src));
        if (hi <= lo) hi = lo + 1;
    }
    return { lo, hi, span: hi - lo };
}

/// Resample one cached { min, max, rms } to `buckets` columns over an optional time window, as the
/// flat [min…, max…, rms…] array the .NET side expects. NOTE: a plain Array, not a Float32Array —
/// Blazor's JSON interop serializes a typed array as an OBJECT ({"0":..}), which fails to
/// deserialize into float[]; a plain array serializes as a JSON array.
export function resamplePeaksFlat(p, buckets, durationSeconds, startSeconds, endSeconds) {
    if (!p || buckets < 1) return null;
    const { lo, hi, span } = peaksWindow(p.min.length, durationSeconds, startSeconds, endSeconds);
    const out = new Array(buckets * 3);
    for (let b = 0; b < buckets; b++) {
        // Nearest-neighbour resample of the (windowed) pre-bucketed peaks. Coerce any missing/NaN sample
        // to 0: an out-of-range index yields `undefined`, which serializes to JSON as `null` and crashes
        // the C# float[] deserialize (DeserializeUnableToConvertValue). `+x || 0` maps undefined/NaN → 0
        // while leaving every real (incl. negative) value untouched. Defensive across all callers.
        const i = Math.min(hi - 1, lo + Math.floor((b / buckets) * span));
        out[b] = +p.min[i] || 0;
        out[buckets + b] = +p.max[i] || 0;
        out[buckets * 2 + b] = +p.rms[i] || 0;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Stretch engine
// ---------------------------------------------------------------------------------------------

/// Single funnel for node.schedule() so tempo/pitch/loop state is always re-asserted together.
/// An open-ended loop (end == null) loops to the end of the media — matching the classic
/// buffer-source behavior, which loops to buffer.duration (review finding: the stretch engine
/// silently disabled such loops).
export function applyStretchSchedule(node, range, durationSeconds, tempoRatio, pitchSemitones, extra) {
    if (!node) return;
    const loopActive = !!(range && range.loop && durationSeconds > 0);
    const loopEnd = loopActive ? (range.end != null ? range.end : durationSeconds) : 0;
    node.schedule({
        rate: tempoRatio,
        semitones: pitchSemitones,
        loopStart: loopActive ? range.start : 0,
        loopEnd: loopEnd, // equal values disable looping
        ...extra,
    });
}

/// Position mirror + end-of-media watchdog for a stretch node's setUpdateInterval. `playerState`
/// is the player's module state — one holder (matching ensureMasterPanner's pattern) instead of
/// per-field getters, so the two same-shaped accessors can't be transposed at a call site; its
/// `stretch` sub-object is stable, while `ctx`/`range` are re-read each tick because the players
/// reassign them.
///
/// Two guards, both battle scars:
///  - Deferred-start hold: during a count-in the node is SCHEDULED but not yet producing, and its
///    reported inputTime is a stale echo of the previous run (possibly at or past the section/track
///    end). The hold gates EVERYTHING, mirror included: the only message in that window is the
///    schedule acknowledgment, whose stale position would overwrite the entry position the player
///    just seeded (the playhead then shows the old spot for the whole count) — and checking end
///    conditions on it false-fires "ended", which the host answers by restarting playback under the
///    still-scheduled clicks. Hold until the music enters.
///  - While a loop is active the node wraps gaplessly on its own — the watchdog must NOT fire near
///    the loop/track end or it would kill loops whose end sits close to the media end (review).
export function makeEndWatchdog(node, playerState, onEnded) {
    return (inputTime) => {
        const stretch = playerState.stretch;
        const ctx = playerState.ctx;
        if (ctx && ctx.currentTime < (stretch.holdEndCheckUntil || 0)) return;
        stretch.position = inputTime;
        if (!stretch.playing) return;
        const r = playerState.range;
        if (r && r.loop) return; // native loop handles the wrap
        const stopAt = r && r.end != null ? r.end : null;
        const mediaEnd = stretch.duration > 0 ? stretch.duration - 0.05 : null;
        if ((stopAt != null && inputTime >= stopAt) || (mediaEnd != null && inputTime >= mediaEnd)) {
            stretch.playing = false;
            node.stop();
            onEnded();
        }
    };
}

// ---------------------------------------------------------------------------------------------
// Master panner
// ---------------------------------------------------------------------------------------------

/// The shared master StereoPanner both engines connect INTO (instead of straight to destination),
/// so L/R pan works the same regardless of which engine owns the media. Created lazily on `holder`
/// (the player state carrying `.panner`/`.pan`); retains the current pan.
///
/// iOS background keep-alive: the panner routes to a MediaStreamAudioDestinationNode whose stream
/// feeds a real <audio> element (registered with audioUnlock.js), NOT straight to ctx.destination.
/// A *playing* HTMLMediaElement carrying the real mix is what makes iOS keep the app — and this
/// context's worklet — alive when backgrounded; a bare AudioContext destination is suspended on
/// background (device-confirmed). The stream sink is the SOLE output so nothing is heard twice; pan
/// and per-stem gains sit UPSTREAM of it, so they still apply. Falls back to ctx.destination only if
/// createMediaStreamDestination or the unlock hook is unavailable (older/edge WebViews) — there the
/// foreground still works and background is no worse than before.
export function ensureMasterPanner(ctx, holder) {
    if (!holder.panner) {
        holder.panner = ctx.createStereoPanner();
        applyMasterPan(holder);

        var routedToSink = false;
        try {
            if (ctx.createMediaStreamDestination && window.__audioUnlock && window.__audioUnlock.registerSink) {
                holder.streamSink = ctx.createMediaStreamDestination();
                holder.panner.connect(holder.streamSink);
                window.__audioUnlock.registerSink(holder.streamSink.stream);
                routedToSink = true;
            }
        } catch (err) {
            // MediaStream sink unavailable — fall through to the plain destination below.
        }
        if (!routedToSink) {
            holder.panner.connect(ctx.destination);
        }
    }
    return holder.panner;
}

/// The ONE place the master panner's node value is computed. While any hard-panned dual-mix
/// plumbing exists on this holder (the buses or the count-in tap), the node is PINNED to center —
/// a StereoPanner at pan ≠ 0 crossfeeds its input channels (at pan > 0, outR = R + L·sin(x·π/2)),
/// so any non-zero master pan would leak the monitor mix (the click!) into the room channel and
/// vice versa (DualMixPlan.md §3.2). Deriving the pin from the plumbing's EXISTENCE makes the
/// invariant structural: there is no flag to keep in lockstep, and tearing the plumbing down
/// restores the user's pan by construction. `holder.pan` always retains the user's value.
function applyMasterPan(holder) {
    if (holder.panner) {
        holder.panner.pan.value = (holder.dualBuses || holder.countInTap) ? 0 : holder.pan;
    }
}

/// L/R balance, -1 (left) … 0 (center) … +1 (right). Applies live via the master panner — unless
/// dual-mix plumbing pins it to center (see applyMasterPan); the value is retained either way.
export function setMasterPan(holder, pan) {
    holder.pan = Math.max(-1, Math.min(1, pan || 0));
    if (holder.panner) {
        applyMasterPan(holder);
    } else if (holder.ctx) {
        // Context exists but nothing has built a graph yet — create the panner so the value sticks.
        ensureMasterPanner(holder.ctx, holder);
    }
}

// ---------------------------------------------------------------------------------------------
// Dual-mix buses (DualMixPlan.md §3)
// ---------------------------------------------------------------------------------------------

/// One hard-panned dual-mix LEG: gain(headroom) → StereoPanner(±1) → fanIn. The single statement of
/// the construction shared by the two buses and the count-in tap, so the headroom and the wiring can
/// never drift between them — the planned Phase-C by-ear retune (0.5 → ~0.7, §3.3) edits ONE number
/// and stays click-to-stem balanced by construction. The gain exists because a StereoPanner at ±1
/// MONO-SUMS its stereo input (out = L+R): full-scale stereo would reach ±2.0 and clip without it.
const LEG_HEADROOM_GAIN = 0.5;
function makeHardPannedLeg(ctx, pan, fanIn) {
    const gain = ctx.createGain();
    gain.gain.value = LEG_HEADROOM_GAIN;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner).connect(fanIn);
    return { gain, panner };
}

function teardownLeg(leg) {
    try { leg.gain.disconnect(); } catch { /* ignore */ }
    try { leg.panner.disconnect(); } catch { /* ignore */ }
}

/// The two dual-mix buses: **monitor** (hard-panned LEFT — the drummer's in-ears: click, count-in,
/// cue stems) and **room** (hard-panned RIGHT — what the PA hears). Created lazily on
/// `holder.dualBuses`, mirroring the ensureMasterPanner holder pattern. `fanIn` is the node the
/// hard-panners feed: the master panner on the stretch path, the CLASSIC BUS on the classic path so
/// the pitch worklet stays downstream of the split (it processes channels independently, so the L/R
/// separation survives it — DualMixPlan.md §Both engines). Callers feed each bus's `.gain`.
export function ensureDualBuses(ctx, holder, fanIn) {
    if (!holder.dualBuses) {
        holder.dualBuses = { monitor: makeHardPannedLeg(ctx, -1, fanIn), room: makeHardPannedLeg(ctx, 1, fanIn) };
        applyMasterPan(holder); // hard-panned buses now exist — the master pan pins to center (§3.2)
    }
    return holder.dualBuses;
}

/// Disconnect and drop the dual buses — on dual-mix off, on a graph rebuild (the fan-in target may
/// change with the engine), and on dispose. Safe when none exist.
export function teardownDualBuses(holder) {
    const buses = holder.dualBuses;
    if (!buses) return;
    teardownLeg(buses.monitor);
    teardownLeg(buses.room);
    holder.dualBuses = null;
    applyMasterPan(holder); // pin lifts with the plumbing (unless the count-in tap still holds it)
}

/// The count-in's own dual-mix sink: a hard-LEFT leg into the MASTER panner. Deliberately NOT the
/// monitor bus: the bus fans into the classic path UPSTREAM of the pitch worklet (the count would
/// come out pitch-shifted and grain-smeared), and the bus dies with the stem graph during a reload
/// while the count must stay hard-left through the load-vs-play window. Lazy on the holder like the
/// buses; callers feed the returned `.gain`.
export function ensureCountInTap(ctx, holder) {
    if (!holder.countInTap) {
        holder.countInTap = makeHardPannedLeg(ctx, -1, ensureMasterPanner(ctx, holder));
        applyMasterPan(holder); // the tap is hard-panned plumbing too — same pin rule as the buses
    }
    return holder.countInTap;
}

/// Disconnect and drop the count-in tap (dual-mix off). Safe when none exists.
export function teardownCountInTap(holder) {
    const tap = holder.countInTap;
    if (!tap) return;
    teardownLeg(tap);
    holder.countInTap = null;
    applyMasterPan(holder);
}
