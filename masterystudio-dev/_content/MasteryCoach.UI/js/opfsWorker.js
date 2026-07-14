// OPFS write worker (WebOpfsStoragePlan.md P1). All MUTATIONS of the Origin Private File System go
// through this dedicated worker because Safari only allows OPFS writes via createSyncAccessHandle,
// which exists ONLY in workers (Chrome/Edge also support main-thread createWritable, but one code
// path that works everywhere beats two). Reads stay on the main thread (async getFile works there).
//
// Classic worker (not a module): loaded with new Worker(url) from opfsStore.js. Protocol: one
// message per op — { id, op, path, buffer?, recursive? } — answered with { id, ok, error? }.
//
// SERIALIZATION (review finding): async onmessage handlers INTERLEAVE at their awaits — postMessage
// only guarantees delivery order, not completion order — so two writes to one file could collide on
// createSyncAccessHandle (one open handle per file) or land out of order. Every op is therefore
// chained onto one queue: strictly one op runs at a time, in arrival order. Throughput is fine —
// ops are per-file and the caller awaits each anyway.

let queue = Promise.resolve();

// Walk "a/b/c.txt" to its parent directory handle, optionally creating directories on the way.
async function parentDir(path, create) {
    const segments = path.split('/').filter(s => s.length > 0);
    let dir = await navigator.storage.getDirectory();
    for (let i = 0; i < segments.length - 1; i++) {
        dir = await dir.getDirectoryHandle(segments[i], { create });
    }
    return { dir, name: segments[segments.length - 1] };
}

async function writeFile(path, buffer) {
    const { dir, name } = await parentDir(path, true);
    const file = await dir.getFileHandle(name, { create: true });
    // Sync access handle: the only write API Safari offers (worker-only). Truncate-then-write so a
    // shorter rewrite can't leave stale bytes from a longer previous version. Each call is awaited:
    // on modern engines these return undefined (awaiting a non-promise is a no-op), but on
    // Safari 15.2–16.3 they returned Promises — NOT awaiting them there let close() race the write
    // and land a truncated file with no error (review finding).
    const handle = await file.createSyncAccessHandle();
    try {
        await handle.truncate(0);
        await handle.write(new Uint8Array(buffer), { at: 0 });
        await handle.flush();
    } finally {
        await handle.close();
    }
}

async function deleteEntry(path, recursive) {
    try {
        const { dir, name } = await parentDir(path, false);
        await dir.removeEntry(name, { recursive: !!recursive });
    } catch (err) {
        if (err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError')) return; // absent = done
        throw err;
    }
}

async function handle(data) {
    const { id, op, path, buffer, recursive } = data;
    try {
        if (op === 'write') await writeFile(path, buffer);
        else if (op === 'delete') await deleteEntry(path, recursive);
        else throw new Error(`unknown op: ${op}`);
        self.postMessage({ id, ok: true });
    } catch (err) {
        self.postMessage({ id, ok: false, error: `${err && err.name}: ${err && err.message}` });
    }
}

self.onmessage = (e) => {
    const data = e.data;
    // Chain, never parallelize (see the serialization note above). handle() never rejects — every
    // outcome posts a reply — so the chain can't wedge on a failed op.
    queue = queue.then(() => handle(data));
};
