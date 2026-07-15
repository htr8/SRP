// A tiny best-effort haptic: a short vibration to confirm an event without looking at the screen (the
// tuner fires it when a string lands in tune). navigator.vibrate is supported on Android/Chrome; iOS
// Safari has no vibrate API, so this is a silent no-op there — the visual flash still carries the cue.
export function buzz(ms) {
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
            navigator.vibrate(Math.max(1, Math.min(ms | 0, 200)));
        }
    } catch (e) { /* vibrate can throw if the page isn't focused — ignore, it's a nicety */ }
}
