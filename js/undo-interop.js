// undo-interop.js
// Registers a document-level keydown listener for Ctrl+Z (undo) and Ctrl+Y /
// Ctrl+Shift+Z / Cmd+Z / Cmd+Shift+Z (redo), then calls into the Blazor
// UndoKeyboardHandler component via DotNetObjectReference.
//
// Guard: when focus is inside an <input> or <textarea>, we let the browser
// handle Ctrl+Z natively (undo last character typed) and do NOT fire the app-level undo.

export function registerUndoShortcuts(dotnetRef) {
    function handler(e) {
        // Don't intercept when user is typing in a field.
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        const ctrl = e.ctrlKey || e.metaKey;
        if (!ctrl) return;

        const isUndo = !e.shiftKey && e.key === 'z';
        const isRedo = e.key === 'y' || (e.shiftKey && e.key === 'z') || (e.shiftKey && e.key === 'Z');

        if (isUndo) {
            e.preventDefault();
            dotnetRef.invokeMethodAsync('HandleUndo');
        } else if (isRedo) {
            e.preventDefault();
            dotnetRef.invokeMethodAsync('HandleRedo');
        }
    }

    document.addEventListener('keydown', handler);

    // Return a disposer object so Blazor can clean up on component disposal.
    return { dispose: () => document.removeEventListener('keydown', handler) };
}
