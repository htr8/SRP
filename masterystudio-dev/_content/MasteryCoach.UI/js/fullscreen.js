// Browser Fullscreen API interop for Session mode (SessionModePlan.md P2). Requests/exits fullscreen so
// the OS status bar and browser chrome get out of the way on a phone on a stand. Best-effort: where the
// API is missing or refused (notably iOS Safari, which does NOT support element fullscreen for non-video),
// this no-ops and the caller falls back to the full-viewport minimal-chrome shell.
//
// CRITICAL (caller contract): requestFullscreen() must be called SYNCHRONOUSLY from within a user-gesture
// handler — browsers require transient activation and reject a fullscreen request issued after an await.
// So the Session-mode entry button must call enter() BEFORE it awaits media load / set-run start. enter()
// itself does no awaiting before the request for exactly this reason.
//
// Node-import safe: nothing touches document at module scope (the import smoke test loads this).

// Vendor-prefixed fallbacks (older WebKit). Resolve lazily so module import stays Node-safe.
function fsElement() {
    if (typeof document === 'undefined') return null;
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function requestOn(el) {
    // Standard, then WebKit-prefixed. Returns a promise or undefined; callers ignore the result.
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    return fn ? fn.call(el) : undefined;
}

function exitFn() {
    if (typeof document === 'undefined') return null;
    return document.exitFullscreen || document.webkitExitFullscreen || null;
}

// True when the browser exposes an element-fullscreen API at all (iOS Safari returns false).
export function isSupported() {
    if (typeof document === 'undefined' || typeof document.documentElement === 'undefined') return false;
    const el = document.documentElement;
    return !!(el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen);
}

// Enter fullscreen on <html> (the whole app). MUST be called synchronously in a user gesture (see top).
// Returns true if a request was issued (not a guarantee it was granted — that resolves async and may be
// refused; the caller doesn't depend on it). Swallows everything: fullscreen is a nicety, never fatal.
export function enter() {
    try {
        if (!isSupported() || fsElement()) return false;
        const p = requestOn(document.documentElement);
        if (p && p.catch) p.catch(() => { }); // refused (no activation / policy) — the shell still works
        return true;
    } catch (e) {
        return false;
    }
}

// Leave fullscreen if we're in it. Best-effort.
export function exit() {
    try {
        if (!fsElement()) return;
        const fn = exitFn();
        if (fn) {
            const p = fn.call(document);
            if (p && p.catch) p.catch(() => { });
        }
    } catch (e) { /* already out / unsupported — no-op */ }
}

// Whether the document is currently in fullscreen.
export function isActive() {
    return !!fsElement();
}

// Notify .NET when fullscreen changes (e.g. the user pressed Esc / swiped to exit), so Session mode can
// reconcile its own state. Idempotent; returns a disposer. `dotnet` gets a [JSInvokable] OnFullscreenChange(bool).
let wired = null;
export function watch(dotnet) {
    if (typeof document === 'undefined' || wired) return;
    const handler = () => {
        if (!dotnet) return;
        try {
            const p = dotnet.invokeMethodAsync('OnFullscreenChange', isActive());
            if (p && p.catch) p.catch(() => { }); // disposed ref → no-op
        } catch (e) { /* sync throw (disposed) → no-op */ }
    };
    document.addEventListener('fullscreenchange', handler);
    document.addEventListener('webkitfullscreenchange', handler);
    wired = () => {
        document.removeEventListener('fullscreenchange', handler);
        document.removeEventListener('webkitfullscreenchange', handler);
        wired = null;
    };
    return wired;
}

export function unwatch() {
    if (wired) wired();
}
