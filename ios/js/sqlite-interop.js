/**
 * sqlite-interop.js — SQLite WASM interop proxy for SuccessRate browser storage.
 *
 * This module spawns a dedicated Web Worker (sqlite-worker.js) that runs the
 * actual sqlite-wasm engine with opfs-sahpool VFS.  All database operations are
 * forwarded to the worker via postMessage and resolved via a promise-based RPC
 * mechanism.
 *
 * Why a worker?  The opfs-sahpool VFS uses FileSystemSyncAccessHandle, which is
 * only available in Web Worker threads — not the main thread.  Moving sqlite-wasm
 * into a worker enables true OPFS persistence.
 *
 * The public API on window.srSqlite is identical to the previous main-thread
 * implementation.  No C# / IJSRuntime changes required.
 *
 * Lifecycle:
 *   srSqlite.open(dbName)          — open/create database (OPFS or in-memory)
 *   srSqlite.exec(sql, params)     — execute DDL or DML (no return value)
 *   srSqlite.query(sql, params)    — returns rows as JSON string (array of objects)
 *   srSqlite.scalar(sql, params)   — returns a single scalar value
 *   srSqlite.close()               — close the database
 *   srSqlite.exportDb()            — export as Uint8Array
 *   srSqlite.importDb(name, bytes) — import from Uint8Array
 *   srSqlite.isOpfsActive()        — synchronous boolean check
 *   srSqlite.ping()                — health-check: returns timestamp if worker alive
 *   srSqlite.insertAndGetId(sql, params) — atomic INSERT + last_insert_rowid()
 */

(function () {
    'use strict';

    // ── Timeouts ──────────────────────────────────────────────────────────────

    /** RPC timeout for normal operations (exec, query, open, etc.) */
    const RPC_TIMEOUT_MS = 30000;   // 30 seconds

    /** RPC timeout for init (loads WASM binary + OPFS retries can take a while) */
    const INIT_TIMEOUT_MS = 60000;  // 60 seconds

    // ── State ─────────────────────────────────────────────────────────────────

    /** @type {Worker|null} */
    let _worker = null;

    /** Monotonically increasing RPC request ID */
    let _nextId = 1;

    /** Pending RPC calls: id → { resolve, reject } */
    const _pending = new Map();

    /** Cached init promise (idempotent) */
    let _initPromise = null;

    /** Mirrored from worker — true when opfs-sahpool VFS is active */
    let _opfsAvailable = false;

    /** True when OPFS was unavailable because another tab holds the Web Lock */
    let _lockedByAnotherTab = false;

    /** Tracks whether a database is currently open (for sync isOpfsActive) */
    let _dbOpen = false;

    /**
     * Generation counter — incremented each time the worker dies and is
     * nulled out.  Prevents stale onmessage responses from a previous
     * worker instance from resolving promises belonging to a new worker.
     */
    let _workerGeneration = 0;

    // ── Asset paths ──────────────────────────────────────────────────────────

    const LOCAL_BASE = 'js/sqlite-wasm/';
    const CDN_BASE   = 'https://cdn.jsdelivr.net/npm/@sqlite.org/sqlite-wasm@3.49.1-build1/sqlite-wasm/jswasm/';

    // ── Helpers ───────────────────────────────────────────────────────────────

    function log(...args) { console.log('[sr-sqlite]', ...args); }
    function warn(...args) { console.warn('[sr-sqlite]', ...args); }

    /**
     * Send a method call to the worker and return a promise for its result.
     * Includes a timeout to prevent promises from hanging forever if the
     * worker becomes unresponsive.
     */
    function rpc(method, ...args) {
        const timeout = method === 'init' ? INIT_TIMEOUT_MS : RPC_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const id = _nextId++;
            const timer = setTimeout(() => {
                _pending.delete(id);
                reject(new Error(`[sr-sqlite] RPC '${method}' timed out after ${timeout}ms`));
            }, timeout);
            _pending.set(id, {
                resolve: (v) => { clearTimeout(timer); resolve(v); },
                reject:  (e) => { clearTimeout(timer); reject(e); },
            });
            _worker.postMessage({ id, method, args });
        });
    }

    /**
     * Probe whether bundled sqlite-wasm assets are available locally.
     * Returns an absolute URL base suitable for the worker's importScripts().
     */
    async function resolveAssetBase() {
        let relBase = CDN_BASE;
        try {
            const probe = await fetch(LOCAL_BASE + 'sqlite3.js', { method: 'HEAD' });
            if (probe.ok) {
                log('Using bundled sqlite-wasm assets');
                relBase = LOCAL_BASE;
            } else {
                warn('Bundled sqlite-wasm not found — falling back to CDN');
            }
        } catch {
            warn('Bundled sqlite-wasm not found — falling back to CDN');
        }
        // Resolve to absolute URL so the worker's importScripts works correctly
        // regardless of worker script location or <base href> value.
        return new URL(relBase, document.baseURI).href;
    }

    /**
     * Ensure the worker is spawned and sqlite-wasm is initialized inside it.
     * Idempotent — subsequent calls return the cached promise.
     *
     * If initialization fails the cached promise is discarded so the next
     * call will retry (worker respawn after crash, CDN retry after timeout).
     */
    function ensureInit() {
        if (!_initPromise) {
            _initPromise = (async () => {
                try {
                    const assetBase = await resolveAssetBase();

                    // Pre-acquire OPFS root on main thread.  Some browsers
                    // (notably Chrome) may not expose navigator.storage inside
                    // dedicated workers even when the main thread has it.
                    // Passing the directory handle lets the worker polyfill
                    // the missing API so sqlite-wasm's VFS init succeeds.
                    let opfsRoot = null;
                    try {
                        if (navigator?.storage?.getDirectory) {
                            opfsRoot = await navigator.storage.getDirectory();
                            log('OPFS root acquired on main thread');
                        }
                    } catch (e) {
                        warn('Main-thread OPFS not available:', e.message);
                    }

                    // Spawn the sqlite worker.
                    _worker = new Worker(new URL('js/sqlite-worker.js', document.baseURI).href);

                    // Capture the current generation so that if the worker dies
                    // and a new one is spawned, stale responses are discarded.
                    const gen = _workerGeneration;

                    // Route responses to pending promises.
                    _worker.onmessage = (e) => {
                        // Discard responses from a previous worker generation.
                        if (gen !== _workerGeneration) return;

                        const { id, result, error } = e.data;
                        const p = _pending.get(id);
                        if (p) {
                            _pending.delete(id);
                            if (error !== undefined) {
                                p.reject(new Error('[sr-sqlite] ' + error));
                            } else {
                                p.resolve(result);
                            }
                        }
                    };

                    // If the worker itself fails to load, reject all pending
                    // calls and allow the next ensureInit() to respawn.
                    _worker.onerror = (e) => {
                        warn('Worker error:', e.message);
                        for (const [, p] of _pending) {
                            p.reject(new Error('[sr-sqlite] Worker error: ' + (e.message || 'unknown')));
                        }
                        _pending.clear();
                        // Tear down so next ensureInit() respawns.
                        _worker = null;
                        _initPromise = null;
                        _dbOpen = false;
                        _opfsAvailable = false;
                        _workerGeneration++;
                    };

                    // Initialize sqlite-wasm inside the worker, passing the
                    // OPFS root handle (may be null if main thread lacks OPFS).
                    const info = await rpc('init', assetBase, opfsRoot);
                    _opfsAvailable = info.opfsAvailable;
                    _lockedByAnotherTab = info.lockedByAnotherTab === true;
                    log('Worker initialized. OPFS available:', _opfsAvailable,
                        '| locked by another tab:', _lockedByAnotherTab,
                        '| version:', info.version);
                } catch (e) {
                    // Allow retry on next call instead of caching the failure forever.
                    _initPromise = null;
                    throw e;
                }
            })();
        }
        return _initPromise;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Open (or create) a SQLite database.
     * @param {string} dbName  Logical database name, e.g. "sr_plans_1".
     */
    async function open(dbName) {
        await ensureInit();
        const result = await rpc('open', dbName);
        _dbOpen = true;
        if (result.persisted) {
            log('Opened OPFS database:', dbName);
        } else {
            warn('OPFS unavailable — using in-memory database (data will not persist across reloads)');
        }
    }

    /**
     * Execute a SQL statement with no result (DDL, INSERT, UPDATE, DELETE).
     * @param {string} sql     SQL with optional ? placeholders.
     * @param {any[]}  params  Bind values for placeholders (can be null/undefined).
     */
    async function exec(sql, params) {
        await ensureInit();
        await rpc('exec', sql, params);
    }

    /**
     * Execute a SELECT statement and return rows as a JSON string.
     * @param {string} sql     SQL with optional ? placeholders.
     * @param {any[]}  params  Bind values for placeholders (can be null/undefined).
     * @returns {string}  JSON array of row objects, e.g. '[{"id":1,"blob":"..."}]'
     */
    async function query(sql, params) {
        await ensureInit();
        return await rpc('query', sql, params);
    }

    /**
     * Execute a SQL statement that returns a single scalar value.
     * @param {string} sql
     * @param {any[]}  params
     * @returns {any}
     */
    async function scalar(sql, params) {
        await ensureInit();
        return await rpc('scalar', sql, params);
    }

    /**
     * Close the open database. Safe to call when no DB is open.
     */
    async function close() {
        if (_worker) {
            await rpc('close');
            _dbOpen = false;
            log('Database closed');
        }
    }

    /**
     * Export the current database as a Uint8Array (raw .db bytes).
     */
    async function exportDb() {
        await ensureInit();
        return await rpc('exportDb');
    }

    /**
     * Import a database from raw .db bytes, replacing the current database.
     * @param {string}            dbName  Logical database name (same as open()).
     * @param {Uint8Array|string} bytes   Raw SQLite database bytes, or a base64
     *   string (Blazor WASM marshals byte[] as base64 when passed via IJSRuntime).
     */
    async function importDb(dbName, bytes) {
        await ensureInit();
        // Blazor WASM marshals byte[] to JS as a base64-encoded string, not a
        // Uint8Array.  Decode it here so the worker always receives typed bytes.
        var data = typeof bytes === 'string'
            ? Uint8Array.from(atob(bytes), function(c) { return c.charCodeAt(0); })
            : bytes;
        await rpc('importDb', dbName, data);
        _dbOpen = true;
    }

    /**
     * Health-check ping. Returns a timestamp from the worker if alive.
     * Useful for verifying the worker is responsive before a critical operation.
     */
    async function ping() {
        await ensureInit();
        return await rpc('ping');
    }

    /**
     * Atomic INSERT + last_insert_rowid() in a single worker call.
     * Prevents interleaving between the INSERT and the rowid lookup.
     * @param {string} sql     INSERT statement with optional ? placeholders.
     * @param {any[]}  params  Bind values for placeholders (can be null/undefined).
     * @returns {number}  The rowid of the newly inserted row.
     */
    async function insertAndGetId(sql, params) {
        await ensureInit();
        return await rpc('insertAndGetId', sql, params);
    }

    // ── Attach to window ──────────────────────────────────────────────────────

    globalThis.srSqlite = {
        open,
        exec,
        query,
        scalar,
        close,
        exportDb,
        importDb,
        ping,
        insertAndGetId,
        /** Returns true if OPFS persistence is active (false = in-memory fallback). */
        isOpfsActive: () => _opfsAvailable && _dbOpen,
        /** Returns true when OPFS is unavailable because another tab owns the Web Lock. */
        isLockedByAnotherTab: () => _lockedByAnotherTab,
    };

    log('Module registered on window.srSqlite (worker proxy)');
})();
