// Modal helper: focus the first focusable field inside the dialog panel when it opens, so the user can
// type immediately (e.g. the name field). Falls back to focusing the panel itself.
export function focusFirst(panel) {
    if (!panel) return;
    const focusable = panel.querySelector(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    (focusable || panel).focus();
}
