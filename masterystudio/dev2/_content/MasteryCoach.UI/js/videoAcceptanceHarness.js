// Debug video-acceptance helpers. Production playback is entirely in videoPlayer.js; this module
// only turns a post-unload object-URL probe into an explicit evidence verdict.

export async function verifyReleasedObjectUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('blob:')) {
        throw new Error(
            `verifyReleasedObjectUrl expected a browser blob: playback URL; received '${url || '<empty>'}'.`);
    }

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0' },
            cache: 'no-store',
        });

        return {
            released: !response.ok,
            detail: response.ok
                ? `FAILED: the supposedly revoked object URL still returned HTTP ${response.status}.`
                : `PASS: the revoked object URL was refused with HTTP ${response.status}.`,
        };
    } catch (error) {
        // Fetch rejecting is the normal browser result for a revoked blob URL. Name both the probe
        // and the browser observation so this cannot become a silent catch-all success.
        return {
            released: true,
            detail: `PASS: fetching the revoked object URL failed (${error?.name || 'Error'}: ` +
                `${error?.message || 'browser refused the URL'}).`,
        };
    }
}
