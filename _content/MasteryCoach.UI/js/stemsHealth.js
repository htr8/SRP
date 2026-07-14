// Playback-health monitor for the Signalsmith stretch engine — the instrumentation behind task #77
// (intermittent pitch/speed "wobble" the user hears occasionally, maybe around a text/call, maybe not).
//
// WHY THIS SHAPE: the wobble can't be reproduced on desktop and the user can't predict WHEN it fires,
// so real-time capture is hopeless. Instead this keeps a rolling ~60 s RING BUFFER of per-tick samples
// during stem playback and AUTO-DUMPS that window to the diagnostics log (console.warn '[stems-health]',
// which the errorCapture funnel collects → /diagnostics) the moment an anomaly is detected. The user
// just plays; when they notice a wobble it's already logged. A manual snapshot() is also exposed.
//
// The three things that make a phase-vocoder stretch node wobble, each detected here:
//  1. AudioContext INTERRUPTION — iOS flips the context running→interrupted→running on a call/text/route
//     change; on resume the worklet's clock and the context clock are out of sync and it slow-catches-up.
//  2. Sample-RATE change — if iOS reopens the context at a different hardware rate (48000↔44100, common
//     when a Bluetooth device connects), the worklet indexes its PCM at the wrong rate → continuous wobble.
//  3. Position DRIFT — the worklet advances slower/faster than tempoRatio × wall-clock for a stretch of
//     ticks, then snaps back. This is the direct fingerprint of the "slowed then got back to tempo" report.
//
// Node-import safe: no navigator/window/AudioContext access at module scope (the smoke test imports this).

const RING_SECONDS = 60;
const TICK_SECONDS = 0.1;                       // matches node.setUpdateInterval(0.1, …)
const RING_MAX = Math.ceil(RING_SECONDS / TICK_SECONDS); // ~600 samples

// A tick's advance may legitimately vary (scheduling jitter, the 0.1 s interval isn't exact), so only a
// SUSTAINED deviation counts as drift. We compare the position advance per wall-clock second against the
// expected tempoRatio and flag when it stays off by more than DRIFT_TOLERANCE across DRIFT_MIN_TICKS.
const DRIFT_TOLERANCE = 0.12;                   // ±12% advance-per-wall deviation from tempoRatio
const DRIFT_MIN_TICKS = 3;                      // sustained over ≥3 ticks (~0.3 s) — not a single blip
const ANOMALY_COOLDOWN_MS = 4000;               // don't re-dump the same event storm every tick

// Rolling ring of { t, pos, rate, st, tempo } — t = ctx.currentTime (wall), pos = worklet song-position.
let ring = [];
let prev = null;                                // previous sample, for per-tick advance
let lastRate = null;
let lastState = null;
let driftRun = 0;                               // consecutive off-tempo ticks
let lastDumpAtMs = -Infinity;
let sessionActive = false;

// Monotonic-ish clock for the cooldown only (NOT for measurement — measurement uses ctx.currentTime).
// performance.now is fine here; guarded for Node where it may be absent at import (called only at runtime).
function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
}

// Snapshot the ENVIRONMENT at an interruption so the log names the TRIGGER (task #77): is the page
// hidden (phone locked / app backgrounded)? Is the keep-alive sink paused (iOS grabbed the WebView
// audio)? What's the output route? All guarded — reads only what's present, never throws. Node-safe
// (nothing runs at module scope; this is called only from the runtime statechange handler).
function envSnapshot() {
    const parts = [];
    try {
        if (typeof document !== 'undefined') {
            parts.push(`vis=${document.visibilityState}`);
            if (document.hidden) parts.push('HIDDEN');
        }
    } catch (e) { /* ignore */ }
    try {
        // The keep-alive sink(s): if any is paused during playback, iOS interrupted the WebView audio
        // (the '[sink] self-heal' path). audioUnlock tags them; find them by the srcObject <audio> els.
        if (typeof document !== 'undefined' && document.querySelectorAll) {
            const els = document.querySelectorAll('audio');
            let sinks = 0, paused = 0;
            els.forEach(el => { if (el.srcObject) { sinks++; if (el.paused) paused++; } });
            if (sinks > 0) parts.push(`sinks=${sinks}${paused ? ` PAUSED=${paused}` : ''}`);
        }
    } catch (e) { /* ignore */ }
    try {
        // Output route hint: whether headphones/BT vs speaker (a route change flips the context). No
        // sync API for the active route, but userActivation + the media-session playbackState help.
        if (typeof navigator !== 'undefined') {
            if (navigator.userActivation) parts.push(`active=${navigator.userActivation.isActive}`);
            if (navigator.mediaSession) parts.push(`ms=${navigator.mediaSession.playbackState}`);
        }
    } catch (e) { /* ignore */ }
    return parts.join(' ');
}

// Attach a statechange listener to the shared context ONCE, so a context INTERRUPTION is caught even
// when it happens BETWEEN two 0.1 s watchdog ticks (an interrupted context stops rendering, so the tick
// itself may pause and miss the transition). Idempotent per context. Only logs while a session is active
// — a statechange while stopped isn't a playback wobble. Called from stemPlayer.ensureCtx().
const watched = new WeakSet();
export function watch(ctx) {
    if (!ctx || !ctx.addEventListener || watched.has(ctx)) return;
    watched.add(ctx);
    ctx.addEventListener('statechange', () => {
        if (!sessionActive) return;
        try {
            const at = num(ctx.currentTime, 2);
            // Include the environment snapshot so the NEXT warble's log names the trigger (hidden page =
            // lock/background; PAUSED sink = iOS grabbed the audio; route hints for BT/headphone flips).
            console.warn(`[stems-health] STATECHANGE @t=${at}s -> ${ctx.state} (rate=${ctx.sampleRate}) [${envSnapshot()}]`);
            // Force a ring dump around the transition — this is the highest-value moment for the wobble.
            dump(`context ${ctx.state}`, /*force*/ true);
        } catch (e) { /* never break on a state event */ }
    });
}

// Begin a fresh capture session (called from play()). Clears the ring so an old session's tail can't
// masquerade as current data, and logs a one-line summary so the log shows playback started cleanly.
export function begin(ctx, tempoRatio, pitchSemitones) {
    ring = [];
    prev = null;
    driftRun = 0;
    sessionActive = true;
    lastRate = ctx ? ctx.sampleRate : null;
    lastState = ctx ? ctx.state : null;
    try {
        console.warn(`[stems-health] play: rate=${lastRate} state=${lastState} ` +
            `tempo=${num(tempoRatio, 3)} pitchSemis=${pitchSemitones}`);
    } catch (e) { /* logging must never break playback */ }
}

// End the session (stop/pause). Quiet — no dump on a normal stop.
export function end() {
    sessionActive = false;
    prev = null;
    driftRun = 0;
}

// Sample one tick. Call from the stretch node's setUpdateInterval callback with the context and the
// worklet's reported song-position + the current tempoRatio. Pure bookkeeping + anomaly checks; it never
// throws into the audio path (all wrapped). Returns nothing.
export function tick(ctx, pos, tempoRatio) {
    if (!sessionActive || !ctx) return;
    try {
        const t = ctx.currentTime;
        const rate = ctx.sampleRate;
        const st = ctx.state;
        const sample = { t, pos, rate, st, tempo: tempoRatio };

        ring.push(sample);
        if (ring.length > RING_MAX) ring.shift();

        // Rate + state changes are DISCRETE and rare, so they FORCE a dump (they're the highest-value
        // signals and bypassing the cooldown ensures the very first one is never swallowed). Drift is a
        // per-tick continuous signal, so it respects the cooldown (one window per event, not per tick).
        const hard = [];   // force-dump reasons (rate/state change)
        let drift = null;  // cooldown-limited reason

        // (2) Rate change — a hard fingerprint of the wrong-rate wobble.
        if (lastRate != null && rate !== lastRate) {
            hard.push(`RATE CHANGED ${lastRate}->${rate}`);
        }
        // (1) Context state change into a non-running state (or back out of one).
        if (lastState != null && st !== lastState) {
            hard.push(`STATE ${lastState}->${st}`);
        }

        // (3) Position drift: expected advance = tempoRatio × wall-clock delta. Compare to actual.
        if (prev && st === 'running' && prev.st === 'running') {
            const dWall = t - prev.t;
            if (dWall > 0.02) {                 // ignore sub-tick duplicate callbacks
                const dPos = pos - prev.pos;
                const expected = (tempoRatio || 1) * dWall;
                // Ratio of actual to expected advance; 1.0 = on tempo. Skip loop wraps (dPos < 0).
                if (dPos >= 0 && expected > 0) {
                    const advRatio = dPos / expected;
                    if (Math.abs(advRatio - 1) > DRIFT_TOLERANCE) {
                        driftRun++;
                        if (driftRun >= DRIFT_MIN_TICKS) {
                            drift = `DRIFT advRatio=${num(advRatio, 3)} (${driftRun} ticks) ` +
                                `dPos=${num(dPos, 3)} expected=${num(expected, 3)}`;
                        }
                    } else {
                        driftRun = 0;
                    }
                }
            }
        }

        lastRate = rate;
        lastState = st;
        prev = sample;

        if (hard.length > 0) dump(hard.join('; '), /*force*/ true);
        if (drift) dump(drift); // cooldown-limited
    } catch (e) { /* never break the tick */ }
}

// User-initiated capture: dump the current ring window on demand (a 'capture' button, or a diagnostics
// call), regardless of anomalies. Ignores the cooldown so an explicit tap always produces output.
export function snapshot(label) {
    dump(`MANUAL SNAPSHOT${label ? ' ' + label : ''}`, /*force*/ true);
}

// Emit the anomaly header + a compact rendering of the ring window to console.warn (→ diagnostics funnel).
// Rate-limited unless forced, so an interruption storm (many statechange ticks) logs ONE window, not 50.
function dump(header, force) {
    const ms = nowMs();
    if (!force && ms - lastDumpAtMs < ANOMALY_COOLDOWN_MS) return;
    lastDumpAtMs = ms;
    try {
        const last = ring.length ? ring[ring.length - 1] : null;
        const at = last ? num(last.t, 2) : '?';
        console.warn(`[stems-health] ANOMALY @t=${at}s: ${header}`);
        // Render the last ~4 s of ticks (40 samples) so the window is readable but shows the run-up.
        const tail = ring.slice(-40);
        const line = tail.map(s =>
            `t${num(s.t, 1)} p${num(s.pos, 2)} ${s.rate} ${short(s.st)}`).join(' | ');
        console.warn(`[stems-health]   ring(${tail.length}/${ring.length}): ${line}`);
    } catch (e) {
        try { console.warn(`[stems-health]   (failed to render ring: ${e && e.name})`); } catch (_) { }
    }
}

function short(state) {
    if (state === 'running') return 'run';
    if (state === 'interrupted') return 'INT';
    if (state === 'suspended') return 'SUS';
    if (state === 'closed') return 'CLS';
    return state || '?';
}

function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : String(v);
}
