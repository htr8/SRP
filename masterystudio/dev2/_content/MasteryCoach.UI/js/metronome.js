// Web Audio metronome. Runs identically in the browser and every MAUI WebView (Windows/iOS/…),
// replacing the previous Windows-only native metronome.
//
// Uses the standard lookahead scheduler: a timer wakes every ~25ms and schedules any beats that
// fall inside the next SCHEDULE_AHEAD window, so click timing is sample-accurate and does not
// drift with JS timer jitter. Each click is a short oscillator burst (accent = higher pitch +
// louder).
//
// Background-tab survival: browsers throttle setInterval on a hidden/backgrounded tab (Chrome can
// drop to ~1 tick/minute after several minutes hidden). AudioContext.currentTime itself never
// drifts while backgrounded, but a short SCHEDULE_AHEAD window empties out between throttled ticks,
// so clicks stop firing until the tab is foregrounded again — heard as the metronome "slowing to a
// crawl" (a long gap, then a burst of catch-up clicks). SCHEDULE_AHEAD is deliberately generous
// (several seconds) so one scheduler tick, however delayed, always has enough already-scheduled
// audio queued to bridge the gap; scheduling seconds ahead costs nothing since every voice is
// scheduled by absolute AudioContext time (see scheduleClick), not wall-clock time.
import { getSharedContext } from './audioContext.js';
import { scheduleClickVoice } from './countIn.js';
import { ensureMasterPanner } from './engineCommon.js';

const SCHEDULE_AHEAD = 3.0;   // seconds of audio scheduled in advance
const LOOKAHEAD_MS = 25;      // how often the scheduler wakes (foreground cadence; throttled when hidden)

const state = {
    ctx: null,
    timer: null,
    running: false,
    nextNoteTime: 0,
    beatIndex: 0,
    gridStartTime: 0,         // ctx time of beat 0 for the current run (shared-clock anchor)
    secondsPerBeat: 0.5,
    beatsPerMeasure: 4,
    accents: new Set([1]),
    endTime: null,            // AudioContext time to auto-stop, or null
    endTimer: null,           // wall-clock setTimeout that fires notifyEnded() at the real end time
    pendingClicks: [],        // {osc, time} not yet sounded — see updateSettings()
    dotnet: null,
    pan: 0,
    volumeGain: null,         // GainNode boosting the click ONLY, upstream of the shared master panner
    volumeMultiplier: 1,      // volumePercent / 100, applied to volumeGain.gain — see setVolume()
};

export function setEndedCallback(dotnetRef) {
    state.dotnet = dotnetRef;
}

function notifyEnded() {
    if (state.dotnet) state.dotnet.invokeMethodAsync('OnMetronomeStopped');
}

function ensureContext() {
    if (!state.ctx) {
        // Shared with the recorder so beat times and capture times live on one clock.
        state.ctx = getSharedContext();
    }
    return state.ctx;
}

// A dedicated GainNode for the click ONLY (upstream of the shared master panner, which other
// engines also route through) — boosting it never touches playback/stem volume. Lazily created on
// first use, same pattern as ensureMasterPanner.
function ensureVolumeNode() {
    if (!state.volumeGain) {
        const ctx = ensureContext();
        state.volumeGain = ctx.createGain();
        state.volumeGain.gain.value = state.volumeMultiplier;
        state.volumeGain.connect(ensureMasterPanner(ctx, state));
    }
    return state.volumeGain;
}

function outputNode() {
    return ensureVolumeNode();
}

// volumePercent: 100 = the engine's default (pre-boost) click level, 200 = roughly double. Applied
// immediately (including to clicks already scheduled but not yet sounding — a plain gain.value
// write takes effect at the AudioContext's next processing block, well before SCHEDULE_AHEAD's
// multi-second horizon could make that lag audible).
function setVolume(volumePercent) {
    const percent = Number.isFinite(volumePercent) && volumePercent >= 0 ? volumePercent : 100;
    state.volumeMultiplier = percent / 100;
    if (state.volumeGain) {
        state.volumeGain.gain.value = state.volumeMultiplier;
    }
}

// The click voice itself is shared with the count-in (countIn.js) so the two never drift in timbre.
// Tracked in state.pendingClicks (with its start time) so a live tempo edit (updateSettings) can
// cancel whatever was already scheduled at the OLD tempo inside the wide SCHEDULE_AHEAD window,
// instead of leaving up to SCHEDULE_AHEAD seconds of stale-tempo clicks to play out audibly.
function scheduleClick(beatInMeasure, time) {
    const osc = scheduleClickVoice(state.ctx, time, state.accents.has(beatInMeasure), outputNode());
    state.pendingClicks.push({ osc, time });
}

// Drops entries for clicks that have already started sounding (nothing to cancel there — nothing
// left pending) so the array stays bounded across a long run instead of growing forever.
function prunePendingClicks(now) {
    while (state.pendingClicks.length > 0 && state.pendingClicks[0].time <= now) {
        state.pendingClicks.shift();
    }
}

// Cancels every click still scheduled STRICTLY in the future (its start time has not yet arrived).
// A click already sounding or finished is left alone — stopping it now would cut off audio the user
// already heard, or is a no-op. Used by updateSettings() so a live tempo edit takes effect
// immediately instead of after up to SCHEDULE_AHEAD seconds of stale-tempo clicks.
function cancelFutureClicks() {
    const now = state.ctx.currentTime;
    const remaining = [];
    for (const click of state.pendingClicks) {
        if (click.time > now) {
            try { click.osc.stop(); click.osc.disconnect(); } catch { /* already stopped */ }
        } else {
            remaining.push(click); // sounding or already past — leave it alone
        }
    }
    state.pendingClicks = remaining;
}

function scheduleChimeVoice(time, frequency, gainValue, duration) {
    const osc = state.ctx.createOscillator();
    const gain = state.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(gainValue, time + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    osc.connect(gain).connect(outputNode());
    osc.start(time);
    osc.stop(time + duration + 0.03);
}

function scheduler() {
    const ctx = state.ctx;
    prunePendingClicks(ctx.currentTime);
    while (state.running && state.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        if (state.endTime != null && state.nextNoteTime >= state.endTime) {
            // Stop SCHEDULING further clicks now, but notifyEnded() fires from the endTimer armed in
            // start() at the run's actual (wall-clock-equivalent) end time — not here, which with a
            // multi-second SCHEDULE_AHEAD would fire up to SCHEDULE_AHEAD seconds before the last
            // already-scheduled click has actually sounded.
            state.running = false;
            if (state.timer) {
                clearInterval(state.timer);
                state.timer = null;
            }
            return;
        }
        const beatInMeasure = (state.beatIndex % state.beatsPerMeasure) + 1;
        scheduleClick(beatInMeasure, state.nextNoteTime);
        state.nextNoteTime += state.secondsPerBeat;
        state.beatIndex += 1;
    }
}

function parseAccents(pattern, beatsPerMeasure) {
    const set = new Set();
    if (typeof pattern === 'string') {
        for (const token of pattern.split(',')) {
            const n = parseInt(token.trim(), 10);
            if (Number.isInteger(n) && n >= 1 && n <= beatsPerMeasure) set.add(n);
        }
    }
    set.add(1); // downbeat always accented so the measure is audible
    return set;
}

// bpm > 0; beatsPerMeasure >= 1; accentPattern like "1" or "1,3"; runForSeconds null = run until
// stop; volumePercent (optional) as documented on setVolume() — 100 if omitted.
export async function start(bpm, beatsPerMeasure, accentPattern, runForSeconds, volumePercent) {
    stopInternal();
    const ctx = ensureContext();
    // iOS/Safari suspend the context until a user gesture; start() is called from a click handler.
    if (ctx.state === 'suspended') await ctx.resume();

    state.secondsPerBeat = 60.0 / (bpm > 0 ? bpm : 120);
    state.beatsPerMeasure = beatsPerMeasure >= 1 ? beatsPerMeasure : 1;
    state.accents = parseAccents(accentPattern, state.beatsPerMeasure);
    setVolume(volumePercent);
    state.beatIndex = 0;
    state.nextNoteTime = ctx.currentTime + 0.05;
    state.gridStartTime = state.nextNoteTime; // beat 0's exact ctx time — the shared-clock anchor
    state.endTime = runForSeconds != null && runForSeconds > 0 ? state.nextNoteTime + runForSeconds : null;
    state.running = true;
    state.timer = setInterval(scheduler, LOOKAHEAD_MS);

    // Fires notifyEnded() at the run's REAL end (wall-clock-equivalent), independent of how far
    // ahead the scheduler has already committed clicks — see the comment on scheduler()'s endTime
    // branch. setTimeout drifts negligibly over a single run's length and, like the scheduler
    // interval, is fine to be throttled while backgrounded (the notification simply lands late,
    // same as the scheduler catching up).
    if (state.endTime != null) {
        state.endTimer = setTimeout(() => {
            state.endTimer = null;
            if (!state.running) return; // already stopped some other way (e.g. explicit stop())
            stopInternal();
            notifyEnded();
        }, Math.max(0, runForSeconds) * 1000);
    }
}

export function updateSettings(bpm, beatsPerMeasure, accentPattern, volumePercent) {
    const ctx = ensureContext();
    const oldSecondsPerBeat = state.secondsPerBeat;
    const newSecondsPerBeat = 60.0 / (bpm > 0 ? bpm : 120);
    const elapsed = state.running ? ctx.currentTime - state.gridStartTime : 0;
    const currentBeatIndex = oldSecondsPerBeat > 0
        ? Math.max(0, Math.floor(elapsed / oldSecondsPerBeat))
        : 0;

    state.secondsPerBeat = newSecondsPerBeat;
    state.beatsPerMeasure = beatsPerMeasure >= 1 ? beatsPerMeasure : 1;
    state.accents = parseAccents(accentPattern, state.beatsPerMeasure);
    setVolume(volumePercent);

    if (state.running) {
        // Keep the visual/current beat stable across a live tempo edit.
        state.gridStartTime = ctx.currentTime - (currentBeatIndex * newSecondsPerBeat);
        // Cancel whatever was scheduled at the OLD tempo but hasn't sounded yet — with the wide
        // SCHEDULE_AHEAD window that can be several seconds' worth of clicks — then re-arm the
        // scheduler from "now" at the new tempo so the audible change is immediate, matching the
        // visual beat indicator this function just re-anchored above.
        cancelFutureClicks();
        state.nextNoteTime = ctx.currentTime + 0.05;
        state.beatIndex = currentBeatIndex;
    }
}

export async function playCompletionChime() {
    const ctx = ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
    const start = ctx.currentTime + 0.02;
    scheduleChimeVoice(start, 880, 0.36, 0.16);
    scheduleChimeVoice(start + 0.14, 1320, 0.28, 0.2);
}

// The current run's beat grid on the shared AudioContext clock, for the recorder to compute an
// exact grid offset. Null when not running.
export function getGrid() {
    if (!state.running) return null;
    return {
        startTime: state.gridStartTime,
        secondsPerBeat: state.secondsPerBeat,
        beatsPerMeasure: state.beatsPerMeasure,
    };
}

// The 1-based beat currently sounding, derived from the shared-clock grid — for the visual beat
// indicator to poll (cheap, pure, no per-frame .NET callbacks). 0 when not running, or before the
// first beat has actually sounded (during the ~50ms lead-in the grid exists but no click has fired
// yet, so lighting a dot then would be premature). Uses the SAME clock the clicks are scheduled on,
// so the lit dot lands on the click rather than drifting with a wall-clock timer.
export function getCurrentBeat() {
    if (!state.running || !state.ctx) return 0;
    const elapsed = state.ctx.currentTime - state.gridStartTime;
    if (elapsed < 0) return 0; // lead-in before beat 0
    const beatIndex = Math.floor(elapsed / state.secondsPerBeat);
    return (beatIndex % state.beatsPerMeasure) + 1;
}

export function stop() {
    stopInternal();
}

function stopInternal() {
    state.running = false;
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
    if (state.endTimer) {
        clearTimeout(state.endTimer);
        state.endTimer = null;
    }
    // With the wide SCHEDULE_AHEAD window, up to several seconds of clicks can already be scheduled
    // (Web Audio does not cancel on its own) — stop them so a Stop/Reset is heard immediately rather
    // than continuing to click for up to SCHEDULE_AHEAD seconds after the UI shows it stopped.
    for (const click of state.pendingClicks) {
        try { click.osc.stop(); click.osc.disconnect(); } catch { /* already stopped */ }
    }
    state.pendingClicks = [];
}

export function isRunning() {
    return state.running;
}
