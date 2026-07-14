// Keeps the device SCREEN awake while any caller holds it, via the Screen Wake Lock API
// (navigator.wakeLock). A phone left on a music stand during practice/performance would otherwise dim
// and lock; this holds the display on for as long as at least one HOLD is active. It is NOT the
// lock-screen now-playing controls (that's mediaSession.js) — this only prevents the screen sleeping.
//
// NAMED / COUNTED HOLDS (SessionModePlan.md P1): several independent callers want the screen awake at
// overlapping times — 'playback', 'recording', 'tuner', and 'session' (Session mode holds it for a whole
// setlist, ACROSS song stops). A single bool broke that: any caller's release() dropped everyone's lock,
// so a playback stop inside Session mode would let the screen sleep between songs. Instead we track a SET
// of active hold ids; the underlying OS lock is held while the set is non-empty and released only when it
// empties. acquire(id)/release(id) add/remove one id; the no-arg forms use a 'default' id so existing
// callers keep working unchanged.
//
// Works in every WebView the app runs in: the standalone web build (Safari 16.4+ / Chrome) and the
// MAUI BlazorWebView on both iOS and Android. Unsupported engines no-op cleanly.
//
// The API's one sharp edge, handled here: the OS AUTO-RELEASES a screen wake lock whenever the page
// becomes hidden (tab switch, app background, screen lock). It does NOT come back on its own. So we
// track our own intent (the hold set) and re-acquire on `visibilitychange` when the page is visible
// again and a hold is still active. Without that, one glance away permanently drops the lock.
//
// Best-effort throughout — a rejected request (e.g. Low Power Mode denies it) is swallowed; playback
// must never be affected by whether the screen stays on.
//
// Node-import safe: nothing touches navigator/document at module scope (the smoke test imports this).

const DEFAULT_ID = 'default';
let sentinel = null;      // the active WakeLockSentinel, or null when not held
const holds = new Set();  // active hold ids; the OS lock is wanted while this is non-empty
let wired = false;        // visibilitychange listener installed once
let requesting = false;   // a navigator.wakeLock.request() is in flight (re-entrancy guard)

// Does anyone currently want the screen kept awake?
function wanted() {
    return holds.size > 0;
}

function supported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

// Install the re-acquire-on-return listener exactly once. The OS drops the sentinel when the page
// hides; when it's visible again and a hold is still active, request a fresh one. (The sentinel also
// fires its own 'release' event on that OS drop — we null it there so state stays honest.)
function ensureWired() {
    if (wired || typeof document === 'undefined') return;
    wired = true;
    document.addEventListener('visibilitychange', () => {
        if (wanted() && document.visibilityState === 'visible') {
            request();
        }
    });
}

async function request() {
    // Guard on BOTH `sentinel` (already held) and `requesting` (a request is mid-flight). The mid-flight
    // guard is essential: navigator.wakeLock.request() is async and doesn't assign `sentinel` until it
    // resolves, so without it two overlapping request() calls (e.g. a record-start firing two acquires,
    // or a visibilitychange racing an acquire) would BOTH pass a bare `!sentinel` check, each acquire a
    // distinct sentinel, and the second would orphan the first — a leaked lock never released.
    if (!supported() || sentinel || requesting) return;
    requesting = true;
    try {
        const s = await navigator.wakeLock.request('screen');
        // If every hold was released while the async request was in flight, immediately release it.
        if (!wanted()) { try { await s.release(); } catch (e) { } return; }
        sentinel = s;
        // The OS drops the lock on hide and surfaces it as a 'release' event; forget the sentinel — but
        // only if it's still THIS one — so a later acquire() requests a fresh lock instead of assuming we
        // still hold this dead handle, and a stale listener can't null a newer live sentinel.
        s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
    } catch (e) {
        // Denied (Low Power Mode, permissions policy) or transient — leave sentinel null; a later
        // visibilitychange or acquire() will retry. Never throw into the caller.
        sentinel = null;
    } finally {
        requesting = false;
    }
}

// Ask to keep the screen awake under a named hold. Idempotent per id (re-acquiring the same id is a
// no-op). `id` omitted → the shared 'default' hold, so existing callers (acquire()) are unchanged.
export function acquire(id) {
    holds.add(id || DEFAULT_ID);
    if (!supported()) return;
    ensureWired();
    request(); // no-op if already held / mid-flight
}

// Drop one named hold. The OS lock is torn down ONLY when NO holds remain — so a 'playback' release
// inside Session mode leaves the 'session' hold (and the screen) alive. `id` omitted → 'default'.
export function release(id) {
    holds.delete(id || DEFAULT_ID);
    if (wanted()) return; // other holds keep the screen awake
    if (!sentinel) return;
    const s = sentinel;
    sentinel = null;
    try {
        const p = s.release();
        if (p && p.catch) p.catch(() => { });
    } catch (e) { /* already released by the OS → no-op */ }
}

// Drop ALL holds and release the lock (service dispose / hard reset). Best-effort.
export function releaseAll() {
    holds.clear();
    release(); // no holds remain → tears down the sentinel
}

// Test hook: the active hold ids + whether the lock is wanted. The counted-hold logic runs BEFORE the
// navigator.wakeLock calls (which no-op in Node), so this is verifiable in a Node module test without a
// browser. Not for production callers.
export function _wakeLockStateForTest() {
    return { holds: [...holds].sort(), wanted: wanted() };
}
