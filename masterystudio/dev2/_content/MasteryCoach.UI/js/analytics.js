// Usage analytics wrapper (WebAnalyticsPlan.md). Plain script (no module), loaded before Blazor —
// same style as errorCapture.js. Web-only in practice: the MAUI WebView's index doesn't load it.
//
// Design goals:
//  - ONE place that knows about the analytics tool (Umami today), so the sink is swappable.
//  - Silent + safe when unconfigured or off-host: local dev, a raw checkout, or a deploy without a
//    website-id must NOT phone home and must never error.
//  - track(name, props) never throws and tolerates being called before the tool script has loaded
//    (events queue, then flush once it's ready).
//
// Config is read from window.__mcAnalytics (set by a small inline script in index.html, which CI may
// rewrite). The Umami website-id is NOT a secret — it only identifies which dashboard receives
// events — so shipping a default is fine.
(function () {
    var cfg = window.__mcAnalytics || {};

    // Idempotency guard: if this IIFE somehow runs twice (a duplicated tag, an HMR reload), don't inject
    // a second Umami script — that would double every pageview and custom event. Bail if we already ran.
    if (cfg.__installed) return;

    // Resolve config, treating an unrewritten CI placeholder token as "unset". Matches ONLY the exact
    // __…__ token forms this project uses, not any value that merely starts and ends with '_', so a
    // legitimate id/URL is never silently discarded as a placeholder.
    function resolve(value) {
        if (typeof value !== 'string') return '';
        var v = value.trim();
        if (!v || /^__[A-Z0-9_]+__$/.test(v)) return '';
        return v;
    }

    var websiteId = resolve(cfg.websiteId);
    var scriptSrc = resolve(cfg.umamiSrc);

    // Per-device opt-out (user request): the owner's own laptop/phone traffic should never reach the
    // dashboard. A hardcoded IP list is useless here — the devices are on mobile-carrier CGNAT IPs that
    // rotate constantly, and a static page can't read its own public IP anyway. Instead a DURABLE
    // localStorage flag suppresses Umami on that device forever, set once per device via a URL param:
    //   ?notrack=1  -> opt OUT (persist the flag)      ?notrack=0 -> opt back IN (clear it)
    // The flag survives reloads/IP changes/offline. Best-effort: any storage failure (private mode,
    // disabled storage) just leaves tracking at its normal state — it must never throw.
    var OPT_OUT_KEY = 'masterycoach.analytics.optout';
    function isOptedOut() {
        try {
            var params = new URLSearchParams(window.location.search);
            if (params.has('notrack')) {
                var v = params.get('notrack');
                if (v === '0' || v === 'false') {
                    window.localStorage.removeItem(OPT_OUT_KEY); // opt back in
                } else {
                    window.localStorage.setItem(OPT_OUT_KEY, '1'); // opt out (any other value = on)
                }
            }
            return window.localStorage.getItem(OPT_OUT_KEY) === '1';
        } catch (e) {
            return false; // storage blocked → don't force opt-out; normal host rules apply
        }
    }

    // Don't track from local/dev origins even when configured — otherwise `dotnet run` and a
    // developer's browser would pollute the real dashboard. Only genuine web hosts report.
    function isTrackableHost() {
        try {
            var h = window.location.hostname;
            if (!h) return false;                          // file:// etc.
            if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return false;
            if (/\.local$/.test(h)) return false;
            return window.location.protocol === 'https:' || window.location.protocol === 'http:';
        } catch (e) { return false; }
    }

    var enabled = !!websiteId && !!scriptSrc && isTrackableHost() && !isOptedOut();

    // A tiny queue so track() calls made before Umami's script finishes loading aren't lost.
    var queue = [];
    var loaded = false;

    function drain() {
        if (!loaded || !window.umami || typeof window.umami.track !== 'function') return;
        while (queue.length) {
            var ev = queue.shift();
            try { window.umami.track(ev[0], ev[1]); } catch (e) { /* never break on a bad event */ }
        }
    }

    // Public API — the ONLY thing the app calls (via WebAnalytics.cs and errorCapture.js). Always safe
    // to call. NOTE: this file MUST load before any caller of __mcAnalytics.track (index.html orders it
    // before errorCapture.js); it installs .track here, so an earlier definition would be overwritten.
    window.__mcAnalytics = window.__mcAnalytics || {};
    window.__mcAnalytics.__installed = true;
    window.__mcAnalytics.enabled = enabled;
    window.__mcAnalytics.track = function (name, props) {
        if (!enabled || !name) return;
        try {
            if (loaded && window.umami && typeof window.umami.track === 'function') {
                window.umami.track(name, props || undefined);
            } else {
                queue.push([name, props || undefined]);
                if (queue.length > 200) queue.shift(); // bound it — analytics is never worth memory
            }
        } catch (e) { /* analytics must never throw into the app */ }
    };

    if (!enabled) {
        return; // unconfigured or off-host: the script is inert, no network, no tracking.
    }

    // Inject Umami's tracking script. It auto-collects pageviews/sessions; data-website-id scopes it.
    // data-auto-track stays on (default) for automatic session/reach; our track() adds custom events.
    try {
        var s = document.createElement('script');
        s.defer = true;
        s.src = scriptSrc;
        s.setAttribute('data-website-id', websiteId);
        s.addEventListener('load', function () { loaded = true; drain(); });
        s.addEventListener('error', function () {
            // The tool script was blocked (ad-blocker, COEP, offline). Stay silent — drop queued
            // events rather than retry forever.
            enabled = false;
            window.__mcAnalytics.enabled = false;
            queue.length = 0;
        });
        (document.head || document.documentElement).appendChild(s);
    } catch (e) {
        enabled = false;
        window.__mcAnalytics.enabled = false;
    }
})();
