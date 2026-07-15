// Gesture-anchored AudioContext unlock, loaded before Blazor starts (plain script, no module) —
// the twin of errorCapture.js.
//
// Why this exists: on iOS (Safari AND the MAUI WKWebView) an AudioContext is born 'suspended' and
// only goes 'running' if .resume() runs SYNCHRONOUSLY inside a real user-gesture handler. Every
// engine (audioContext.js, audioPlayer.js) resumes from inside its own `async play()`, but those
// are reached via @onclick -> C# handler -> IJSRuntime.InvokeVoidAsync("play"), and that .NET<->JS
// hop is async: by the time JS runs ctx.resume() iOS no longer sees a live gesture, so the resume
// silently no-ops and the app is dead silent. Two earlier "autoplay policy" fixes patched those
// already-ignored resume calls and so didn't help.
//
// The fix is to resume from a listener that runs DIRECTLY in the DOM gesture, before any marshaling.
// The engines register their context here on creation (window.__audioUnlock.register); the first
// pointerdown/touchend/click/keydown anywhere resumes every registered context and plays a silent
// buffer through each (the buffer play is what some iOS versions actually require). The very tap
// that hits Play also unlocks, so nothing extra is asked of the user.
//
// State is exposed via snapshot() for the /diagnostics Audio HUD, so "is the context running?" is
// answerable on-device with one tap instead of guesswork.
(function () {
    var contexts = [];      // every AudioContext the engines have created this session
    var unlocked = false;   // a gesture has fired and we've attempted resume on all contexts
    var lastGesture = null; // event type of the gesture that triggered the unlock (HUD detail)
    var silentEl = null;    // looping silent <audio> element (the iOS silent-switch fix; see below)
    var sinkEls = [];       // real-audio <audio> sinks fed by engine MediaStreams (the background keep-alive; see below)

    // --- iOS background keep-alive --------------------------------------------------------------
    // Distinct from the silent-switch element above. When the app is BACKGROUNDED, iOS suspends the
    // WKWebView's Web Audio graph (AudioContext + the Signalsmith AudioWorklet) unless the app is
    // producing audio through a path iOS recognizes as "now playing" media — i.e. a *playing*
    // HTMLMediaElement carrying real audio. UIBackgroundModes=audio + the Playback session are
    // necessary but not sufficient on their own (device-confirmed: app-switch still stopped audio).
    //
    // The fix (engineCommon.ensureMasterPanner): each engine also routes its master output into a
    // MediaStreamAudioDestinationNode and hands that stream here. We attach it to a real <audio>
    // element and play it from the gesture. Because that element carries the ACTUAL mix (not silence),
    // iOS keeps the app — and the worklet feeding the stream — alive in the background.
    //
    // The silent element's 0-byte content does NOT achieve this: iOS sees no real audio and suspends.

    // Register an engine's MediaStream as a background keep-alive sink. Idempotent per stream. Called
    // by engineCommon when it builds the master graph; plays immediately if a gesture already unlocked.
    function registerSink(stream) {
        if (!stream) return;
        for (var i = 0; i < sinkEls.length; i++) {
            if (sinkEls[i].__stream === stream) return; // already registered this stream
        }
        var el = document.createElement('audio');
        el.srcObject = stream;
        el.setAttribute('playsinline', '');
        el.autoplay = true;    // best-effort: try to start without waiting for a gesture (usually blocked)
        el.__stream = stream;  // identity tag so a re-register of the same stream no-ops
        el.__heals = 0;
        // Self-heal: iOS can pause the sink when a native session activation (the lock-screen
        // now-playing anchor) briefly interrupts the WebView's audio — heard as "a split second
        // then it stops". A sink is NEVER intentionally paused while playback runs, so an
        // unexpected pause is always worth a retry. Bounded per element (counter resets on the
        // next unlock gesture) so a hard interruption like a phone call can't ping-pong; the
        // console.warn lands in the /diagnostics funnel so every heal is visible.
        el.addEventListener('pause', function () {
            if (!unlocked || el.__heals >= 5) return;
            el.__heals++;
            setTimeout(function () {
                if (!el.paused) return; // recovered on its own (or an intentional state change)
                try { console.warn('[sink] self-heal ' + el.__heals + '/5: replaying paused keep-alive sink'); } catch (e) { }
                playSink(el);
            }, 250);
        });
        sinkEls.push(el);
        if (unlocked) playSink(el);
    }

    function playSink(el) {
        try {
            var p = el.play();
            if (p && p.catch) p.catch(function () { /* blocked until a gesture; retried on the next one */ });
        } catch (err) {
            // Never throw out of a gesture handler.
        }
    }

    function kickSinks() {
        for (var i = 0; i < sinkEls.length; i++) {
            sinkEls[i].__heals = 0; // a fresh gesture re-arms the pause self-heal budget
            playSink(sinkEls[i]);
        }
    }

    // --- iOS silent-switch fix ------------------------------------------------------------------
    // On iOS the WKWebView plays Web Audio (AudioContext) into a session that the hardware Ring/Silent
    // switch SILENCES — even when the context reports 'running' and the app's AVAudioSession is
    // Playback (the WebView runs Web Audio in a separate process with its own session the host app
    // cannot control — WebKit bug #167788). BUT iOS does NOT silence HTMLMediaElement playback, and
    // playing a media element flips WebKit's audio session onto the play-through-silent route, after
    // which the separate AudioContext output ALSO becomes audible on silent. So we play a tiny,
    // SILENT, looping <audio> element from the same gesture that unlocks the contexts. This is the
    // battle-tested unmute-ios-audio / howler.js technique. The 1-frame Web Audio buffer in kick()
    // does NOT achieve this (it is itself Web Audio, so it is muted too) — the ELEMENT is the key.

    // A minimal valid WAV: 44-byte header + one 16-bit silent sample, as a base64 data URI. Built
    // once; the element loops it forever.
    function silentWavDataUri() {
        var bytes = new Uint8Array(46); // 44-byte header + one 16-bit sample (2 bytes)
        var view = new DataView(bytes.buffer);
        function ascii(offset, s) { for (var i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); }
        var sampleRate = 8000, dataLen = 2; // one 16-bit mono sample of silence
        ascii(0, 'RIFF');
        view.setUint32(4, 36 + dataLen, true);
        ascii(8, 'WAVE');
        ascii(12, 'fmt ');
        view.setUint32(16, 16, true);   // PCM chunk size
        view.setUint16(20, 1, true);    // PCM
        view.setUint16(22, 1, true);    // mono
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
        view.setUint16(32, 2, true);    // block align
        view.setUint16(34, 16, true);   // bits per sample
        ascii(36, 'data');
        view.setUint32(40, dataLen, true);
        // sample bytes at 44..45 are already 0 (silence)
        var binary = '';
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return 'data:audio/wav;base64,' + btoa(binary);
    }

    // Create (once) and start the looping silent element. Called from inside a user gesture so iOS
    // permits play(). Never paused/stopped for the session — pausing drops the session back onto the
    // switch-respecting route. Returns nothing; best-effort, never throws out of a gesture handler.
    function kickSilentElement() {
        try {
            if (!silentEl) {
                silentEl = document.createElement('audio');
                silentEl.src = silentWavDataUri();
                silentEl.loop = true;
                silentEl.setAttribute('playsinline', '');
                silentEl.muted = false;   // a MUTED element does not flip the session — must be audible (it is silent by content)
                silentEl.volume = 1;      // content is silence, so full volume is inaudible
            }
            var p = silentEl.play();
            if (p && p.catch) p.catch(function () { /* play() can reject if not in a gesture; retried on the next one */ });
        } catch (err) {
            // Never break the gesture. HUD's mediaElement state will show it isn't playing.
        }
    }

    // Resume one context and push a zero-value silent buffer through it. Best-effort: resume()
    // returns a promise on some browsers and is sync on others; either way we never throw out of a
    // gesture handler (that would cancel the gesture's other default actions, e.g. the click).
    //
    // Handles BOTH stuck states: 'suspended' (never unlocked / auto-suspended) and 'interrupted' —
    // the iOS-only state a context enters when the audio ROUTE changes (Bluetooth/AirPods connect or
    // drop, a call, another app grabbing audio). An interrupted context is silent until resumed, and
    // nothing else re-resumes it, so a route change would otherwise kill all audio until reload.
    function kick(ctx) {
        try {
            if ((ctx.state === 'suspended' || ctx.state === 'interrupted') && ctx.resume) {
                var p = ctx.resume();
                if (p && p.catch) p.catch(function () { });
            }
            // A 1-frame silent buffer. On older iOS this — not resume() alone — is what flips the
            // context to 'running'. Guard: createBuffer/createBufferSource can throw if the context
            // is closed.
            var buf = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
            var src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            if (src.start) src.start(0); else if (src.noteOn) src.noteOn(0);
        } catch (err) {
            // Never break the gesture; the HUD will still show the context as suspended if this failed.
        }
    }

    function unlockAll(evType) {
        unlocked = true;
        lastGesture = evType || 'gesture';
        // The silent element must be (re)started from the gesture — it's the iOS silent-switch fix.
        kickSilentElement();
        // The keep-alive sinks must also be (re)started from the gesture — that's what lets iOS keep
        // the app (and its Web Audio worklet) alive when backgrounded.
        kickSinks();
        for (var i = 0; i < contexts.length; i++) kick(contexts[i]);
    }

    var GESTURES = ['pointerdown', 'touchend', 'mousedown', 'click', 'keydown'];

    function onGesture(e) {
        unlockAll(e && e.type);
        // Leave the listeners attached: a context created AFTER the first gesture (lazy engine init
        // on a later tap) is resumed by register() below, and re-running unlockAll on subsequent
        // gestures is harmless and cheap — it keeps every context warm if iOS re-suspends one.
    }

    for (var i = 0; i < GESTURES.length; i++) {
        // Capture phase + passive: we observe the gesture without interfering with the app's own
        // handlers (Blazor's @onclick still fires normally).
        window.addEventListener(GESTURES[i], onGesture, { capture: true, passive: true });
    }

    window.__audioUnlock = {
        // Called by each engine right after it constructs an AudioContext. If a gesture has already
        // happened this session, resume the newcomer immediately (we're likely already inside that
        // gesture's synchronous call stack — the engine's ensureCtx runs during play()).
        register: function (ctx) {
            if (!ctx) return ctx;
            if (contexts.indexOf(ctx) === -1) {
                contexts.push(ctx);
                // Auto-recover from route-change interruptions (Bluetooth/AirPods connect/drop, calls):
                // iOS flips the context to 'interrupted' and it stays silent until resumed. Re-kick on
                // every state change once a gesture has unlocked us — resume() is only honored after
                // the first user gesture, so before that we just wait for the gesture path.
                if (ctx.addEventListener) {
                    ctx.addEventListener('statechange', function () {
                        if (unlocked && (ctx.state === 'interrupted' || ctx.state === 'suspended')) {
                            kick(ctx);
                            // Best-effort re-prime of the silent element after a route change
                            // (Bluetooth/AirPods) that may have paused it. NOTE: this runs in a
                            // statechange callback, NOT a user gesture — iOS MAY reject play() here
                            // (the rejection is swallowed in kickSilentElement). An element that was
                            // already gesture-blessed and merely paused often resumes; if not, the
                            // user's next tap re-primes it via unlockAll. Not a guaranteed recovery.
                            kickSilentElement();
                        }
                    });
                }
            }
            if (unlocked) kick(ctx);
            return ctx;
        },
        // Called by engineCommon.ensureMasterPanner with each engine's master MediaStream, so the
        // background keep-alive <audio> sink carries the real mix (see the keep-alive block above).
        registerSink: registerSink,
        // Snapshot for the diagnostics HUD.
        snapshot: function () {
            var mediaElement = 'none';
            if (silentEl) {
                // `paused` is the only reliable playing/not signal here: the silent clip is a single
                // ~0.000125s sample that loops sub-millisecond, so `currentTime` reads ~0 even while
                // playing (a currentTime>0 heuristic would show a working fix as "not playing").
                mediaElement = silentEl.paused ? 'paused' : 'playing';
            }
            // Keep-alive sinks: how many are registered, and how many are actually playing (the
            // signal that iOS will keep the app alive backgrounded). e.g. "1/1 playing".
            var sinkPlaying = 0;
            for (var i = 0; i < sinkEls.length; i++) {
                if (!sinkEls[i].paused) sinkPlaying++;
            }
            var keepAlive = sinkEls.length === 0
                ? 'none'
                : sinkPlaying + '/' + sinkEls.length + ' playing';
            return {
                unlocked: unlocked,
                lastGesture: lastGesture,
                contexts: contexts.map(function (c) { return c.state; }),
                mediaElement: mediaElement,
                keepAlive: keepAlive,
            };
        },
    };

    // Flat top-level alias so the Diagnostics HUD can call it by name via JS interop (window.<name>)
    // without eval and without a null-check dance if the object shape ever changes.
    window.audioUnlockSnapshot = function () { return window.__audioUnlock.snapshot(); };

    // Lock-screen breadcrumb (BackgroundPlaybackPlan.md Item 4d, carried over from the 4a probe).
    // The iOS NowPlayingBridge calls this from a native lock-screen button handler via IJSRuntime;
    // if it runs while the app is backgrounded, the console.warn lands in the /diagnostics funnel
    // (errorCapture.js hook) and proves interop is live in the background — the answer that shapes
    // the Item 4b command bridge. Replaced by the real transport hook once 4b is built.
    window.__probeBreadcrumb = function (which) {
        try { console.warn('[nowplaying] js reached from background: ' + which); } catch (e) { }
    };
})();
