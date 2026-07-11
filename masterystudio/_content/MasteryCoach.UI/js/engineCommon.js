// Shared engine plumbing for BOTH players (audioPlayer.js single-file track, stemPlayer.js stem
// mix). Like countIn.js, these were byte-identical twins living in two files — the deferred-start
// hold gate in the end watchdog had to be fixed twice, once per copy. Everything takes its inputs
// as parameters (no module state); the players bind their own `state` through thin wrappers.

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
        // Nearest-neighbour resample of the (windowed) pre-bucketed peaks.
        const i = Math.min(hi - 1, lo + Math.floor((b / buckets) * span));
        out[b] = p.min[i];
        out[buckets + b] = p.max[i];
        out[buckets * 2 + b] = p.rms[i];
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
        holder.panner.pan.value = holder.pan;

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

/// L/R balance, -1 (left) … 0 (center) … +1 (right). Applies live via the master panner.
export function setMasterPan(holder, pan) {
    holder.pan = Math.max(-1, Math.min(1, pan || 0));
    if (holder.panner) {
        holder.panner.pan.value = holder.pan;
    } else if (holder.ctx) {
        // Context exists but nothing has built a graph yet — create the panner so the value sticks.
        ensureMasterPanner(holder.ctx, holder);
    }
}
