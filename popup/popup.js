/* ============================================================
   InstaGuard — Popup Script
   Settings management for the extension popup
   ============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('api-key-input');
    const toggleEnabled = document.getElementById('toggle-enabled');
    const saveBtn = document.getElementById('save-btn');
    const revealBtn = document.getElementById('reveal-btn');
    const statusBar = document.getElementById('status-bar');

    // ── Load existing settings ──────────────────────────────
    try {
        const settings = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (settings) {
            apiKeyInput.value = settings.apiKey || '';
            toggleEnabled.checked = settings.enabled !== false;
            updateStatus(settings);
        }
    } catch (err) {
        console.error('Failed to load settings:', err);
    }

    // ── Save settings ───────────────────────────────────────
    saveBtn.addEventListener('click', async () => {
        const settings = {
            apiKey: apiKeyInput.value.trim(),
            enabled: toggleEnabled.checked
        };

        try {
            await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
            saveBtn.textContent = '✓ Saved!';
            saveBtn.classList.add('saved');
            updateStatus(settings);

            setTimeout(() => {
                saveBtn.textContent = 'Save Settings';
                saveBtn.classList.remove('saved');
            }, 2000);
        } catch (err) {
            console.error('Failed to save settings:', err);
            saveBtn.textContent = '✗ Error';
            setTimeout(() => {
                saveBtn.textContent = 'Save Settings';
            }, 2000);
        }
    });

    // ── Toggle key visibility ───────────────────────────────
    revealBtn.addEventListener('click', () => {
        const isPassword = apiKeyInput.type === 'password';
        apiKeyInput.type = isPassword ? 'text' : 'password';
        revealBtn.textContent = isPassword ? '🙈' : '👁';
    });

    // ── Toggle enabled state ────────────────────────────────
    toggleEnabled.addEventListener('change', async () => {
        const settings = {
            apiKey: apiKeyInput.value.trim(),
            enabled: toggleEnabled.checked
        };
        try {
            await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
            updateStatus(settings);
        } catch (err) {
            console.error('Failed to save toggle state:', err);
        }
    });

    // ── Update status bar ───────────────────────────────────
    function updateStatus(settings) {
        const statusDot = statusBar.querySelector('.popup-status-dot');
        const statusText = statusBar.querySelector('.popup-status-text');

        statusBar.className = 'popup-status';

        if (!settings.enabled) {
            statusBar.classList.add('inactive');
            statusText.textContent = 'Extension disabled';
        } else if (!settings.apiKey) {
            statusBar.classList.add('error');
            statusText.textContent = 'No API key set — enter key below';
        } else {
            statusBar.classList.add('active');
            statusText.textContent = 'Active — ready to scan posts';
        }
    }
});
