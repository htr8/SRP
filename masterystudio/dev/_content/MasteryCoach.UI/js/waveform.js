// Canvas renderer + interaction for the Waveform component. Blazor owns the authoritative state
// (peaks, sections, loop, position); this module paints at 60fps, extrapolates the playhead between
// the ~4/sec authoritative updates so it moves smoothly without per-frame interop, and reports
// pointer gestures (seek, loop drag) back to .NET. Runs in the web app and every MAUI WebView.
//
// Detailed look: a min/max sample OUTLINE with a filled RMS (loudness) BODY inside it, mirrored
// about the centre line — DAW-style.

const instances = new Map();
let nextId = 1;

// Call a .NET instance method, swallowing the rejection when the DotNetObjectReference is already
// disposed. A queued timer, a trailing view-notify, or a pointer callback that lands after teardown
// would otherwise reject with "no tracked object with id N" — repeatedly, flooding the error funnel
// and the client_error analytics event (device log 2026-07-12). A late call is a correct no-op.
function safeInvoke(dotnet, method, ...args) {
    if (!dotnet) return;
    try {
        const p = dotnet.invokeMethodAsync(method, ...args);
        if (p && p.catch) p.catch(() => { });
    } catch (e) { /* synchronous already-disposed throw — also a no-op */ }
}

// Respect the OS "reduce motion" setting: skip per-frame extrapolation and only repaint on the
// authoritative position syncs from Blazor, so the playhead steps rather than glides. Read lazily
// (not at module scope) so importing this module in Node — the CI smoke test — has no browser globals.
function prefersReducedMotion() {
    return typeof window !== 'undefined' && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function cssVar(el, name, fallback) {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

export function attach(canvas, dotnet) {
    // The canvas ref can marshal as null if the element isn't in the DOM yet when .NET calls attach
    // (seen opening the Console right after an export). Returning -1 (no crash) lets the host retry on a
    // later render instead of throwing "Cannot read properties of null (reading 'getContext')".
    if (!canvas) return -1;
    const id = nextId++;
    const inst = {
        canvas,
        ctx: canvas.getContext('2d'),
        dotnet,                 // .NET ref with [JSInvokable] OnSeek / OnLoopChanged
        dpr: 1,
        model: null,            // last snapshot from Blazor
        localPos: 0,            // extrapolated playhead seconds
        lastFrame: 0,
        raf: 0,
        drag: null,
        reduceMotion: prefersReducedMotion(),
        ro: null,               // ResizeObserver
        // The LIVE view window. Null = whole track. While the user pans or the playhead auto-follows,
        // JS owns this and drives it at 60fps, notifying Blazor on a throttled cadence (see notifyView).
        // For discrete zooms (wheel/keyboard/zoom-to-range) Blazor pushes the window in via update().
        view: null,
        lastViewNotify: 0,      // throttle clock for notifyView
        trailingNotify: 0,      // pending trailing-edge notify timer id
        hoverLoopEdge: null,     // visual affordance for the nearest active-loop grab handle
    };
    instances.set(id, inst);
    addPointerHandlers(inst);

    // Keep the backing store matched to the (responsive) CSS box on any layout change, so the
    // waveform stays crisp and pointer math stays accurate. rAF then repaints from the new size.
    if (typeof ResizeObserver !== 'undefined') {
        inst.ro = new ResizeObserver(() => resizeInstance(inst));
        inst.ro.observe(canvas);
    }

    resizeInstance(inst);
    inst.raf = requestAnimationFrame(ts => frame(id, ts));
    return id;
}

export function dispose(id) {
    const inst = instances.get(id);
    if (inst) {
        cancelAnimationFrame(inst.raf);
        if (inst.ro) inst.ro.disconnect();
        // Cancel any pending trailing view-notify — otherwise it fires ~100ms after teardown and calls
        // OnViewChanged on a disposed DotNetObjectReference (dead circuit → interop rejection).
        if (inst.trailingNotify) clearTimeout(inst.trailingNotify);
    }
    instances.delete(id);
}

function resizeInstance(inst) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = inst.canvas.clientWidth, h = inst.canvas.clientHeight;
    inst.canvas.width = Math.max(1, Math.round(w * dpr));
    inst.canvas.height = Math.max(1, Math.round(h * dpr));
    inst.dpr = dpr;
    if (inst.model) paint(inst); // repaint immediately at the new size
    return { width: w, height: h };
}

export function resize(id) {
    const inst = instances.get(id);
    if (!inst) return { width: 0, height: 0 };
    return resizeInstance(inst);
}

// Test-only accessor for the extrapolated playhead seconds. Used by the Node unit tests to assert the
// page-turn / stale-position handling; not called by the app.
export function __peekLocalPos(id) {
    const inst = instances.get(id);
    return inst ? inst.localPos : undefined;
}

// model: { peaks|null, duration, position, playing, tempo, view:{start,end}, loop:{start,end,active}|null }
// Heavy, rarely-changing data (peaks ~3600 floats, duration, section boundaries). Sent only when
// the peaks change, NOT every render — sending this per render was the Studio-jank source.
export function setData(id, data) {
    const inst = instances.get(id);
    if (!inst) return;
    inst.model = { ...(inst.model || {}), ...data };
    inst.lastFrame = performance.now();
}

// Lightweight per-frame state (position/playing/tempo/view/loop). Merged into the model so the
// peaks/boundaries set by setData are preserved.
export function update(id, model) {
    const inst = instances.get(id);
    if (!inst) return;
    const prev = inst.model;
    inst.model = { ...(prev || {}), ...model };
    // Resync the playhead to the authoritative clock — but ignore a STALE echo. The host only syncs
    // position ~1/sec, so the 60fps-extrapolated localPos legitimately leads it; and a follow/pan view
    // change round-trips through Blazor and re-pushes update() carrying that SAME stale position.
    // Snapping localPos back to it would jerk the playhead back a fraction of a second on every page-turn.
    // A view-only echo re-pushes the *unchanged* position, whereas a real seek/tick carries a NEW one — so
    // adopt only when the pushed position actually changed (or on the first push, or while paused).
    const playing = model.playing ?? (prev && prev.playing);
    const positionChanged = prev == null || model.position !== prev.position;
    // An explicit seek bumps seekNonce. Force the playhead onto the seeked position even when the
    // position VALUE didn't change from the last one JS saw and we're playing (e.g. back-to-start to 0
    // right after load, before any distinct nonzero position was pushed) — otherwise the extrapolation
    // would keep drifting forward and the seek would look like it did nothing.
    const seeked = prev != null && model.seekNonce !== undefined && model.seekNonce !== prev.seekNonce;
    if (!playing || positionChanged || seeked) {
        inst.localPos = model.position;
    }
    inst.lastFrame = performance.now();
    // Discrete zooms (wheel/keyboard/zoom-to-range/clear) flow Blazor→JS via model.view. Adopt it only
    // when it differs from our live window beyond an epsilon: a real zoom differs; the throttled echo of
    // our own pan/follow does not — so this ignores the echo and breaks the feedback loop.
    const incoming = model.view;
    if (incoming && !viewsEqual(incoming, inst.view)) {
        // A DIFFERING view arriving mid-pan can only be a genuine discrete zoom (keyboard/parts-click while
        // dragging) — the pan's own echo is filtered by viewsEqual above. Let the explicit zoom win and end
        // the pan, so the drag's later pointerup settle can't clobber the zoom the user just invoked.
        if (inst.drag && inst.drag.kind === 'pan') {
            inst.drag = null;
            inst.canvas.classList && inst.canvas.classList.remove('panning');
        }
        inst.view = { start: incoming.start, end: incoming.end };
    }
    if (inst.model && inst.model.centerLock && inst.view && isZoomed(inst) && !inst.drag) {
        const span = inst.view.end - inst.view.start;
        setFixedHeadView(inst, inst.localPos, span, true, true);
    }
}

const VIEW_EPS = 0.002; // seconds; below this two windows are "the same" (ignore the pan/follow echo)

function viewsEqual(a, b) {
    return a && b && Math.abs(a.start - b.start) < VIEW_EPS && Math.abs(a.end - b.end) < VIEW_EPS;
}

// True when the live window is a strict, POSITIVE-width sub-range of the track (i.e. the user has
// zoomed in). Follow and pan only apply when zoomed; at full-track view every gesture is unchanged.
// The `span > VIEW_EPS` lower bound also stops a degenerate zero-width view from reaching the follow
// math (a 0 span would make rel = ±Infinity/NaN).
function isZoomed(inst) {
    const m = inst.model, v = inst.view;
    const span = v ? v.end - v.start : 0;
    return !!(m && v && span > VIEW_EPS && span < (m.duration || 0) - VIEW_EPS);
}

// How far past the track edges a MANUAL pan may pull the view, as a fraction of the visible span — so
// the first/last moment can be dragged away from the canvas edge and become reachable (the playhead and
// loop handles sit flush at t=0 / t=duration otherwise, hard to grab on a phone; user request). Only
// manual pans overscroll; auto-follow (playback / center-lock) stays clamped to [0, duration] so it
// never scrolls into empty space.
const OVERSCROLL_FRACTION = 0.4;

// Set the live window (JS-authoritative during motion), preserving span, then notify Blazor on a
// throttled cadence. `settle` forces an immediate notify (pan release / page land). `allowOverscroll`
// (manual pan only) lets the window extend a margin beyond [0, duration]; the paint blanks the region
// outside the track so it reads as empty gutter, not a smeared edge.
function setLocalView(inst, start, end, settle, allowOverscroll, follow) {
    const dur = (inst.model && inst.model.duration) || 0;
    const span = Math.min(end - start, dur);
    // Only overscroll when actually zoomed (a whole-track view has nothing to pull away from) and asked.
    const margin = (allowOverscroll && span < dur - VIEW_EPS) ? span * OVERSCROLL_FRACTION : 0;
    start = Math.max(-margin, Math.min(start, dur - span + margin));
    inst.view = { start, end: start + span };
    notifyView(inst, settle, follow);
}

function fixedHeadStart(inst, position, span) {
    const dur = (inst.model && inst.model.duration) || 0;
    if (dur <= VIEW_EPS || span <= VIEW_EPS) return 0;
    const halfSpan = span / 2;
    const minStart = -halfSpan;
    const maxStart = Math.max(minStart, dur - halfSpan);
    return Math.max(minStart, Math.min(position - halfSpan, maxStart));
}

function setFixedHeadView(inst, position, span, settle, follow) {
    const dur = (inst.model && inst.model.duration) || 0;
    span = Math.min(span, dur);
    if (span <= VIEW_EPS) return false;
    const start = fixedHeadStart(inst, position, span);
    const next = { start, end: start + span };
    if (viewsEqual(next, inst.view)) return false;
    inst.view = next;
    notifyView(inst, settle, follow);
    return true;
}

// Center-lock scrub: the playhead stays visually fixed at the centre while the waveform moves under it.
// The view may extend half a window past the media edges so the fixed centre line can land exactly on
// 0:00 or the track end.
function setFixedHeadScrubView(inst, start, settle, follow) {
    const dur = (inst.model && inst.model.duration) || 0;
    const v = view(inst);
    const span = Math.min(v.end - v.start, dur);
    if (span <= VIEW_EPS) return;
    start = fixedHeadStart(inst, start + span / 2, span);
    inst.view = { start, end: start + span };
    inst.localPos = Math.max(0, Math.min(dur, start + span / 2));
    notifyView(inst, settle, follow);
}

function notifyScrubSeek(inst, settle) {
    if (!inst.dotnet) return;
    const now = performance.now();
    if (!settle && now - (inst.lastScrubSeekNotify || 0) < 80) return;
    inst.lastScrubSeekNotify = now;
    safeInvoke(inst.dotnet, 'OnSeekJs', inst.localPos);
}

// Report the live window to Blazor. Throttled to ~10/sec during continuous motion (pan), with a
// trailing-edge call so the final window always lands. `settle` bypasses the throttle. `follow` marks
// a page-follow step — the host uses it to keep whole-track peaks (no detail re-pull while playing).
function notifyView(inst, settle, follow) {
    if (!inst.dotnet || !inst.view) return;
    if (inst.trailingNotify) { clearTimeout(inst.trailingNotify); inst.trailingNotify = 0; }
    const fire = () => {
        inst.lastViewNotify = performance.now();
        safeInvoke(inst.dotnet, 'OnViewChanged', inst.view.start, inst.view.end, follow === true);
    };
    const now = performance.now();
    if (settle || now - inst.lastViewNotify >= 100) {
        fire();
    } else if (typeof setTimeout !== 'undefined') {
        inst.trailingNotify = setTimeout(fire, 100 - (now - inst.lastViewNotify));
    }
}

function frame(id, ts) {
    const inst = instances.get(id);
    if (!inst) return;
    const m = inst.model;
    if (m) {
        const dt = (ts - inst.lastFrame) / 1000;
        inst.lastFrame = ts;
        if (m.playing && !inst.reduceMotion) {
            inst.localPos += dt * (m.tempo || 1);
            const loop = m.loop;
            if (loop && loop.active && loop.end != null && inst.localPos >= loop.end) {
                inst.localPos = loop.start;                 // visually mirror the gapless loop
            } else if (inst.localPos > m.duration) {
                inst.localPos = m.duration;
            }
        }
        followPlayhead(inst);
        paint(inst);
    }
    inst.raf = requestAnimationFrame(t => frame(id, t));
}

// Page-turn follow: when zoomed, keep the playhead on screen by JUMPING the window (not scrolling it),
// landing the playhead back near the left. While PLAYING it pages with lookahead (as the playhead nears
// the right edge at 85%); while PAUSED it only re-centres if the playhead has landed fully OFF the visible
// window (e.g. an End/Home keyboard seek) — a click-seek is always inside the view, so paused playback
// normally never pages. Discrete jumps mean one view change per page — cheap, and it doesn't thrash the
// peaks debounce (the host keeps whole-track peaks while following; see the `follow` flag on the notify).
// Under reduced motion this still runs — just off the coarser position syncs, so it steps.
function followPlayhead(inst) {
    if (!isZoomed(inst) || (inst.drag && (inst.drag.kind === 'pan' || inst.drag.kind === 'scrub'))) return; // don't fight a live gesture
    const m = inst.model, v = inst.view, span = v.end - v.start;
    const dur = (m && m.duration) || 0;

    // Center-lock mode: keep the playhead pinned at the horizontal centre and scroll the window under it.
    // The view may extend half a visible span before/after the track, so 0:00 and the track end still
    // land on the fixed centre line instead of being pinned to the canvas edges.
    if (m.centerLock && m.playing) {
        setFixedHeadView(inst, inst.localPos, span, false, true);
        return;
    }

    const rel = (inst.localPos - v.start) / span;
    const offView = rel < 0 || rel > 1; // playhead not visible in the current window
    // While PAUSED, only re-centre when the PLAYHEAD moved (an End/Home-style seek) — NOT when the VIEW
    // moved out from under a stationary playhead. Otherwise a minimap/pan move of the view snapped
    // straight back to the playhead the very next frame (user bug report: "minimap keeps snapping back
    // to the start"). Track the last playhead we followed; a view move alone leaves it unchanged.
    // First follow after attach: seed from a sentinel (not the current pos), so a playhead that is
    // ALREADY off-view on the very first frame still counts as "moved" and gets chased — otherwise a
    // paused off-screen seek right after load never re-centres (the ?? inst.localPos default made the
    // first frame's playheadMoved always false).
    const playheadMoved = Math.abs(inst.localPos - (inst._lastFollowPos ?? Number.NEGATIVE_INFINITY)) > VIEW_EPS;
    inst._lastFollowPos = inst.localPos;
    const trigger = m.playing
        ? (rel < 0 || rel > 0.85)              // lookahead while playing
        : (offView && playheadMoved);          // paused: chase a real off-view seek, not a view move
    if (trigger) {
        if (inst.localPos >= dur - VIEW_EPS && v.end >= dur - VIEW_EPS) return; // already parked at the end
        let ns = inst.localPos - span * 0.15;               // playhead lands at ~15% from the left
        ns = Math.max(0, Math.min(ns, dur - span));
        if (Math.abs(ns - v.start) < VIEW_EPS) return;      // no meaningful move (avoids a redundant notify)
        inst.view = { start: ns, end: ns + span };
        notifyView(inst, false, true);                      // follow=true → host keeps whole-track peaks
    }
}

function view(inst) { return inst.view || { start: 0, end: (inst.model && inst.model.duration) || 1 }; }

function paint(inst) {
    const { ctx, canvas, model: m } = inst;
    const w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    if (w <= 0 || h <= 0) return; // mid-layout the box can report 0 size; skip the frame (avoids a garbage draw)
    ctx.setTransform(inst.dpr, 0, 0, inst.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const v = view(inst);
    const span = Math.max(0.001, v.end - v.start);
    const timeToX = t => ((t - v.start) / span) * w;
    const playedX = timeToX(inst.localPos);

    const cPlayed = cssVar(canvas, '--wave-played', '#e44c2a');
    const cOutline = cssVar(canvas, '--wave-unplayed', '#55636e');
    const cBody = cssVar(canvas, '--wave-body', 'rgba(120,138,150,0.5)');

    // section boundary guides (faint verticals dropped through the wave)
    if (m.boundaries && m.boundaries.length) {
        ctx.fillStyle = cssVar(canvas, '--line', '#313941');
        ctx.globalAlpha = 0.9;
        for (const bt of m.boundaries) {
            if (bt <= v.start || bt >= v.end) continue;
            ctx.fillRect(Math.round(timeToX(bt)), 0, 1, h);
        }
        ctx.globalAlpha = 1;
    }

    // Saved loops: quiet BLUE markers (distinct from the gold active loop) so the user can see where their
    // named loops sit without loading one. A faint blue band + slim blue edge bars at each saved loop's
    // start/end. Drawn UNDER the wave and under the active loop, so an active gold loop always reads on
    // top. Skipped for any saved loop the active loop exactly matches (it's shown gold instead).
    if (m.savedLoops && m.savedLoops.length) {
        const cSavedBand = cssVar(canvas, '--saved-loop-band', 'rgba(122,180,255,0.14)');
        const cSavedEdge = cssVar(canvas, '--saved-loop-edge', '#7fb4ff');
        for (const sl of m.savedLoops) {
            if (sl.end == null || sl.end <= v.start || sl.start >= v.end) continue;
            const x0 = Math.round(timeToX(sl.start)), x1 = Math.round(timeToX(sl.end));
            ctx.fillStyle = cSavedBand;
            ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
            ctx.fillStyle = cSavedEdge;
            ctx.globalAlpha = 0.85;
            ctx.fillRect(x0, 0, 2, h);
            ctx.fillRect(x1 - 1, 0, 2, h);
            ctx.globalAlpha = 1;
        }
    }

    // Loop band sits under the wave so it reads as a selected region, but the edge strokes are drawn
    // again after the wave below; otherwise dense peaks hide the yellow handles through the middle.
    if (m.loop && m.loop.end != null) {
        const x0 = timeToX(m.loop.start), x1 = timeToX(m.loop.end);
        ctx.fillStyle = cssVar(canvas, '--loop-band', 'rgba(240,195,90,0.16)');
        ctx.fillRect(x0, 0, x1 - x0, h);
    }

    if (!m.peaks) {
        ctx.strokeStyle = cOutline; ctx.globalAlpha = 0.5;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
        ctx.globalAlpha = 1;
    } else {
        const { min, max, rms } = m.peaks;
        const n = min.length;
        // The peaks array spans a time window: the whole track by default, or m.peaksView when the host
        // re-pulled peaks for a zoomed sub-window (so the zoomed view keeps full detail). Map the visible
        // view range into that window's buckets. When peaksView == the view, this is the whole array.
        const pv = m.peaksView || { start: 0, end: m.duration || 1 };
        const pSpan = Math.max(0.001, pv.end - pv.start);
        // Clamp into [0, n-1]. During the async gap between a zoom and the host's peaks re-pull, the view
        // can briefly sit outside the (stale) peaksView window — an unclamped index would read past the
        // array end (undefined → NaN rects). It self-corrects when the re-pull lands.
        const b0 = Math.min(n - 1, Math.max(0, Math.floor(((v.start - pv.start) / pSpan) * n)));
        const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil(((v.end - pv.start) / pSpan) * n)));
        const cols = Math.max(1, b1 - b0);
        const drawCols = Math.min(cols, Math.max(1, Math.ceil(w * 1.5)));
        // Position each bucket by its actual TIME (via timeToX), not an even column across the whole
        // canvas. When the view is within [0, duration] this is identical to the old even spacing, but
        // when a manual pan OVERSCROLLS past an edge it keeps the audio at its true x and simply leaves
        // the off-track region blank — instead of stretching the track columns across the full width.
        const bucketTime = b => pv.start + ((b + 0.5) / n) * pSpan; // centre time of bucket b
        const colW = w / drawCols;
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < drawCols; i++) {
                const gb0 = Math.min(n - 1, b0 + Math.floor((i / drawCols) * cols));
                const gb1 = Math.min(n, Math.max(gb0 + 1, b0 + Math.ceil(((i + 1) / drawCols) * cols)));
                let minV = 1, maxV = -1, rmsV = 0;
                for (let b = gb0; b < gb1; b++) {
                    if (min[b] < minV) minV = min[b];
                    if (max[b] > maxV) maxV = max[b];
                    if (rms[b] > rmsV) rmsV = rms[b];
                }
                const cx = timeToX(bucketTime((gb0 + gb1 - 1) / 2)), x = cx - colW / 2, played = cx <= playedX;
                if (pass === 0) {
                    const top = mid - maxV * (mid - 1), bot = mid - minV * (mid - 1);
                    ctx.fillStyle = played ? cPlayed : cOutline;
                    ctx.globalAlpha = played ? 0.9 : 0.7;
                    ctx.fillRect(x, top, Math.max(1, colW * 0.9), Math.max(1, bot - top));
                } else {
                    const r = rmsV * (mid - 1);
                    ctx.fillStyle = played ? cPlayed : cBody;
                    ctx.globalAlpha = played ? 1 : 0.9;
                    ctx.fillRect(x, mid - r, Math.max(1, colW * 0.9), Math.max(1, r * 2));
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    // MIDI hit overlay: note-on events are thin full-height strokes, shifted by the host's manual
    // alignment offset. Drawn above the waveform body but below the loop/playhead/edit handles.
    if (m.midiHits && m.midiHits.length) {
        const hitColor = cssVar(canvas, '--midi-hit', '#8bd3ff');
        const offset = (m.midiHitOffsetMs || 0) / 1000;
        ctx.fillStyle = hitColor;
        for (const hit of m.midiHits) {
            const t = (hit.time || 0) + offset;
            if (t < v.start || t > v.end) continue;
            const velocity = Math.max(1, Math.min(127, hit.velocity || 80));
            ctx.globalAlpha = 0.25 + (velocity / 127) * 0.55;
            const x = Math.round(timeToX(t));
            ctx.fillRect(x - 1, 0, 2, h);
        }
        ctx.globalAlpha = 1;
    }

    // Saved marks: full-height point ticks. Skip marks get the warmer colour because they affect
    // transport flow; regular marks stay cool and quieter as recall anchors.
    if (Array.isArray(m.marks) && m.marks.length) {
        const markColor = cssVar(canvas, '--mark-edge', '#d6b2ff');
        const skipColor = cssVar(canvas, '--skip-mark-edge', '#ff8a5b');
        for (const mark of m.marks) {
            const t = Number(mark.position);
            if (!Number.isFinite(t) || t < v.start || t > v.end) continue;
            const x = Math.round(timeToX(t));
            const isSkip = !!mark.isSkip;
            ctx.fillStyle = isSkip ? skipColor : markColor;
            ctx.globalAlpha = isSkip ? 0.92 : 0.72;
            ctx.fillRect(x - 1, 0, isSkip ? 3 : 2, h);
            ctx.fillRect(x - 4, 0, 8, 3);
            ctx.fillRect(x - 4, h - 3, 8, 3);
        }
        ctx.globalAlpha = 1;
    }

    // Foreground loop handles: keep them visible across the full waveform height, even on loud/dense
    // passages whose filled peaks would otherwise cover the underlay. The caps make the handles read as
    // draggable targets instead of hairline markers, matching the larger touch hit target below.
    if (m.loop && m.loop.end != null) {
        const x0 = Math.round(timeToX(m.loop.start));
        const x1 = Math.round(timeToX(m.loop.end));
        const loopEdge = cssVar(canvas, '--loop-edge', '#f0c35a');
        const activeEdge = inst.drag && (inst.drag.edge === 'start' || inst.drag.edge === 'end')
            ? inst.drag.edge
            : inst.hoverLoopEdge;
        drawLoopHandle(ctx, x0, h, loopEdge, activeEdge === 'start');
        drawLoopHandle(ctx, x1, h, loopEdge, activeEdge === 'end');
    }

    // Edit mode: draw a draggable grab-line at each interior section boundary, plus a live preview
    // line while one is being dragged. The lane above shows section names/colours; this is the handle.
    if (m.editSections && m.boundaries) {
        const dur = m.duration || 0;
        const edge = cssVar(canvas, '--accent-2', '#f0c35a');
        for (const bt of m.boundaries) {
            // Skip the outer track edges EXCEPT for a lone splittable section, whose edges are grabbable
            // (drag inward to split) — draw their handles so the affordance is visible (matches hit-test).
            if (!m.splittable && (bt <= 0 || bt >= dur)) continue;
            // For a splittable lone section, nudge an edge tab a hair inward so it isn't clipped at x=0/x=dur.
            const raw = Math.round(timeToX(bt));
            const bx = m.splittable ? Math.min(Math.max(raw, 2), canvas.clientWidth - 2) : raw;
            ctx.fillStyle = edge;
            ctx.globalAlpha = 0.7;
            ctx.fillRect(bx - 1, 0, 2, h);
            // little grab tabs top & bottom
            ctx.fillRect(bx - 3, 0, 6, 4);
            ctx.fillRect(bx - 3, h - 4, 6, 4);
        }
        ctx.globalAlpha = 1;
        if (inst.previewBoundary != null) {
            const px = Math.round(timeToX(inst.previewBoundary));
            ctx.fillStyle = cssVar(canvas, '--accent', '#e44c2a');
            ctx.fillRect(px - 1, 0, 2, h);
        }
    }

    // Playhead: draw last so the current audible position is never hidden by peaks, loop bands, saved
    // markers, or section guides. The dark halo keeps it legible over bright played waveform columns.
    drawPlayhead(ctx, Math.round(playedX), h, cssVar(canvas, '--wave-playhead', '#f8fafc'));
}

function drawLoopHandle(ctx, x, h, color, active) {
    if (active) {
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.16;
        ctx.fillRect(x - 14, 0, 28, h);
        ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.fillRect(x - 2, 0, 4, h);
    ctx.fillRect(x - 9, 0, 18, 6);
    ctx.fillRect(x - 9, h - 6, 18, 6);

    if (active) {
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.85;
        ctx.fillRect(x - 1, 6, 2, Math.max(1, h - 12));
        ctx.globalAlpha = 1;
    }
}

function drawPlayhead(ctx, x, h, color) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 3, 0, 7, h);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, 0, 3, h);
    ctx.fillStyle = '#f0c35a';
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
}

function xToTime(inst, clientX) {
    const m = inst.model; if (!m) return 0;
    const v = view(inst);
    const rect = inst.canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return v.start + frac * (v.end - v.start);
}

function timeToXpx(inst, t) {
    const v = view(inst);
    return ((t - v.start) / Math.max(0.001, v.end - v.start)) * inst.canvas.clientWidth;
}

// Snap a time to a nearby section boundary (within a few px). Zero-crossing snap is applied C#-side
// where the buffer lives; here we snap to the visible structure the user sees.
function snapTime(inst, t) {
    const m = inst.model;
    if (!m.boundaries) return t;
    const px = timeToXpx(inst, t);
    let best = t, bestDist = 8; // px threshold
    for (const bt of m.boundaries) {
        const d = Math.abs(timeToXpx(inst, bt) - px);
        if (d < bestDist) { bestDist = d; best = bt; }
    }
    return best;
}

const SECTION_EDGE_PX = 8;
const LOOP_EDGE_MOUSE_PX = 12;
const LOOP_EDGE_TOUCH_PX = 28;

function loopEdgeHitPx(pointerType) {
    return pointerType === 'touch' || pointerType === 'pen'
        ? LOOP_EDGE_TOUCH_PX
        : LOOP_EDGE_MOUSE_PX;
}

function hitLoopEdge(inst, clientX, pointerType) {
    const m = inst.model;
    if (!m || !m.loop || m.loop.end == null) return null;
    const x = clientX - inst.canvas.getBoundingClientRect().left;
    const xStart = timeToXpx(inst, m.loop.start);
    const xEnd = timeToXpx(inst, m.loop.end);
    const dStart = Math.abs(x - xStart);
    const dEnd = Math.abs(x - xEnd);
    const edgePx = loopEdgeHitPx(pointerType);
    if (Math.min(dStart, dEnd) <= edgePx) return dStart <= dEnd ? 'start' : 'end';
    const inside = x > xStart && x < xEnd;
    return inside ? 'move' : null;
}

function commitLoop(inst, start, end) {
    if (end - start < (inst.model.duration || 1) * 0.005) return; // ignore hairline loops
    if (inst.dotnet) safeInvoke(inst.dotnet, 'OnLoopCommit', start, end);
}

// In edit mode, the nearest INTERIOR section boundary (a time shared by two adjacent sections) to the
// pointer, if within SECTION_EDGE_PX. The track-start/end aren't draggable. Returns the boundary time or null.
function hitSectionBoundary(inst, clientX) {
    const m = inst.model;
    // The model can be null before the first update() (or momentarily during a resize/reflow, e.g. a
    // device rotation firing pointermove mid-relayout) — bail rather than throw on m.editSections.
    if (!m || !m.editSections || !m.boundaries || m.boundaries.length === 0) return null;
    const x = clientX - inst.canvas.getBoundingClientRect().left;
    const dur = m.duration || 0;
    let best = null, bestDist = SECTION_EDGE_PX;
    for (const bt of m.boundaries) {
        // Normally only INTERIOR boundaries move (the track start/end aren't draggable). But when there's
        // a single section (m.splittable), its OUTER edges ARE grabbable so the user can drag one inward
        // to SPLIT the section in two (C# side does the split — user request 2026-07-13).
        if (!m.splittable && (bt <= 0 || bt >= dur)) continue;
        const d = Math.abs(timeToXpx(inst, bt) - x);
        if (d <= bestDist) { bestDist = d; best = bt; }
    }
    return best;
}

// A pointer event can fire mid-relayout — most notably a DEVICE ROTATION, which reflows the whole page
// and can hand us a canvas that's momentarily detached / zero-sized, or an instance whose model hasn't
// been (re)pushed yet. Every pointer handler below derefs inst.model and inst.canvas, so any of them
// would throw during that window (the landscape crash: hitSectionBoundary@waveform.js). One shared gate
// bails the whole gesture when the instance isn't in a usable state, rather than guarding each deref.
function pointerReady(inst) {
    const c = inst && inst.canvas;
    if (!c || !inst.model) return false;
    // A canvas removed from the DOM (or not yet laid out) reports a 0×0 box — pointer math would divide
    // by zero / read a stale rect. Skip until it has a real size again (post-rotation relayout).
    const r = c.getBoundingClientRect && c.getBoundingClientRect();
    return !!(r && r.width > 0 && r.height > 0);
}

function addPointerHandlers(inst) {
    const c = inst.canvas;
    c.addEventListener('pointerdown', e => {
        if (!pointerReady(inst)) return;
        c.setPointerCapture(e.pointerId);
        const t = xToTime(inst, e.clientX);
        // Edit mode: dragging a section boundary takes priority over (and suppresses) loop/seek, so the
        // two gestures never fight. A boundary drag carries the ORIGINAL boundary time so C# can map it
        // back to the two sections it separates on commit.
        const boundary = hitSectionBoundary(inst, e.clientX);
        if (boundary != null) {
            inst.drag = { t0: t, kind: 'boundary', boundary0: boundary, boundaryNow: boundary, moved: false };
            c.style.cursor = 'ew-resize';
            return;
        }
        const edge = hitLoopEdge(inst, e.clientX, e.pointerType);
        // Pan/scrub sits ABOVE loop-create/seek but BELOW boundary/loop-edge drags, and only exists WHEN
        // ZOOMED. With center-lock on, the playhead stays fixed and the wave drags underneath it,
        // seeking to the time under the fixed head. Otherwise a plain drag pans the view. A tap/click
        // still seeks; existing loop edges remain draggable.
        if (edge == null && isZoomed(inst)) {
            const kind = inst.model && inst.model.centerLock ? 'scrub' : 'pan';
            inst.drag = { kind, panStartX: e.clientX, t0: t, view0: { ...inst.view }, moved: false };
            c.style.cursor = 'grabbing';
            c.classList && c.classList.add('panning');
            return;
        }
        inst.drag = { t0: t, edge, moved: false, loop0: inst.model.loop ? { ...inst.model.loop } : null };
        c.style.cursor = edge === 'start' || edge === 'end' ? 'ew-resize' : edge === 'move' ? 'grabbing' : 'text';
    });
    c.addEventListener('pointermove', e => {
        if (!pointerReady(inst)) return;
        if (!inst.drag) {
            // hover cursor feedback — a boundary under the pointer (edit mode) shows the resize cursor.
            if (hitSectionBoundary(inst, e.clientX) != null) {
                inst.hoverLoopEdge = null;
                c.style.cursor = 'ew-resize';
                return;
            }
            const edge = hitLoopEdge(inst, e.clientX, e.pointerType);
            inst.hoverLoopEdge = edge === 'start' || edge === 'end' ? edge : null;
            // Over an existing loop edge/interior, show its resize/move cursors. Otherwise, when zoomed the
            // wave background is grab-to-pan; unzoomed it's the seek/loop-create caret.
            if (edge === 'start' || edge === 'end') c.style.cursor = 'ew-resize';
            else if (edge === 'move') c.style.cursor = 'grab';
            else c.style.cursor = isZoomed(inst) ? 'grab' : 'text';
            return;
        }
        const d = inst.drag;

        if (d.kind === 'pan') {
            // Slide the window opposite the pointer: drag right → reveal earlier audio (window moves left).
            const width = inst.canvas.clientWidth || 1;
            const span = d.view0.end - d.view0.start;
            const dtSec = ((e.clientX - d.panStartX) / width) * span;
            if (Math.abs(e.clientX - d.panStartX) > 2) d.moved = true;
            setLocalView(inst, d.view0.start - dtSec, d.view0.end - dtSec, false, true, inst.model && inst.model.playing); // manual pan → overscroll allowed
            return;
        }

        if (d.kind === 'scrub') {
            // Fixed-head scrub: drag right rewinds, drag left fast-forwards. The waveform moves behind
            // the centre playhead, and the engine is seeked to the time now under that fixed head.
            const width = inst.canvas.clientWidth || 1;
            const span = d.view0.end - d.view0.start;
            const dtSec = ((e.clientX - d.panStartX) / width) * span;
            if (Math.abs(e.clientX - d.panStartX) > 2) d.moved = true;
            setFixedHeadScrubView(inst, d.view0.start - dtSec, false, inst.model && inst.model.playing);
            if (d.moved) notifyScrubSeek(inst, false);
            return;
        }

        if (d.kind === 'boundary') {
            // Use the RAW pointer time, not snapTime — snapTime would snap to boundaries including the
            // one being dragged, pinning it to its own start (a dead-zone that eats small drags). The
            // authoritative grow/shrink/insert happens C#-side on commit.
            const raw = xToTime(inst, e.clientX);
            if (Math.abs(raw - d.t0) > (inst.model.duration || 1) * 0.004) d.moved = true;
            d.boundaryNow = Math.max(0, Math.min(raw, inst.model.duration || raw));
            inst.previewBoundary = d.boundaryNow;
            return;
        }

        const t = snapTime(inst, xToTime(inst, e.clientX));
        if (Math.abs(t - d.t0) > (inst.model.duration || 1) * 0.004) d.moved = true;
        const L = d.loop0;
        if (!d.moved) return;

        if (d.edge === 'start' && L) inst.model.loop = { start: Math.min(t, L.end - 0.05), end: L.end, active: true };
        else if (d.edge === 'end' && L) inst.model.loop = { start: L.start, end: Math.max(t, L.start + 0.05), active: true };
        else if (d.edge === 'move' && L) {
            const span = L.end - L.start;
            let ns = t - (d.t0 - L.start);
            ns = Math.max(0, Math.min(ns, (inst.model.duration || span) - span));
            inst.model.loop = { start: ns, end: ns + span, active: true };
        } else {
            inst.model.loop = { start: Math.min(d.t0, t), end: Math.max(d.t0, t), active: true };
        }
    });
    c.addEventListener('pointerup', e => {
        if (!inst.drag) return;
        // If a rotation/teardown left us without a usable canvas or model, don't run the commit math
        // (it derefs both) — just drop the in-flight gesture so a stale drag can't linger.
        if (!pointerReady(inst)) { inst.drag = null; inst.previewBoundary = null; return; }
        const d = inst.drag;

        if (d.kind === 'pan') {
            c.classList && c.classList.remove('panning');
            c.style.cursor = isZoomed(inst) ? 'grab' : 'text';
            if (d.moved) {
                // Settle: a final notify (bypasses the throttle). While playing, the host keeps
                // whole-track peaks so the waveform does not re-bucket under a mark target.
                if (inst.view) notifyView(inst, true, inst.model && inst.model.playing);
            } else if (inst.dotnet) {
                // Didn't move → a tap/click on the zoomed wave still seeks (pan never steals the seek).
                inst.localPos = d.t0;
                safeInvoke(inst.dotnet, 'OnSeekJs', d.t0);
            }
            inst.drag = null;
            return;
        }

        if (d.kind === 'scrub') {
            c.classList && c.classList.remove('panning');
            c.style.cursor = isZoomed(inst) ? 'grab' : 'text';
            if (d.moved) {
                if (inst.view) notifyView(inst, true, inst.model && inst.model.playing);
                notifyScrubSeek(inst, true);
            } else if (inst.dotnet) {
                inst.localPos = d.t0;
                safeInvoke(inst.dotnet, 'OnSeekJs', d.t0);
            }
            inst.drag = null;
            return;
        }

        const t = snapTime(inst, xToTime(inst, e.clientX));
        c.style.cursor = 'text';
        inst.previewBoundary = null;

        if (d.kind === 'boundary') {
            // Report original + new boundary time + whether Alt was held (Alt = insert a new section
            // in the freed gap instead of growing the neighbour). C# applies the rule. Ignore a no-op.
            if (d.moved && Math.abs(d.boundaryNow - d.boundary0) > (inst.model.duration || 1) * 0.002 && inst.dotnet) {
                safeInvoke(inst.dotnet, 'OnSectionBoundaryCommit', d.boundary0, d.boundaryNow, e.altKey === true);
            }
            inst.drag = null;
            return;
        }

        if (!d.moved) {
            if (d.edge) { /* click on/in loop: leave it, no seek */ }
            else if (inst.dotnet) { inst.localPos = t; safeInvoke(inst.dotnet, 'OnSeekJs', t); }
        } else if (inst.model.loop) {
            commitLoop(inst, inst.model.loop.start, inst.model.loop.end);
        }
        inst.drag = null;
    });
    c.addEventListener('pointerleave', () => {
        if (!inst.drag) inst.hoverLoopEdge = null;
    });
}
