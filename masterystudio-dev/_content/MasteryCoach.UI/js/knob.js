// Drag helper for the Knob component (rotary volume/pan control). Vertical drag adjusts the value:
// dragging UP increases, DOWN decreases, scaled so a full knob travel is ~150px. Uses pointer capture
// so the drag keeps tracking even when the finger/cursor leaves the small knob. Reports deltas (in
// value units, already scaled) back to .NET; .NET owns clamping and the actual value. A wheel step and
// keyboard are handled in Blazor directly — this module is only the drag.

const instances = new Map();
let nextId = 1;

// Call a .NET instance method, swallowing the rejection when the DotNetObjectReference is already
// disposed — a pointer callback landing after teardown would otherwise reject with "no tracked
// object with id N" and flood the error funnel / client_error analytics (device log 2026-07-12).
function safeInvoke(dotnet, method, ...args) {
    if (!dotnet) return;
    try {
        const p = dotnet.invokeMethodAsync(method, ...args);
        if (p && p.catch) p.catch(() => { });
    } catch (e) { /* already-disposed sync throw — no-op */ }
}

// pixelsPerUnit: how many pixels of vertical drag == one value unit (so range/travel feels right).
export function attach(el, dotnet, pixelsPerUnit) {
    if (!el || !dotnet) return -1;
    const id = nextId++;
    const inst = { el, dotnet, ppu: pixelsPerUnit > 0 ? pixelsPerUnit : 1, dragging: false, lastY: 0, acc: 0 };
    instances.set(id, inst);

    const onDown = (e) => {
        // Primary button / touch only; ignore right-click.
        if (e.button != null && e.button !== 0) return;
        inst.dragging = true;
        inst.lastY = e.clientY;
        inst.acc = 0;
        try { el.setPointerCapture(e.pointerId); } catch { /* not all elements/pointers support it */ }
        el.classList.add('dragging');
        e.preventDefault();
    };
    const onMove = (e) => {
        if (!inst.dragging) return;
        // Up is negative clientY delta → positive value change.
        inst.acc += (inst.lastY - e.clientY) / inst.ppu;
        inst.lastY = e.clientY;
        // Emit whole units as they accumulate, so .NET's stepped value stays in sync without spamming.
        const whole = Math.trunc(inst.acc);
        if (whole !== 0) {
            inst.acc -= whole;
            safeInvoke(inst.dotnet, 'OnDragDelta', whole);
        }
        e.preventDefault();
    };
    const onUp = (e) => {
        if (!inst.dragging) return;
        inst.dragging = false;
        inst.acc = 0;
        try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        el.classList.remove('dragging');
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    inst.handlers = { onDown, onMove, onUp };
    return id;
}

export function dispose(id) {
    const inst = instances.get(id);
    if (!inst) return;
    const { el, handlers } = inst;
    if (handlers) {
        el.removeEventListener('pointerdown', handlers.onDown);
        el.removeEventListener('pointermove', handlers.onMove);
        el.removeEventListener('pointerup', handlers.onUp);
        el.removeEventListener('pointercancel', handlers.onUp);
    }
    instances.delete(id);
}
