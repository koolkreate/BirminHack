/* ============================================================
   InstaGuard — MAIN world detector script
   Only job: send session headers to content script on page load/navigation
   (sessionStorage is inaccessible in ISOLATED world)
   Shortcode is now extracted from URL in content.js directly.
   ============================================================ */

(function () {
    'use strict';

    function sendHeaders() {
        const wwwClaim = sessionStorage.getItem('www-claim-v2') || '';
        const csrfToken = document.cookie.split('; ')
            .find(r => r.startsWith('csrftoken='))?.split('=')[1] || '';
        window.postMessage({
            type: 'INSTAGUARD_HEADERS',
            wwwClaim,
            csrfToken
        }, '*');
    }

    // ── Override History API to catch SPA navigation ──────────
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    let lastPath = window.location.pathname;

    function onNavigate() {
        const newPath = window.location.pathname;
        if (newPath !== lastPath) {
            lastPath = newPath;
            setTimeout(sendHeaders, 300);
        }
    }

    history.pushState = function (...args) {
        originalPushState.apply(this, args);
        onNavigate();
    };
    history.replaceState = function (...args) {
        originalReplaceState.apply(this, args);
        onNavigate();
    };
    window.addEventListener('popstate', () => onNavigate());

    // ── Send headers on page load and on demand ───────────────
    sendHeaders();
    // Re-send periodically in case content script asks later
    setInterval(sendHeaders, 5000);

    // ── Listen for requests from content script ───────────────
    window.addEventListener('message', (e) => {
        if (e.source !== window) return;
        if (e.data?.type === 'INSTAGUARD_REQUEST_HEADERS') {
            sendHeaders();
        }
    });

    console.log('[InstaGuard] Detector (MAIN world) ready');
})();
