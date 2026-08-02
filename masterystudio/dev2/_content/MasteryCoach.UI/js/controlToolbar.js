// Horizontal scroll helpers for the ControlToolbar. The bar hides its native scrollbar and is driven
// by left/right chevrons instead; these functions scroll it and report which chevrons should show.

// Call a .NET instance method, swallowing the rejection when the DotNetObjectReference has already
// been disposed. The `dotnet` JS handle stays truthy after .NET disposal, so a document/window
// listener or a ResizeObserver/MutationObserver that fires between disposal and this module's
// dispose() would otherwise reject with "no tracked object with id N" — and those observers fire in
// BURSTS during a song switch (the toolbar reflows repeatedly), flooding the error funnel and the
// client_error analytics event (device log 2026-07-12). Catching the rejection makes a late callback
// a silent no-op, which is the correct behavior for a torn-down component.
function safeInvoke(dotnet, method) {
    try {
        const p = dotnet.invokeMethodAsync(method);
        if (p && p.catch) p.catch(() => { });
    } catch (e) { /* synchronous throw (already-disposed) — also a no-op */ }
}

// Scroll the row by ~80% of its visible width in the given direction (-1 left, +1 right), smoothly.
export function scrollBy(row, direction) {
    if (!row) return;
    const amount = Math.max(120, Math.floor(row.clientWidth * 0.8)) * Math.sign(direction);
    row.scrollBy({ left: amount, behavior: 'smooth' });
}

// Whether the row overflows to the left / right of its current scroll position, so the host can show
// or hide each chevron. A 1px slack absorbs sub-pixel rounding so a fully-scrolled bar reads as "end".
export function overflowState(row) {
    if (!row) return { left: false, right: false };
    const maxScroll = row.scrollWidth - row.clientWidth;
    return {
        left: row.scrollLeft > 1,
        right: row.scrollLeft < maxScroll - 1,
    };
}

// Anchor a fixed-position popover above its icon button and keep it on-screen. The toolbar row is a
// horizontal scroll container, so an in-flow (absolute) popover floated above it would be CLIPPED by
// the row's overflow; a position:fixed popover escapes that clip, but then we must place it ourselves.
//
// We place it centered over the button, above it (flipping below only if there's no room above), and
// clamped horizontally into the viewport. Because a fixed popover can't follow the button as the row
// scrolls, we CLOSE it on any scroll / resize / outside-pointer instead (calling back into .NET). That
// keeps the behaviour honest — the panel is never left pointing at the wrong place. Returns a handle
// with dispose(); the caller disposes it when the popover closes or the component tears down.
export function anchorPopover(button, popover, dotnet) {
    if (!button || !popover) return null;

    const place = () => {
        // Reset any prior flip so measurements are of the natural (above) layout.
        const btn = button.getBoundingClientRect();
        const pop = popover.getBoundingClientRect();
        const gap = 6; // matches the CSS pointer/offset
        const margin = 8; // keep this far from the viewport edges

        // Clamp against the VISUAL viewport, not window.innerWidth/innerHeight (the LAYOUT viewport). On
        // iOS the two differ: focusing the "Enter on" <select> auto-zooms and shifts the visual viewport,
        // and pinch-zoom narrows it — so a layout-viewport clamp put a right-edge popover off the visible
        // area (count-in dialog off-screen, user report). getBoundingClientRect (used for btn/pop above)
        // and a position:fixed panel are BOTH in layout-viewport coordinates, so the visible region is
        // [vv.offsetLeft, vv.offsetLeft + vv.width) — clamp into that. Falls back to the layout viewport
        // where visualViewport is unavailable.
        const vv = window.visualViewport;
        const viewLeft = vv ? vv.offsetLeft : 0;
        const viewTop = vv ? vv.offsetTop : 0;
        const viewWidth = vv ? vv.width : window.innerWidth;
        const viewHeight = vv ? vv.height : window.innerHeight;
        const minLeft = viewLeft + margin;
        const maxLeft = viewLeft + viewWidth - pop.width - margin;

        // Horizontal: center on the button, then clamp so the panel stays fully in the VISIBLE region.
        // (maxLeft can fall below minLeft if the popover is wider than the visible width — pin to minLeft
        // then, so its left edge stays on-screen rather than centering it off both edges.)
        let left = btn.left + btn.width / 2 - pop.width / 2;
        left = Math.max(minLeft, Math.min(left, Math.max(minLeft, maxLeft)));

        // Vertical: prefer above the button; flip below if it wouldn't fit above (in the visible region).
        const above = btn.top - gap - pop.height;
        const below = btn.bottom + gap;
        const flip = above < viewTop + margin && below + pop.height <= viewTop + viewHeight - margin;
        const top = flip ? below : above;

        popover.style.left = `${Math.round(left)}px`;
        popover.style.top = `${Math.round(top)}px`;
        // Point the CSS pointer the right way (up when flipped below, down when above).
        popover.classList.toggle('flipped', flip);
    };

    place();
    // Re-place once after layout settles (fonts/reflow can change the measured size on first paint).
    requestAnimationFrame(place);

    // iOS auto-zooms when the inner <select>/inputs get focus, which moves/narrows the VISUAL viewport
    // AFTER we first placed. That fires visualViewport resize/scroll (not necessarily window resize), so
    // re-place — do NOT close — to keep the panel on-screen through the zoom. Distinct from the window
    // scroll/resize handlers below, which DO close (a page/toolbar scroll strands a fixed panel).
    const vvRef = window.visualViewport;
    const onViewportChange = () => place();
    if (vvRef) {
        vvRef.addEventListener('resize', onViewportChange);
        vvRef.addEventListener('scroll', onViewportChange);
    }

    // Ignore any close trigger for a brief moment after opening: the very gesture that opened the
    // popover (and the layout settle / iOS scroll it can cause) must not immediately dismiss it.
    let armed = false;
    const armTimer = setTimeout(() => { armed = true; }, 250);

    const close = () => { if (armed && dotnet) safeInvoke(dotnet, 'CloseFromJs'); };
    // "Inside" is tested by ANCESTRY CLASS, not the captured `popover`/`button` node refs: when the
    // popover body re-renders (e.g. dragging the tempo/pitch slider fires @bind:after → StateHasChanged,
    // which patches the popover subtree), the captured node can go stale so popover.contains(target)
    // wrongly returns false and the next tap closed the dialog — the user couldn't set tempo/pitch at
    // all (bug 2026-07-11). closest() against the live classes is immune to that.
    const inside = (target) =>
        !!(target && target.closest && (target.closest('.toolbar-icon-popover') || target.closest('.toolbar-iconbtn')));
    // A pointerdown outside both the button and the popover dismisses it.
    const onPointerDown = (e) => { if (!inside(e.target)) close(); };
    // A scroll of the TOOLBAR or PAGE would strand the fixed panel, so close then. But a scroll that
    // originates INSIDE the popover (e.g. flicking its own content, or the momentary scroll iOS fires
    // when a <select>/list inside it is used) must NOT dismiss it — that made the count-in dialog close
    // the instant you tapped into it (user bug report, 2026-07-10). Guard on the scroll's target.
    const onScroll = (e) => { if (!inside(e.target)) close(); };
    const onResize = () => close();

    // Capture-phase so we see the pointerdown before Blazor's own handlers swallow it.
    document.addEventListener('pointerdown', onPointerDown, true);
    // Listen for scrolls anywhere in the capture phase (the toolbar row scroll doesn't bubble to window).
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return {
        dispose: () => {
            clearTimeout(armTimer);
            document.removeEventListener('pointerdown', onPointerDown, true);
            window.removeEventListener('scroll', onScroll, true);
            window.removeEventListener('resize', onResize);
            if (vvRef) {
                vvRef.removeEventListener('resize', onViewportChange);
                vvRef.removeEventListener('scroll', onViewportChange);
            }
        },
    };
}

// Subscribe the .NET component to scroll/resize so it can re-evaluate the chevrons. Returns a handle
// with dispose() to detach the listeners. The observer also fires when pills expand/collapse (the row's
// scrollWidth changes) so the chevrons stay correct without the host polling.
export function observe(row, dotnet) {
    if (!row || !dotnet) return null;
    const notify = () => safeInvoke(dotnet, 'OnOverflowChanged');
    row.addEventListener('scroll', notify, { passive: true });
    // A ResizeObserver on the row catches its own size changes AND, because it observes the border box,
    // fires when a pill expands/collapses and reflows the row's content width.
    const ro = new ResizeObserver(notify);
    ro.observe(row);
    // Pills added/removed change scrollWidth without necessarily resizing the row; watch child lists.
    // (Deliberately NOT watching attributes — pill/toggle clicks rewrite class/aria on every render,
    // which would fire a JS→.NET round-trip per click for changes that never affect overflow.)
    const mo = new MutationObserver(notify);
    mo.observe(row, { childList: true, subtree: true });
    notify();
    return {
        dispose: () => {
            row.removeEventListener('scroll', notify);
            ro.disconnect();
            mo.disconnect();
        },
    };
}
