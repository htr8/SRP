// Chunked OPFS video import worker (VideoLibraryAndStudioSourcePlan.md §6.2, phase3-video-006).
//
// WHY A SECOND WORKER, not opfsWorker.js. That worker's protocol is one message = one complete op
// against a whole ArrayBuffer the MAIN thread already holds. A video import is the opposite shape: a
// single long-running op that must read, hash, and write a multi-hundred-megabyte File in bounded
// slices, report progress while it runs, and be cancellable mid-flight. Driving that through the
// per-message protocol would put the read loop on the main thread — every slice's bytes crossing the
// postMessage boundary — and would need cross-message hash state in a file whose contract is
// deliberately stateless. Here the File is transferred in ONCE and never leaves the worker.
//
// MODULE worker (`{ type: 'module' }`), unlike the classic opfsWorker: it imports the incremental
// SHA-256. Both Chrome and Safari 15+ support module workers, and Safari is the constraining host for
// OPFS writes anyway (createSyncAccessHandle is worker-only, which is why any OPFS mutation is here).
//
// §2.10 / §6.2 prohibition, enforced structurally: the ONLY read of the picked file below is
// `blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer()`. There is no `file.arrayBuffer()`, no
// `FileReader.readAsArrayBuffer(file)`, no `new Response(file).arrayBuffer()`, and nothing here ever
// holds more than one CHUNK_BYTES buffer. A whole-asset read is what terminates the iPhone tab.
//
// It also owns the RECORDING sink (§6.3, phase3-video-008) for the same reason: appending a recorder
// chunk is an OPFS mutation, createSyncAccessHandle is worker-only, and the sink must hold ONE open
// handle across hundreds of appends while nothing ever accumulates the recording.
//
// Protocol (one message per op, answered by id):
//   in : { id, op: 'import',  tempPath, file, chunkBytes? }
//        { id, op: 'commit',  tempPath, finalPath }
//        { id, op: 'delete',  path }
//        { id, op: 'cancel',  importId }   // importId is the id of the in-flight 'import'
//        { id, op: 'hash',    file, chunkBytes? }
//        { id, op: 'recordBegin',   tempPath, mimeType }
//        { id, op: 'recordAppend',  tempPath, sequence, buffer }
//        { id, op: 'recordPrepareProbe', tempPath }
//        { id, op: 'recordFinish',  tempPath, finalPath, mimeType, durationSeconds, width, height,
//                                   captureSeconds? }
//        { id, op: 'recordCancel',  tempPath }
//        { id, op: 'recordCleanup', root, olderThanMs }
//   out: { id, ok: true, result? } | { id, ok: false, error } | { id, progress: <bytes> }

import { Sha256 } from './sha256.js';

// 8 MiB: big enough that a 500 MB import is ~64 slices rather than thousands of syscalls, small
// enough that peak worker memory stays flat regardless of asset size. Cancellation granularity is one
// chunk, which §6.2 explicitly permits ("cancellation at chunk boundaries").
const CHUNK_BYTES = 8 * 1024 * 1024;

// In-flight imports, keyed by their request id, so a later 'cancel' message can reach them. Cleared
// when the import settles either way.
const inFlight = new Map();

// Ops are chained for the SAME reason opfsWorker.js chains them: async handlers interleave at their
// awaits, and two OPFS mutations touching one file would collide on createSyncAccessHandle (one open
// handle per file). 'cancel' is deliberately NOT chained — it must be able to reach an import that is
// currently running, which is exactly the op holding the chain.
let queue = Promise.resolve();

// Walk "a/b/c.mp4" to its parent directory handle. `create` makes the directories on the way.
async function parentDir(path, create) {
    const segments = path.split('/').filter(s => s.length > 0);
    if (segments.length === 0) throw new Error('empty OPFS path');
    let dir = await navigator.storage.getDirectory();
    for (let i = 0; i < segments.length - 1; i++) {
        dir = await dir.getDirectoryHandle(segments[i], { create });
    }
    return { dir, name: segments[segments.length - 1] };
}

async function removeEntry(path) {
    try {
        const { dir, name } = await parentDir(path, false);
        await dir.removeEntry(name);
    } catch (err) {
        // Absent = already gone = the outcome the caller wanted. Anything else is a real failure and
        // is reported by the caller (the cleanup paths below name what they were cleaning up).
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return;
        throw err;
    }
}

/// Write every byte or fail naming the short write. FileSystemSyncAccessHandle.write returns the
/// count actually written; treating a short write as success advances the hash/progress past bytes
/// that never reached storage. WebKit documents that count explicitly, so it is not optional status.
async function writeAll(access, bytes, offset, operation) {
    let consumed = 0;
    while (consumed < bytes.length) {
        const view = bytes.subarray(consumed);
        const count = await access.write(view, { at: offset + consumed });
        if (!Number.isInteger(count) || count <= 0 || count > view.length) {
            throw new Error(
                `${operation} wrote ${count} of ${view.length} requested bytes at offset ` +
                `${offset + consumed}; the incomplete write was refused.`);
        }
        consumed += count;
    }
    return consumed;
}

/// Copy `file` into the OPFS entry at `tempPath` in bounded slices, hashing incrementally and posting
/// a progress message per slice. Returns { bytesWritten, hash } — the length is what was ACTUALLY
/// written (a counter incremented by each slice's real byteLength), never the File's declared size,
/// so a short read cannot report as a complete copy.
async function importToTemp(id, tempPath, file, chunkBytes) {
    const size = file.size;
    const step = chunkBytes > 0 ? chunkBytes : CHUNK_BYTES;

    const state = { cancelled: false, tempPath };
    inFlight.set(id, state);
    self.postMessage({ id, stage: 'opening the temporary OPFS entry' });

    // Truncate on open: a leftover temp from an earlier crashed attempt must not have its tail
    // survive under a shorter new copy.
    const { dir, name } = await parentDir(tempPath, true);
    const handle = await dir.getFileHandle(name, { create: true });
    // Safari 15.2–16.3 returned Promises from these; awaiting a non-promise is a no-op on modern
    // engines, and NOT awaiting on those Safari versions lets close() race the write (opfsWorker.js
    // review finding — same hazard, same rule).
    const access = await handle.createSyncAccessHandle();

    const sha = new Sha256();
    let written = 0;

    try {
        await access.truncate(0);
        self.postMessage({ id, stage: 'copying and hashing the selected file' });

        for (let offset = 0; offset < size; offset += step) {
            // Chunk-boundary cancellation (§6.2). Checked BEFORE the read so a cancel that arrives
            // during a slice costs at most one more slice, never the rest of the file.
            if (state.cancelled) {
                throw new DOMException('The video import was cancelled.', 'AbortError');
            }

            // The one and only read of the picked file: a bounded Blob slice. Slicing a File does not
            // read it — the returned Blob is still a lazy handle onto the same on-disk range — so only
            // these `step` bytes are ever resident.
            const slice = file.slice(offset, Math.min(offset + step, size));
            const bytes = new Uint8Array(await slice.arrayBuffer());

            if (bytes.length === 0) {
                // The picker's size said there were more bytes but the file yielded none: the user
                // deleted/ejected the source mid-import. Fail loudly — the alternative is committing a
                // truncated container that later reads treat as a complete video.
                throw new Error(
                    `The picked video ended after ${written} of ${size} bytes, so the copy is ` +
                    'incomplete. The source file was changed or removed while it was being imported.');
            }

            await writeAll(access, bytes, written, 'Importing the selected video');
            sha.update(bytes);
            written += bytes.length;

            self.postMessage({ id, progress: written });
        }

        self.postMessage({ id, stage: 'flushing the temporary OPFS entry' });
        await access.flush();
    } finally {
        // Close before ANY cleanup: an open sync access handle is exclusive, so removeEntry on the
        // same path would fail with NoModificationAllowedError while it is held.
        try { await access.close(); } catch { }
        inFlight.delete(id);
    }

    return { bytesWritten: written, hash: sha.hex() };
}

/// Hash a picked file WITHOUT copying it — the reattach comparison (§7.2). Same bounded-slice rule.
async function hashFile(file, chunkBytes) {
    const step = chunkBytes > 0 ? chunkBytes : CHUNK_BYTES;
    const sha = new Sha256();
    let read = 0;
    for (let offset = 0; offset < file.size; offset += step) {
        const slice = file.slice(offset, Math.min(offset + step, file.size));
        const bytes = new Uint8Array(await slice.arrayBuffer());
        if (bytes.length === 0) {
            throw new Error(
                `Hashing the picked video ended after ${read} of ${file.size} bytes; the file was ` +
                'changed or removed while it was being read.');
        }
        sha.update(bytes);
        read += bytes.length;
    }
    return { bytesRead: read, hash: sha.hex() };
}

/// Commit the verified temp entry onto its final path.
///
/// OPFS has no rename, so "rename" is copy-then-delete at the OPFS layer — but the ORDERING is what
/// §6.2 actually requires and it is preserved: nothing reaches `finalPath` until the temp entry's
/// length and hash have already been verified by the caller. The copy is itself chunked (a commit
/// must not do the whole-buffer read the import just avoided), and if it fails partway the final
/// entry is removed so a partial file can never be mistaken for an imported video.
async function commit(tempPath, finalPath, requestId) {
    const source = await parentDir(tempPath, false);
    const sourceHandle = await source.dir.getFileHandle(source.name, { create: false });
    const sourceFile = await sourceHandle.getFile();

    const target = await parentDir(finalPath, true);
    const targetHandle = await target.dir.getFileHandle(target.name, { create: true });
    const access = await targetHandle.createSyncAccessHandle();

    let written = 0;
    try {
        await access.truncate(0);
        for (let offset = 0; offset < sourceFile.size; offset += CHUNK_BYTES) {
            const slice = sourceFile.slice(offset, Math.min(offset + CHUNK_BYTES, sourceFile.size));
            const bytes = new Uint8Array(await slice.arrayBuffer());
            if (bytes.length === 0) break;
            await writeAll(access, bytes, written, 'Committing the imported video');
            written += bytes.length;
            self.postMessage({ id: requestId, progress: written });
        }
        await access.flush();
    } catch (err) {
        try { await access.close(); } catch { }
        // The half-written committed entry is the one thing that must not survive: a reader cannot
        // tell it from a finished import. The temp entry is deliberately LEFT — it is verified-good
        // and recognizable, so a retry has something to commit from.
        try { await removeEntry(finalPath); } catch { }
        throw err;
    }
    await access.close();

    if (written !== sourceFile.size) {
        try { await removeEntry(finalPath); } catch { }
        throw new Error(
            `Committing the imported video copied ${written} of ${sourceFile.size} verified bytes; ` +
            'the partial entry was removed rather than published as a complete video.');
    }

    // Only now is the temp entry redundant. A failure here leaves a recognizable orphan, not data
    // loss, so it is reported rather than fatal to the commit that already succeeded.
    await removeEntry(tempPath);
    return { bytesWritten: written };
}

// =================================================================================================
// The recording sink (§6.3, phase3-video-008)
//
// THE PROHIBITION THIS SECTION IS SHAPED AROUND (§6.3 / locked decision §2.14): "holding the whole
// recording as a Blob list, byte[], or ArrayBuffer until Stop is forbidden". So there is no array of
// chunks below — not even "just for retry" on a failure path. Each `recordAppend` writes its buffer
// straight into the already-open sync access handle, folds it into the running SHA-256, and drops it.
// A 701-second capture (the accepted iPhone run) costs one in-flight chunk, whatever its size.
//
// AND COMPLETION DOES NOT TRUST ITS OWN BYTE COUNT. Two rejected device runs finalized with correct
// byte totals and a duration of NaN / 7,158,897.04 s. `recordFinish` therefore validates the finalized
// metadata BEFORE publishing anything, and a failure deletes the temp instead of minting a permanent
// record that points at an unplayable file.
// =================================================================================================

/// The suffix that makes an in-flight recording entry RECOGNIZABLE, which is what lets the 24-hour
/// sweep find abandoned ones without ever considering a committed recording (§6.3).
const RECORDING_TEMP_SUFFIX = '.rec.tmp';

/// The longest capture accepted as a plausible finalized duration: 24 h, far beyond any real capture
/// and far below the 82-day value the rejected Safari run reported.
const MAX_PLAUSIBLE_DURATION_SECONDS = 24 * 60 * 60;

/// Open sinks, keyed by temp path. Each entry holds a handle, counters and the running digest — never
/// chunk data. This map is also the "active session" register the cleanup sweep consults: §6.3 removes
/// an abandoned temp only "after confirming no active session owns them", and a 701-second capture's
/// temp legitimately looks old the whole time it is being written.
const sinks = new Map();

async function recordBegin(tempPath, mimeType) {
    if (sinks.has(tempPath)) {
        throw new Error(
            `A recording sink is already open at '${tempPath}'. Two recorders writing one temp entry ` +
            'would interleave their chunks into an unplayable container.');
    }

    // Truncate on open: a leftover temp from an earlier crashed capture must not have its tail survive
    // under a shorter new recording.
    const { dir, name } = await parentDir(tempPath, true);
    const handle = await dir.getFileHandle(name, { create: true });
    // Awaited for the same Safari 15.2-16.3 reason importToTemp documents.
    const access = await handle.createSyncAccessHandle();
    await access.truncate(0);

    sinks.set(tempPath, {
        access,
        sha: new Sha256(),
        bytesWritten: 0,
        chunksWritten: 0,
        nextSequence: 0,
        mimeType: mimeType || null,
        failure: null,
        probePrepared: false,
    });

    return { tempPath, bytesWritten: 0, chunksWritten: 0 };
}

/// The sink for `tempPath`, or a refusal naming why there isn't one. A sink resolves EXACTLY ONCE
/// (§6.3), so a late `dataavailable` — which Safari really does deliver — can never reopen, extend, or
/// resurrect an already-committed recording.
function requireSink(tempPath, operation) {
    const sink = sinks.get(tempPath);
    if (!sink) {
        throw new Error(
            `${operation}: no open recording sink for '${tempPath}'. It was already finalized or ` +
            'cancelled, and a sink is resolved exactly once (plan §6.3), so nothing was written.');
    }
    return sink;
}

async function recordAppend(tempPath, sequence, buffer) {
    const sink = requireSink(tempPath, 'recordAppend');

    if (sink.probePrepared) {
        throw new Error(
            `recordAppend refused chunk ${sequence}: the final flush already closed this sink for ` +
            'its pre-commit probe, so a late chunk cannot modify the bytes that were probed.');
    }

    if (sink.failure) {
        throw new Error(
            `recordAppend refused chunk ${sequence}: an earlier chunk failed to store, so this ` +
            `recording can no longer be completed. ${sink.failure}`);
    }

    // Ordering is pinned because a hole in a container plays back as corruption, not as an error, and
    // a REPLAYED sequence would double-count bytes and corrupt the hash while looking successful.
    const expected = sink.nextSequence;
    if (!(Number.isInteger(sequence) && sequence === expected)) {
        throw new Error(
            `recordAppend received chunk sequence ${sequence} but expected ${expected}. An ` +
            'out-of-order or replayed chunk is refused rather than written: appending it would leave ' +
            'a hole in the container, or double-count bytes and corrupt the hash.');
    }

    const bytes = new Uint8Array(buffer);
    try {
        sink.sha.update(bytes);
        await sink.access.write(bytes, { at: sink.bytesWritten });
    } catch (err) {
        // Poison the sink and REPORT. §6.3 forbids dropping a chunk and then presenting the result as
        // valid, so this is remembered and recordFinish refuses — a silently swallowed failure is how
        // a truncated recording reaches the user looking complete.
        sink.failure = `chunk ${sequence} failed to store: ${(err && err.message) || 'write failed'}`;
        throw new Error(`recordAppend: ${sink.failure}`);
    }

    sink.bytesWritten += bytes.length;
    sink.chunksWritten += 1;
    sink.nextSequence = sequence + 1;

    // The RUNNING total, not this chunk's size: an append that echoed only its own length would let a
    // lost chunk go unnoticed by every caller.
    return { bytesWritten: sink.bytesWritten, chunksWritten: sink.chunksWritten };
}

/// Why this recording must NOT become a record, or null when it may (§6.3's completion gate).
/// Final flush before the browser opens the still-temporary entry through a local video element.
/// The OPFS sync handle is exclusive, so it must be closed before getFile()/createObjectURL can read
/// the entry. The sink stays registered for finish/cancel but rejects every late append.
async function recordPrepareProbe(tempPath) {
    const sink = requireSink(tempPath, 'recordPrepareProbe');
    if (sink.probePrepared) {
        return { bytesWritten: sink.bytesWritten, chunksWritten: sink.chunksWritten };
    }

    if (sink.failure || sink.bytesWritten <= 0) {
        const failure = sink.failure ||
            'the recording produced no bytes, so there is nothing to probe';
        await discardSink(tempPath, sink);
        throw new Error(
            `recordPrepareProbe refused the recording: ${failure}. The temporary entry was deleted.`);
    }

    try {
        await sink.access.flush();
        await sink.access.close();
        sink.access = null;
        sink.probePrepared = true;
    } catch (err) {
        sink.failure =
            `the final recording flush failed before the playback probe: ` +
            `${(err && err.message) || 'flush failed'}`;
        await discardSink(tempPath, sink);
        throw new Error(`recordPrepareProbe: ${sink.failure}. The temporary entry was deleted.`);
    }

    return { bytesWritten: sink.bytesWritten, chunksWritten: sink.chunksWritten };
}

function finalizationFailure(sink, durationSeconds, captureSeconds) {
    if (sink.failure) return sink.failure;
    if (sink.bytesWritten <= 0) return 'the recording produced no bytes, so there is nothing to play';

    const duration = typeof durationSeconds === 'number' ? durationSeconds : NaN;
    if (!Number.isFinite(duration)) {
        return 'the finalized recording reported an unreadable duration ' +
            `(${String(durationSeconds)}), which is malformed container metadata — the same result ` +
            'two rejected iPhone Safari captures produced while reporting correct byte counts';
    }
    if (duration <= 0) {
        return `the finalized recording reported a duration of ${duration} seconds, so it contains ` +
            'no playable media';
    }
    if (duration > MAX_PLAUSIBLE_DURATION_SECONDS) {
        return `the finalized recording reported an implausible duration of ${duration} seconds, ` +
            'which is malformed container metadata — a 641.55-second iPhone capture reported ' +
            '7,158,897.04 seconds this way';
    }
    // When the caller knows how long it actually captured, the finalized value must agree with it.
    // Without something to compare against, "implausible" has no meaning below the absolute cap.
    if (Number.isFinite(captureSeconds) && captureSeconds > 0) {
        const tolerance = Math.max(10, captureSeconds * 0.05);
        if (Math.abs(duration - captureSeconds) > tolerance) {
            return `the finalized recording reported ${duration} seconds for a ${captureSeconds}-second ` +
                'capture, so its container metadata does not describe what was recorded';
        }
    }
    return null;
}

/// Close the sink's handle and drop it from the register, then remove its temp entry. Scoped to THIS
/// recording's OWN temp path — never a directory or prefix, which is how a later recording's failure
/// path deletes an earlier completed one.
async function discardSink(tempPath, sink) {
    sinks.delete(tempPath);
    // Close BEFORE removing: an open sync access handle is exclusive, so removeEntry on the same path
    // would fail with NoModificationAllowedError while it is held.
    if (sink.access) {
        try { await sink.access.close(); } catch { }
    }
    try {
        await removeEntry(tempPath);
    } catch (err) {
        // NOT rethrown: this runs on a path that is ALREADY failing, and the caller's own reason is
        // the one worth reporting. But it is not silent either — on a phone this entry is the whole
        // recording, so a leak the user cannot see or reclaim has to be diagnosable. The 24-hour
        // sweep is the backstop; it recognizes the entry by its .rec.tmp suffix.
        try {
            console.warn(`[video] could not remove the abandoned recording temp '${tempPath}': ` +
                `${(err && err.message) || 'delete failed'}`);
        } catch { }
    }
}

async function recordFinish(tempPath, finalPath, durationSeconds, captureSeconds) {
    const sink = requireSink(tempPath, 'recordFinish');

    let failure = null;
    if (sink.access) {
        try {
            await sink.access.flush();
        } catch (err) {
            failure = `the recording could not be flushed to storage: ${(err && err.message) || 'flush failed'}`;
        }
    }

    failure = failure || finalizationFailure(sink, durationSeconds, captureSeconds);

    if (failure) {
        // §6.3: "cancel the sink and do not create a record". Nothing has reached finalPath yet, so a
        // previously completed recording is untouched by construction.
        await discardSink(tempPath, sink);
        throw new Error(
            `recordFinish refused to publish the recording: ${failure}. The temporary entry was ` +
            'deleted and no record was created (plan §6.3).');
    }

    const bytesWritten = sink.bytesWritten;
    const chunksWritten = sink.chunksWritten;
    const hash = sink.sha.hex();

    // Close before the commit reads the temp back: `commit` opens its own handles, and an entry cannot
    // be read while this exclusive handle is held.
    sinks.delete(tempPath);
    if (sink.access) {
        try { await sink.access.close(); } catch { }
    }

    try {
        // Validated FIRST, published second — §6.3's atomic completion ordering. commit() removes the
        // temp itself once the final entry is whole, and removes a half-written final entry on failure.
        await commit(tempPath, finalPath);
    } catch (err) {
        // commit() already removed any half-written FINAL entry; this removes the temp so a failed
        // publish does not leave both. Warned rather than rethrown for the reason discardSink
        // documents — the commit failure is the error worth reporting.
        try {
            await removeEntry(tempPath);
        } catch (cleanupErr) {
            try {
                console.warn(`[video] could not remove the recording temp '${tempPath}' after a ` +
                    `failed publish: ${(cleanupErr && cleanupErr.message) || 'delete failed'}`);
            } catch { }
        }
        throw new Error(
            `recordFinish could not publish the validated recording to its final entry, so no record ` +
            `was created: ${(err && err.message) || 'commit failed'}`);
    }

    return { bytesWritten, chunksWritten, hash };
}

/// Abandon a recording: close the handle, delete the temp, create no record. Idempotent, because
/// cancel, permission denial, track loss, storage failure and page hide all reach it and overlap.
async function recordCancel(tempPath) {
    const sink = sinks.get(tempPath);
    if (!sink) {
        // Already resolved. An orphaned entry is still removed, so a cancel racing a crash cleans up —
        // and unlike discardSink's cleanup this one is REPORTED, because here deleting the entry IS
        // what the caller asked for. removeEntry treats an absent entry as success, so the idempotent
        // second cancel still answers cleanly.
        await removeEntry(tempPath);
        return { cancelled: false };
    }

    await discardSink(tempPath, sink);
    return { cancelled: true };
}

/// Walk every entry under `root`, depth-first, yielding "<path>" for files only.
async function* walkFiles(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
        const path = `${prefix}/${name}`;
        if (handle.kind === 'directory') {
            yield* walkFiles(handle, path);
        } else {
            yield { path, handle };
        }
    }
}

// Lists durable per-video folders without hydrating OPFS into MEMFS or reading file contents.
async function listVideoFolders(root) {
    const segments = String(root || '').split('/').filter(s => s.length > 0);
    if (segments.length === 0) throw new Error('listVideoFolders was given an empty root.');
    let dir;
    try {
        dir = await navigator.storage.getDirectory();
        for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: false });
    } catch (err) {
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return [];
        throw err;
    }
    const result = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind !== 'directory' || !/^[0-9a-f]{32}$/i.test(name)) continue;
        const prefix = `${segments.join('/')}/${name}`;
        if ([...sinks.keys()].some(path => path.startsWith(`${prefix}/`))
            || [...inFlight.values()].some(state => state.tempPath?.startsWith(`${prefix}/`))) continue;
        let byteCount = 0;
        for await (const entry of walkFiles(handle, prefix)) byteCount += (await entry.handle.getFile()).size;
        result.push({ folderId: name, byteCount });
    }
    return result;
}

/// §6.3's startup/next-open sweep: remove abandoned recording temps older than `olderThanMs` "after
/// confirming no active session owns them".
///
/// OWNERSHIP, NOT AGE, IS THE GUARD. The accepted P0 captures ran 665 s and 701 s, and nothing
/// rewrites a temp's timestamp while it is being written — so a live recording's entry can look
/// arbitrarily old. Condemning by pattern and age alone destroys a capture in progress.
///
/// The sweep matches only the RECORDING_TEMP_SUFFIX pattern, so a COMMITTED recording is never a
/// candidate however old it is.
async function recordCleanup(root, olderThanMs) {
    const segments = String(root || '').split('/').filter(s => s.length > 0);
    if (segments.length === 0) {
        throw new Error('recordCleanup was given an empty root; refusing to sweep the OPFS root.');
    }

    let dir;
    try {
        dir = await navigator.storage.getDirectory();
        for (const segment of segments) {
            dir = await dir.getDirectoryHandle(segment, { create: false });
        }
    } catch (err) {
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) {
            return { removed: 0, scanned: 0 };
        }
        throw err;
    }

    const threshold = olderThanMs > 0 ? olderThanMs : 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - threshold;

    let removed = 0;
    let scanned = 0;
    const doomed = [];

    for await (const entry of walkFiles(dir, segments.join('/'))) {
        if (!entry.path.endsWith(RECORDING_TEMP_SUFFIX)) continue;
        scanned++;
        if (sinks.has(entry.path)) continue;   // an ACTIVE session owns it; age is irrelevant

        let lastModified;
        try {
            lastModified = (await entry.handle.getFile()).lastModified;
        } catch {
            // Unreadable timestamp: leave it. Deleting on "we could not tell how old it is" is the
            // direction that loses data.
            continue;
        }
        if (lastModified > cutoff) continue;
        doomed.push(entry.path);
    }

    // Collected first, deleted second: removing entries while iterating a directory handle is what
    // makes an OPFS sweep skip siblings.
    for (const path of doomed) {
        try {
            await removeEntry(path);
            removed++;
        } catch {
            // One stubborn orphan must not abort the sweep; it stays a recognizable *.rec.tmp entry.
        }
    }

    return { removed, scanned };
}

async function handle(data) {
    const { id, op } = data;
    try {
        let result;
        if (op === 'import') {
            result = await importToTemp(id, data.tempPath, data.file, data.chunkBytes);
        } else if (op === 'commit') {
            self.postMessage({ id, stage: 'copying the verified temp entry into the library' });
            result = await commit(data.tempPath, data.finalPath, id);
        } else if (op === 'delete') {
            await removeEntry(data.path);
            result = null;
        } else if (op === 'hash') {
            result = await hashFile(data.file, data.chunkBytes);
        } else if (op === 'recordBegin') {
            result = await recordBegin(data.tempPath, data.mimeType);
        } else if (op === 'recordAppend') {
            result = await recordAppend(data.tempPath, data.sequence, data.buffer);
        } else if (op === 'recordPrepareProbe') {
            result = await recordPrepareProbe(data.tempPath);
        } else if (op === 'recordFinish') {
            result = await recordFinish(
                data.tempPath, data.finalPath, data.durationSeconds, data.captureSeconds);
        } else if (op === 'recordCancel') {
            result = await recordCancel(data.tempPath);
        } else if (op === 'recordCleanup') {
            result = await recordCleanup(data.root, data.olderThanMs);
        } else if (op === 'listVideoFolders') {
            result = await listVideoFolders(data.root);
        } else {
            throw new Error(`unknown op: ${op}`);
        }
        self.postMessage({ id, ok: true, result });
    } catch (err) {
        self.postMessage({ id, ok: false, error: `${err && err.name}: ${err && err.message}` });
    }
}

self.onmessage = (e) => {
    const data = e.data;

    if (data.op === 'cancel') {
        // Answered immediately and OUT of the queue — an import holding the chain is precisely what
        // this needs to reach. Flagging an id that already finished is a no-op, which is correct:
        // cancel races completion and neither outcome is an error.
        const state = inFlight.get(data.importId);
        if (state) state.cancelled = true;
        self.postMessage({ id: data.id, ok: true, result: { cancelled: !!state } });
        return;
    }

    queue = queue.then(() => handle(data));
};
