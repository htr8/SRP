// The local-video playback engine (VideoLibraryAndStudioSourcePlan.md §8.2, phase4-video-transport-
// surface). The C# side is MasteryCoach.UI.Services.JsVideoPlayer, which binds this module to the
// existing ITransport (VideoTransportContract.md — there is no IVideoTransport).
//
// SCOPE — read this before adding anything:
//   - This module owns EXACTLY ONE <video playsinline preload="metadata"> element, handed to it by
//     the rendered VideoPlayer component via attach(). It never creates or queries elements itself.
//   - Loop-window and skip-mark ENFORCEMENT lives here (phase4-video-011): setLoop/setSkipMarks plus
//     the rendered-frame watcher below. The YOUTUBE watcher is NOT here — §8.3's approximate
//     seekTo-based one belongs to youtubePlayer.js (phase 8).
//   - LOCAL-VIDEO FULLSCREEN lives here (phase4-video-012, §8.4's optional local-video polish):
//     bindFullscreenToggle() plus the change listeners in attach(). It is deliberately NOT in
//     fullscreen.js — that module puts <html> into fullscreen for Session mode and states outright
//     that iOS Safari has no element-fullscreen API. A <video> element on iOS DOES have one
//     (webkitEnterFullscreen + webkitbegin/endfullscreen events), and it is element-scoped, so it
//     shares this module's element and detach() bookkeeping rather than fullscreen.js's document-level
//     singleton.
//   - The YouTube transport is a SEPARATE module (§8.3). Do not teach this <video> element to load a
//     YouTube URL.
//
// THE THREE RULES THE SHAPE ENFORCES:
//
//   1. GESTURE SAFETY (§8.2 "User-gesture handling"). The first audible play() must execute from a
//      direct JS handler reached by the user's tap. A C# async round trip (Blazor @onclick ->
//      dispatcher -> interop) does not reliably retain Safari's transient activation, and the play()
//      then rejects with NotAllowedError. bindPlayToggle() installs a real DOM listener that calls
//      element.play() SYNCHRONOUSLY inside the pointer event; .NET is told afterwards.
//   2. NATURAL PITCH (§2.6). Tempo is playbackRate, and preservesPitch must be true BEFORE play and
//      re-applied on every rate change — some engines reset it when the source or rate changes, and a
//      chipmunked backing video is not the product's meaning of "slow it down".
//   3. NO UNGUARDED INTEROP (repo rule, 2026-07-12 stale-reference flood). Every invokeMethodAsync
//      here goes through safeInvoke, which swallows the rejection from an already-disposed
//      DotNetObjectReference. These callbacks fire from app-lifetime media events; an unguarded one
//      can tear down the whole WASM circuit.
//
// Node-import safe (tests/js/module-imports.test.mjs): no browser globals are touched at module scope.

/// Position reports per second. §8.2 fixes the band at 4-10 Hz ("Never render on every video frame"):
/// slower than 4 Hz makes the playhead visibly stutter, faster than 10 Hz spends the WASM render
/// budget on a number that only has ~2 significant digits on screen.
export const POSITION_HZ = 6;

/// Minimum gap between position callbacks, derived from POSITION_HZ so the two can never disagree.
export const POSITION_INTERVAL_MS = 1000 / POSITION_HZ;

// The single attached element and its .NET peer. Module-scoped because the module itself is the
// singleton the component attaches to and detaches from — the same lifetime shape as audioPlayer.js.
let video = null;
let dotnet = null;

// Listener bookkeeping, so detach/attach cannot leak a listener onto a replaced element.
let mediaListeners = [];
let triggerCleanups = [];

/// Cleanups for the DOCUMENT-level fullscreenchange listeners (see bindFullscreenToggle). Kept apart
/// from mediaListeners because they are not on the element: removeMediaListeners() iterates the
/// element, and a document listener left in that list would never be removed.
let documentListeners = [];

/// The element the stage is wrapped in, or null. Standard Fullscreen API fullscreens the CONTAINER,
/// not the bare <video>, so the stage's own chrome (the exit button, and later the timeline) stays
/// visible and styleable; iOS's webkitEnterFullscreen has no such choice and always takes the video.
let stage = null;

let lastPositionSentMs = -Infinity;
let positionTimer = null;

/// The active loop window: { start, end, loop } in seconds, or null for "play the whole track".
/// Mirrors audioPlayer.js's `state.range` field for field name and meaning, so the two engines'
/// SetLoopAsync arguments cannot mean different things.
let range = null;

/// Forward-only skip marks, sorted by skipAt: [{ skipAt, jumpTo }]. Ordering/chaining is precomputed
/// by the application layer (ITransport.SetSkipMarksAsync), so this module only compares and seeks.
let skipMarks = [];

/// The position this watcher last examined. A mark fires only when its skipAt lies in
/// (lastScan, position] — the half-open window is what makes ONE crossing produce ONE seek no matter
/// how many times the watcher samples the same instant. Identical to engineCommon.scanSkipMarks's
/// `lastSkipScan` cursor; the video engine keeps its own copy rather than importing that module
/// because engineCommon's helpers are written around the Web Audio player state object.
let lastScan = 0;

/// Set while a loop return seek is in flight, and cleared once currentTime is safely back inside the
/// destination. WITHOUT this a watcher sampling at frame rate sees `currentTime >= end` again on the
/// next frame (a media element's currentTime does not change until the seek completes) and issues a
/// second, third, ... seek — the "seek storm" that shows up on device as a stuttering loop point.
let loopReturnPending = false;

// The rendered-frame driver. rVFC fires once per COMPOSITED frame (the §8.2 preference: it is what
// makes "return within one rendered frame" measurable); rAF is the fallback where rVFC is missing.
// Both stop being called when the tab is hidden, which is why `timeupdate` also feeds the watcher as
// the safety signal §8.2 names.
let frameHandle = null;
let frameKind = null; // 'rvfc' | 'raf' | null

/// Call a .NET instance method, swallowing the rejection when the DotNetObjectReference has already
/// been disposed. `dotnet` stays truthy after .NET disposal, so a media event arriving between .NET
/// disposal and detach() would otherwise reject with "no tracked object with id N" — the flood that
/// broke solo/pause on web in 2026-07-12. A late callback becoming a silent no-op is the correct
/// behaviour for a torn-down component; a late callback taking the circuit down is not.
function safeInvoke(method, ...args) {
    if (!dotnet) return;
    try {
        const p = dotnet.invokeMethodAsync(method, ...args);
        if (p && p.catch) p.catch(() => { });
    } catch { /* synchronous throw from an already-disposed reference — also a no-op */ }
}

function addMediaListener(type, handler) {
    if (!video) return;
    video.addEventListener(type, handler);
    mediaListeners.push([type, handler]);
}

function removeMediaListeners() {
    if (video) {
        for (const [type, handler] of mediaListeners) {
            video.removeEventListener(type, handler);
        }
    }
    mediaListeners = [];
}

/// Report position at most POSITION_HZ times per second. `force` bypasses the gate for the edges that
/// must land exactly (a seek, a pause, the end) — throttling those would leave the playhead showing a
/// stale time after playback stopped moving.
function reportPosition(force) {
    if (!video) return;
    const nowMs = typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now();
    if (!force && nowMs - lastPositionSentMs < POSITION_INTERVAL_MS) return;
    lastPositionSentMs = nowMs;
    safeInvoke('OnPosition', currentTimeOrZero());
}

function currentTimeOrZero() {
    const t = video ? video.currentTime : 0;
    return Number.isFinite(t) ? t : 0;
}

/// Duration is NaN until metadata loads and Infinity for a still-recording stream. Both are reported
/// as 0 = "not known yet" rather than marshalled to .NET, where a NaN TimeSpan throws and an Infinity
/// one overflows. This is the same trap the recording spike hit: a container whose duration read back
/// as NaN must be visible as "unknown", never as a number.
function durationOrZero() {
    const d = video ? video.duration : 0;
    return Number.isFinite(d) && d > 0 ? d : 0;
}

/// The <video> element's MediaError code, or 0 when there is no error. Passed through verbatim so the
/// .NET side reports WHICH failure happened (2 = network, 3 = decode, 4 = src unsupported) rather
/// than a generic "video failed".
function mediaErrorCode() {
    return video && video.error && Number.isInteger(video.error.code) ? video.error.code : 0;
}

function startPositionTimer() {
    if (positionTimer !== null || typeof setInterval !== 'function') return;
    // A timer, not requestVideoFrameCallback/requestAnimationFrame: §8.2's frame-accurate driver
    // (startWatcher, below) belongs to loop enforcement alone. Position reporting is a UI readout and
    // must run at a fixed low rate whether or not frames are being painted — an rAF-driven readout
    // stops entirely when the tab is hidden, freezing the displayed time while audio keeps playing.
    positionTimer = setInterval(() => reportPosition(false), POSITION_INTERVAL_MS);
}

function stopPositionTimer() {
    if (positionTimer === null) return;
    clearInterval(positionTimer);
    positionTimer = null;
}

// -------------------------------------------------------------------------------------------------
// Loop + skip-mark enforcement (§8.2, phase4-video-011)
//
// SEMANTICS ARE THE AUDIO ENGINE'S, NOT A VIDEO-SPECIFIC INVENTION. audioPlayer.js's element path
// (its `timeupdate` handler) and engineCommon.scanSkipMarks define the contract this mirrors:
//   1. Skip marks are scanned FIRST and win: a mark whose skipAt was crossed seeks to jumpTo, CLEARS
//      the active loop (`range = null`), reports the jump, and no loop check runs on that sample.
//      Clearing is deliberate — a skip that jumped outside the loop window would otherwise be dragged
//      straight back by the very next loop check, so the mark would look like it did nothing.
//   2. Otherwise, once position reaches the loop end: loop -> back to start; no loop -> pause + ended.
//
// WHAT IS VIDEO-SPECIFIC: the driver. Audio can watch from its own audio-clock callback; a <video>
// element has no such tick, so §8.2 specifies requestVideoFrameCallback (or rAF) with `timeupdate` as
// a safety signal, and the seek is an asynchronous currentTime write that needs the re-trigger
// suppression above. Native <video loop> is NEVER used: it loops the WHOLE FILE, which is not an A/B
// loop, and it would fight every seek this watcher makes.
// -------------------------------------------------------------------------------------------------

/// Seed the skip cursor so marks BEHIND the given position cannot fire. Every discontinuity (a seek,
/// a loop return, a skip jump, a new mark list) must call this: without it, jumping backwards over a
/// mark leaves `lastScan` ahead of the playhead, and the scan window (lastScan, position] stays empty
/// until the playhead climbs back past it — the mark silently stops working for that pass.
function seedSkipScan(position) {
    lastScan = Number.isFinite(position) ? position : 0;
}

/// Normalize what .NET marshalled into the module's own shape. Marks that are not finite, or that
/// jump backwards, are DROPPED rather than kept: ITransport documents skip marks as forward-only, and
/// a backwards mark would fire forever (jump back, cross it again, jump back...).
function normalizeSkipMarks(marks) {
    if (!Array.isArray(marks)) return [];
    return marks
        .map((mark) => ({ skipAt: Number(mark?.skipAt), jumpTo: Number(mark?.jumpTo) }))
        .filter((mark) => Number.isFinite(mark.skipAt) && Number.isFinite(mark.jumpTo)
            && mark.jumpTo > mark.skipAt)
        .sort((a, b) => a.skipAt - b.skipAt || a.jumpTo - b.jumpTo);
}

/// Move the playhead as part of enforcement, WITHOUT the public seek()'s skip-cursor reseeding —
/// enforcement reseeds explicitly to the value that belongs to the transition it just made.
/// Returns whether the write landed, so a caller never treats a refused seek as a completed jump.
function seekForEnforcement(target) {
    try {
        video.currentTime = target;
        return true;
    } catch {
        // Seeking before metadata throws InvalidStateError. Reporting false (rather than pretending)
        // is what lets the boundary stay armed for the next sample instead of being consumed by a
        // seek that never happened.
        return false;
    }
}

/// One sample of the enforcement watcher. Called from rVFC/rAF while playing and from `timeupdate`.
/// Idempotent with respect to a position it has already acted on, which is what "exactly one seek per
/// crossing" means: re-entering with the same currentTime after a loop return seek does nothing.
function checkBoundaries() {
    if (!video) return;
    const position = currentTimeOrZero();

    // Release the loop-return suppression only once the playhead is genuinely back inside the window.
    // Comparing against the loop END (not the start) is deliberate: a seek to `start` may land on a
    // nearby keyframe slightly AFTER start on MP4, and demanding position <= start exactly would keep
    // the guard latched forever, disabling every subsequent loop return.
    if (loopReturnPending) {
        if (!range || !Number.isFinite(range.end) || position < range.end) {
            loopReturnPending = false;
            seedSkipScan(position);
        }
        return;
    }

    // Skip marks first, and a fired mark ends this sample (audioPlayer.js's `return` after the scan).
    const previous = Number.isFinite(lastScan) ? lastScan : position;
    if (position < previous) {
        // The playhead moved backwards (a user seek, a loop return). Re-arm rather than scan: the
        // window (previous, position] is empty going backwards and would swallow the next crossing.
        seedSkipScan(position);
    } else if (skipMarks.length > 0) {
        const mark = skipMarks.find((m) => m.skipAt > previous && m.skipAt <= position);
        if (mark) {
            // Consume the mark BEFORE the seek: a failed seek must not leave the mark armed to fire
            // again on the very next sample, which would be an unbounded retry loop at frame rate.
            seedSkipScan(mark.jumpTo);
            range = null; // the audio engines' rule — a skip clears the active loop window
            if (!seekForEnforcement(mark.jumpTo)) {
                // Never silent: the mark has been consumed, so without this report the skip would
                // simply not have happened and nothing would say why.
                safeInvoke('OnEnforcementFailed',
                    `skip mark at ${mark.skipAt}s could not seek to ${mark.jumpTo}s`);
                return;
            }
            reportPosition(true);
            safeInvoke('OnPlaybackSkipped', mark.jumpTo);
            return;
        }
        seedSkipScan(position);
    } else {
        seedSkipScan(position);
    }

    if (!range || !Number.isFinite(range.end) || position < range.end) return;

    if (range.loop) {
        // Suppress re-trigger until the playhead is back inside; the currentTime write below does not
        // take effect synchronously, so the next frame would otherwise see the same >= end.
        loopReturnPending = true;
        seedSkipScan(range.start);
        if (!seekForEnforcement(range.start)) {
            // Unlatch, so the next sample retries rather than leaving the loop permanently disarmed,
            // and report: a loop that stopped wrapping must not do so silently.
            loopReturnPending = false;
            safeInvoke('OnEnforcementFailed',
                `loop return to ${range.start}s was refused by the element`);
            return;
        }
        // Acceptance instrumentation from the production engine, not a harness-side position guess:
        // one callback is emitted for each successful boundary seek. The observed position records
        // overshoot beyond the requested end; counting callbacks proves "one seek per crossing" over
        // the real 20-lap device run.
        safeInvoke('OnLoopReturned', position, range.start, range.end);
        reportPosition(true);
        return;
    }

    // A non-looping window still ENDS at its end (ITransport: "constrains playback to a time window").
    // Pausing and reporting Ended is what audioPlayer.js does, and it is what makes a bounded section
    // stop where the user drew it instead of running on into the next one.
    video.pause();
    stopWatcher();
    stopPositionTimer();
    reportPosition(true);
    safeInvoke('OnPlayingChanged', false);
    safeInvoke('OnEnded');
}

/// Start the frame-driven watcher. Runs ONLY while playing: a leaked rVFC/rAF chain is a battery and
/// CPU cost that no functional test notices, which is why every stop path below calls stopWatcher().
/// Idempotent — a second `playing` event does not start a second chain.
function startWatcher() {
    if (frameHandle !== null || !video) return;

    if (typeof video.requestVideoFrameCallback === 'function') {
        frameKind = 'rvfc';
        const tick = () => {
            frameHandle = null;
            if (frameKind !== 'rvfc') return; // stopped between the frame and this callback
            checkBoundaries();
            if (frameKind === 'rvfc' && video) {
                frameHandle = video.requestVideoFrameCallback(tick);
            }
        };
        frameHandle = video.requestVideoFrameCallback(tick);
        return;
    }

    if (typeof requestAnimationFrame === 'function') {
        frameKind = 'raf';
        const tick = () => {
            frameHandle = null;
            if (frameKind !== 'raf') return;
            checkBoundaries();
            if (frameKind === 'raf') {
                frameHandle = requestAnimationFrame(tick);
            }
        };
        frameHandle = requestAnimationFrame(tick);
        return;
    }

    // Neither driver exists (a non-browser host, or a very old engine). The `timeupdate` safety
    // signal still enforces the boundaries, at that event's coarser ~4 Hz rate.
    frameKind = null;
}

function stopWatcher() {
    const kind = frameKind;
    const handle = frameHandle;
    frameKind = null;
    frameHandle = null;
    if (handle === null) return;
    try {
        if (kind === 'rvfc' && video && typeof video.cancelVideoFrameCallback === 'function') {
            video.cancelVideoFrameCallback(handle);
        } else if (kind === 'raf' && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(handle);
        }
    } catch { /* the element or the frame callback is already gone; the chain is stopped either way */ }
}

/// Apply preservesPitch across the vendor-prefixed spellings. Returns the number of properties that
/// were actually set, so the caller (and the suite) can tell "applied" from "this engine has no such
/// property" instead of assuming success.
function applyPreservesPitch(element) {
    let applied = 0;
    for (const name of ['preservesPitch', 'mozPreservesPitch', 'webkitPreservesPitch']) {
        if (name in element) {
            element[name] = true;
            applied++;
        }
    }
    return applied;
}

/// Register the one <video> element and the .NET callback peer. Idempotent per element: attaching a
/// second time (a re-render handing back the same element) re-binds cleanly rather than doubling the
/// listeners. Attaching a DIFFERENT element detaches the old one first, so a stale element can never
/// be left playing off-screen.
///
/// The element is configured here rather than trusted from markup: playsinline is what stops iOS
/// from hijacking playback into its own fullscreen player, and getting it from markup alone has
/// already been a source of drift in this repo's audio path.
export function attach(element, dotNetCallback) {
    if (!element) {
        throw new Error('videoPlayer.attach requires a <video> element; got none.');
    }

    if (video && video !== element) {
        detach();
    } else {
        removeMediaListeners();
        // Also the document-level ones: attach() re-registers them below, and a re-render handing back
        // the SAME element would otherwise stack a second fullscreenchange listener on every render —
        // duplicate OnFullscreenChanged callbacks that grow without bound.
        removeDocumentListeners();
    }

    video = element;
    dotnet = dotNetCallback ?? null;

    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.preload = 'metadata';
    // ARCH-007 on Windows authorizes the HTTP loopback request with the HTTPS document's exact
    // Origin. A downgrade suppresses Referer, and a media element outside CORS mode sends no Origin,
    // producing a correct fail-closed 403. Set this BEFORE src in load(), so the request is CORS mode.
    video.crossOrigin = 'anonymous';
    // Custom Studio buttons are the transport (§8.2); native controls would present a second,
    // competing one.
    video.controls = false;
    applyPreservesPitch(video);

    addMediaListener('loadedmetadata', () => {
        applyPreservesPitch(video);
        safeInvoke('OnLoadedMetadata', durationOrZero(), video.videoWidth || 0, video.videoHeight || 0);
        reportPosition(true);
    });
    addMediaListener('playing', () => {
        startPositionTimer();
        startWatcher();
        safeInvoke('OnPlayingChanged', true);
    });
    addMediaListener('pause', () => {
        stopPositionTimer();
        // The watcher exists to enforce boundaries the playhead is CROSSING; a paused element crosses
        // nothing, so leaving it running would burn frames forever after the user stops.
        stopWatcher();
        reportPosition(true);
        safeInvoke('OnPlayingChanged', false);
    });
    addMediaListener('ended', () => {
        stopPositionTimer();
        stopWatcher();
        reportPosition(true);
        safeInvoke('OnEnded');
    });
    addMediaListener('seeked', () => reportPosition(true));
    // The §8.2 safety signal: rVFC/rAF stop firing when the tab is hidden or no frames are painted,
    // and `timeupdate` keeps arriving (~4 Hz) in exactly those cases. It shares checkBoundaries()'s
    // suppression state with the frame driver, so having both running cannot double-seek a crossing.
    addMediaListener('timeupdate', () => checkBoundaries());
    addMediaListener('error', () => {
        stopPositionTimer();
        stopWatcher();
        safeInvoke('OnError', mediaErrorCode());
    });

    // Fullscreen exit via the PLATFORM's own path — Esc, browser chrome, the iOS "Done" button, a
    // swipe — never reaches the app's toggle button. Without these the component would keep rendering
    // "exit fullscreen" over an inline stage after the user already left (§8.4 / this item's
    // reviewer focus). webkitbegin/endfullscreen are the iOS video element's own events; the
    // document-level fullscreenchange pair covers the standard API.
    addMediaListener('webkitbeginfullscreen', () => reportFullscreen());
    addMediaListener('webkitendfullscreen', () => reportFullscreen());
    addDocumentListener('fullscreenchange', () => reportFullscreen());
    addDocumentListener('webkitfullscreenchange', () => reportFullscreen());

    return true;
}

/// Release the element: stop the timer, drop every listener, and forget the .NET peer. Does NOT clear
/// src — that is unload()'s job, and it must run through .NET so the store can release the playback
/// source. Calling detach() alone on a loaded element deliberately leaves the source open rather than
/// silently orphaning it.
export function detach() {
    stopPositionTimer();
    // Before `video = null`: stopWatcher() needs the element to cancel an rVFC handle on it.
    stopWatcher();
    removeMediaListeners();
    // Document-level fullscreenchange listeners outlive the element unless removed here: they are on
    // `document`, so the element going away does not take them with it, and a surviving one would keep
    // invoking a torn-down component's reference on every unrelated fullscreen change in the app.
    removeDocumentListeners();
    for (const cleanup of triggerCleanups) {
        try { cleanup(); } catch { /* the element is already gone; nothing to unbind */ }
    }
    triggerCleanups = [];
    stage = null;
    video = null;
    dotnet = null;
    lastPositionSentMs = -Infinity;
    // The loop window and marks belong to the source that was loaded into the released element. A
    // surviving range would silently constrain whatever is attached next.
    range = null;
    skipMarks = [];
    seedSkipScan(0);
    loopReturnPending = false;
}

/// Point the element at a playback source produced by IVideoMediaStore.OpenPlaybackSourceAsync
/// (a URL plus MIME — never a filesystem path). Resolves once metadata has loaded, so the caller
/// learns the duration and dimensions the FINALIZED container reports rather than what was requested.
///
/// Rejects with a diagnosable message naming the media error code on failure. Returning a bare false
/// here would leave the caller unable to distinguish "wrong codec" from "bytes vanished".
export function load(playbackUrl, mimeType) {
    if (!video) {
        return Promise.reject(new Error('videoPlayer.load: no <video> element is attached.'));
    }
    if (!playbackUrl) {
        return Promise.reject(new Error('videoPlayer.load: a playback URL is required.'));
    }

    const element = video;
    return new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            element.removeEventListener('loadedmetadata', onLoaded);
            element.removeEventListener('error', onError);
            fn(value);
        };
        const onLoaded = () => done(resolve, {
            durationSeconds: durationOrZero(),
            widthPixels: element.videoWidth || 0,
            heightPixels: element.videoHeight || 0,
        });
        const onError = () => done(reject, new Error(
            `videoPlayer.load failed for the opened playback source (media error code ` +
            `${mediaErrorCode()}, declared type '${mimeType || 'unknown'}').`));

        element.addEventListener('loadedmetadata', onLoaded);
        element.addEventListener('error', onError);

        // src, not a <source> child: the element is owned here and only ever has one source, and
        // assigning src is what makes the later `src = ''` + load() teardown total.
        element.src = playbackUrl;
        applyPreservesPitch(element);
        element.load();
    });
}

/// Pause, clear the source, and reset the element so no decoder, buffer, or network read survives.
/// Returns the URL that was loaded (or null) so the CALLER can hand it to
/// IVideoMediaStore.ReleasePlaybackSourceAsync — the store owns revocation (the loopback allow-list
/// entry on Windows, the object URL on web) and JS must not guess how to revoke it.
///
/// The `src = ''` + load() pair is deliberate and both halves are required: clearing src alone leaves
/// the media element holding its current resource, and load() is what actually tears the resource
/// selection down. Skipping either is how a "stopped" video keeps playing audio.
export function unload() {
    if (!video) return null;

    stopPositionTimer();
    // The window and marks describe THIS source's timeline; carrying them onto the next one would
    // silently constrain a different video to the previous video's A/B points.
    stopWatcher();
    range = null;
    skipMarks = [];
    seedSkipScan(0);
    loopReturnPending = false;
    const released = video.currentSrc || video.src || null;
    try {
        video.pause();
    } catch { /* pausing an element with no resource is a no-op, not a failure */ }
    video.removeAttribute('src');
    video.src = '';
    video.load();
    lastPositionSentMs = -Infinity;
    return released || null;
}

/// Start playback from a C# caller. NOT the gesture-safe path — see bindPlayToggle(), which is what
/// the user's first tap must reach. This exists for programmatic starts (a resumed session, a timed
/// run) where no transient activation is involved.
///
/// Rejects with the underlying reason. Swallowing a NotAllowedError here would present a blocked
/// autoplay as a successful play and leave the UI showing a playing state that is silent.
export async function play() {
    if (!video) {
        throw new Error('videoPlayer.play: no <video> element is attached.');
    }
    applyPreservesPitch(video);
    await video.play();
    startPositionTimer();
    startWatcher();
    return true;
}

export function pause() {
    if (!video) return false;
    video.pause();
    stopPositionTimer();
    stopWatcher();
    return true;
}

/// Halt AND rewind to the section/track start — ITransport.StopAsync's contract, as distinct from
/// pause(), which leaves the playhead alone. With a loop window set, "the start" is the WINDOW's
/// start (audioPlayer.js's `state.range ? state.range.start : 0`), not the file's: stopping inside a
/// section and playing again must resume that section, not the top of the video.
export function stop() {
    if (!video) return false;
    video.pause();
    stopPositionTimer();
    stopWatcher();
    const startAt = range && Number.isFinite(range.start) ? range.start : 0;
    try {
        video.currentTime = startAt;
    } catch { /* seeking before metadata throws InvalidStateError; the element is at 0 anyway */ }
    // A stop is a discontinuity: re-arm the marks ahead of the new position, and drop any loop-return
    // suppression left over from a seek that will never complete now that the element is paused.
    seedSkipScan(startAt);
    loopReturnPending = false;
    reportPosition(true);
    return true;
}

/// Move the playhead. Clamped into [0, duration] because assigning a negative or past-the-end
/// currentTime is a silent no-op on some engines and a throw on others — clamping makes an
/// out-of-range seek land at the nearest valid position on every host instead of doing nothing.
export function seek(seconds) {
    if (!video) return false;
    const duration = durationOrZero();
    let target = Number.isFinite(seconds) ? seconds : 0;
    if (target < 0) target = 0;
    if (duration > 0 && target > duration) target = duration;
    try {
        video.currentTime = target;
    } catch {
        return false;
    }
    // Re-arm the skip cursor at the destination (audioPlayer.js's seek() does the same via
    // engineCommon.seedSkipScan): a user seek that lands BEFORE a mark must let that mark fire again,
    // and one that lands after it must not fire it retroactively. Any in-flight loop return is
    // superseded by this explicit seek.
    seedSkipScan(target);
    loopReturnPending = false;
    reportPosition(true);
    return true;
}

/// Set or clear the A/B window (§8.2, ITransport.SetLoopAsync). `start == null` clears it and plays
/// the whole track; `end == null` is an open-ended window with a start but no boundary to enforce.
/// `enabled` false keeps the window as a stop point but does not wrap — the same {start, end, loop}
/// triple audioPlayer.js stores, so a caller cannot mean different things on the two engines.
///
/// Never sets the native `<video loop>` attribute: that attribute loops the ENTIRE FILE and ignores
/// A/B points entirely, so it is not a weaker version of this feature — it is a different one that
/// would fight every seek made here (§8.2 states this explicitly).
export function setLoop(start, end, enabled) {
    if (!video) return false;

    range = start == null || !Number.isFinite(Number(start))
        ? null
        : {
            start: Number(start),
            end: end == null || !Number.isFinite(Number(end)) ? null : Number(end),
            loop: !!enabled,
        };
    // A window that changed under the playhead invalidates any suppression from the previous one.
    loopReturnPending = false;

    // Pull the playhead into a window it is sitting BEFORE, matching audioPlayer.js's
    // `if (audio.currentTime < start) audio.currentTime = start`. Selecting a section that begins
    // later in the song and then hearing the previous section play is the behaviour this prevents.
    if (range && currentTimeOrZero() < range.start) {
        if (seekForEnforcement(range.start)) {
            seedSkipScan(range.start);
            reportPosition(true);
        }
        // A refused seek (metadata not loaded yet) is not an error: the window stands, and the
        // watcher enforces it from wherever playback actually begins.
    }
    return true;
}

/// Install the forward-only skip marks (§8.2, ITransport.SetSkipMarksAsync). Ordering and chaining
/// are precomputed by the application layer; this module only compares and seeks. Returns the number
/// of marks accepted, so a caller can tell "installed 3" from "all 3 were malformed and dropped" —
/// returning nothing would make a rejected list look identical to an enforced one.
export function setSkipMarks(marks) {
    skipMarks = normalizeSkipMarks(marks);
    // Seed at the CURRENT position so a mark already behind the playhead does not fire the instant
    // the list is installed (engineCommon.setSkipMarks does exactly this).
    seedSkipScan(currentTimeOrZero());
    return skipMarks.length;
}

/// Tempo as playbackRate, with natural pitch (§2.6). preservesPitch is re-applied on EVERY rate change
/// because engines reset it when the rate or the source changes; setting it once at attach time is how
/// a slowed video ends up chipmunked. Returns whether the rate was accepted, so a caller can tell a
/// clamped/refused rate from an applied one.
export function setTempo(rate) {
    if (!video) return false;
    if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(`videoPlayer.setTempo requires a positive finite rate; got '${rate}'.`);
    }
    applyPreservesPitch(video);
    video.playbackRate = rate;
    // Re-apply AFTER the assignment too: the rate change is the event that resets the flag on some
    // engines, so a pre-assignment write alone does not survive it.
    applyPreservesPitch(video);
    return video.playbackRate === rate;
}

export function getPosition() {
    return currentTimeOrZero();
}

export function getDuration() {
    return durationOrZero();
}

/// A snapshot for .NET to reconcile against, so IsPlaying can never drift from what the element is
/// actually doing. `paused` is the element's own truth; `ended` distinguishes "stopped at the end"
/// from "stopped by the user".
export function getState() {
    if (!video) {
        return { attached: false, paused: true, ended: false, seeking: false, positionSeconds: 0, durationSeconds: 0, playbackRate: 1, errorCode: 0 };
    }
    return {
        attached: true,
        paused: !!video.paused,
        ended: !!video.ended,
        seeking: !!video.seeking,
        positionSeconds: currentTimeOrZero(),
        durationSeconds: durationOrZero(),
        playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
        errorCode: mediaErrorCode(),
    };
}

/// THE GESTURE-SAFE PLAY PATH (§8.2). Install a DOM listener on the Studio's play/pause control that
/// toggles the element SYNCHRONOUSLY inside the user's own event, then tells .NET what happened.
///
/// This exists because the obvious wiring — Blazor @onclick -> .NET handler -> await interop ->
/// play() — is asynchronous by construction, and Safari's transient activation does not survive that
/// round trip: the first tap on a fresh page produces a NotAllowedError rejection instead of audio.
/// Nothing is awaited before play() here.
///
/// Returns true when the listener was installed. Repeated calls for the same trigger replace the
/// previous binding rather than stacking, so a re-render cannot produce a double-toggle.
export function bindPlayToggle(trigger) {
    if (!video) {
        throw new Error('videoPlayer.bindPlayToggle: attach the <video> element first.');
    }
    if (!trigger) {
        throw new Error('videoPlayer.bindPlayToggle requires the trigger element.');
    }

    unbindPlayToggle(trigger);

    const handler = () => {
        if (!video) return;
        if (video.paused) {
            applyPreservesPitch(video);
            // Synchronous: this call IS the user gesture. Awaiting anything first loses activation.
            const started = video.play();
            if (started && started.catch) {
                // A rejection here is real (blocked autoplay, no decodable source) and must reach the
                // user, not vanish — but it must not become an unhandled rejection either.
                started.catch((err) => safeInvoke(
                    'OnPlayRejected', (err && (err.name || err.message)) || 'play() was rejected'));
            }
            startPositionTimer();
            safeInvoke('OnPlayingChanged', true);
        } else {
            video.pause();
            stopPositionTimer();
            safeInvoke('OnPlayingChanged', false);
        }
    };

    // 'click' rather than 'pointerup': click is what every engine treats as the activation-consuming
    // event for a button, and it is what keyboard Enter/Space also produce, so the keyboard path is
    // gesture-safe for free.
    trigger.addEventListener('click', handler);
    const cleanup = () => trigger.removeEventListener('click', handler);
    cleanup.trigger = trigger;
    cleanup.role = 'play';
    triggerCleanups.push(cleanup);
    return true;
}

/// Remove a binding installed by bindPlayToggle. Safe to call for a trigger that was never bound.
export function unbindPlayToggle(trigger) {
    return unbindTrigger(trigger, 'play');
}

/// Drop the cleanup(s) recorded for one trigger and one ROLE. The role matters: a trigger is keyed by
/// (element, role), so re-binding the fullscreen toggle cannot silently remove a play binding that
/// happens to be on the same element. Keying by element alone would make a caller that reuses one
/// button end up with whichever binding it installed last, silently.
function unbindTrigger(trigger, role) {
    let removed = false;
    triggerCleanups = triggerCleanups.filter((cleanup) => {
        if (cleanup.trigger !== trigger || cleanup.role !== role) return true;
        try { cleanup(); } catch { /* element already gone */ }
        removed = true;
        return false;
    });
    return removed;
}

// -------------------------------------------------------------------------------------------------
// Local-video fullscreen (§8.4 optional local-video polish, phase4-video-012)
//
// TWO APIS, NOT ONE, and the fallback is not cosmetic. Desktop and WebView2 have the standard
// Fullscreen API on any element, so the STAGE container is fullscreened and keeps the app's own
// controls. iOS Safari's <video> does NOT implement requestFullscreen; it implements the WebKit
// element-only webkitEnterFullscreen(), which hands playback to the native iOS player. Without that
// fallback the fullscreen button on an iPhone would do nothing at all.
//
// PLAYSINLINE IS NOT REMOVED to enter fullscreen. playsinline is what keeps iOS from hijacking every
// play() into its own player, and stripping it would make fullscreen implicit rather than
// user-initiated (§8.4/§8.2). webkitEnterFullscreen works WITH playsinline set: it is an explicit,
// gesture-scoped request, which is exactly the property this feature needs.
//
// EXIT MUST BE OBSERVED, NOT ASSUMED. The user can leave fullscreen by a path this app never sees:
// Esc, the browser's own exit chrome, the iOS "Done" button, or a swipe. A component that flipped a
// local boolean on its own button press would then render an "exit fullscreen" button over an inline
// stage forever. So the truth is read from the platform (isFullscreen()) and every change is pushed to
// .NET from fullscreenchange / webkitbeginfullscreen / webkitendfullscreen.
// -------------------------------------------------------------------------------------------------

/// The element the platform currently reports as fullscreen, or null. Both spellings are checked
/// because WebView2/Chromium and older WebKit disagree on the property name.
function fullscreenElement() {
    if (typeof document === 'undefined') return null;
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

/// Whether the standard Fullscreen API can be used on the given element. iOS Safari answers false here
/// for a <div>, which is what routes it to the webkitEnterFullscreen path below.
function canRequestStandardFullscreen(element) {
    return !!(element && (element.requestFullscreen || element.webkitRequestFullscreen));
}

/// Whether the ELEMENT-only WebKit video API is available. Present on iOS Safari's <video>, absent on
/// Chromium.
function canRequestVideoFullscreen(element) {
    return !!(element && typeof element.webkitEnterFullscreen === 'function');
}

/// Whether video is currently presented fullscreen, by EITHER mechanism. `webkitDisplayingFullscreen`
/// is the iOS video element's own flag — during native-player fullscreen there is no
/// document.fullscreenElement at all, so checking only the standard property would report false while
/// the video filled the screen.
export function isFullscreen() {
    const active = fullscreenElement();
    if (active && (active === stage || active === video)) return true;
    return !!(video && video.webkitDisplayingFullscreen);
}

/// Push the current fullscreen truth to .NET. Guarded like every other callback here: these events
/// fire from app-lifetime document listeners, and an unguarded one on a disposed reference is the
/// 2026-07-12 circuit teardown.
function reportFullscreen() {
    safeInvoke('OnFullscreenChanged', isFullscreen());
}

function addDocumentListener(type, handler) {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener(type, handler);
    documentListeners.push([type, handler]);
}

function removeDocumentListeners() {
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        for (const [type, handler] of documentListeners) {
            document.removeEventListener(type, handler);
        }
    }
    documentListeners = [];
}

/// Enter fullscreen, SYNCHRONOUSLY, from inside the caller's user gesture. Returns a string naming
/// which mechanism was used ('standard' | 'video' | 'unsupported') rather than a bare boolean, so the
/// suite and a device log can tell "iOS took the native player" from "this host has no fullscreen at
/// all" — two outcomes that look identical through a boolean.
///
/// Nothing is awaited before the request, for the same reason play() is not: a fullscreen request
/// issued after an await has lost its transient activation and is refused.
function enterFullscreen() {
    const container = stage || video;
    if (canRequestStandardFullscreen(container)) {
        const request = container.requestFullscreen || container.webkitRequestFullscreen;
        const result = request.call(container);
        // A refusal (no activation, or a policy block) resolves asynchronously. It must not become an
        // unhandled rejection, and it must not be reported as success: the fullscreenchange listener
        // is the only thing that flips .NET's state, and it never fires for a refused request.
        if (result && result.catch) {
            result.catch((err) => safeInvoke('OnFullscreenRejected',
                (err && (err.name || err.message)) || 'the fullscreen request was refused'));
        }
        return 'standard';
    }

    // iOS Safari: the video element's own API. No promise to guard — it either presents or it does not,
    // and webkitbeginfullscreen is what tells us which.
    if (canRequestVideoFullscreen(video)) {
        video.webkitEnterFullscreen();
        return 'video';
    }

    return 'unsupported';
}

/// Leave fullscreen by whichever mechanism is presenting. Returns the mechanism, so "exit did nothing
/// because nothing was fullscreen" is distinguishable from a real exit.
export function exitFullscreen() {
    if (video && video.webkitDisplayingFullscreen && typeof video.webkitExitFullscreen === 'function') {
        video.webkitExitFullscreen();
        return 'video';
    }

    if (typeof document === 'undefined' || !fullscreenElement()) return 'unsupported';
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return 'unsupported';
    const result = exit.call(document);
    if (result && result.catch) {
        result.catch((err) => safeInvoke('OnFullscreenRejected',
            (err && (err.name || err.message)) || 'the fullscreen exit was refused'));
    }
    return 'standard';
}

/// THE GESTURE-SAFE FULLSCREEN PATH. Install a DOM listener on the stage's fullscreen button that
/// enters or exits SYNCHRONOUSLY inside the user's own click, then tells .NET. Registers the
/// `stage` container to fullscreen (falling back to the <video> when no container is supplied).
///
/// Repeated calls for the same trigger replace the previous binding rather than stacking, so a
/// re-render cannot produce an enter-then-exit double toggle.
export function bindFullscreenToggle(trigger, container) {
    if (!video) {
        throw new Error('videoPlayer.bindFullscreenToggle: attach the <video> element first.');
    }
    if (!trigger) {
        throw new Error('videoPlayer.bindFullscreenToggle requires the trigger element.');
    }

    stage = container ?? null;
    // Role-scoped, so re-binding this toggle replaces only the PREVIOUS FULLSCREEN binding. Keying by
    // element alone would let a caller that reuses one button for both roles lose its play binding here.
    unbindTrigger(trigger, 'fullscreen');

    const handler = () => {
        if (!video) return;
        try {
            const mechanism = isFullscreen() ? exitFullscreen() : enterFullscreen();
            if (mechanism === 'unsupported') {
                // Never silent: a button the user pressed that cannot do anything on this host must say
                // so, or it reads as a broken app rather than a missing platform feature.
                safeInvoke('OnFullscreenRejected',
                    'this host exposes neither the Fullscreen API on the stage nor ' +
                    'webkitEnterFullscreen on the video element');
            }
        } catch (err) {
            // A synchronous throw (some engines throw TypeError instead of rejecting) is still a
            // refusal the user must see.
            safeInvoke('OnFullscreenRejected',
                (err && (err.name || err.message)) || 'the fullscreen request threw');
        }
        // Report immediately as well as from the change events: on the standard API the state flips
        // asynchronously (fullscreenchange does the real work), but on the iOS path an exit is already
        // observable here, and reporting twice is harmless because .NET stores an absolute truth, not a
        // toggle.
        reportFullscreen();
    };

    trigger.addEventListener('click', handler);
    const cleanup = () => trigger.removeEventListener('click', handler);
    cleanup.trigger = trigger;
    cleanup.role = 'fullscreen';
    triggerCleanups.push(cleanup);
    return true;
}
