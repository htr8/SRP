// iOS/Android lock-screen + Control Center now-playing controls via the Media Session API
// (navigator.mediaSession). The web twin of MauiNowPlaying: it puts the song's title/artist on the
// lock screen and wires the play / pause / seek buttons back into the app's transport.
//
// Why this works on the WEB build specifically: iOS only surfaces MediaSession controls for a page
// that owns a *playing HTMLMediaElement it recognizes as the active media*. The app already has one
// — the background keep-alive <audio> sink in audioUnlock.js that carries the real mix so audio
// survives a screen lock. MediaSession latches onto that element automatically; we only supply the
// metadata and the action handlers. Best-effort throughout: unsupported browsers (older Safari) just
// no-op, and a handler that the app can't service (e.g. seek before load) is swallowed.
//
// Node-import safe: nothing touches navigator/window at module scope (the smoke test imports this).

let dotnet = null;         // DotNetObjectReference<PracticeStudio> for the action callbacks
let attached = false;      // action handlers installed once
let lastPlaying = false;

function supported() {
    return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

// The app-logo artwork URL, resolved against the document base so it works on the /SRP/ Pages subpath
// and the native WebView alike (new URL(relative, document.baseURI) honors the <base href>).
function artworkUrl() {
    try { return new URL('app-logo-512.png', document.baseURI).href; }
    catch (e) { return 'app-logo-512.png'; }
}

// Wire the lock-screen buttons to the app. Idempotent. The handlers call [JSInvokable] methods on
// PracticeStudio (same pattern as the keyboard-shortcut bridge). A null/failed handler is a no-op —
// iOS then simply doesn't show that button, which is the correct degradation.
export function attach(dotNetRef) {
    dotnet = dotNetRef;
    if (!supported() || attached) return supported();
    const ms = navigator.mediaSession;

    const set = (action, fn) => {
        try { ms.setActionHandler(action, fn); }
        catch (e) { /* action unsupported on this engine — leave it unhandled */ }
    };
    const call = (method, arg) => {
        if (!dotnet) return;
        try {
            const p = arg === undefined
                ? dotnet.invokeMethodAsync(method)
                : dotnet.invokeMethodAsync(method, arg);
            if (p && p.catch) p.catch(() => { }); // disposed ref / late tap → no-op
        } catch (e) { /* sync throw (disposed) → no-op */ }
    };

    set('play', () => call('MediaSessionPlay'));
    set('pause', () => call('MediaSessionPause'));
    set('stop', () => call('MediaSessionStop'));

    // The two SIDE buttons on the iOS lock screen are a SINGLE pair of slots that iOS fills with EITHER
    // skip-±Ns (seekbackward/seekforward) OR track prev/next (previoustrack/nexttrack) — and when BOTH
    // are registered, iOS keeps the skip buttons and SILENTLY DROPS prev/next (user report 2026-07-12:
    // "new logo shows but not the additional controls"). The user asked for prev/next SONG (setlist nav)
    // on the lock screen, so we DON'T register seekbackward/seekforward — prev/next own the side slots.
    // The ±5 s nudge is unaffected in-app (transport buttons) and off-screen when locked is an acceptable
    // trade for the far more useful setlist hop. (There is also no dedicated `stop` slot in the iOS Now
    // Playing UI — the `stop` handler above is a no-op visually on iOS, honored on engines that show it.)
    set('previoustrack', () => call('MediaSessionPreviousTrack'));
    set('nexttrack', () => call('MediaSessionNextTrack'));

    // Absolute scrub (the lock-screen progress bar) is a SEPARATE surface from the side buttons, so it
    // coexists with prev/next: iOS passes details.seekTime in seconds.
    set('seekto', (details) => {
        if (details && typeof details.seekTime === 'number') call('MediaSessionSeekTo', details.seekTime);
    });

    attached = true;
    return true;
}

// Publish the current transport state. Called on every play/pause/stop transition (INowPlaying
// contract) — iOS extrapolates the playhead from position + playbackState, so per-second calls
// aren't needed. Title/artist show on the lock screen; playbackState drives the play/pause glyph.
export function setMetadata(title, artist, isPlaying, durationSeconds, positionSeconds) {
    if (!supported()) return;
    const ms = navigator.mediaSession;
    try {
        if (typeof MediaMetadata === 'function') {
            ms.metadata = new MediaMetadata({
                title: title || 'Mastery Studio',
                artist: artist || '',
                album: 'Mastery Studio',
                // The app logo (the iOS app icon's level-bars mark) as lock-screen artwork. Resolved
                // against the document base so it works on the /SRP/ Pages subpath; iOS picks the size
                // it needs from the one 512 we ship.
                artwork: [
                    { src: artworkUrl(), sizes: '512x512', type: 'image/png' },
                ],
            });
        }
    } catch (e) { /* metadata construction unsupported — controls can still work without it */ }

    try { ms.playbackState = isPlaying ? 'playing' : 'paused'; } catch (e) { }

    // DELIBERATELY NOT calling setPositionState with a duration/position. On the iOS lock screen a live
    // position state makes iOS render its built-in ±15 s scrub-skip arrows on the two side slots — and
    // those slots are the SAME ones previoustrack/nexttrack would use, so the scrubber WINS and prev/next
    // never appear (user report 2026-07-12: "play/pause + ±15s skip, not track prev/next"). The user
    // wants prev/next SONG (setlist nav) there, so we suppress the scrubber: clear any position state a
    // prior build/session set (setPositionState() with no arg resets it) so iOS drops the ±15 s arrows
    // and falls back to showing the prev/next handlers as ⏮/⏭. Trade-off: no lock-screen scrubber — the
    // in-app waveform is the scrub surface; the lock screen is for transport + set nav.
    try {
        if (typeof ms.setPositionState === 'function') {
            ms.setPositionState(); // no argument = clear → iOS shows prev/next, not the scrubber skip
        }
    } catch (e) { /* clearing unsupported — nothing to undo */ }
    void durationSeconds; void positionSeconds; // no longer published to the lock screen (see above)

    lastPlaying = isPlaying;
}

// Tear the entry down (stop / song cleared): clear metadata and mark stopped so iOS drops the
// lock-screen card rather than leaving a stale "paused" entry.
export function clear() {
    if (!supported()) return;
    const ms = navigator.mediaSession;
    try { ms.metadata = null; } catch (e) { }
    try { ms.playbackState = 'none'; } catch (e) { }
    lastPlaying = false;
}
