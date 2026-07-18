/**
 * webauthn-interop.js — WebAuthn biometric unlock for the idle lock screen.
 *
 * Uses the Web Authentication API to register and authenticate with platform
 * biometrics (Windows Hello, Face ID, Touch ID, fingerprint).  Credential IDs
 * are stored in localStorage so the lock screen can re-trigger authentication
 * without a server round-trip.
 *
 * Public API on window.srWebAuthn:
 *   isAvailable()   — true if a platform authenticator exists
 *   register()      — create a credential (enrollment), returns credential ID or null
 *   authenticate()  — verify the user via biometric, returns true/false
 */
'use strict';

(function () {
    const CREDENTIAL_KEY = 'sr_webauthn_credential';

    function log(...args) { console.log('[sr-webauthn]', ...args); }
    function warn(...args) { console.warn('[sr-webauthn]', ...args); }

    // ── Helpers ────────────────────────────────────────────────────────

    /** Encode Uint8Array to base64url string. */
    function toBase64Url(buf) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    /** Decode base64url string to Uint8Array. */
    function fromBase64Url(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        const binary = atob(str);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // ── Public API ─────────────────────────────────────────────────────

    window.srWebAuthn = {
        /**
         * Check if a platform authenticator (Windows Hello / Face ID / fingerprint)
         * is available in this browser.
         * @returns {Promise<boolean>}
         */
        isAvailable: async function () {
            try {
                if (!window.PublicKeyCredential) return false;
                return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            } catch {
                return false;
            }
        },

        /**
         * Register a new platform credential (enrollment).
         * Triggers the biometric prompt (Windows Hello / Face ID).
         * Stores the credential ID in localStorage.
         * @returns {Promise<string|null>} credential ID (base64url) or null on cancel/failure
         */
        register: async function () {
            try {
                const userId = crypto.getRandomValues(new Uint8Array(16));
                const challenge = crypto.getRandomValues(new Uint8Array(32));

                const credential = await navigator.credentials.create({
                    publicKey: {
                        rp: { name: 'SuccessRate' },
                        user: {
                            id: userId,
                            name: 'successrate-user',
                            displayName: 'SuccessRate User'
                        },
                        challenge: challenge,
                        pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
                        authenticatorSelection: {
                            authenticatorAttachment: 'platform',
                            userVerification: 'required',
                            residentKey: 'discouraged'
                        },
                        timeout: 60000
                    }
                });

                if (!credential) {
                    warn('Registration returned null');
                    return null;
                }

                const credentialId = toBase64Url(credential.rawId);
                localStorage.setItem(CREDENTIAL_KEY, credentialId);
                log('Credential registered:', credentialId.substring(0, 16) + '...');
                return credentialId;
            } catch (e) {
                warn('Registration failed or canceled:', e.message);
                return null;
            }
        },

        /**
         * Returns a platform-specific label for the biometric authenticator.
         * Used to show "Unlock with Windows Hello" / "Unlock with Face ID" etc.
         * @returns {string}
         */
        getAuthenticatorLabel: function () {
            const ua = navigator.userAgent;
            // navigator.platform is deprecated but still universally supported;
            // userAgent is the primary signal and serves as fallback.
            const platform = navigator.platform || '';
            if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'Windows Hello';
            if (/iPhone|iPad|iPod/i.test(ua)) return 'Face ID';
            if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return 'Touch ID';
            if (/Android/i.test(ua)) return 'fingerprint';
            return 'biometrics';
        },

        /**
         * Authenticate using the stored credential (triggers biometric prompt).
         * @returns {Promise<boolean>} true if the user passed biometric verification
         */
        authenticate: async function () {
            try {
                const credentialId = localStorage.getItem(CREDENTIAL_KEY);
                if (!credentialId) {
                    warn('No stored credential — cannot authenticate');
                    return false;
                }

                const challenge = crypto.getRandomValues(new Uint8Array(32));

                const assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge: challenge,
                        allowCredentials: [{
                            id: fromBase64Url(credentialId),
                            type: 'public-key',
                            transports: ['internal']
                        }],
                        userVerification: 'required',
                        timeout: 60000
                    }
                });

                if (assertion) {
                    log('Biometric authentication succeeded');
                    return true;
                }
                return false;
            } catch (e) {
                warn('Authentication failed or canceled:', e.message);
                return false;
            }
        }
    };

    log('Module registered on window.srWebAuthn');
})();
