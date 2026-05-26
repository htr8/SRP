/**
 * sqlite-worker.js — Web Worker that runs sqlite-wasm with OPFS persistence.
 *
 * The opfs-sahpool VFS requires FileSystemSyncAccessHandle, which is only
 * available inside Web Worker threads. This worker hosts the entire sqlite-wasm
 * engine and communicates with the main thread (sqlite-interop.js proxy) via
 * a simple postMessage-based RPC protocol.
 *
 * Message protocol:
 *   Request:  { id: number, method: string, args: any[] }
 *   Response: { id: number, result?: any }  or  { id: number, error: string }
 */
'use strict';

// ── State ────────────────────────────────────────────────────────────────────

/** @type {any} sqlite3 API object after init */
let _sqlite3 = null;

/** @type {any} opfs-sahpool utility (cached after first install) */
let _poolUtil = null;

/** @type {any} open database handle */
let _db = null;

/** Whether OPFS persistence is active */
let _opfsAvailable = false;

/** Logical name of the currently-open database (empty string = none). */
let _currentDbName = '';

/**
 * Web Lock release function.  Set when we successfully acquire the 'sr-opfs-pool'
 * lock; called in handleClose() to release the lock so other tabs can take over.
 * @type {Function|null}
 */
let _releaseLock = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(...args) { console.log('[sr-sqlite-worker]', ...args); }
function warn(...args) { console.warn('[sr-sqlite-worker]', ...args); }

// ── Method handlers ──────────────────────────────────────────────────────────

/**
 * Initialize sqlite-wasm and attempt to install the opfs-sahpool VFS.
 * @param {string} assetBase  Absolute URL base for sqlite-wasm assets.
 * @param {FileSystemDirectoryHandle|null} opfsRoot  OPFS root handle pre-acquired
 *        on the main thread.  Used to polyfill navigator.storage.getDirectory()
 *        in worker contexts where Chrome doesn't expose the Storage API.
 */
async function handleInit(assetBase, opfsRoot) {
    // ── OPFS capability diagnostics ──────────────────────────────────
    log('OPFS diagnostics:',
        'crossOriginIsolated:', self.crossOriginIsolated,
        '| SharedArrayBuffer:', typeof SharedArrayBuffer !== 'undefined',
        '| FileSystemFileHandle:', typeof FileSystemFileHandle !== 'undefined',
        '| navigator.storage:', !!(self.navigator?.storage),
        '| getDirectory:', !!(self.navigator?.storage?.getDirectory),
        '| opfsRootFromMainThread:', !!opfsRoot);

    // ── Polyfill navigator.storage.getDirectory if needed ────────────
    // Chrome workers under service-worker-injected COEP may not expose
    // navigator.storage even when the main thread has full OPFS access.
    // The main thread pre-acquires the root handle and passes it here
    // so we can shim the API before sqlite-wasm's VFS init runs.
    if (opfsRoot) {
        let nativeWorks = false;
        try {
            if (self.navigator?.storage?.getDirectory) {
                await self.navigator.storage.getDirectory();
                nativeWorks = true;
            }
        } catch { /* native call failed */ }

        if (!nativeWorks) {
            log('Polyfilling navigator.storage.getDirectory from main-thread handle');
            try {
                Object.defineProperty(self.navigator, 'storage', {
                    value: { getDirectory: () => Promise.resolve(opfsRoot) },
                    configurable: true,
                });
            } catch {
                // Property may be non-configurable — try patching directly
                try {
                    self.navigator.storage.getDirectory = () => Promise.resolve(opfsRoot);
                } catch (e2) {
                    warn('Could not polyfill navigator.storage:', e2.message);
                }
            }
        }
    }

    // Load sqlite-wasm into the worker via importScripts (classic worker).
    importScripts(assetBase + 'sqlite3.js');

    if (typeof globalThis.sqlite3InitModule !== 'function') {
        throw new Error('sqlite3InitModule not defined after importScripts');
    }

    // Tell sqlite3-wasm where to find its assets (sqlite3.wasm, etc.).
    //
    // sqlite3.js has TWO IIFEs:
    //   1) The Emscripten factory (lines 36–13925) — defines the init function
    //   2) A wrapper IIFE (lines 13931+) — creates a NEW sqlite3InitModuleState
    //      on globalThis, overwriting anything we set before importScripts.
    //
    // The Emscripten factory reads globalThis.sqlite3InitModuleState LAZILY
    // (when called, not when imported).  So we must set sqlite3Dir on the
    // state object that the wrapper IIFE created — i.e., AFTER importScripts
    // but BEFORE calling sqlite3InitModule().
    //
    // Without this, Emscripten falls back to self.location.href (the worker
    // script dir js/) instead of the actual asset dir (js/sqlite-wasm/).
    if (globalThis.sqlite3InitModuleState) {
        globalThis.sqlite3InitModuleState.sqlite3Dir = assetBase;
    }
    log('Asset base for sqlite3:', assetBase);

    _sqlite3 = await globalThis.sqlite3InitModule({
        print: (msg) => log(msg),
        printErr: (msg) => warn(msg),
    });

    // ── Web Locks: fast single-tab detection ─────────────────────────────
    // The opfs-sahpool VFS requires exclusive file handles — two tabs cannot
    // share the same OPFS pool.  Requesting an exclusive lock with
    // { ifAvailable: true } tells us instantly if another tab already owns
    // OPFS, avoiding a 10-second retry spin before falling back to in-memory.
    //
    // When we DO acquire the lock we hold it (via a long-lived Promise) until
    // handleClose() releases it, so a second tab that opens later will see the
    // lock is taken and fall back immediately too.
    let canUseOpfs = true;
    if ('locks' in navigator) {
        try {
            canUseOpfs = await new Promise(resolve => {
                navigator.locks.request('sr-opfs-pool', { ifAvailable: true }, lock => {
                    if (lock === null) {
                        // Another tab already holds the lock.
                        resolve(false);
                        return Promise.resolve(); // Release immediately (we never held it)
                    }
                    // We own the lock.  Hold it until handleClose() calls _releaseLock().
                    resolve(true);
                    return new Promise(release => { _releaseLock = release; });
                });
            });
            if (!canUseOpfs) {
                warn('Another tab owns the OPFS lock — using in-memory fallback immediately');
            }
        } catch (e) {
            // Web Locks API unavailable — fall through to the retry loop below.
            warn('Web Locks API unavailable, proceeding with OPFS retries:', e.message);
        }
    }

    // Attempt to install the OPFS SAH Pool VFS.  This requires
    // FileSystemSyncAccessHandle which is available in worker threads.
    // Retry up to 5 times with increasing delays — Edge in particular can
    // hold stale file handles from previous sessions for several seconds
    // after a tab closes, causing the first few attempts to fail.
    var maxAttempts = 5;
    for (let attempt = 1; canUseOpfs && attempt <= maxAttempts; attempt++) {
        try {
            _poolUtil = await _sqlite3.installOpfsSAHPoolVfs({
                forceReinitIfPreviouslyFailed: true,
                // Pool capacity: old per-domain DBs (sr_plans_N, sr_history_N,
                // sr_portfolio_N, sr_cashflow_N) may still occupy slots from before
                // the unification commit.  12 gives ample headroom for the unified
                // sr_data_N file plus any legacy files still in the pool.
                initialCapacity: 12,
            });
            // Ensure the pool has room for all files (handles case where an existing
            // pool was smaller and forceReinit didn't expand it).
            const currentCap = _poolUtil.getCapacity ? _poolUtil.getCapacity() : 0;
            if (currentCap > 0 && currentCap < 12) {
                const needed = 12 - currentCap;
                try {
                    await _poolUtil.addCapacity(needed);
                    log('Expanded OPFS pool capacity by', needed, '→ now', _poolUtil.getCapacity());
                } catch (capE) {
                    warn('Could not expand OPFS pool capacity:', capE.message);
                }
            }
            _opfsAvailable = true;
            log('opfs-sahpool VFS installed (attempt ' + attempt + ')', '| pool capacity:', _poolUtil.getCapacity ? _poolUtil.getCapacity() : 'unknown');
            break;
        } catch (e) {
            if (attempt < maxAttempts) {
                var delay = attempt * 1000; // 1s, 2s, 3s, 4s
                warn('opfs-sahpool attempt ' + attempt + ' failed, retrying in ' + delay + 'ms:', e.message);
                await new Promise(r => setTimeout(r, delay));
            } else {
                _opfsAvailable = false;
                warn('opfs-sahpool VFS unavailable after ' + maxAttempts + ' attempts — will use in-memory fallback:', e.message);
            }
        }
    }

    log('Initialized. OPFS available:', _opfsAvailable,
        '| version:', _sqlite3.version.libVersion);

    return {
        opfsAvailable: _opfsAvailable,
        version: _sqlite3.version.libVersion,
        // true when another tab owns the OPFS lock (Web Locks API detected it).
        // false when OPFS failed for any other reason (unsupported, retry exhausted).
        lockedByAnotherTab: !canUseOpfs && !_opfsAvailable,
    };
}

/**
 * Open (or create) a SQLite database.
 * If the requested database is already open, this is a no-op (returns immediately
 * without closing/reopening).  This allows multiple C# services that each manage
 * a different logical DB to call open() before every operation without clobbering
 * each other's active handle.
 * @param {string} dbName  Logical database name (e.g. "sr_plans_1").
 */
async function handleOpen(dbName) {
    // No-op if this database is already open.
    if (_db && _currentDbName === dbName) {
        return { persisted: _opfsAvailable };
    }

    if (_db) {
        try { _db.close(); } catch (_) { /* ignore */ }
        _db = null;
    }
    _currentDbName = '';

    if (_opfsAvailable && _poolUtil) {
        try {
            _db = new _poolUtil.OpfsSAHPoolDb('/' + dbName + '.db');
            _currentDbName = dbName;
            log('Opened OPFS database:', dbName);
            return { persisted: true };
        } catch (e) {
            warn('OPFS open failed, falling back to in-memory:', e.message);
            _db = new _sqlite3.oo1.DB(':memory:', 'c');
            _currentDbName = dbName;
            return { persisted: false };
        }
    }

    _db = new _sqlite3.oo1.DB(':memory:', 'c');
    _currentDbName = dbName;
    warn('OPFS unavailable — using in-memory database');
    return { persisted: false };
}

/**
 * Execute DDL/DML (no result).
 */
function handleExec(sql, params) {
    if (!_db) throw new Error('exec called before open()');
    const bind = (Array.isArray(params) && params.length > 0) ? params : undefined;
    _db.exec({ sql, bind });
}

/**
 * Execute SELECT and return rows as a JSON string.
 */
function handleQuery(sql, params) {
    if (!_db) throw new Error('query called before open()');
    const rows = [];
    const bind = (Array.isArray(params) && params.length > 0) ? params : undefined;
    _db.exec({ sql, bind, rowMode: 'object', callback: (row) => rows.push(row) });
    return JSON.stringify(rows);
}

/**
 * Execute SELECT returning a single scalar value.
 */
function handleScalar(sql, params) {
    if (!_db) throw new Error('scalar called before open()');
    const bind = (Array.isArray(params) && params.length > 0) ? params : undefined;
    return _db.selectValue(sql, bind);
}

/**
 * Close the open database and release the OPFS Web Lock so other tabs can take over.
 */
function handleClose() {
    if (_db) {
        try { _db.close(); } catch (_) { /* ignore */ }
        _db = null;
        _currentDbName = '';
        log('Database closed');
    }
    if (_releaseLock) {
        _releaseLock();
        _releaseLock = null;
        log('OPFS lock released');
    }
}

/**
 * Atomic INSERT + last_insert_rowid() in a single synchronous call.
 * Prevents interleaving between the INSERT and the rowid lookup.
 */
function handleInsertAndGetId(sql, params) {
    if (!_db) throw new Error('insertAndGetId called before open()');
    const bind = (Array.isArray(params) && params.length > 0) ? params : undefined;
    _db.exec({ sql, bind });
    return _db.selectValue('SELECT last_insert_rowid()');
}

/**
 * Export the database as raw bytes (Uint8Array).
 */
function handleExportDb() {
    if (!_db) throw new Error('exportDb called before open()');
    const bytes = _sqlite3.capi.sqlite3_js_db_export(_db);
    log('Database exported:', bytes.byteLength, 'bytes');
    return bytes;
}

/**
 * Import a database from raw bytes, replacing the current database.
 * @param {string}     dbName  Logical database name.
 * @param {Uint8Array} bytes   Raw SQLite .db bytes.
 */
async function handleImportDb(dbName, bytes) {
    if (_db) {
        try { _db.close(); } catch (_) { /* ignore */ }
        _db = null;
        _currentDbName = '';
    }

    // sqlite3_deserialize loads into memory but doesn't persist to OPFS SAH Pool.
    // The backup C API isn't exposed in this wasm build.
    // Strategy: deserialize into a temp in-memory DB, then SQL-copy all tables
    // into the OPFS-backed target.

    // 1. Load imported bytes into a temporary in-memory database.
    var srcDb = new _sqlite3.oo1.DB(':memory:', 'c');
    var pData = _sqlite3.wasm.allocFromTypedArray(bytes);
    var rc = _sqlite3.capi.sqlite3_deserialize(
        srcDb, 'main', pData, bytes.byteLength, bytes.byteLength,
        _sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        _sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
    );
    if (rc !== 0) {
        srcDb.close();
        throw new Error('sqlite3_deserialize failed with rc=' + rc);
    }

    // 2. Open the OPFS target database.
    await handleOpen(dbName);

    // 3. Drop all existing user tables in the target.
    try {
        var tables = [];
        _db.exec({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            callback: function(row) { tables.push(row[0]); }
        });
        for (var i = 0; i < tables.length; i++) {
            _db.exec('DROP TABLE IF EXISTS "' + tables[i] + '"');
        }
    } catch (_) { /* target might be empty */ }

    // 4. Copy schema and data from source to target.
    try {
        // Create tables
        srcDb.exec({
            sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL",
            callback: function(row) { _db.exec(row[0]); }
        });

        // Copy data table by table
        var srcTables = [];
        srcDb.exec({
            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            callback: function(row) { srcTables.push(row[0]); }
        });

        for (var t = 0; t < srcTables.length; t++) {
            var tbl = srcTables[t];
            var rows = [];
            srcDb.exec({
                sql: 'SELECT * FROM "' + tbl + '"',
                rowMode: 'array',
                callback: function(row) { rows.push(Array.from(row)); }
            });
            if (rows.length === 0) continue;

            var colCount = rows[0].length;
            var placeholders = new Array(colCount).fill('?').join(',');
            var insertSql = 'INSERT INTO "' + tbl + '" VALUES (' + placeholders + ')';

            _db.exec('BEGIN');
            try {
                for (var r = 0; r < rows.length; r++) {
                    _db.exec({ sql: insertSql, bind: rows[r] });
                }
                _db.exec('COMMIT');
            } catch (insertErr) {
                _db.exec('ROLLBACK');
                throw insertErr;
            }
        }

        // Recreate indexes
        srcDb.exec({
            sql: "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL",
            callback: function(row) { try { _db.exec(row[0]); } catch (_) {} }
        });
    } finally {
        srcDb.close();
    }

    log('Database imported:', bytes.byteLength, 'bytes into', dbName, '(via SQL copy)');
}

// ── Message dispatcher ───────────────────────────────────────────────────────

self.onmessage = async function (e) {
    const { id, method, args } = e.data;
    try {
        let result;
        switch (method) {
            case 'init':         result = await handleInit(...args); break;
            case 'open':         result = await handleOpen(...args); break;
            case 'exec':         handleExec(...args); result = undefined; break;
            case 'query':        result = handleQuery(...args); break;
            case 'scalar':       result = handleScalar(...args); break;
            case 'close':        handleClose(); result = undefined; break;
            case 'exportDb':     result = handleExportDb(); break;
            case 'importDb':     await handleImportDb(...args); result = undefined; break;
            case 'ping':           result = Date.now(); break;
            case 'insertAndGetId': result = handleInsertAndGetId(...args); break;
            case 'isOpfsActive':   result = _opfsAvailable && _db !== null; break;
            default:               throw new Error('Unknown method: ' + method);
        }

        // Use Transferable for exportDb to avoid copying large byte arrays.
        if (method === 'exportDb' && result instanceof Uint8Array) {
            self.postMessage({ id, result }, [result.buffer]);
        } else {
            self.postMessage({ id, result });
        }
    } catch (err) {
        self.postMessage({ id, error: err.message || String(err) });
    }
};
