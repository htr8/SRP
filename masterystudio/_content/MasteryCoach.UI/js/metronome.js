// Web Audio metronome. Runs identically in the browser and every MAUI WebView (Windows/iOS/…),
// replacing the previous Windows-only native metronome.
//
// Uses the standard lookahead scheduler: a timer wakes every ~25ms and schedules any beats that
// fall inside the next 100ms window, so click timing is sample-accurate and does not drift with
// JS timer jitter. Each click is a short oscillator burst (accent = higher pitch + louder).

import { getSharedContext } from './audioContext.js';
import { scheduleClickVoice } from './countIn.js';

const SCHEDULE_AHEAD = 0.1;   // seconds of audio scheduled in advance
const LOOKAHEAD_MS = 25;      // how often the scheduler wakes

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
    dotnet: null,
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

// The click voice itself is shared with the count-in (countIn.js) so the two never drift in timbre.
function scheduleClick(beatInMeasure, time) {
    scheduleClickVoice(state.ctx, time, state.accents.has(beatInMeasure));
}

function scheduler() {
    const ctx = state.ctx;
    while (state.running && state.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
        if (state.endTime != null && state.nextNoteTime >= state.endTime) {
            stopInternal();
            notifyEnded();
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

// bpm > 0; beatsPerMeasure >= 1; accentPattern like "1" or "1,3"; runForSeconds null = run until stop.
export async function start(bpm, beatsPerMeasure, accentPattern, runForSeconds) {
    stopInternal();
    const ctx = ensureContext();
    // iOS/Safari suspend the context until a user gesture; start() is called from a click handler.
    if (ctx.state === 'suspended') await ctx.resume();

    state.secondsPerBeat = 60.0 / (bpm > 0 ? bpm : 120);
    state.beatsPerMeasure = beatsPerMeasure >= 1 ? beatsPerMeasure : 1;
    state.accents = parseAccents(accentPattern, state.beatsPerMeasure);
    state.beatIndex = 0;
    state.nextNoteTime = ctx.currentTime + 0.05;
    state.gridStartTime = state.nextNoteTime; // beat 0's exact ctx time — the shared-clock anchor
    state.endTime = runForSeconds != null && runForSeconds > 0 ? state.nextNoteTime + runForSeconds : null;
    state.running = true;
    state.timer = setInterval(scheduler, LOOKAHEAD_MS);
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

export function stop() {
    stopInternal();
}

function stopInternal() {
    state.running = false;
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
}

export function isRunning() {
    return state.running;
}
