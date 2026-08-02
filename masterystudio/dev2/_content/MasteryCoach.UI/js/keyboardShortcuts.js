// Page-level keyboard shortcuts for the Practice Studio. A window-level keydown listener so the
// shortcut works no matter where focus sits — except while the user is typing in a form field or
// operating a focused control, where the key must keep its normal behavior.

let handler = null;

// True when the event target is somewhere a keystroke should be left alone: text entry, a select,
// or an editable region. Buttons/checkboxes are intentionally NOT excluded here — space on a
// focused button already activates it via the button's own handler, so we also skip those.
function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return true;
    if (el.isContentEditable) return true;
    return false;
}

// Register the space-to-toggle shortcut. `dotnet` is a .NET ref with a [JSInvokable] OnSpacebar.
// Returns nothing; call detach() on teardown to remove the listener.
export function attach(dotnet) {
    detach(); // never stack listeners across re-inits
    handler = (e) => {
        if (e.code !== 'Space' && e.key !== ' ') return;
        if (e.repeat) return;                 // ignore key-held autorepeat
        if (isTypingTarget(e.target)) return; // don't hijack space in inputs/selects/buttons
        e.preventDefault();                   // stop the page from scrolling
        dotnet.invokeMethodAsync('OnSpacebar');
    };
    window.addEventListener('keydown', handler);
}

export function detach() {
    if (handler) {
        window.removeEventListener('keydown', handler);
        handler = null;
    }
}
