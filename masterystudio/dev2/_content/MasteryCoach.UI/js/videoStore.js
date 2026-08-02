// Video-specific OPFS interop for the WEB build (VideoLibraryAndStudioSourcePlan.md §6.2,
// phase3-video-006: the IMPORT half). The C# side is WebVideoMediaStore.
//
// THE RULE THIS MODULE EXISTS TO KEEP (plan §2.10). A video is hundreds of megabytes. It must never
// become a `byte[]`, a whole-`ArrayBuffer` read, a `DotNetStreamReference` read-all, or a MEMFS
// working file — the P0 spike terminated the iPhone tab doing exactly that. So:
//
//   - The picked `File` is RETAINED HERE, in JS, keyed by an opaque token. It is never round-tripped
//     through .NET: no IJSStreamReference over it, no pickedFile()-style hand-off. .NET sees only the
//     small metadata record (name/size/type/lastModified) and the token.
//   - The bytes are read, hashed, and written entirely inside videoWorker.js, in bounded slices.
//     Nothing on this thread ever holds a chunk, let alone the asset.
//   - Progress and cancellation cross the boundary as numbers and a token, not as data.
//
// This module is deliberately SEPARATE from opfsStore.js rather than more exports on it. That module
// is the audio/data path, whose whole contract is "read the file, hand .NET the bytes" — the exact
// shape forbidden here. Keeping them apart means a future audio-shaped helper cannot be reused for
// video by accident.
//
// Playback object URLs, availability probes, delete, and stat are phase3-video-007 (below). The
// recording sink (phase3-video-008) lives in videoRecorder.js and reaches the worker through this
// module's exported `recordingWorkerOp`, so both paths share ONE worker and its OPFS serialization.
//
// Node-import safe (module-imports smoke test): no browser globals touched at module scope.

let worker = null;
let nextMsgId = 1;
const pending = new Map();
const IMPORT_INACTIVITY_TIMEOUT_MS = 90_000;

function clearPendingTimer(p) {
    if (p.timer !== null) {
        clearTimeout(p.timer);
        p.timer = null;
    }
}

function failAllPending(error, triggeringId) {
    const failure = error instanceof Error ? error : new Error(error);
    for (const [id, p] of pending.entries()) {
        clearPendingTimer(p);
        if (triggeringId === undefined || id === triggeringId) {
            p.reject(failure);
        } else {
            const collateral = new Error(
                `Video worker operation '${p.operation}' could not finish because the shared worker ` +
                `was reset after another operation failed: ${failure.message}`);
            collateral.name = 'VideoWorkerResetError';
            p.reject(collateral);
        }
    }
    pending.clear();
}

function resetWorker(error, triggeringId) {
    const failedWorker = worker;
    worker = null;
    failAllPending(error, triggeringId);
    if (failedWorker) {
        try { failedWorker.terminate(); } catch { }
    }
}

function ensureWorker() {
    if (!worker) {
        // Document-base-relative, same convention as opfsStore.js (resolves on native AND the
        // web-preview subpath). MODULE worker: videoWorker.js imports the incremental SHA-256.
        worker = new Worker('./_content/MasteryCoach.UI/js/videoWorker.js', { type: 'module' });
        worker.onmessage = (e) => {
            const { id, ok, error, result, progress, stage } = e.data;
            const p = pending.get(id);
            if (!p) return;

            // Progress/stage messages are activity, NOT completion: leave the entry pending and
            // re-arm the inactivity watchdog. Stage is worker-owned so a timeout names whether Safari
            // stopped while opening, copying, flushing, or committing instead of reporting "hung".
            if (progress !== undefined || stage !== undefined) {
                if (stage !== undefined) p.stage = stage;
                if (progress !== undefined) p.lastProgress = progress;
                if (p.armTimer) p.armTimer();
                if (progress !== undefined && p.onProgress) p.onProgress(progress);
                return;
            }

            pending.delete(id);
            clearPendingTimer(p);
            if (ok) p.resolve(result);
            else p.reject(new Error(error || 'video worker failed'));
        };
        // Same hazard opfsStore.js documents: a worker that fails to LOAD (404 on a mis-based deploy,
        // CSP, parse error) fires 'error' asynchronously and answers nothing — without this every
        // import would await forever with zero diagnostics. Fail everything loudly, drop the worker so
        // the next op retries with a fresh one.
        worker.onerror = (e) => {
            const reason = `video worker error: ${(e && e.message) || 'failed to load'}`;
            try { console.warn('[video] ' + reason); } catch { }
            resetWorker(new Error(reason));
        };
        // A deserialization failure means this channel cannot be trusted to answer the request that
        // triggered it. Reset it so the next cleanup/retry gets a fresh worker rather than reusing a
        // channel that has already stranded one operation.
        worker.onmessageerror = () =>
            resetWorker(new Error('video worker message deserialization failed'));
    }
    return worker;
}

function workerOp(message, onProgress, transfer, inactivity) {
    const id = nextMsgId++;
    return {
        id,
        promise: new Promise((resolve, reject) => {
            const entry = {
                resolve,
                reject,
                onProgress,
                timer: null,
                stage: inactivity && inactivity.initialStage,
                lastProgress: 0,
                armTimer: null,
                operation: message.op || 'unknown',
            };
            pending.set(id, entry);
            if (inactivity && inactivity.timeoutMs > 0) {
                entry.armTimer = () => {
                    clearPendingTimer(entry);
                    entry.timer = setTimeout(() => {
                        if (!pending.has(id)) return;
                        const error = new Error(inactivity.message(entry.stage, entry.lastProgress));
                        error.name = 'VideoImportStalledError';
                        // Termination is recovery, not just visibility: it releases a possibly wedged
                        // exclusive OPFS handle and lets deleteQuietly/retry create a fresh worker.
                        resetWorker(error, id);
                    }, inactivity.timeoutMs);
                };
                entry.armTimer();
            }
            try {
                const payload = { id, ...message };
                // Transferables move ownership of a chunk's ArrayBuffer to the worker instead of
                // structured-cloning it. Without this every recorder chunk would exist twice — on this
                // thread and in the worker — which at a 701-second capture's chunk rate is the
                // whole-recording-resident shape §6.3 forbids.
                if (transfer && transfer.length) ensureWorker().postMessage(payload, transfer);
                else ensureWorker().postMessage(payload);
            } catch (err) {
                pending.delete(id); // don't strand the entry when postMessage itself throws
                clearPendingTimer(entry);
                reject(err);
            }
        }),
    };
}

/// The worker channel, for videoRecorder.js's recording sink (§6.3, phase3-video-008).
///
/// Exported rather than duplicated because the ONE worker instance is what serializes OPFS mutations
/// against each other: a recording appending to its temp entry and an import committing another video
/// must not both hold a sync access handle. A second worker created by the recorder would reintroduce
/// exactly the collision videoWorker.js's queue comment exists to prevent.
export function recordingWorkerOp(message, transfer) {
    return workerOp(message, null, transfer).promise;
}

// -------------------------------------------------------------------------------------------------
// Support probe (§6.2: "Private Browsing/OPFS-unavailable gets a clear unsupported message; do not
// pretend the video will survive reload.")
// -------------------------------------------------------------------------------------------------

/// The explicit unsupported message §6.2 requires, or null when video storage IS available.
///
/// Probing is not just a feature test. Safari Private Browsing exposes `navigator.storage` and even
/// `getDirectory()`, but the store it hands back is discarded when the tab closes and on some builds
/// throws only when a write is attempted. So the probe actually OPENS a sync access handle on a
/// scratch entry in a worker — the same API the import uses — because that is the operation that
/// really fails there. A feature test alone would let a doomed 500 MB import start.
export async function checkVideoStorageSupport() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
        return 'This browser does not provide Origin Private File System storage, so videos cannot be ' +
            'stored in the app. Videos added here would not survive a page reload.';
    }
    if (typeof Worker === 'undefined') {
        return 'This browser does not support the background worker the app uses to store video, so ' +
            'videos cannot be stored here.';
    }

    try {
        const probePath = 'data/library/videos/.support-probe';
        const { promise } = workerOp({ op: 'import', tempPath: probePath, file: new Blob([new Uint8Array(1)]) });
        await promise;
        await workerOp({ op: 'delete', path: probePath }).promise;
        return null;
    } catch (err) {
        return 'This browser cannot store video for this site — most often because it is a Private ' +
            'Browsing window, where storage is discarded when the tab closes. Videos added here would ' +
            `not survive a page reload. (${(err && err.message) || 'storage probe failed'})`;
    }
}

// -------------------------------------------------------------------------------------------------
// Quota preflight (§6.2: warn when free quota is below file size + max(10%, 256 MB))
// -------------------------------------------------------------------------------------------------

/// The §6.2 safety margin: the larger of 10% of the file and 256 MB. Exported for the test harness —
/// this is arithmetic worth pinning, because a margin that quietly became "10% only" would let a
/// 40 MB import pass a preflight it should fail.
export function quotaMargin(fileSizeBytes) {
    return Math.max(Math.floor(fileSizeBytes * 0.1), 256 * 1024 * 1024);
}

/// Pure decision half of the preflight, so it is testable without a browser.
/// Returns { required, freeBytes, sufficient, quotaKnown }.
export function evaluateQuota(fileSizeBytes, usage, quota) {
    const required = fileSizeBytes + quotaMargin(fileSizeBytes);

    // quota === 0 means the browser declined to say (some Safari builds). Unknown is NOT "plenty":
    // reporting sufficient here would suppress the warning §6.2 exists to raise, so it is surfaced as
    // quotaKnown=false with sufficient=false and the caller warns rather than blocks.
    if (!(quota > 0)) {
        return { required, freeBytes: 0, sufficient: false, quotaKnown: false };
    }

    const freeBytes = Math.max(0, quota - usage);
    return { required, freeBytes, sufficient: freeBytes >= required, quotaKnown: true };
}

/// navigator.storage.estimate() + the §6.2 decision.
export async function checkVideoQuota(fileSizeBytes) {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
        return evaluateQuota(fileSizeBytes, 0, 0); // unknown → warn
    }
    const e = await navigator.storage.estimate();
    return evaluateQuota(fileSizeBytes, e.usage || 0, e.quota || 0);
}

/// Ask the browser to protect this origin's storage from eviction (§6.2: "Request
/// navigator.storage.persist() after the user chooses to keep a large library").
export async function requestVideoPersistence() {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return false;
    return await navigator.storage.persist();
}

// -------------------------------------------------------------------------------------------------
// The picked File, retained HERE (§6.2: "JS retains the picked File; do not round-trip it through
// .NET")
// -------------------------------------------------------------------------------------------------

// token -> File. Entries live until releaseVideo(token): a reattach comparison hashes the candidate
// and the caller may then import the SAME token, so a one-shot hand-off (opfsStore.js's pickedFile
// style) would silently lose it between the two calls.
const retained = new Map();
let nextToken = 1;

/// Open the video file chooser. Returns the small metadata record .NET needs to build a
/// PickedVideoFile — name, token, size, MIME, lastModified — and NOTHING that can open the bytes.
/// Null on cancel.
export async function pickVideo(accept) {
    const file = await openPicker(accept || 'video/*');
    if (!file) return null;
    return retainVideo(file);
}

/// Retain a `File` and return the metadata record for it. This is the ONE place a token is minted, so
/// it is also the one place to look to confirm that what leaves this module is metadata and a token —
/// never anything that can open the bytes.
///
/// Exported (rather than inlined into pickVideo) because it is also the seam the future
/// drag-and-drop and share-target entry points attach to, and because it is what lets the import
/// orchestration be tested without a DOM file chooser: the picker's job is producing a File, which is
/// browser behaviour, not this module's logic.
export function retainVideo(file) {
    const token = `v${nextToken++}`;
    retained.set(token, file);
    return describeRetained(token, file);
}

function describeRetained(token, file) {
    return {
        fileName: file.name,
        handleToken: token,
        lengthBytes: file.size,
        mimeType: file.type || null,
        // Epoch ms; .NET converts. A browser exposes no durable path for the picked file, which is
        // why sourcePath is absent here and SupportsLinkedFiles is false on this host (ARCH-010).
        lastModifiedMs: file.lastModified || 0,
    };
}

/// Whether a token still names a retained file. .NET probes this before an import so a stale token
/// (page reloaded, release already called) produces a diagnosable refusal rather than a hang.
export function hasRetainedVideo(token) {
    return retained.has(token);
}

/// Metadata for a retained token, or null. Lets the store re-read the size it will verify against
/// without trusting a value that round-tripped through .NET.
export function retainedVideoInfo(token) {
    const file = retained.get(token);
    return file ? describeRetained(token, file) : null;
}

/// Drop the retained reference. Called when the import commits, when the flow is abandoned, and on
/// page teardown — a retained File is only a handle, but a Map that only ever grows is still a leak.
export function releaseVideo(token) {
    return retained.delete(token);
}

function warnIfNoActivation() {
    try {
        if (navigator.userActivation && !navigator.userActivation.isActive) {
            console.warn('[video] pickVideo: no transient user activation — the browser will likely ' +
                'refuse to open the file dialog');
        }
    } catch { }
}

// The cancel event is authoritative where supported. Focus and visibility are useful diagnostics,
// but are not completion signals: Safari can return focus before it delivers a selected File. Do not
// turn either lifecycle observation, or a timeout based on one, into a cancellation/error; doing so
// discards a valid late selection on a cold iPhone load.
function openPicker(accept) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let pickerOpened = false;
        let openGuardTimer = null;
        let fallbackTimer = null;
        const input = document.createElement('input');

        const settle = (value, error) => {
            if (settled) return;
            settled = true;
            if (openGuardTimer !== null) clearTimeout(openGuardTimer);
            if (fallbackTimer !== null) clearTimeout(fallbackTimer);
            window.removeEventListener('focus', onRefocus, true);
            window.removeEventListener('blur', onBlur, true);
            document.removeEventListener('visibilitychange', onVisibilityChange, true);
            input.remove();
            if (error) reject(error);
            else resolve(value);
        };

        const markOpened = () => { pickerOpened = true; };
        const onBlur = () => markOpened();
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') markOpened();
        };
        const onRefocus = () => {
            if (fallbackTimer !== null) clearTimeout(fallbackTimer);
            fallbackTimer = setTimeout(() => {
                if (!pickerOpened) {
                    console.warn('[video] pickVideo: no picker lifecycle signal 1500 ms after refocus; ' +
                        'waiting for the browser to report selection or cancellation');
                }
            }, 1500);
        };

        input.type = 'file';
        input.accept = accept;
        // Safari treats a programmatically clicked file input as non-interactive when its rendered
        // hit target is outside the viewport. Keep a real 1px target in the viewport, but make it
        // almost transparent rather than fully transparent: a zero-sized, display:none, or opacity:0
        // input reintroduces the intermittent no-op this picker is specifically guarding against.
        input.style.position = 'fixed';
        input.style.left = '0';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0.01';
        input.onchange = () => {
            markOpened();
            settle(input.files && input.files.length ? input.files[0] : null);
        };
        input.oncancel = () => settle(null);
        window.addEventListener('focus', onRefocus, true);
        window.addEventListener('blur', onBlur, true);
        document.addEventListener('visibilitychange', onVisibilityChange, true);

        warnIfNoActivation();
        try {
            document.body.appendChild(input);
            input.click();
            if (!settled) {
                openGuardTimer = setTimeout(() => {
                    if (!pickerOpened) {
                        console.warn('[video] pickVideo: no picker lifecycle signal 1500 ms after click; ' +
                            'waiting for the browser to report selection or cancellation');
                    }
                }, 1500);
            }
        } catch (error) {
            const detail = error && error.message ? `: ${error.message}` : '';
            settle(null, new Error(`Opening the video file picker failed${detail}`));
        }
    });
}

// -------------------------------------------------------------------------------------------------
// The import (§6.2: chunked worker copy, incremental hash, progress, cancel, verify, then commit)
// -------------------------------------------------------------------------------------------------

// importToken -> the worker message id of the in-flight import, so cancelVideoImport can name it.
const activeImports = new Map();

/// Copy the retained file at `token` into OPFS at `finalPath`, via a temp entry.
///
/// ORDERING (§6.2, and the reviewer's named failure mode): the bytes land at `tempPath`; the length
/// and hash the worker actually computed are verified HERE; only then does the commit put anything at
/// `finalPath`. A rename-first ordering would present a corrupt file as imported.
///
/// `dotnetRef` is an optional DotNetObjectReference whose `ReportProgress(long)` receives bytes
/// written. It is invoked per chunk and any failure is swallowed — an unguarded invokeMethodAsync
/// from a callback can tear down the whole WASM app, and a progress bar is never worth that.
///
/// Returns { bytesWritten, hash, cancelled }.
export async function importPickedVideoToOpfs(
    token,
    finalPath,
    tempPath,
    importToken,
    dotnetRef,
    inactivityTimeoutMs = IMPORT_INACTIVITY_TIMEOUT_MS) {
    const file = retained.get(token);
    if (!file) {
        throw new Error(
            `The picked video is no longer retained under token '${token}', so there was nothing to ` +
            'import. The page was reloaded, or the pick was already released.');
    }

    const onProgress = dotnetRef
        ? (bytes) => {
            try {
                const p = dotnetRef.invokeMethodAsync('ReportProgress', bytes);
                if (p && typeof p.catch === 'function') p.catch(() => { });
            } catch { }
        }
        : null;

    const watchdog = (initialStage) => ({
        timeoutMs: inactivityTimeoutMs,
        initialStage,
        message: (stage, lastProgress) =>
            `Importing '${file.name}' stopped responding during ${stage || 'an unknown worker stage'} ` +
            `after ${lastProgress || 0} bytes. The Safari storage worker was reset and the partial ` +
            'copy will be removed. Try importing the file again.',
    });

    const op = workerOp(
        { op: 'import', tempPath, file },
        onProgress,
        null,
        watchdog('starting the worker copy'));
    if (importToken) activeImports.set(importToken, op.id);

    let copied;
    try {
        copied = await op.promise;
    } catch (err) {
        // §6.2: "On failure or cancellation, delete the temp entry and leave any prior media intact."
        // Nothing was committed, so whatever is at finalPath from an earlier import is untouched by
        // construction — this only removes the partial temp entry.
        await deleteQuietly(tempPath);

        // The worker formats its failures as "<name>: <message>", so an AbortError is identifiable by
        // the PREFIX. Anchored rather than a substring search: an unanchored match could be satisfied
        // by text further into the message, and misreading a real failure as a cancellation would
        // report "the user cancelled" for a storage error the user needs to see.
        if (/^AbortError:/.test(err && err.message ? err.message : '')) {
            return { bytesWritten: 0, hash: null, cancelled: true };
        }
        throw err;
    } finally {
        if (importToken) activeImports.delete(importToken);
    }

    // Verify BEFORE commit. The declared size is the picker's, i.e. a hint — but when it disagrees
    // with what was actually written, that is the interrupted-copy case, and committing it would
    // publish a truncated container that later reads treat as a complete video.
    if (file.size > 0 && copied.bytesWritten !== file.size) {
        await deleteQuietly(tempPath);
        throw new Error(
            `Importing '${file.name}' wrote ${copied.bytesWritten} bytes but the picker declared ` +
            `${file.size}. The import was abandoned before the commit, so nothing was written to the ` +
            'library; a partial copy must never become a managed video.');
    }

    if (!copied.hash) {
        await deleteQuietly(tempPath);
        throw new Error(
            `Importing '${file.name}' produced no content hash, so the copy could not be verified. ` +
            'The temp entry was removed and nothing was written to the library.');
    }

    try {
        await workerOp(
            { op: 'commit', tempPath, finalPath },
            null,
            null,
            watchdog('starting the verified-copy commit')).promise;
    } catch (err) {
        await deleteQuietly(tempPath);
        throw new Error(
            `Committing the imported video '${file.name}' failed, so no complete file was published ` +
            `to the library: ${(err && err.message) || 'commit failed'}`);
    }

    return { bytesWritten: copied.bytesWritten, hash: copied.hash, cancelled: false };
}

/// Cancel the in-flight import named by `importToken`. Returns whether an import was actually
/// flagged — false simply means it had already finished, which is a race, not an error.
export async function cancelVideoImport(importToken) {
    const id = activeImports.get(importToken);
    if (id === undefined) return false;
    const result = await workerOp({ op: 'cancel', importId: id }).promise;
    return !!(result && result.cancelled);
}

/// Hash the retained file at `token` WITHOUT copying it — the §7.2 reattach comparison. Same bounded
/// slices as the import; the candidate file is only ever read.
export async function hashRetainedVideo(token) {
    const file = retained.get(token);
    if (!file) {
        throw new Error(
            `The candidate video is no longer retained under token '${token}', so it could not be ` +
            'hashed for comparison.');
    }
    const result = await workerOp({ op: 'hash', file }).promise;
    return result.hash;
}

/// Best-effort temp cleanup on an ALREADY-failing path: the caller's original error is the one worth
/// reporting, and a surviving *.import.tmp entry is a recognizable orphan, not data loss. The failure
/// is still named on the console so it is diagnosable.
async function deleteQuietly(path) {
    try {
        await workerOp(
            { op: 'delete', path },
            null,
            null,
            {
                timeoutMs: 15_000,
                initialStage: 'removing the abandoned import temp entry',
                message: () =>
                    `Removing the abandoned import temp entry '${path}' stopped responding. The ` +
                    'storage worker was reset; the recognizable .import.tmp entry may require a ' +
                    'later cleanup.',
            }).promise;
    } catch (err) {
        try {
            console.warn(`[video] could not remove the abandoned import temp entry '${path}': ` +
                `${(err && err.message) || 'delete failed'}`);
        } catch { }
    }
}

// -------------------------------------------------------------------------------------------------
// Playback, stat, and delete (§6.2, phase3-video-007). The C# side is WebVideoMediaStore's
// OpenPlaybackSourceAsync / ReleasePlaybackSourceAsync / GetAvailabilityAsync / Delete* .
//
// WHY THESE THREE RUN ON THE MAIN THREAD AND DELETE DOES NOT.
//
//   - `openOpfsVideoUrl` and `statOpfsVideo` are READS. `getFile()` on a FileSystemFileHandle is
//     available on the main thread (only `createSyncAccessHandle` is worker-only), and it hands back a
//     lazy `File` — a handle onto the OPFS entry, NOT its bytes. That laziness is the whole §2.10
//     point: `URL.createObjectURL(file)` on it yields a URL the element range-reads on demand, which
//     is what the P0 iPhone spike proved seeks near the end of a 500 MB asset without materializing
//     it. An object URL minted inside a worker is scoped to that worker's context and is NOT loadable
//     by a main-thread `<video>`, so this cannot be moved there even if we wanted to.
//   - `deleteOpfsVideo` is a MUTATION, so it goes through the worker like every other one — that is
//     where OPFS ops are serialized against each other (videoWorker.js's queue comment). Deleting on
//     this thread while the worker holds a sync access handle on the same entry would fail with
//     NoModificationAllowedError.
// -------------------------------------------------------------------------------------------------

/// Resolve an OPFS path to its file handle WITHOUT creating anything. Returns null when any segment
/// on the way is absent — "the entry is gone" is an availability answer (§6.4), not an exception.
/// A non-NotFound failure still throws: an OPFS that is broken for some other reason must not be
/// reported to the user as "your video is missing".
async function findFileHandle(path) {
    const segments = String(path || '').split('/').filter(s => s.length > 0);
    if (segments.length === 0) return null;

    try {
        let dir = await navigator.storage.getDirectory();
        for (let i = 0; i < segments.length - 1; i++) {
            dir = await dir.getDirectoryHandle(segments[i], { create: false });
        }
        return await dir.getFileHandle(segments[segments.length - 1], { create: false });
    } catch (err) {
        // TypeMismatchError: the name exists but is a directory — for a video path that is "not the
        // file we stored", i.e. equally absent.
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return null;
        throw err;
    }
}

// Every object URL this module has minted and not yet revoked, url -> path. Kept for two reasons that
// both matter on Safari, where an unrevoked object URL pins the whole file:
//   1. revokeVideoUrl can report whether it actually revoked something, so .NET's release is not a
//      blind call that silently succeeds on a URL this module never issued;
//   2. deleteOpfsVideo revokes any live URL for the entry it is about to delete — a URL surviving its
//      file is exactly the leak §13 ("object URL revoked on switch/dispose/delete") forbids.
const issuedUrls = new Map();

/// Open the OPFS entry at `path` as an object URL for a `<video>` element (§6.2:
/// "getFile() + URL.createObjectURL(file) is handed directly to <video>").
///
/// Returns { url, lengthBytes, mimeType } or null when the entry is not there — null is the
/// availability answer the caller maps, never a thrown "missing file".
///
/// The `File` is NOT read here. Nothing in this function touches `.arrayBuffer()`, `.stream()`, or
/// `.text()`; `createObjectURL` records a reference to the blob's backing store and the element
/// range-reads it as it plays.
export async function openOpfsVideoUrl(path) {
    const handle = await findFileHandle(path);
    if (!handle) return null;

    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    issuedUrls.set(url, path);

    return {
        url,
        lengthBytes: file.size,
        // The stored entry's own type, which OPFS usually reports as empty — the caller keeps the
        // MIME recorded at import time for that case rather than guessing one here.
        mimeType: file.type || null,
    };
}

/// Revoke an object URL minted by openOpfsVideoUrl (§6.2 "Revoke on unload/source switch").
/// Returns whether this module was still tracking it: false means it was already revoked or was never
/// issued here, which is the expected result of the idempotent second release, not a failure.
///
/// URL.revokeObjectURL is still called for an untracked value on purpose. A URL that round-tripped
/// through .NET and back must revoke even if this map was cleared, and revoking an unknown string is
/// a documented no-op.
export function revokeVideoUrl(url) {
    if (!url) return false;
    const tracked = issuedUrls.delete(url);
    try {
        URL.revokeObjectURL(url);
    } catch (err) {
        // Nothing actionable — the URL is being abandoned either way — but a revoke that started
        // throwing would otherwise silently become a per-playback whole-file leak on Safari.
        try {
            console.warn(`[video] revoking a playback object URL failed: ${(err && err.message) || 'revoke failed'}`);
        } catch { }
    }
    return tracked;
}

/// Metadata for the durable OPFS entry at `path`, or null when it is not there (§6.4: "Managed: check
/// durable store entry, not merely a warm MEMFS path"). Reads no bytes — `getFile()` returns a lazy
/// handle and only its `size`/`type` are touched.
export async function statOpfsVideo(path) {
    const handle = await findFileHandle(path);
    if (!handle) return null;
    const file = await handle.getFile();
    return { lengthBytes: file.size, mimeType: file.type || null };
}

/// Hands a lazy OPFS File to Web Share when available, otherwise to an object-URL download. The
/// File's bytes are never read into an ArrayBuffer/base64/managed stream. Browsers do not reveal a
/// durable destination, so the result deliberately never contains one.
export async function exportOpfsVideo(path, suggestedFileName) {
    const handle = await findFileHandle(path);
    if (!handle) {
        throw new Error(`Cannot export '${path}' because the managed OPFS video does not exist.`);
    }

    const file = await handle.getFile();
    const fileName = suggestedFileName || file.name || 'video';
    if (navigator.share && navigator.canShare) {
        if (navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file] });
                return { completed: true, fileName, durablePath: null };
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    return { completed: false, fileName: null, durablePath: null };
                }
                throw error;
            }
        }
    }

    const url = URL.createObjectURL(file);
    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        try {
            anchor.click();
            return { completed: true, fileName, durablePath: null };
        } finally {
            anchor.remove();
        }
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

/// Delete the OPFS entry at `path`, first revoking any object URL still open on it.
///
/// Returns whether anything was there to delete; an already-absent entry is the outcome the caller
/// wanted, not an error (the worker's removeEntry treats NotFound the same way). A REAL failure
/// throws, because §7.1/§7.3 make a failed byte deletion something the caller must be able to report
/// rather than a silently orphaned copy.
export async function deleteOpfsVideo(path) {
    // Before the bytes go: a live object URL outliving its file is the §13 leak. Iterating rather
    // than a reverse index because at most a handful of URLs are ever open at once (one per playing
    // element).
    for (const [url, issuedPath] of [...issuedUrls]) {
        if (issuedPath === path) revokeVideoUrl(url);
    }

    const existed = (await findFileHandle(path)) !== null;
    await workerOp({ op: 'delete', path }).promise;
    return existed;
}

/// Delete every entry directly inside the OPFS directory at `dirPath`, then the directory itself —
/// the §7.3 "delete everything this store holds for this video" path, scoped to ONE video's folder.
///
/// Returns the number of entries removed. An absent directory is 0, not an error. The scope is the
/// caller's `dirPath` and nothing above it: this never walks to a parent, so a bad call can lose one
/// video's bytes, never the whole library.
export async function deleteOpfsVideoFolder(dirPath) {
    const segments = String(dirPath || '').split('/').filter(s => s.length > 0);
    if (segments.length === 0) {
        throw new Error('deleteOpfsVideoFolder was given an empty path; refusing to delete the OPFS root.');
    }

    let dir;
    try {
        dir = await navigator.storage.getDirectory();
        for (const segment of segments) {
            dir = await dir.getDirectoryHandle(segment, { create: false });
        }
    } catch (err) {
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return 0;
        throw err;
    }

    // Revoke first, for the same reason deleteOpfsVideo does: these URLs are about to name files that
    // no longer exist.
    const prefix = segments.join('/') + '/';
    for (const [url, issuedPath] of [...issuedUrls]) {
        const normalized = String(issuedPath || '').split('/').filter(s => s.length > 0).join('/');
        if (normalized.startsWith(prefix)) revokeVideoUrl(url);
    }

    let removed = 0;
    for await (const name of dir.keys()) {
        await workerOp({ op: 'delete', path: `${prefix}${name}` }).promise;
        removed++;
    }

    // The now-empty folder itself. Removing it is what keeps a "delete video" from leaving an empty
    // per-video directory behind; a failure here is reported, since a leftover directory the caller
    // believes is gone is worth surfacing.
    await workerOp({ op: 'delete', path: prefix.slice(0, -1) }).promise;
    return removed;
}

/// List durable managed-video folders through the OPFS worker only. This never calls hydration.
export async function listOpfsVideoFolders(root) {
    return await workerOp({ op: 'listVideoFolders', root }).promise;
}

// -------------------------------------------------------------------------------------------------
// Codec probe (§6.4: "Codec support is a JS <video>.canPlayType(mime)/metadata-load probe. A
// container may exist but still be unusable on the current browser.")
// -------------------------------------------------------------------------------------------------

/// Decide from `canPlayType`'s three-valued answer alone, without a load. Exported because it is the
/// only part of the probe that is pure, and because the mapping is worth pinning: `canPlayType`
/// returns '' (no), 'maybe', or 'probably', and treating 'maybe' as a refusal would report
/// UnsupportedFormat for the majority of real files — Safari answers 'maybe' for a plain
/// `video/mp4` with no codecs parameter.
///
/// Returns 'no' | 'unknown'. There is deliberately no 'yes': a positive canPlayType is a statement
/// about the CONTAINER, not about this file, so it can only defer to the metadata load.
export function classifyCanPlayType(answer) {
    return answer === '' || answer === undefined || answer === null ? 'no' : 'unknown';
}

/// Probe whether this browser can actually play the media at `url` (§6.4).
///
/// Returns { playable, reason }. Two stages, because either alone is wrong:
///   1. `canPlayType(mime)` returning '' is a definite no and costs nothing — no element is attached
///      to the URL at all.
///   2. Otherwise the element is asked to LOAD METADATA. That is what catches the case §6.4 names —
///      a container the browser nominally supports holding a codec it does not — which canPlayType
///      cannot see, and which the P0 spike's malformed-duration recordings are a live example of.
///
/// `preload='metadata'` means the element reads the container header, not the asset. The element is
/// torn down on every exit path (its `src` is cleared and `load()` called), because an abandoned
/// element holding an object URL keeps the whole file pinned on Safari.
///
/// A probe that cannot run (no document, no element support) reports playable:true with a reason. It
/// downgrades to "assume it plays" rather than throwing or claiming UnsupportedFormat: the store's
/// §6.4 rule is that a stale Available must not bypass a real open failure, and the open failure is
/// still ahead — whereas reporting UnsupportedFormat here would hide a perfectly good video behind a
/// verdict nothing actually observed.
export async function probeVideoPlayable(url, mimeType, timeoutMs) {
    if (typeof document === 'undefined' || !document.createElement) {
        return { playable: true, reason: 'no document is available to run the codec probe' };
    }

    let element;
    try {
        element = document.createElement('video');
    } catch {
        element = null;
    }
    if (!element || typeof element.canPlayType !== 'function') {
        return { playable: true, reason: 'this browser exposes no <video> element to probe with' };
    }

    if (mimeType && classifyCanPlayType(element.canPlayType(mimeType)) === 'no') {
        return {
            playable: false,
            reason: `this browser reports it cannot play '${mimeType}' media`,
        };
    }

    return await new Promise((resolve) => {
        let settled = false;
        let timer = null;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            element.removeEventListener('loadedmetadata', onLoaded);
            element.removeEventListener('error', onError);
            // Detach BEFORE the caller can revoke: an element still holding the src keeps the file
            // pinned even after revokeObjectURL.
            try {
                element.removeAttribute('src');
                element.load();
            } catch { }
            resolve(result);
        };

        const onLoaded = () => finish({
            playable: true,
            reason: null,
            metadataObserved: true,
            durationSeconds: Number.isFinite(element.duration) ? element.duration : null,
            widthPixels: element.videoWidth || null,
            heightPixels: element.videoHeight || null,
        });
        const onError = () => {
            const code = element.error && element.error.code;
            // MEDIA_ERR_SRC_NOT_SUPPORTED (4) and MEDIA_ERR_DECODE (3) are the format verdicts §6.4
            // asks for. A network/abort error (1, 2) is NOT a format verdict — reporting it as
            // UnsupportedFormat would tell the user to re-encode a file that is merely unreadable
            // right now — so it resolves playable with the reason named instead.
            const unsupported = code === 3 || code === 4;
            finish({
                playable: !unsupported,
                reason: unsupported
                    ? `the browser could not decode this video (media error ${code})`
                    : `the codec probe could not read the video (media error ${code || 'unknown'})`,
            });
        };

        element.addEventListener('loadedmetadata', onLoaded);
        element.addEventListener('error', onError);
        element.preload = 'metadata';
        // Keep the detached metadata probe out of iOS's native fullscreen presentation; a probe
        // diverted there is not a fair observation of whether the finalized container decodes.
        element.playsInline = true;
        element.setAttribute('playsinline', '');
        element.muted = true;
        element.src = url;

        // A `<video>` that neither loads nor errors — Safari has done this for entries it is still
        // resolving — must not leave the caller's availability probe pending forever. The timeout
        // resolves PLAYABLE: an inconclusive probe is not evidence of a bad codec. Say explicitly
        // that no media error arrived so device evidence distinguishes a decoder refusal from a
        // probe that WebKit never completed.
        const limit = timeoutMs > 0 ? timeoutMs : 10000;
        timer = setTimeout(
            () => finish({
                playable: true,
                reason: `the codec probe timed out after ${limit} ms with no media error`,
            }),
            limit);

        try {
            element.load();
        } catch (err) {
            finish({
                playable: true,
                reason: `the codec probe could not start: ${(err && err.message) || 'load failed'}`,
            });
        }
    });
}
