// One shared AudioContext for modules that must agree on a clock. The metronome schedules its
// clicks on this context and the recorder timestamps its first captured sample on it, so
// "where does beat 0 fall in the recording" is EXACT arithmetic on one clock — the shared-clock
// requirement of docs/08_Audio_Engine/TimingAnalysis.md §6.2, solved by construction.
//
// stemPlayer.js ALSO uses this context (RecordOverStemsSyncPlan.md) so a take recorded while the
// stems play shares their clock — the basis for sample-exact record-over-stems sync. Modules on this
// context must never close/suspend it (others depend on it staying alive). audioPlayer.js keeps its
// own context — the backing-track player has no clock-agreement requirement.

let ctx = null;

export function getSharedContext() {
    if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        ctx = new Ctor();
        // Hand the context to the gesture-anchored unlock (audioUnlock.js): on iOS a context is born
        // suspended and only resumes from inside a real gesture, which our async C#->JS play() path no
        // longer sees. register() also resumes it immediately if a gesture already fired this session.
        window.__audioUnlock?.register(ctx);
    }
    return ctx;
}
