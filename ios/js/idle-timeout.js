/**
 * idle-timeout.js — Idle timeout for session lock screen.
 *
 * Listens for user interaction events (mouse, keyboard, touch, scroll)
 * and fires a callback to Blazor when the user has been idle for the
 * configured duration.  Used by WebMainLayout to show the lock overlay.
 */
'use strict';

(function () {
    let _timer = null;
    let _dotnetRef = null;
    let _timeoutMs = 20 * 60 * 1000;

    const EVENTS = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];

    /**
     * Immediately hide all app content via a CSS attribute flag.
     * This runs synchronously before the async Blazor re-render so there is
     * no window where financial data is visible or interactive while locked.
     */
    function applyImmediateLock() {
        document.documentElement.setAttribute('data-sr-locked', '');
    }

    /** Remove the immediate-lock CSS flag (called after Blazor confirms unlock). */
    function removeImmediateLock() {
        document.documentElement.removeAttribute('data-sr-locked');
    }

    function resetTimer() {
        if (_timer) clearTimeout(_timer);
        if (!_dotnetRef) return;
        _timer = setTimeout(() => {
            if (_dotnetRef) {
                applyImmediateLock();
                _dotnetRef.invokeMethodAsync('OnIdleTimeout');
            }
        }, _timeoutMs);
    }

    window.srIdleTimeout = {
        /** Start the idle timer. Called once from WebMainLayout after first render. */
        start: function (dotnetRef, timeoutMinutes) {
            _dotnetRef = dotnetRef;
            _timeoutMs = timeoutMinutes * 60 * 1000;
            EVENTS.forEach(e => document.addEventListener(e, resetTimer, { passive: true }));
            resetTimer();
        },
        /** Restart the timer (called after successful unlock). */
        reset: function () {
            removeImmediateLock();
            resetTimer();
        },
        /** Tear down listeners and timer (called on dispose). */
        stop: function () {
            if (_timer) clearTimeout(_timer);
            _timer = null;
            EVENTS.forEach(e => document.removeEventListener(e, resetTimer));
            _dotnetRef = null;
        }
    };
})();
