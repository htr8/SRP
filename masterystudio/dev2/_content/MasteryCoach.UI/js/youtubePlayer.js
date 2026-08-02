// Official YouTube IFrame Player API boundary (VideoLibraryAndStudioSourcePlan.md §8.3).
// This deliberately owns only the visible iframe supplied by the host. It creates no overlay,
// custom controls, or gesture target; the YouTube player remains unobstructed.

let loadAttempt = null;
const API_READY_TIMEOUT_MS = 20_000;
const WATCH_INTERVAL_MS = 100;
const SEEK_SETTLE_MS = 500;
const DESTINATION_MARGIN_SECONDS = 0.05;
const PLAYER_STATE_PLAYING = 1;

function apiReady() {
    return typeof window !== 'undefined' && typeof window.YT?.Player === 'function';
}

function safeCallback(callbacks, method, ...args) {
    if (!callbacks) return;
    try {
        const callback = callbacks[method];
        if (typeof callback === 'function') {
            const result = callback(...args);
            if (result?.catch) result.catch(() => { });
            return;
        }
        if (typeof callbacks.invokeMethodAsync === 'function') {
            const result = callbacks.invokeMethodAsync(method, ...args);
            if (result?.catch) result.catch(() => { });
        }
    } catch {
        // A disposed DotNetObjectReference can throw synchronously. Player events must not take
        // down the circuit after its host has been removed.
    }
}

function loaderError(detail) {
    return new Error(`youtubePlayer.loadApiOnce failed: ${detail}`);
}

/// Loads one official API script per active attempt. A failed attempt rejects every caller, removes
/// its failed tag, and clears shared state so the next caller gets a genuine retry.
export function loadApiOnce() {
    if (apiReady()) return Promise.resolve(window.YT);
    if (loadAttempt) return loadAttempt.promise;
    if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(loaderError('window and document are required to load the IFrame API.'));
    }

    let resolveAttempt;
    let rejectAttempt;
    const priorReady = window.onYouTubeIframeAPIReady;
    const script = document.createElement('script');
    const attempt = {
        promise: new Promise((resolve, reject) => { resolveAttempt = resolve; rejectAttempt = reject; }),
        script,
        finished: false
    };
    let readyTimer = null;
    loadAttempt = attempt;

    const restorePriorReady = () => {
        if (window.onYouTubeIframeAPIReady === ready) {
            window.onYouTubeIframeAPIReady = priorReady;
        }
    };
    const fail = (detail) => {
        if (attempt.finished) return;
        attempt.finished = true;
        if (readyTimer !== null) clearTimeout(readyTimer);
        restorePriorReady();
        script.remove?.();
        if (loadAttempt === attempt) loadAttempt = null;
        rejectAttempt(loaderError(detail));
    };
    const succeed = () => {
        if (attempt.finished) return;
        if (!apiReady()) {
            fail('the API reported ready but window.YT.Player is unavailable.');
            return;
        }
        attempt.finished = true;
        if (readyTimer !== null) clearTimeout(readyTimer);
        if (loadAttempt === attempt) loadAttempt = null;
        resolveAttempt(window.YT);
    };
    const ready = () => {
        try { priorReady?.(); } catch { /* another host's callback must not block this API load */ }
        succeed();
    };

    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => fail('the official IFrame API script could not load.');
    script.onload = () => {
        if (apiReady()) succeed();
        else {
            // A successful network load without the documented ready callback is still a failed
            // API load. Time out so callers can report it and a later create can retry.
            readyTimer = setTimeout(
                () => fail(`the IFrame API did not expose window.YT.Player within ${API_READY_TIMEOUT_MS} ms.`),
                API_READY_TIMEOUT_MS);
        }
    };
    window.onYouTubeIframeAPIReady = ready;
    document.head.appendChild(script);
    return attempt.promise;
}

function requirePlayer(handle, operation) {
    if (!handle || handle.destroyed || !handle.player) {
        throw new Error(`youtubePlayer.${operation} failed: the player has been destroyed or was not created.`);
    }
    return handle.player;
}

function finiteOrZero(value) {
    return Number.isFinite(value) ? value : 0;
}

function reportEnforcementFailure(handle, operation, error) {
    safeCallback(handle.callbacks, 'OnEnforcementFailed',
        `YouTube ${operation} enforcement failed: ${error?.message ?? error}`);
}

function stopWatcher(handle) {
    if (handle.watcher !== null) clearInterval(handle.watcher);
    handle.watcher = null;
    handle.suppression = null;
    handle.lastTime = null;
}

function safelyInsideDestination(time, target, range) {
    const lower = target + DESTINATION_MARGIN_SECONDS;
    const upper = range.end - DESTINATION_MARGIN_SECONDS;
    return lower < upper && time >= lower && time <= upper;
}

function seekForEnforcement(handle, target, kind) {
    try {
        requirePlayer(handle, `${kind} enforcement`).seekTo(target, true);
        handle.suppression = { target, kind, until: Date.now() + SEEK_SETTLE_MS };
        return true;
    } catch (error) {
        reportEnforcementFailure(handle, kind, error);
        return false;
    }
}

function watch(handle) {
    if (handle.destroyed || !handle.player) return;
    try {
        if (handle.player.getPlayerState() !== PLAYER_STATE_PLAYING) return;
    } catch (error) {
        reportEnforcementFailure(handle, 'player-state observation', error);
        return;
    }
    let time;
    try {
        time = handle.player.getCurrentTime();
        if (!Number.isFinite(time) || time < 0) throw new Error(`player returned invalid current time '${time}'.`);
    } catch (error) {
        reportEnforcementFailure(handle, 'timeline observation', error);
        return;
    }

    const range = handle.range;
    if (handle.suppression) {
        if (range && safelyInsideDestination(time, handle.suppression.target, range)) {
            handle.suppression = null;
        } else if (Date.now() < handle.suppression.until) {
            handle.lastTime = time;
            return;
        } else {
            // A keyframe seek can report a point beyond the requested destination.  Release the
            // latch after a bounded settle window. This is a reported, bounded retry rather than
            // a next-poll double seek or a latch that disables the loop forever.
            const suppressed = handle.suppression;
            handle.suppression = null;
            handle.lastTime = time;
            reportEnforcementFailure(handle, suppressed.kind,
                new Error(`seek did not settle near ${suppressed.target} seconds before retrying.`));
            seekForEnforcement(handle, suppressed.target, suppressed.kind);
            return;
        }
    }

    const previous = handle.lastTime;
    handle.lastTime = time;
    if (previous === null) return;

    // Skip marks win over loops just as they do for local video. A fired mark clears the loop so a
    // return jump cannot be immediately wrapped by an old A/B boundary.
    const crossedMark = handle.skipMarks.find((mark) => previous < mark.skipAt && time >= mark.skipAt);
    if (crossedMark) {
        handle.range = null;
        seekForEnforcement(handle, crossedMark.jumpTo, 'skip mark');
        return;
    }

    if (range?.end !== null && previous < range.end && time >= range.end) {
        if (range.loop) seekForEnforcement(handle, range.start, 'loop');
        else {
            try { requirePlayer(handle, 'range end enforcement').pauseVideo(); }
            catch (error) { reportEnforcementFailure(handle, 'range end', error); }
        }
    }
}

function startWatcher(handle) {
    if (handle.watcher !== null || handle.destroyed || !handle.player) return;
    handle.watcher = setInterval(() => watch(handle), WATCH_INTERVAL_MS);
}

function isUsableOrigin(origin) {
    return typeof origin === 'string' && /^https?:\/\/[^/?#]+$/i.test(origin);
}

// The host must supply its real navigated document origin to the official player.  Keeping this
// read here avoids a string-backed origin (notably about:blank in a WebView) leaking in from .NET.
export function getDocumentOrigin() {
    const origin = typeof window === 'undefined' ? null : window.location?.origin;
    return isUsableOrigin(origin) ? origin : null;
}

function projectOpenOnYouTube(container, videoId, callbacks) {
    // An IFrame API origin is a host capability, not something this module may invent. In
    // particular, do not turn an unavailable document origin into about:blank or a build-time
    // value: YouTube can reject either. Keep the user's reference usable through YouTube instead.
    const link = document.createElement('a');
    link.href = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open on YouTube';
    link.className = 'youtube-open-link';
    container.appendChild(link);
    safeCallback(callbacks, 'OnOriginUnavailable');
    return { player: null, host: link, callbacks: null, destroyed: false, openOnYouTube: true };
}

/// Creates a scoped, visible official player. `origin` must be the host's validated app origin;
/// when that origin is unavailable, this projects Open on YouTube and does not create a player.
export async function create(container, videoId, origin, callbacks = null) {
    if (!container || typeof container.appendChild !== 'function') {
        throw new Error('youtubePlayer.create failed: a host container is required.');
    }
    if (typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        throw new Error(`youtubePlayer.create failed: '${videoId}' is not a valid 11-character YouTube video id.`);
    }
    if (!isUsableOrigin(origin)) {
        return projectOpenOnYouTube(container, videoId, callbacks);
    }

    const YT = await loadApiOnce();
    const host = document.createElement('div');
    container.appendChild(host);
    const handle = { player: null, host, callbacks, destroyed: false, range: null, skipMarks: [], watcher: null, suppression: null, lastTime: null };
    const emit = (name, ...args) => {
        if (!handle.destroyed) safeCallback(handle.callbacks, name, ...args);
    };

    try {
        handle.player = new YT.Player(host, {
            videoId,
            width: '200',
            height: '200',
            playerVars: { enablejsapi: 1, playsinline: 1, controls: 1, origin },
            events: {
                onReady: () => emit('OnReady'),
                onStateChange: (event) => {
                    const state = event?.data;
                    if (state === PLAYER_STATE_PLAYING) startWatcher(handle);
                    else stopWatcher(handle);
                    emit('OnStateChanged', state);
                },
                onPlaybackRateChange: (event) => emit('OnPlaybackRateChanged', event?.data),
                onError: (event) => emit('OnError', event?.data)
            }
        });
    } catch (error) {
        host.remove?.();
        throw new Error(`youtubePlayer.create failed to construct the official player: ${error?.message ?? error}`);
    }
    return handle;
}

export function play(handle) { requirePlayer(handle, 'play').playVideo(); }
export function pause(handle) { requirePlayer(handle, 'pause').pauseVideo(); }
export function stop(handle) { requirePlayer(handle, 'stop').stopVideo(); }
export function seekTo(handle, seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`youtubePlayer.seekTo requires a non-negative finite time; got '${seconds}'.`);
    requirePlayer(handle, 'seekTo').seekTo(seconds, true);
}
export function getCurrentTime(handle) { return finiteOrZero(requirePlayer(handle, 'getCurrentTime').getCurrentTime()); }
export function getDuration(handle) { return finiteOrZero(requirePlayer(handle, 'getDuration').getDuration()); }
export function getPlayerState(handle) { return requirePlayer(handle, 'getPlayerState').getPlayerState(); }
export function getAvailablePlaybackRates(handle) {
    const rates = requirePlayer(handle, 'getAvailablePlaybackRates').getAvailablePlaybackRates();
    return Array.isArray(rates) ? rates.filter((rate) => Number.isFinite(rate) && rate > 0) : [];
}
export function getPlaybackRate(handle) { return finiteOrZero(requirePlayer(handle, 'getPlaybackRate').getPlaybackRate()); }

// A request is deliberately not a callback: UI confirmation belongs exclusively to the official
// onPlaybackRateChange event above, which prevents an unsupported requested rate looking applied.
export function setPlaybackRate(handle, rate) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`youtubePlayer.setPlaybackRate requires a positive finite rate; got '${rate}'.`);
    requirePlayer(handle, 'setPlaybackRate').setPlaybackRate(rate);
}

// These rules are deliberately polling-based: YouTube does not expose a frame callback and seeks
// are approximate.  Inputs are normalized at the boundary so malformed interop cannot install an
// invisible watcher configuration.
export function setLoop(handle, start, end, loop) {
    requirePlayer(handle, 'setLoop');
    if (start === null || start === undefined) {
        handle.range = null;
        handle.suppression = null;
        return true;
    }
    if (!Number.isFinite(start) || start < 0) throw new Error(`youtubePlayer.setLoop requires a non-negative finite start; got '${start}'.`);
    if (end !== null && end !== undefined && (!Number.isFinite(end) || end <= start)) {
        throw new Error(`youtubePlayer.setLoop requires an end after start; got '${end}'.`);
    }
    handle.range = { start, end: end ?? null, loop: loop === true };
    handle.suppression = null;
    handle.lastTime = null;
    return true;
}

export function setSkipMarks(handle, marks) {
    requirePlayer(handle, 'setSkipMarks');
    if (!Array.isArray(marks)) throw new Error('youtubePlayer.setSkipMarks requires an array.');
    handle.skipMarks = marks
        .filter((mark) => Number.isFinite(mark?.skipAt) && mark.skipAt >= 0 && Number.isFinite(mark?.jumpTo) && mark.jumpTo >= 0 && mark.jumpTo > mark.skipAt)
        .map((mark) => ({ skipAt: mark.skipAt, jumpTo: mark.jumpTo }))
        .sort((left, right) => left.skipAt - right.skipAt);
    handle.suppression = null;
    handle.lastTime = null;
    return handle.skipMarks.length;
}

export function destroy(handle) {
    if (!handle || handle.destroyed) return false;
    handle.destroyed = true; // silence re-entrant/late IFrame API callbacks before teardown.
    stopWatcher(handle);
    let failure = null;
    try { handle.player?.destroy(); } catch (error) { failure = error; }
    handle.player = null;
    handle.callbacks = null;
    handle.host?.remove?.();
    handle.host = null;
    if (failure) throw new Error(`youtubePlayer.destroy failed to destroy the official player: ${failure?.message ?? failure}`);
    return true;
}
