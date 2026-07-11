// Overview minimap for the Waveform component: a thin, always-visible full-song strip with a
// translucent viewport rectangle marking where the (zoomed) main view sits, plus a whole-song
// playhead tick. Click/drag the strip to move the main view. Blazor owns the state; this module
// only paints (no rAF loop — it repaints on model change) and reports nav gestures back to .NET.
//
// Sibling of waveform.js: same attach/update/dispose/resize + ResizeObserver shape, but far simpler
// (static peaks, no playhead extrapolation, no loop/section editing). Runs in the web app and every
// MAUI WebView.

const instances = new Map();
let nextId = 1;

function cssVar(el, name, fallback) {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
}

export function attach(canvas, dotnet) {
    // Null canvas (element not in the DOM yet) → no-op with -1 rather than crash on getContext; the
    // host retries on a later render. Mirrors waveform.js attach.
    if (!canvas) return -1;
    const id = nextId++;
    const inst = {
        canvas,
        ctx: canvas.getContext('2d'),
        dotnet,          // .NET ref with [JSInvokable] OnMinimapNav(centerSeconds, spanSeconds|null)
        dpr: 1,
        model: null,     // { peaks|null, duration, position, view:{start,end}|null }
        drag: null,      // { moved } while dragging the viewport
        ro: null,
    };
    instances.set(id, inst);
    addPointerHandlers(inst);

    if (typeof ResizeObserver !== 'undefined') {
        inst.ro = new ResizeObserver(() => resizeInstance(inst));
        inst.ro.observe(canvas);
    }

    resizeInstance(inst);
    return id;
}

export function dispose(id) {
    const inst = instances.get(id);
    if (inst && inst.ro) inst.ro.disconnect();
    instances.delete(id);
}

function resizeInstance(inst) {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = inst.canvas.clientWidth, h = inst.canvas.clientHeight;
    inst.canvas.width = Math.max(1, Math.round(w * dpr));
    inst.canvas.height = Math.max(1, Math.round(h * dpr));
    inst.dpr = dpr;
    if (inst.model) paint(inst);
    return { width: w, height: h };
}

export function resize(id) {
    const inst = instances.get(id);
    if (!inst) return { width: 0, height: 0 };
    return resizeInstance(inst);
}

// model: { peaks:{min,max,rms}|null, duration, position, view:{start,end}|null }
export function update(id, model) {
    const inst = instances.get(id);
    if (!inst) return;
    inst.model = { ...(inst.model || {}), ...model };
    paint(inst);
}

// The whole-track window this minimap represents. Duration guards a not-yet-loaded track.
function duration(inst) {
    return (inst.model && inst.model.duration) || 0;
}

// The viewport window (seconds) the MAIN view is showing. Null (whole track) → the whole strip.
function viewport(inst) {
    const m = inst.model, dur = duration(inst);
    if (!m || !m.view) return { start: 0, end: dur };
    return { start: m.view.start, end: m.view.end };
}

function paint(inst) {
    const { ctx, canvas, model: m } = inst;
    if (!m) return;
    const w = canvas.clientWidth, h = canvas.clientHeight, mid = h / 2;
    if (w <= 0 || h <= 0) return; // mid-layout the box can report 0 size; skip (avoids a garbage draw)
    const dur = duration(inst);
    ctx.setTransform(inst.dpr, 0, 0, inst.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (dur <= 0) return;

    const timeToX = t => (t / dur) * w;

    const cPlayed = cssVar(canvas, '--wave-played', '#e44c2a');
    const cOutline = cssVar(canvas, '--wave-unplayed', '#55636e');
    const cBody = cssVar(canvas, '--wave-body', 'rgba(120,138,150,0.5)');

    const playedX = timeToX(m.position || 0);

    if (!m.peaks) {
        // Element-fallback engine: no decoded buffer → flat baseline (same as waveform.js).
        ctx.strokeStyle = cOutline; ctx.globalAlpha = 0.4;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
        ctx.globalAlpha = 1;
    } else {
        // The overview peaks always span the WHOLE track, so map buckets straight across the strip.
        const { min, max, rms } = m.peaks;
        const n = min.length;
        const colW = w / n;
        for (let i = 0; i < n; i++) {
            const x = i * colW, cx = x + colW / 2, played = cx <= playedX;
            // Outline (min/max), dimmer than the main wave — the minimap is a reference, not the focus.
            const top = mid - max[i] * (mid - 1), bot = mid - min[i] * (mid - 1);
            ctx.fillStyle = played ? cPlayed : cOutline;
            ctx.globalAlpha = played ? 0.7 : 0.45;
            ctx.fillRect(x, top, Math.max(1, colW), Math.max(1, bot - top));
            // RMS body.
            const r = rms[i] * (mid - 1);
            ctx.fillStyle = played ? cPlayed : cBody;
            ctx.globalAlpha = played ? 0.85 : 0.6;
            ctx.fillRect(x, mid - r, Math.max(1, colW), Math.max(1, r * 2));
        }
        ctx.globalAlpha = 1;
    }

    // Section boundary ticks: faint vertical lines at each section START, so the strip doubles as a
    // map of where the parts fall. Skip the very-start tick (t≈0) — it just hugs the left edge. Drawn
    // under the playhead/viewport so those stay the focus.
    if (Array.isArray(m.sections) && m.sections.length) {
        ctx.fillStyle = cOutline;
        ctx.globalAlpha = 0.5;
        for (const t of m.sections) {
            if (t <= 0.01 || t >= dur) continue;
            ctx.fillRect(Math.round(timeToX(t)), 0, 1, h);
        }
        ctx.globalAlpha = 1;
    }

    // Whole-song playhead tick.
    ctx.fillStyle = cPlayed;
    ctx.fillRect(Math.round(playedX) - 1, 0, 2, h);

    // Viewport indicator: where the main view sits. Rather than a colored band (which could read as a
    // loop), DIM the parts of the song OUTSIDE the current view and frame the in-view window with a
    // crisp muted border. Shading-outside reads correctly in both light and dark themes and never
    // clashes with the loop's yellow. At full-track view the window spans the whole strip → nothing is
    // dimmed (x0≈0, x1≈w), which correctly signals "you're seeing everything".
    const vp = viewport(inst);
    const x0 = Math.round(timeToX(vp.start)), x1 = Math.round(timeToX(vp.end));
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    if (x0 > 0) ctx.fillRect(0, 0, x0, h);          // dim before the view
    if (x1 < w) ctx.fillRect(x1, 0, w - x1, h);     // dim after the view
    // Only draw the frame when actually zoomed (a full-track window needs no frame).
    if (x0 > 0 || x1 < w) {
        ctx.fillStyle = cssVar(canvas, '--muted', '#aab4bd');
        ctx.globalAlpha = 0.9;
        ctx.fillRect(x0, 0, 1, h);
        ctx.fillRect(x1 - 1, 0, 1, h);
        ctx.globalAlpha = 1;
    }
}

function xToTime(inst, clientX) {
    const dur = duration(inst);
    const rect = inst.canvas.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return frac * dur;
}

// The current viewport span (seconds); 0 at full-track view (nothing to move → the host seeks).
function viewportSpan(inst) {
    const m = inst.model, dur = duration(inst);
    if (!m || !m.view) return 0;
    const span = m.view.end - m.view.start;
    return span >= dur - 0.002 ? 0 : span; // ~whole track counts as "not zoomed"
}

// Send a nav: center time + the span to keep (null → full-track view, so the host seeks instead of
// zooming). The host clamps the window into range.
function navTo(inst, centerSeconds) {
    if (!inst.dotnet) return;
    const span = viewportSpan(inst);
    inst.dotnet.invokeMethodAsync('OnMinimapNav', centerSeconds, span > 0 ? span : null);
}

function addPointerHandlers(inst) {
    const c = inst.canvas;
    c.addEventListener('pointerdown', e => {
        c.setPointerCapture(e.pointerId);
        inst.drag = { moved: false };
        c.style.cursor = 'grabbing';
        navTo(inst, xToTime(inst, e.clientX)); // click/press centers the view (or seeks at full track)
    });
    c.addEventListener('pointermove', e => {
        if (!inst.drag) return;
        inst.drag.moved = true;
        navTo(inst, xToTime(inst, e.clientX)); // drag scrubs the view continuously
    });
    c.addEventListener('pointerup', e => {
        if (!inst.drag) return;
        inst.drag = null;
        c.style.cursor = 'pointer';
    });
}
