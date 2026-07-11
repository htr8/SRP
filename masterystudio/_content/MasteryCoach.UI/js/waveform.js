// Canvas renderer + interaction for the Waveform component. Blazor owns the authoritative state
// (peaks, sections, loop, position); this module paints at 60fps, extrapolates the playhead between
// the ~4/sec authoritative updates so it moves smoothly without per-frame interop, and reports
// pointer gestures (seek, loop drag) back to .NET. Runs in the web app and every MAUI WebView.
//
// Detailed look: a min/max sample OUTLINE with a filled RMS (loudness) BODY inside it, mirrored
// about the centre line — DAW-style.

const instances = new Map();
let nextId = 1;

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

// Set the live window (JS-authoritative during motion), preserving span within [0, duration], then
// notify Blazor on a throttled cadence. `settle` forces an immediate notify (pan release / page land).
function setLocalView(inst, start, end, settle) {
    const dur = (inst.model && inst.model.duration) || 0;
    const span = Math.min(end - start, dur);
    start = Math.max(0, Math.min(start, dur - span));
    inst.view = { start, end: start + span };
    notifyView(inst, settle);
}

// Report the live window to Blazor. Throttled to ~10/sec during continuous motion (pan), with a
// trailing-edge call so the final window always lands. `settle` bypasses the throttle. `follow` marks
// a page-follow step — the host uses it to keep whole-track peaks (no detail re-pull while playing).
function notifyView(inst, settle, follow) {
    if (!inst.dotnet || !inst.view) return;
    if (inst.trailingNotify) { clearTimeout(inst.trailingNotify); inst.trailingNotify = 0; }
    const fire = () => {
        inst.lastViewNotify = performance.now();
        inst.dotnet.invokeMethodAsync('OnViewChanged', inst.view.start, inst.view.end, follow === true);
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
    if (!isZoomed(inst) || (inst.drag && inst.drag.kind === 'pan')) return; // don't fight a live pan
    const m = inst.model, v = inst.view, span = v.end - v.start;
    const dur = (m && m.duration) || 0;

    // Center-lock mode: while PLAYING, keep the playhead pinned at the horizontal centre and scroll the
    // window under it every frame — the classic DAW feel. Clamped to [0, duration], so near the very
    // start/end the playhead drifts off-centre rather than showing empty space beyond the track. Paused,
    // it falls through to the page-turn re-centre below (so an off-view seek still brings the view back).
    if (m.centerLock && m.playing) {
        let ns = inst.localPos - span / 2;
        ns = Math.max(0, Math.min(ns, dur - span));
        if (Math.abs(ns - v.start) < VIEW_EPS) return; // sub-epsilon move (e.g. parked at an edge) — skip
        inst.view = { start: ns, end: ns + span };
        notifyView(inst, false, true);                 // follow=true → host keeps whole-track peaks (no re-pull)
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

    // loop band (drawn under the wave)
    if (m.loop && m.loop.end != null) {
        const x0 = timeToX(m.loop.start), x1 = timeToX(m.loop.end);
        ctx.fillStyle = cssVar(canvas, '--loop-band', 'rgba(240,195,90,0.16)');
        ctx.fillRect(x0, 0, x1 - x0, h);
        ctx.fillStyle = cssVar(canvas, '--loop-edge', '#f0c35a');
        ctx.fillRect(x0 - 1, 0, 2, h);
        ctx.fillRect(x1 - 1, 0, 2, h);
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
        const colW = w / cols;
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < cols; i++) {
                const b = Math.min(n - 1, b0 + i), x = i * colW, cx = x + colW / 2, played = cx <= playedX;
                if (pass === 0) {
                    const top = mid - max[b] * (mid - 1), bot = mid - min[b] * (mid - 1);
                    ctx.fillStyle = played ? cPlayed : cOutline;
                    ctx.globalAlpha = played ? 0.9 : 0.7;
                    ctx.fillRect(x, top, Math.max(1, colW * 0.9), Math.max(1, bot - top));
                } else {
                    const r = rms[b] * (mid - 1);
                    ctx.fillStyle = played ? cPlayed : cBody;
                    ctx.globalAlpha = played ? 1 : 0.9;
                    ctx.fillRect(x, mid - r, Math.max(1, colW * 0.9), Math.max(1, r * 2));
                }
            }
        }
        ctx.globalAlpha = 1;
    }

    // playhead
    ctx.fillStyle = cPlayed;
    ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);

    // Edit mode: draw a draggable grab-line at each interior section boundary, plus a live preview
    // line while one is being dragged. The lane above shows section names/colours; this is the handle.
    if (m.editSections && m.boundaries) {
        const dur = m.duration || 0;
        const edge = cssVar(canvas, '--accent-2', '#f0c35a');
        for (const bt of m.boundaries) {
            if (bt <= 0 || bt >= dur) continue;
            const bx = Math.round(timeToX(bt));
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

const EDGE_PX = 6;

function hitLoopEdge(inst, clientX) {
    const m = inst.model;
    if (!m || !m.loop || m.loop.end == null) return null;
    const x = clientX - inst.canvas.getBoundingClientRect().left;
    if (Math.abs(x - timeToXpx(inst, m.loop.start)) <= EDGE_PX) return 'start';
    if (Math.abs(x - timeToXpx(inst, m.loop.end)) <= EDGE_PX) return 'end';
    const inside = x > timeToXpx(inst, m.loop.start) && x < timeToXpx(inst, m.loop.end);
    return inside ? 'move' : null;
}

function commitLoop(inst, start, end) {
    if (end - start < (inst.model.duration || 1) * 0.005) return; // ignore hairline loops
    if (inst.dotnet) inst.dotnet.invokeMethodAsync('OnLoopCommit', start, end);
}

// In edit mode, the nearest INTERIOR section boundary (a time shared by two adjacent sections) to the
// pointer, if within EDGE_PX. The track-start/end aren't draggable. Returns the boundary time or null.
function hitSectionBoundary(inst, clientX) {
    const m = inst.model;
    // The model can be null before the first update() (or momentarily during a resize/reflow, e.g. a
    // device rotation firing pointermove mid-relayout) — bail rather than throw on m.editSections.
    if (!m || !m.editSections || !m.boundaries || m.boundaries.length === 0) return null;
    const x = clientX - inst.canvas.getBoundingClientRect().left;
    const dur = m.duration || 0;
    let best = null, bestDist = EDGE_PX;
    for (const bt of m.boundaries) {
        if (bt <= 0 || bt >= dur) continue; // skip the outer track edges — only interior boundaries move
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
        const edge = hitLoopEdge(inst, e.clientX);
        // Pan (grab-and-slide the window) sits ABOVE loop-create/seek but BELOW boundary/loop-edge drags,
        // and only exists WHEN ZOOMED. Then a plain drag (mouse or touch) pans; a tap/click still seeks;
        // an existing loop's edges are still draggable (edge != null resizes it). At full-track view this
        // never triggers, so loop-create-by-drag and every other gesture are unchanged.
        if (edge == null && isZoomed(inst)) {
            inst.drag = { kind: 'pan', panStartX: e.clientX, t0: t, view0: { ...inst.view }, moved: false };
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
            if (hitSectionBoundary(inst, e.clientX) != null) { c.style.cursor = 'ew-resize'; return; }
            const edge = hitLoopEdge(inst, e.clientX);
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
            setLocalView(inst, d.view0.start - dtSec, d.view0.end - dtSec);
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
                // Settle: a final notify (bypasses the throttle) so the host re-pulls detail for the
                // landed window.
                if (inst.view) notifyView(inst, true);
            } else if (inst.dotnet) {
                // Didn't move → a tap/click on the zoomed wave still seeks (pan never steals the seek).
                inst.localPos = d.t0;
                inst.dotnet.invokeMethodAsync('OnSeekJs', d.t0);
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
                inst.dotnet.invokeMethodAsync('OnSectionBoundaryCommit', d.boundary0, d.boundaryNow, e.altKey === true);
            }
            inst.drag = null;
            return;
        }

        if (!d.moved) {
            if (d.edge) { /* click on/in loop: leave it, no seek */ }
            else if (inst.dotnet) { inst.localPos = t; inst.dotnet.invokeMethodAsync('OnSeekJs', t); }
        } else if (inst.model.loop) {
            commitLoop(inst, inst.model.loop.start, inst.model.loop.end);
        }
        inst.drag = null;
    });
}
