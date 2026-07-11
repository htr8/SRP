// Shared count-in core for BOTH players (audioPlayer.js single-file track, stemPlayer.js stem mix).
// These were byte-identical twins that drifted risk with every edit (28+18 commits of independent
// churn); the players keep their exported setCountIn/play APIs and delegate here. Everything takes
// its inputs as parameters — no module state — so the pure math is testable in Node
// (tests/js/count-in-core.test.mjs).

/// Clamp/normalize the count-in settings at the API boundary — the ONE statement of the contract
/// (the players' setCountIn and the C# ITransport doc point here). `beats` is the clicks HEARD (the
/// lead-in length); `entryBeats` is where the music enters as a fractional beat measured from the
/// count start (classic "enter on 1" = beats — the downbeat AFTER the full count; off-beats pull it
/// earlier, e.g. a 4-count "and of 3" = 2.5). 0/invalid entry falls back to the classic `beats`.
/// `firstBeatOffsetSeconds` is the SONG-time gap from the entry position to the song's first
/// tracked beat at/after it (phase alignment: leading silence / a pickup before beat 1). Negative
/// or non-finite = no beat grid — stored as null so callers can fall back to their own estimate.
export function clampCountIn(beats, entryBeats, secondsPerBeat, firstBeatOffsetSeconds) {
    const b = beats > 0 ? Math.floor(beats) : 0;
    return {
        beats: b,
        entryBeats: Number.isFinite(entryBeats) && entryBeats > 0 ? Math.min(entryBeats, b) : b,
        secondsPerBeat: secondsPerBeat > 0 ? secondsPerBeat : 0.5,
        firstBeatOffset: Number.isFinite(firstBeatOffsetSeconds) && firstBeatOffsetSeconds >= 0
            ? firstBeatOffsetSeconds
            : null,
    };
}

/// The real-time interval between clicks: the musical beat scaled by the practiced tempo.
export function countInIntervalSeconds(countIn, tempoRatio) {
    return countIn.secondsPerBeat / (tempoRatio > 0 ? tempoRatio : 1);
}

/// How the music aligns to the count. Without a beat grid the file simply starts on the entry beat.
/// With one (`firstBeatOffset` != null), the goal is the song's first tracked beat — not the file
/// position, which may sit in leading silence or mid-pickup — landing ON the entry beat:
///  - gap fits inside the entry window → the file starts EARLY by it (a pickup sounds under the
///    closing clicks; leading silence is inaudible anyway);
///  - gap exceeds the window (long leading silence, a pickup longer than the count) → the start
///    clamps to the first click and the file position skips FORWARD by the surplus instead.
/// `maxSkipSeconds` bounds that skip (song-time): when even the skip cannot reach a beat inside the
/// playable window — a section with no tracked beat in it — alignment is impossible, and the result
/// degrades to the plain no-grid entry instead of starting past the section/media end (which would
/// false-fire "ended" under the still-scheduled clicks).
/// Returns { delaySeconds, skipSeconds }: real-time delay from the first click to the file start,
/// and song-time seconds to advance the start position by.
export function countInMusicAlignment(countIn, tempoRatio, maxSkipSeconds = Infinity) {
    const rate = tempoRatio > 0 ? tempoRatio : 1;
    // Both the entry window and the gap are song-time here; only the returned delay needs the
    // real-time conversion (the skip stays song-time by construction).
    const entrySong = countIn.entryBeats * countIn.secondsPerBeat;
    const gapSong = countIn.firstBeatOffset != null ? countIn.firstBeatOffset : 0;
    if (gapSong <= entrySong) {
        return { delaySeconds: (entrySong - gapSong) / rate, skipSeconds: 0 };
    }
    const skip = gapSong - entrySong;
    return skip <= maxSkipSeconds
        ? { delaySeconds: 0, skipSeconds: skip }
        : { delaySeconds: entrySong / rate, skipSeconds: 0 };
}

/// One percussive click voice — shared with the metronome (metronome.js) so the count-in and the
/// metronome stay timbre-identical: any envelope/pitch tweak lands once. Returns the oscillator so
/// callers that need cancellation can retain it.
export function scheduleClickVoice(ctx, time, accent) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    // Short percussive envelope so clicks do not ring or overlap.
    gain.gain.setValueAtTime(accent ? 0.6 : 0.35, time);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);
    osc.connect(gain).connect(ctx.destination);
    osc.start(time);
    osc.stop(time + 0.03);
    return osc;
}

/// Schedule the count's click oscillators on `ctx`, pushing each into `nodes` so the caller can
/// cancel them (pause/stop/seek/replay). Every bar's downbeat is accented (beat % 4 === 0), so an
/// 8-count accents beat 1 of BOTH measures. `label` tags the diagnostic log line ("track"/"stems").
export function scheduleCountInClicks(ctx, startTime, beats, interval, nodes, label) {
    // Diagnostic (perf/tuning): reaches the /diagnostics log via the console.warn bridge.
    console.warn(`[perf:count-in] ${label}: ${beats} clicks, interval ${interval.toFixed(3)}s, ` +
        `startAt +${(startTime - ctx.currentTime).toFixed(3)}s, ctxState ${ctx.state}`);
    for (let beat = 0; beat < beats; beat++) {
        nodes.push(scheduleClickVoice(ctx, startTime + beat * interval, beat % 4 === 0));
    }
}

/// Stop + disconnect every scheduled click and empty the array in place. Timer-based extras (the
/// track player's element-fallback deferred start) stay with the caller.
export function cancelCountInNodes(nodes, label) {
    if (nodes.length > 0) {
        console.warn(`[perf:count-in] ${label}: cancelling ${nodes.length} scheduled clicks`);
    }
    for (const osc of nodes) {
        try { osc.stop(); osc.disconnect(); } catch { /* already done */ }
    }
    nodes.length = 0;
}
