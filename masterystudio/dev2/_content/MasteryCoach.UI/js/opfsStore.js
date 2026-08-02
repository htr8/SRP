// OPFS storage interop for the WEB build (WebOpfsStoragePlan.md P1/P2). The Origin Private File
// System is the browser's persistent, per-origin store — the web twin of the native app-data folder.
// .NET's System.IO cannot see it (WASM's Emscripten FS is in-memory), so the C# side
// (WebMediaStore / OpfsPracticeDataStorage / WebFileTransfer) calls through this module:
//
//  - READS run on the main thread (async getFile() works everywhere) and return Blobs/bytes that
//    .NET consumes via IJSStreamReference.
//  - WRITES/DELETES go through opfsWorker.js, because Safari only permits OPFS mutation via
//    createSyncAccessHandle — a worker-only API (one path that works on Chrome AND Safari).
//  - pickFile/downloadFile are the web stand-ins for the native share sheet / file picker
//    (WebFileTransfer): a browser upload in, a blob download out.
//
// Paths are POSIX-style relative to the OPFS root, e.g. "data/library/songs/<id>/song.m4a" —
// the C# side maps its MEMFS "/data/..." working paths to these by trimming the leading slash.
//
// Node-import safe (module-imports smoke test): no browser globals touched at module scope.

import { readStreamRefBytes } from './engineCommon.js';
import { getSharedContext } from './audioContext.js';
import { encodeWavMono } from './recorder.js';

let worker = null;
let nextMsgId = 1;
const pending = new Map();

function failAllPending(reason) {
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
}

function ensureWorker() {
    if (!worker) {
        // Document-base-relative, same convention as every other asset (resolves on native AND the
        // web-preview subpath — see the b56f8e8 path fix).
        worker = new Worker('./_content/MasteryCoach.UI/js/opfsWorker.js');
        worker.onmessage = (e) => {
            const { id, ok, error } = e.data;
            const p = pending.get(id);
            if (!p) return;
            pending.delete(id);
            if (ok) p.resolve();
            else p.reject(new Error(error || 'OPFS worker failed'));
        };
        // A worker that fails to LOAD (404 on a mis-based deploy, CSP, parse error) fires 'error'
        // asynchronously and never answers anything — without this handler every write would await
        // forever with zero diagnostics (review finding). Fail everything loudly and let the next op
        // retry with a fresh worker.
        worker.onerror = (e) => {
            const reason = `OPFS worker error: ${(e && e.message) || 'failed to load'}`;
            try { console.warn('[opfs] ' + reason); } catch { }
            failAllPending(reason);
            try { worker.terminate(); } catch { }
            worker = null;
        };
        worker.onmessageerror = () => failAllPending('OPFS worker message deserialization failed');
    }
    return worker;
}

function workerOp(message, transfer) {
    const id = nextMsgId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
            ensureWorker().postMessage({ id, ...message }, transfer || []);
        } catch (err) {
            pending.delete(id); // don't strand the entry when postMessage itself throws (review finding)
            reject(err);
        }
    });
}

// Walk a path to its handle. Returns null when any segment is missing (create=false).
async function getHandle(path, kind, create) {
    const segments = path.split('/').filter(s => s.length > 0);
    let dir = await navigator.storage.getDirectory();
    for (let i = 0; i < segments.length - 1; i++) {
        try {
            dir = await dir.getDirectoryHandle(segments[i], { create: !!create });
        } catch {
            return null;
        }
    }
    const name = segments[segments.length - 1];
    if (!name) return dir; // "" or "/" → the root itself
    try {
        return kind === 'dir'
            ? await dir.getDirectoryHandle(name, { create: !!create })
            : await dir.getFileHandle(name, { create: !!create });
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------------------
// Reads (main thread)
// ---------------------------------------------------------------------------------------------

// The file's bytes as a Blob — .NET reads it as an IJSStreamReference (Blobs stream; no JS-side copy).
export async function readFile(path) {
    const handle = await getHandle(path, 'file', false);
    if (!handle) return null;
    return await handle.getFile();
}

export async function exists(path) {
    return (await getHandle(path, 'file', false)) != null
        || (await getHandle(path, 'dir', false)) != null;
}

// Directory listing: [{ name, isDir, size, lastModified }] — size/mtime only for files. Null when
// the directory doesn't exist (distinct from empty).
export async function listDir(path) {
    const dir = await getHandle(path, 'dir', false);
    if (!dir) return null;
    const entries = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
            const f = await handle.getFile();
            entries.push({ name, isDir: false, size: f.size, lastModified: f.lastModified });
        } else {
            entries.push({ name, isDir: true, size: 0, lastModified: 0 });
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------------------------
// Writes / deletes (via the worker — Safari-compatible)
// ---------------------------------------------------------------------------------------------

// streamRef is a DotNetStreamReference: pull its bytes (WASM-safe read — the write-through path
// MUST work on the web build, which is the only place this module runs) then hand the buffer to the
// worker (transferred, not copied).
export async function writeFile(path, streamRef) {
    const buffer = await readStreamRefBytes(streamRef);
    await workerOp({ op: 'write', path, buffer }, [buffer]);
    return true;
}

// Stream a DotNetStreamReference into OPFS in chunks. This avoids the export/download path's old
// whole-zip ArrayBuffer copy, which can get iOS to terminate the page before .NET can log anything.
export async function writeFileStream(path, streamRef) {
    if (typeof streamRef.stream !== 'function') {
        return await writeFile(path, streamRef);
    }

    let stream;
    try {
        stream = await streamRef.stream(); // Promise on native, plain stream on WASM.
    } catch {
        return await writeFile(path, streamRef);
    }

    const reader = stream.getReader();
    let offset = 0;
    let wroteAny = false;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        const chunkLength = bytes.byteLength;
        const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.slice().buffer;
        await workerOp({ op: 'writeChunk', path, offset, truncate: !wroteAny, buffer }, [buffer]);
        // Transferring buffer detaches it, which can make bytes.byteLength read back as 0.
        // Capture the length first so later chunks append instead of overwriting byte 0.
        offset += chunkLength;
        wroteAny = true;
    }

    if (!wroteAny) {
        const empty = new ArrayBuffer(0);
        await workerOp({ op: 'writeChunk', path, offset: 0, truncate: true, buffer: empty }, [empty]);
    }

    return true;
}

export async function deleteEntry(path, recursive) {
    await workerOp({ op: 'delete', path, recursive: !!recursive });
    return true;
}

// ---------------------------------------------------------------------------------------------
// Quota / persistence
// ---------------------------------------------------------------------------------------------

export async function estimate() {
    if (!navigator.storage || !navigator.storage.estimate) return { usage: 0, quota: 0 };
    const e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
}

// Ask the browser to protect this origin's storage from eviction. Chrome decides silently from
// engagement; Safari may prompt. Returns whether storage is now persistent.
export async function persist() {
    if (!navigator.storage || !navigator.storage.persist) return false;
    return await navigator.storage.persist();
}

// ---------------------------------------------------------------------------------------------
// Web file transfer (the browser stand-ins for the native share sheet / file picker)
// ---------------------------------------------------------------------------------------------

// The picked File is held here between pickFile() (which returns its metadata) and pickedFile()
// (which hands the Blob to .NET as a stream) — two hops so the metadata trip stays tiny.
let lastPicked = null;

// Chrome only opens a file chooser inside a transient user activation (~a few seconds after the
// click/change that got us here). If it expired — a slow module load, a long await chain — click()
// is silently ignored and the pick promise would hang with zero diagnostics. Can't recover, but CAN
// say so (navigator.userActivation is Chrome 72+/Safari 16.4+; absent → stay quiet).
function warnIfNoActivation(what) {
    try {
        if (navigator.userActivation && !navigator.userActivation.isActive) {
            console.warn(`[opfs] ${what}: no transient user activation — the browser will likely refuse to open the file dialog`);
        }
    } catch { }
}

// One-shot <input type=file> chooser shared by every pick entry point below. Resolves the picked
// File(s) as an array, or null on cancel/empty.
function openFilePicker(accept, multiple, what) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', onRefocus, true);
            resolve(value);
        };

        const input = document.createElement('input');
        input.type = 'file';
        if (accept) input.accept = accept;
        if (multiple) input.multiple = true;
        input.onchange = () => settle(input.files && input.files.length ? Array.from(input.files) : null);
        // Cancel detection, two layers (review finding: an unresolved promise here left the Settings
        // import spinner stuck forever — its busy state is set BEFORE the picker opens):
        //  1. The 'cancel' event — modern Chrome/Edge/Safari/Firefox.
        //  2. A focus fallback for engines without it: when the window regains focus (the dialog
        //     closed) and no change event follows shortly, treat it as a cancel. The grace period
        //     covers the change event legitimately trailing the refocus on a real pick.
        input.oncancel = () => settle(null);
        const onRefocus = () => setTimeout(() => settle(null), 1500);
        window.addEventListener('focus', onRefocus, true);

        warnIfNoActivation(what);
        input.click();
    });
}

export async function pickFile(accept) {
    const files = await openFilePicker(accept, false, 'pickFile');
    lastPicked = files ? files[0] : null;
    return lastPicked ? { name: lastPicked.name, size: lastPicked.size } : null;
}

export function hasPickedFile() {
    return lastPicked != null;
}

export function pickedFile() {
    const f = lastPicked;
    lastPicked = null; // release the reference on hand-off
    return f; // a File IS a Blob → .NET receives IJSStreamReference and streams it
}

// Multi-file variant backing the web IAudioFilePicker (song attach / batch add / stems). Unlike
// pickedFile above, the list is NOT cleared on hand-off: PickedAudioFile.OpenReadAsync may be called
// later and more than once per file (attach reads it for the store, the loader may read it again),
// so entries live until the next pickFiles call. File objects are cheap handles to on-disk files.
let lastPickedList = null;

export async function pickFiles(accept, multiple) {
    lastPickedList = await openFilePicker(accept, multiple, 'pickFiles');
    return lastPickedList ? lastPickedList.map(f => ({ name: f.name, size: f.size })) : null;
}

export function pickedFileCount() {
    return lastPickedList ? lastPickedList.length : 0;
}

export function pickedFileAt(index) {
    // Callers probe pickedFileCount first — returning JS null into InvokeAsync<IJSStreamReference>
    // throws in the framework marshaling (same finding as pickedFile/hasPickedFile).
    return lastPickedList[index];
}

// ---------------------------------------------------------------------------------------------
// Take decode for timing analysis (web IAudioTakePicker, Tier 2): the picked recording — m4a/
// mp3/wav, whatever THIS browser's decodeAudioData handles — is decoded, downmixed to mono, and
// re-encoded as 16-bit PCM WAV, the exact shape the pure-C# analyzers read (WaveFile.ReadMono).
// The web twin of WindowsAudioTakePicker's MediaFoundation decode. Two-hop hand-off like
// recorder.js takeWavBytes: decodePickedTake returns the tiny metadata; decodedTakeWavBytes
// streams the bytes to .NET and releases them (a 5-minute take is ~26 MB — don't pin it).
// The take pick keeps its OWN stash: sharing pickFiles' list would let a take pick invalidate —
// or worse, silently SUBSTITUTE — a PickedAudioFile the audio picker handed out earlier (those
// entries are index-addressed and deliberately live until the next pickFiles call).
// ---------------------------------------------------------------------------------------------

let lastTakeFile = null;
let decodedTakeWav = null;

export async function pickTakeFile(accept) {
    const files = await openFilePicker(accept, false, 'pickTakeFile');
    lastTakeFile = files ? files[0] : null;
    return lastTakeFile ? { name: lastTakeFile.name, size: lastTakeFile.size } : null;
}

export async function decodePickedTake() {
    decodedTakeWav = null; // a hand-off the .NET side never collected must not stay pinned
    if (!lastTakeFile) {
        return null; // nothing picked — caller re-prompts
    }

    // Decode at 44.1 kHz — the SAME normalization WindowsAudioTakePicker applies (MediaFoundation
    // → 44.1k mono). decodeAudioData resamples to its context's rate, and decoding on the shared
    // context (usually 48 kHz) measurably smears sharp click transients: the E2E parity probe lost
    // 9 of 15 metronome clicks to that resample and locked the grid onto a 60 BPM sub-harmonic —
    // native DSP on the same bytes agreed, so the fix is the input, not the math. A 44.1k
    // OfflineAudioContext decodes 44.1k sources bit-clean (the common case) and matches the
    // analyzer's most-tested rate otherwise. Fallback: old WebKit only exposes callback-form
    // decodeAudioData on offline contexts — the shared context still decodes there. decodeAudioData
    // detaches the buffer it's handed, so the fallback re-reads the File (a cheap on-disk handle)
    // rather than paying a whole-file defensive copy up front on every decode.
    let decoded;
    try {
        decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await lastTakeFile.arrayBuffer());
    } catch {
        decoded = await getSharedContext().decodeAudioData(await lastTakeFile.arrayBuffer());
    }

    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    decodedTakeWav = encodeWavMono(downmixToMono(channels), decoded.sampleRate);
    return { durationSeconds: decoded.duration };
}

// Equal-weight downmix of decoded channel data. Mono passes through UNCOPIED — the common
// phone-recording case, and the encoder only reads it. Exported for the Node test harness.
export function downmixToMono(channels) {
    if (channels.length === 1) {
        return channels[0];
    }
    const mono = new Float32Array(channels[0].length);
    for (const data of channels) {
        for (let i = 0; i < mono.length; i++) mono[i] += data[i];
    }
    for (let i = 0; i < mono.length; i++) mono[i] /= channels.length;
    return mono;
}

export function decodedTakeWavBytes() {
    const bytes = decodedTakeWav ?? new Uint8Array(0);
    decodedTakeWav = null; // hand-off releases the (large) buffer
    return bytes; // Uint8Array → IJSStreamReference on the .NET side
}

// Save bytes to the user's machine as a download — the web's "share/export".
export async function downloadFile(fileName, streamRef) {
    const buffer = await readStreamRefBytes(streamRef); // WASM-safe read
    const blob = new Blob([buffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // Delay the revoke: the click starts the download asynchronously and an immediate revoke
        // can abort it in some browsers.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    return true;
}

// Save an OPFS-backed file without first copying the entire file into JS memory.
export async function downloadStoredFile(path, fileName) {
    const handle = await getHandle(path, 'file', false);
    if (!handle) throw new Error(`Export file not found: ${path}`);
    const file = await handle.getFile();
    const url = URL.createObjectURL(file);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || file.name || 'download.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return true;
}

export function persistRecoveryLog(level, source, message) {
    try {
        const key = 'mc-crash-log';
        const line = `[${new Date().toISOString()}] [${level || 'info'}] [${source || 'web'}] ${String(message || '')}`;
        const raw = window.localStorage.getItem(key);
        const arr = raw ? JSON.parse(raw) : [];
        arr.push(line.slice(0, 8000));
        while (arr.length > 50) arr.shift();
        window.localStorage.setItem(key, JSON.stringify(arr));
    } catch { }
    return true;
}
