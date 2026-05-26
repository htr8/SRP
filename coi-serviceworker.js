/**
 * coi-serviceworker — Cross-Origin Isolation + Asset Caching
 *
 * SharedArrayBuffer (required for .NET 9 WASM multi-threading) needs the page to be
 * "cross-origin isolated", which means the server must send:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: credentialless
 *
 * Static hosts like GitHub Pages don't support custom response headers, so this
 * service worker intercepts every fetch and adds those headers to the response.
 *
 * Additionally, _framework/ assets (WASM binaries, JS, JSON) are cached after
 * first download so repeat visits are near-instant (~34 MB saved on reload).
 * The cache is versioned — a new deployment naturally busts it because
 * blazor.boot.json changes (SRI hashes differ), triggering fresh fetches.
 *
 * Flow:
 *   1st load  — SW is registered; after it activates it posts "reload" to all clients.
 *   2nd load  — SW is active, injects headers, crossOriginIsolated === true, app runs.
 *   repeat    — _framework/ assets served from cache, other requests go to network.
 */

const CACHE_NAME = "sr-framework-1779800109";

// Asset paths worth caching (large, stable between deployments).
// CSS is intentionally excluded — it's small and changes frequently; serving stale
// CSS after a deploy causes missing styles until the cache cycle completes.
// Fonts (.woff2) and JS bundles are included as they rarely change.
function isCacheable(url) {
    return url.includes("/_framework/") ||
           url.includes("/js/") ||
           url.endsWith(".woff2");
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", event =>
    event.waitUntil(
        Promise.all([
            // Clean up old cache versions
            caches.keys().then(keys =>
                Promise.all(keys
                    .filter(k => k.startsWith("sr-framework-") && k !== CACHE_NAME)
                    .map(k => caches.delete(k))
                )
            ),
            self.clients.claim().then(() =>
                self.clients.matchAll({ type: "window" }).then(clients =>
                    clients.forEach(c => c.postMessage({ type: "COI_RELOAD" }))
                )
            ),
        ])
    )
);

function addCOIHeaders(resp) {
    if (resp.type === "opaque" || resp.type === "opaqueredirect") return resp;
    const headers = new Headers(resp.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    return new Response(resp.body, {
        status:     resp.status,
        statusText: resp.statusText,
        headers,
    });
}

self.addEventListener("fetch", event => {
    const req = event.request;

    // Skip opaque cache-only cross-origin requests (would throw on Response construction).
    if (req.cache === "only-if-cached" && req.mode !== "same-origin") return;

    // Cache API only supports GET — skip HEAD requests (e.g. the worker probe in index.html).
    if (req.method !== "GET") {
        event.respondWith(fetch(req).then(resp => addCOIHeaders(resp)));
        return;
    }

    if (isCacheable(req.url)) {
        // Cache-first for framework assets (immutable between deployments)
        event.respondWith(
            caches.open(CACHE_NAME).then(cache =>
                cache.match(req).then(cached => {
                    if (cached) return addCOIHeaders(cached);
                    return fetch(req).then(resp => {
                        if (resp.ok) cache.put(req, resp.clone());
                        return addCOIHeaders(resp);
                    });
                })
            )
        );
    } else {
        // Network-first for HTML, JSON data, API calls
        event.respondWith(
            fetch(req).then(resp => addCOIHeaders(resp))
        );
    }
});
