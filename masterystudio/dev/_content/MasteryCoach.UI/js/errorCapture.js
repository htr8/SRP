// Global client-side error capture, loaded before Blazor starts (plain script, no module).
//
// Two outputs for every failure:
//  1. The on-screen error bar (#blazor-error-ui / #blazor-error-detail) — works even when Blazor
//     itself failed to boot and without dev tools.
//  2. The .NET DiagnosticsLog via the ClientErrorBridge JSInvokable — so JS window errors,
//     unhandled promise rejections, and console.error/warn (including the audio engines' silent
//     fallback warnings) show up on the /diagnostics page and in the shared log file.
//
// Errors raised before Blazor boots are queued and flushed once DotNet interop appears.
(function () {
    var pending = [];
    var flushTimer = null;
    // Re-entrancy guard. Reporting an error can itself PRODUCE a console line (a faulting .NET interop
    // dispatch is logged by Blazor → console → re-enters the console hook below → reports again →
    // loops). Navigating to /diagnostics — which RENDERS the log while the error boundary APPENDS to it
    // — reliably triggered this loop into an "unhandled error" crash (user bug report, 2026-07-11).
    // Dropping any report emitted WHILE already reporting breaks the loop at its source.
    var reporting = false;

    function show(text) {
        var bar = document.getElementById('blazor-error-ui');
        var detail = document.getElementById('blazor-error-detail');
        if (detail) { detail.textContent = String(text || '').slice(0, 4000); }
        if (bar) { bar.style.display = 'block'; }
    }

    // Hide the error bar. show() reveals it with an INLINE display:block, so hiding must clear that
    // inline style (a CSS class toggle can't win against an inline rule) — otherwise the "Close" link
    // did nothing (user bug report: the Close link in the crash banner is dead). Clearing the detail too
    // so a stale message can't flash when the bar is next shown for a different error.
    function hide() {
        var bar = document.getElementById('blazor-error-ui');
        if (bar) { bar.style.display = 'none'; }
    }

    // Wire the built-in "Close"/.dismiss link. This #blazor-error-ui markup is OURS (shown via show()'s
    // inline style), not the framework's, so Blazor never attaches a dismiss handler to it. Delegate off
    // document so it works no matter when the bar is added, and even if this script ran before the DOM
    // was ready. The .reload link is a plain <a href=""> and already reloads — leave it alone.
    document.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('dismiss') && t.closest && t.closest('#blazor-error-ui')) {
            e.preventDefault();
            hide();
        }
    });

    // Persist every error to localStorage IMMEDIATELY, independent of .NET. When the .NET CIRCUIT
    // crashes ("An unhandled error has occurred"), JS can no longer call back into .NET to log
    // (ReportClientError silently fails), so those crashes left NOTHING in the diagnostics log (user
    // report, 2026-07-11). This side-channel survives the crash and a reload; the Diagnostics page reads
    // and folds it into the funnel on next load. Bounded ring so it can't grow without limit.
    var CRASH_KEY = 'mc-crash-log';
    function persistLocal(level, source, message) {
        try {
            var line = '[' + new Date().toISOString() + '] [' + level + '] [' + source + '] ' + String(message || '');
            var raw = window.localStorage.getItem(CRASH_KEY);
            var arr = raw ? JSON.parse(raw) : [];
            arr.push(line.slice(0, 8000));
            while (arr.length > 50) arr.shift();
            window.localStorage.setItem(CRASH_KEY, JSON.stringify(arr));
        } catch (e) { /* storage full/unavailable — never break error handling */ }
    }

    function post(level, source, message) {
        if (reporting) return true; // a report emitted while reporting = the loop; drop it
        reporting = true;
        try {
            // Swallow ASYNC rejections too: an unhandled rejection here would re-enter this
            // file's own 'unhandledrejection' listener and loop forever (found in review).
            var invocation = DotNet.invokeMethodAsync('MasteryCoach.UI', 'ReportClientError', level, source, String(message).slice(0, 8000));
            if (invocation && invocation.catch) invocation.catch(function () { });
            return true;
        } catch (err) {
            return false;
        } finally {
            reporting = false;
        }
    }

    function report(level, source, message) {
        // Persist to the crash-proof local side-channel FIRST, before trying .NET — this is the copy
        // that survives a circuit crash + reload. But SKIP routine console.warn telemetry: the audio
        // engines emit many benign per-play warns (count-in schedule/cancel, stems-diag/-health), and
        // the crash ring is a tiny 50-line buffer — a burst of that telemetry EVICTS the actual crash
        // line, leaving the recovered log full of harmless warnings and no cause (user report: an
        // Original<->Stems crash whose recovered buffer held only count-in warns). The ring exists to
        // survive a CRASH, so only errors/crits and NON-console warnings (real window/promise/blazor
        // faults) belong in it; benign console.warn still shows live via the .NET log below.
        if (!(level === 'warn' && source === 'console')) {
            persistLocal(level, source, message);
        }
        // Central usage-analytics signal for genuine errors (WebAnalyticsPlan.md). ERRORS ONLY — the
        // console.warn hook also flows through here for benign audio-engine fallbacks, which aren't
        // worth an event. SOURCE only — never the message, which can carry file paths or user content.
        // Guarded and never throwing so it can't join the re-entrancy loop or break error handling.
        if (level === 'error') {
            try {
                if (window.__mcAnalytics && typeof window.__mcAnalytics.track === 'function') {
                    window.__mcAnalytics.track('client_error', { source: source });
                }
            } catch (e) { /* analytics must never break error capture */ }
        }
        if (window.DotNet && post(level, source, message)) return;
        pending.push([level, source, message]);
        if (pending.length > 100) pending.shift();
        if (!flushTimer) {
            flushTimer = setInterval(function () {
                if (!window.DotNet) return;
                clearInterval(flushTimer);
                flushTimer = null;
                var queued = pending;
                pending = [];
                for (var i = 0; i < queued.length; i++) post(queued[i][0], queued[i][1], queued[i][2]);
            }, 2000);
        }
    }

    // "ResizeObserver loop completed with undelivered notifications" (and the older "…limit exceeded")
    // is a BENIGN browser notice — it means the browser deferred some resize callbacks to the next
    // frame, not that anything failed. Browsers fire it as a window 'error' event, so it was flooding
    // the diagnostics log (50+ entries on iOS) and burying real errors. Swallow it entirely.
    function isBenignResizeObserver(message) {
        return typeof message === 'string' && message.indexOf('ResizeObserver loop') !== -1;
    }

    window.addEventListener('error', function (e) {
        if (isBenignResizeObserver(e.message)) { return; }
        var detail = e.error && e.error.stack
            ? e.error.stack
            : (e.message || 'Script error') + (e.filename ? ('\n' + e.filename + ':' + e.lineno + ':' + e.colno) : '');
        show(detail);
        report('error', 'window', detail);
    });

    window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        var detail = r && r.stack ? r.stack : (r && r.message ? r.message : JSON.stringify(r));
        show(detail);
        report('error', 'promise', detail);
    });

    // Blazor raises this custom event with the .NET exception details on an unhandled error.
    // REPORT it too (not just show): a .NET unhandled error that reaches this path was otherwise
    // displayed but NEVER written to the diagnostics log, so an "An unhandled error has occurred" crash
    // left no copyable detail to diagnose (user report, 2026-07-11).
    window.addEventListener('blazorError', function (e) {
        if (e.detail) {
            var detail = e.detail.message ? (e.detail.message + '\n' + (e.detail.stackTrace || '')) : JSON.stringify(e.detail);
            show(detail);
            report('error', 'blazor', detail);
        }
    });

    // Console hooks: console.error/warn keep printing normally AND land in the diagnostics log,
    // which is how the audio engines' silent-fallback warnings become visible without dev tools.
    // Lines written by .NET's own console logger (WASM writes ILogger output as
    // "warn: Category[id]") are skipped — DiagnosticsLoggerProvider already records those, and
    // forwarding them again would double every .NET warning in the ring buffer (found in review).
    var dotnetLogLine = /^(trce|dbug|info|warn|fail|crit): \S+\[\d+\]/;
    function hook(name, level) {
        var original = console[name].bind(console);
        console[name] = function () {
            original.apply(null, arguments);
            if (reporting) return; // don't re-enter from a console line emitted DURING a report (loop)
            try {
                if (typeof arguments[0] === 'string' && dotnetLogLine.test(arguments[0])) return;
                var text = Array.prototype.map.call(arguments, function (a) {
                    return a && a.stack ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a));
                }).join(' ');
                report(level, 'console', text);
            } catch (err) { /* never break console */ }
        };
    }
    hook('error', 'error');
    hook('warn', 'warn');

    // Exposed for the Diagnostics page: the crash-proof localStorage buffer survives a circuit crash +
    // reload (when the in-memory .NET ring is gone), so the page can fold recent crashes back in and the
    // user can actually SEE what crashed after reloading. clearCrashLog empties it (tied to "Clear").
    window.__mcCrashLog = {
        read: function () {
            try {
                var raw = window.localStorage.getItem(CRASH_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) { return []; }
        },
        clear: function () {
            try { window.localStorage.removeItem(CRASH_KEY); } catch (e) { /* ignore */ }
        },
    };
})();
