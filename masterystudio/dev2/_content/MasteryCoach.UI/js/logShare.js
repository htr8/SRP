// Share/save the diagnostics log as a file from the WEB build (the MAUI heads use the native Share
// sheet via DiagnosticsLog.ShareRequested; this is the browser twin). Two-tier, best-effort:
//   1. Web Share API with a File — on iOS Safari / Android Chrome this raises the REAL native share
//      sheet (Messages, AirDrop, Save to Files, …), which is what you want on a phone.
//   2. Fallback: a Blob download (an <a download> click) — works everywhere Web Share (files) doesn't,
//      e.g. desktop Firefox or a browser that only shares URLs.
// Must be called from a user gesture (the Share button click) — both navigator.share and the download
// need transient activation. Returns a short status string for the page to show; never throws.

export async function shareText(filename, text) {
    const safeName = (filename && String(filename)) || 'masterycoach-log.txt';
    const body = text == null ? '' : String(text);

    // Prefer the native share sheet with a file, when the browser can share files (canShare gates it —
    // Safari throws on share() with unsupported files rather than falling back, so check first).
    try {
        if (typeof navigator !== 'undefined' && navigator.share && typeof File === 'function') {
            const file = new File([body], safeName, { type: 'text/plain' });
            if (!navigator.canShare || navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'MasteryCoach log' });
                return 'shared';
            }
        }
    } catch (e) {
        // A user cancel (AbortError) is not a failure — report it so the page stays quiet.
        if (e && e.name === 'AbortError') return 'cancelled';
        // Any other share failure → fall through to the download.
    }

    // Fallback: download the file.
    try {
        const blob = new Blob([body], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = safeName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke on the next tick so the click's navigation has consumed the URL.
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* already gone */ } }, 1000);
        return 'downloaded';
    } catch (e) {
        return 'failed';
    }
}
