/* ============================================================
   InstaGuard — Content Script
   Supports Instagram and YouTube scan / trust-score injection
   ============================================================ */

(function () {
    'use strict';

    const PLATFORM = getPlatform();
    const IG_BASE_URL = 'https://www.instagram.com';
    const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const IG_POST_REGEX = /^\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/;
    const IG_PROFILE_REGEX = /^\/([A-Za-z0-9_.]+)\/?$/;
    const YT_CHANNEL_REGEX = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/(featured|videos|shorts|streams|playlists|community|channels|about))?\/?$/;

    let sessionHeaders = { wwwClaim: '', csrfToken: '' };
    const analysisInProgress = new Set();
    const analysisResults = new Map();
    let injectionObserver = null;
    let lastHref = window.location.href;
    let instagramReelPollInterval = null;
    let youtubePollInterval = null;

    if (PLATFORM === 'instagram') {
        window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
        window.addEventListener('message', (event) => {
            if (event.source !== window) return;
            if (event.data?.type === 'INSTAGUARD_HEADERS') {
                sessionHeaders = {
                    wwwClaim: event.data.wwwClaim || '',
                    csrfToken: event.data.csrfToken || ''
                };
            }
        });
    }

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'FETCH_POST_DATA') {
            fetchMediaData(msg.shortcode, 'instagram')
                .then(data => sendResponse(data || { error: 'Not found' }))
                .catch(err => sendResponse({ error: err.message }));
            return true;
        }

        if (msg.type === 'FETCH_MEDIA_DATA') {
            fetchMediaData(msg.shortcode, msg.platform || PLATFORM)
                .then(data => sendResponse(data || { error: 'Not found' }))
                .catch(err => sendResponse({ error: err.message }));
            return true;
        }
    });

    const navObserver = new MutationObserver(() => {
        const currentHref = window.location.href;
        if (currentHref === lastHref) return;

        lastHref = currentHref;
        if (PLATFORM === 'instagram') {
            window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
            setTimeout(tryInjectInstagramButton, 600);
            setTimeout(tryInjectInstagramProfileButton, 800);
            manageInstagramReelPolling();
        } else if (PLATFORM === 'youtube') {
            cleanupStaleYouTubeUI();
            setTimeout(tryInjectYouTubeButton, 600);
            setTimeout(tryInjectYouTubeChannelButton, 900);
            manageYouTubePolling();
        }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });

    if (PLATFORM === 'instagram') {
        manageInstagramReelPolling();
        setTimeout(tryInjectInstagramButton, 1500);
        setTimeout(tryInjectInstagramProfileButton, 1800);
    } else if (PLATFORM === 'youtube') {
        manageYouTubePolling();
        setTimeout(tryInjectYouTubeButton, 1500);
        setTimeout(tryInjectYouTubeChannelButton, 1800);
    }

    function getPlatform() {
        const host = window.location.hostname;
        if (host.includes('instagram.com')) return 'instagram';
        if (host.includes('youtube.com')) return 'youtube';
        return 'unknown';
    }

    function buildAnalysisKey(platform, mediaId) {
        return `${platform}:${mediaId}`;
    }

    function createScanButton({ mediaId, platform, label = 'Scan' }) {
        const btn = document.createElement('button');
        btn.className = 'instaguard-scan-btn';
        btn.dataset.mediaId = mediaId;
        btn.dataset.platform = platform;
        btn.setAttribute('aria-label', `Scan with InstaGuard on ${platform}`);
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>${label}</span>
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            startAnalysis(mediaId, btn, platform);
        });
        return btn;
    }

    function createProfileButton(username, platform) {
        const btn = document.createElement('button');
        btn.id = `instaguard-profile-btn-${platform}`;
        btn.className = 'instaguard-scan-btn';
        btn.style.width = '100%';
        btn.style.justifyContent = 'center';
        btn.style.padding = '8px 16px';
        btn.dataset.username = username;
        btn.dataset.platform = platform;
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>Calculate Trust Score</span>
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startProfileAnalysis(username, btn, platform);
        });
        return btn;
    }

    function createProfileContainer(platform) {
        const wrapper = document.createElement('div');
        wrapper.className = 'instaguard-profile-trust-wrapper';
        wrapper.dataset.platform = platform;
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.marginTop = platform === 'instagram' ? '15px' : '12px';
        wrapper.style.marginBottom = platform === 'instagram' ? '15px' : '12px';
        return wrapper;
    }

    async function fetchMediaData(mediaId, platform) {
        if (platform === 'youtube') return fetchYouTubeVideoData(mediaId);
        return fetchInstagramPostData(mediaId);
    }

    async function startAnalysis(mediaId, btn, platform) {
        const key = buildAnalysisKey(platform, mediaId);
        if (analysisInProgress.has(key)) return;

        if (analysisResults.has(key)) {
            showResult(btn, analysisResults.get(key));
            return;
        }

        analysisInProgress.add(key);
        btn.classList.add('loading');
        btn.innerHTML = `<div class="instaguard-spinner"></div><span>Scanning…</span>`;
        btn.disabled = true;

        try {
            if (platform === 'instagram') {
                window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
                await new Promise(r => setTimeout(r, 300));
            }

            const data = await fetchMediaData(mediaId, platform);
            if (!data?.mediaUrl) {
                showError(btn, 'Could not fetch media');
                return;
            }

            const thumbnailsBase64 = platform === 'youtube'
                ? (await extractYouTubeFrames(mediaId)) || await extractThumbnails(data.mediaUrl, false)
                : await extractThumbnails(data.mediaUrl, data.isVideo);

            const result = await chrome.runtime.sendMessage({
                type: 'ANALYZE_MEDIA',
                shortcode: mediaId,
                mediaUrl: data.mediaUrl,
                mediaType: data.isVideo ? 'video' : 'image',
                hasOriginalAudio: !!data.hasOriginalAudio,
                caption: data.caption,
                thumbnailsBase64,
                platform,
                account: data.account || null
            });

            if (result.error) {
                showError(btn, result.message || result.error);
                return;
            }

            analysisResults.set(key, result.analysis);
            showResult(btn, result.analysis);
        } catch (err) {
            console.error('[InstaGuard]', err);
            showError(btn, 'Analysis failed');
        } finally {
            analysisInProgress.delete(key);
            btn.disabled = false;
        }
    }

    async function startProfileAnalysis(username, btn, platform) {
        const profileKey = `profile_${platform}_${username}`;
        const profileAccount = platform === 'youtube'
            ? (getCurrentYouTubeAccount() || {
                id: username,
                username,
                displayName: username
            })
            : {
                id: username,
                username,
                displayName: username
            };
        if (analysisInProgress.has(profileKey)) return;

        btn.classList.add('loading');
        btn.innerHTML = `<div class="instaguard-spinner"></div><span>Analyzing Top Videos…</span>`;
        btn.disabled = true;
        analysisInProgress.add(profileKey);

        try {
            await new Promise(r => setTimeout(r, 1000));

            const mediaIds = platform === 'youtube'
                ? getYouTubeChannelVideoIds().slice(0, 3)
                : getInstagramProfileShortcodes().slice(0, 3);

            if (mediaIds.length === 0) {
                btn.innerHTML = `<span>No posts found.</span>`;
                btn.classList.remove('loading');
                btn.classList.add('error');
                return;
            }

            const result = await chrome.runtime.sendMessage({
                type: 'ANALYZE_PROFILE',
                username,
                shortcodes: mediaIds,
                platform,
                account: profileAccount
            });

            if (result.success) {
                showProfileResult(btn, result.analysis, username);
            } else {
                btn.innerHTML = `<span>${result.message || 'Analysis failed'}</span>`;
                btn.classList.remove('loading');
                btn.classList.add('error');
            }
        } catch (err) {
            console.error('[InstaGuard]', err);
            btn.innerHTML = `<span>Error occurred</span>`;
            btn.classList.remove('loading');
            btn.classList.add('error');
        } finally {
            analysisInProgress.delete(profileKey);
            btn.disabled = false;
        }
    }

    function showResult(btn, analysis) {
        const aiScore = analysis.aiGenerated?.score ?? 0;
        const misScore = analysis.misinformation?.score ?? 0;

        const isAiSus = aiScore >= 50;
        const isMisSus = misScore >= 50;

        let cls;
        let icon;
        let label;

        if (isAiSus && isMisSus) {
            cls = 'danger';
            icon = '🚨';
            label = 'AI + Misinfo';
        } else if (isAiSus) {
            cls = 'warning';
            icon = '⚠️';
            label = `AI Generated (${aiScore}%)`;
        } else if (isMisSus) {
            cls = 'warning';
            icon = '⚠️';
            label = `Misinformation (${misScore}%)`;
        } else {
            cls = 'safe';
            icon = '✅';
            label = 'Likely Authentic';
        }

        const badge = document.createElement('div');
        badge.className = `instaguard-badge instaguard-${cls}`;
        badge.dataset.mediaId = btn.dataset.mediaId;
        badge.dataset.platform = btn.dataset.platform;

        if (btn.classList.contains('instaguard-overlay-pos')) {
            badge.classList.add('instaguard-overlay-pos');
        }

        badge.innerHTML = `
            <div class="instaguard-badge-header">
                <span>${icon}</span>
                <span class="instaguard-badge-label">${label}</span>
                <span class="instaguard-badge-toggle">▼</span>
            </div>
            <div class="instaguard-badge-body" hidden>
                <div class="instaguard-row">
                    <span>AI Generated</span>
                    <div class="instaguard-bar"><div class="instaguard-bar-fill" style="width:${aiScore}%;background:${col(aiScore)}"></div></div>
                    <span>${aiScore}%</span>
                </div>
                <div class="instaguard-row" style="margin-bottom:8px">
                    <span>Misinformation</span>
                    <div class="instaguard-bar"><div class="instaguard-bar-fill" style="width:${misScore}%;background:${col(misScore)}"></div></div>
                    <span>${misScore}%</span>
                </div>
                ${(analysis.aiGenerated?.reasons || []).slice(0, 2).map(r => `<p class="instaguard-note">🤖 ${r}</p>`).join('')}
                ${analysis.misinformation?.audioSummary ? `<div class="instaguard-mini-summary"><b>Audio:</b> ${analysis.misinformation.audioSummary}</div>` : ''}
                ${(analysis.misinformation?.claims || []).map((c, i) => {
                    const corr = analysis.misinformation?.corrections?.[i];
                    return `<div class="instaguard-factcheck">
                        <p class="instaguard-claim">❌ <b>Claim:</b> ${c}</p>
                        ${corr ? `<p class="instaguard-correction">✅ <b>Fact:</b> ${corr}</p>` : ''}
                    </div>`;
                }).join('')}
                ${analysis.summary ? `<p class="instaguard-summary">"${analysis.summary}"</p>` : ''}
            </div>`;

        badge.querySelector('.instaguard-badge-header').addEventListener('click', (e) => {
            e.stopPropagation();
            const body = badge.querySelector('.instaguard-badge-body');
            const toggle = badge.querySelector('.instaguard-badge-toggle');
            if (body.hidden) {
                body.hidden = false;
                toggle.textContent = '▲';
            } else {
                body.hidden = true;
                toggle.textContent = '▼';
            }
        });

        btn.replaceWith(badge);
    }

    function showProfileResult(btn, analysis, username) {
        const aiScore = analysis.aiGeneratedScore ?? 0;
        const misScore = analysis.misinformationScore ?? 0;
        const trustScore = analysis.trustScore ?? Math.max(0, 100 - Math.max(aiScore, misScore));

        let cls;
        let icon;
        let label;

        if (trustScore < 40) {
            cls = 'danger';
            icon = '🚨';
            label = `Low Trust (${trustScore}%)`;
        } else if (trustScore < 80) {
            cls = 'warning';
            icon = '⚠️';
            label = `Medium Trust (${trustScore}%)`;
        } else {
            cls = 'safe';
            icon = '✅';
            label = `Highly Trusted (${trustScore}%)`;
        }

        const badge = document.createElement('div');
        badge.className = `instaguard-badge instaguard-${cls}`;
        badge.style.width = '100%';
        badge.style.maxWidth = '100%';
        badge.dataset.username = username;

        badge.innerHTML = `
            <div class="instaguard-badge-header">
                <span>${icon}</span>
                <span class="instaguard-badge-label">Profile Reliability: ${label}</span>
                <span class="instaguard-badge-toggle">▼</span>
            </div>
            <div class="instaguard-badge-body" hidden>
                <div class="instaguard-row">
                    <span>Avg AI Content</span>
                    <div class="instaguard-bar"><div class="instaguard-bar-fill" style="width:${aiScore}%;background:${col(aiScore)}"></div></div>
                    <span>${aiScore}%</span>
                </div>
                <div class="instaguard-row" style="margin-bottom:8px">
                    <span>Avg Misinfo</span>
                    <div class="instaguard-bar"><div class="instaguard-bar-fill" style="width:${misScore}%;background:${col(misScore)}"></div></div>
                    <span>${misScore}%</span>
                </div>
                <p class="instaguard-note">Database score built from ${analysis.postsAnalyzedCount} analyzed posts${analysis.recentPostsAnalyzed ? `, including ${analysis.recentPostsAnalyzed} checked just now` : ''}.</p>
                ${analysis.summary ? `<p class="instaguard-summary">"Overall Profile: ${analysis.summary}"</p>` : ''}
            </div>`;

        badge.querySelector('.instaguard-badge-header').addEventListener('click', (e) => {
            e.stopPropagation();
            const body = badge.querySelector('.instaguard-badge-body');
            const toggle = badge.querySelector('.instaguard-badge-toggle');
            if (body.hidden) {
                body.hidden = false;
                toggle.textContent = '▲';
            } else {
                body.hidden = true;
                toggle.textContent = '▼';
            }
        });

        btn.replaceWith(badge);
    }

    async function getStoredProfileAnalysis(accountId, platform) {
        if (!accountId) return null;

        try {
            const response = await chrome.runtime.sendMessage({
                type: 'GET_ACCOUNT_RELIABILITY',
                accountId,
                platform
            });
            return response?.success ? response.analysis : null;
        } catch {
            return null;
        }
    }

    async function renderStoredProfileBadge(wrapper, accountId, platform, usernameLabel) {
        const storedAnalysis = await getStoredProfileAnalysis(accountId, platform);
        if (!storedAnalysis) return false;

        const placeholder = document.createElement('button');
        placeholder.type = 'button';
        placeholder.style.display = 'none';
        wrapper.appendChild(placeholder);
        showProfileResult(placeholder, storedAnalysis, usernameLabel || accountId);
        return true;
    }

    function showError(btn, msg) {
        btn.classList.remove('loading');
        btn.classList.add('error');
        btn.innerHTML = `<span>⚠️</span><span>${msg}</span>`;
        btn.title = msg;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            btn.classList.remove('error');
            btn.innerHTML = `
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg><span>Retry</span>`;
            startAnalysis(btn.dataset.mediaId, btn, btn.dataset.platform);
        }, { once: true });
    }

    function col(score) {
        return score < 30 ? '#22c55e' : score < 60 ? '#f59e0b' : '#ef4444';
    }

    function extractThumbnails(mediaUrl, isVideo) {
        return new Promise((resolve) => {
            if (isVideo) {
                const video = document.createElement('video');
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const frames = [];
                const maxFrames = 10;

                video.crossOrigin = 'anonymous';
                video.preload = 'metadata';
                video.muted = true;
                video.src = mediaUrl;

                const captureFrame = () => {
                    try {
                        canvas.width = video.videoWidth || 640;
                        canvas.height = video.videoHeight || 360;
                        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                        frames.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
                    } catch {
                        // Ignore frame capture error
                    }
                };

                const processFrames = async () => {
                    const duration = video.duration || 10;
                    for (let i = 0; i < maxFrames; i++) {
                        const timeTarget = (duration / maxFrames) * i + 0.5;
                        video.currentTime = Math.min(timeTarget, duration - 0.1);
                        await new Promise(r => {
                            const onSeeked = () => {
                                video.removeEventListener('seeked', onSeeked);
                                r();
                            };
                            video.addEventListener('seeked', onSeeked);
                            setTimeout(() => {
                                video.removeEventListener('seeked', onSeeked);
                                r();
                            }, 1500);
                        });
                        captureFrame();
                    }
                    resolve(frames.length ? frames : null);
                };

                video.addEventListener('loadedmetadata', () => {
                    processFrames();
                });
                video.addEventListener('error', () => resolve(null));
                setTimeout(() => resolve(frames.length ? frames : null), 20000);
            } else {
                fetch(mediaUrl)
                    .then(r => r.blob())
                    .then(blob => new Promise((res, rej) => {
                        const reader = new FileReader();
                        reader.onloadend = () => res([reader.result.split(',')[1]]);
                        reader.onerror = rej;
                        reader.readAsDataURL(blob);
                    }))
                    .then(b64 => resolve(b64))
                    .catch(() => resolve(null));
            }
        });
    }

    async function extractYouTubeFrames(mediaId) {
        const currentId = getYouTubeVideoIdFromURL();
        if (currentId !== mediaId) return null;

        const player = document.querySelector('video.html5-main-video');
        if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return null;

        try {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const frames = [];
            const maxFrames = 6;
            const originalTime = player.currentTime;
            const wasPaused = player.paused;

            canvas.width = player.videoWidth || 640;
            canvas.height = player.videoHeight || 360;

            if (!wasPaused) player.pause();

            for (let i = 0; i < maxFrames; i++) {
                const ratio = maxFrames === 1 ? 0.5 : i / (maxFrames - 1);
                const targetTime = Math.max(0, Math.min(player.duration - 0.25, player.duration * ratio));
                player.currentTime = targetTime;
                await new Promise(resolve => {
                    const onSeeked = () => {
                        player.removeEventListener('seeked', onSeeked);
                        resolve();
                    };
                    player.addEventListener('seeked', onSeeked);
                    setTimeout(() => {
                        player.removeEventListener('seeked', onSeeked);
                        resolve();
                    }, 1200);
                });
                try {
                    ctx.drawImage(player, 0, 0, canvas.width, canvas.height);
                    frames.push(canvas.toDataURL('image/jpeg', 0.82).split(',')[1]);
                } catch {
                    return null;
                }
            }

            player.currentTime = originalTime;
            if (!wasPaused) {
                player.play().catch(() => {});
            }

            return frames.length ? frames : null;
        } catch {
            return null;
        }
    }

    function getInstagramShortcodeFromURL() {
        const m = window.location.pathname.match(IG_POST_REGEX);
        return m ? m[2] : null;
    }

    function manageInstagramReelPolling() {
        if (window.location.pathname.includes('/reel')) {
            if (!instagramReelPollInterval) {
                instagramReelPollInterval = setInterval(() => {
                    const shortcode = getInstagramShortcodeFromURL();
                    if (shortcode && !document.querySelector(`[data-media-id="${shortcode}"][data-platform="instagram"]`)) {
                        tryInjectInstagramButton();
                    }
                }, 1000);
            }
        } else if (instagramReelPollInterval) {
            clearInterval(instagramReelPollInterval);
            instagramReelPollInterval = null;
        }
    }

    function getInstagramProfileUsernameFromURL() {
        const path = window.location.pathname;
        if (path === '/' || path.startsWith('/explore/') || path.startsWith('/reels/') || path.startsWith('/direct/')) return null;
        const m = path.match(IG_PROFILE_REGEX);
        return m ? m[1] : null;
    }

    function tryInjectInstagramProfileButton() {
        const username = getInstagramProfileUsernameFromURL();
        if (!username) return;
        if (document.querySelector('.instaguard-profile-trust-wrapper[data-platform="instagram"]')) return;

        const headerSelectors = ['header section', 'header'];
        let target = null;
        for (const selector of headerSelectors) {
            target = document.querySelector(selector);
            if (target) break;
        }

        if (!target) {
            setTimeout(tryInjectInstagramProfileButton, 1000);
            return;
        }

        const wrapper = createProfileContainer('instagram');
        target.appendChild(wrapper);

        renderStoredProfileBadge(wrapper, username, 'instagram', username).then((hasStoredBadge) => {
            if (!hasStoredBadge && wrapper.isConnected && !wrapper.querySelector('#instaguard-profile-btn-instagram')) {
                wrapper.appendChild(createProfileButton(username, 'instagram'));
            }
        });
    }

    function getInstagramProfileShortcodes() {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const shortcodes = [];

        for (const anchor of links) {
            const href = anchor.getAttribute('href') || '';
            const match = href.match(IG_POST_REGEX);
            if (!match) continue;
            const shortcode = match[2];
            if (!shortcodes.includes(shortcode)) shortcodes.push(shortcode);
        }

        return shortcodes;
    }

    function tryInjectInstagramButton() {
        const shortcode = getInstagramShortcodeFromURL();
        if (!shortcode) return;
        if (document.querySelector(`[data-media-id="${shortcode}"][data-platform="instagram"]`)) return;

        const anchored = findInstagramInsertionPoint();
        if (anchored) {
            insertInstagramButton(anchored, shortcode);
            return;
        }

        if (injectionObserver) injectionObserver.disconnect();
        let attempts = 0;
        injectionObserver = new MutationObserver(() => {
            attempts++;
            if (attempts > 100) {
                injectionObserver.disconnect();
                return;
            }
            const point = findInstagramInsertionPoint();
            if (point) {
                injectionObserver.disconnect();
                insertInstagramButton(point, shortcode);
            }
        });
        injectionObserver.observe(document.body, { childList: true, subtree: true });
    }

    function findInstagramInsertionPoint() {
        const activeContainer = findInstagramActiveContainer();

        if (activeContainer) {
            const mediaHost =
                activeContainer.querySelector('video')?.parentElement ||
                activeContainer.querySelector('img')?.parentElement;

            if (mediaHost) {
                return { type: 'overlay', element: mediaHost };
            }

            const moreButtons = activeContainer.querySelectorAll('button, div[role="button"]');
            for (const btn of moreButtons) {
                const svg = btn.querySelector('svg[aria-label="More options"], svg[aria-label="More"]');
                if (svg && !btn.nextSibling?.dataset?.mediaId) {
                    return { type: 'after', element: btn };
                }
            }

            const svgLike = activeContainer.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
            if (svgLike) {
                let el = svgLike;
                for (let i = 0; i < 8; i++) {
                    if (!el.parentElement || el.parentElement === activeContainer) break;
                    el = el.parentElement;
                    if (el.tagName.toLowerCase() === 'section' || (el.children.length > 2 && el.getAttribute('role') !== 'button')) {
                        return { type: 'append', element: el };
                    }
                }
            }
        }

        const moreButtons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of moreButtons) {
            const svg = btn.querySelector('svg[aria-label="More options"], svg[aria-label="More"]');
            if (svg && !btn.nextSibling?.dataset?.mediaId) {
                return { type: 'after', element: btn };
            }
        }

        return null;
    }

    function findInstagramActiveContainer() {
        const viewportCenter = window.innerHeight / 2;
        const videos = document.querySelectorAll('video');

        if (videos.length > 0) {
            let closest = null;
            let closestDist = Infinity;

            for (const video of videos) {
                const rect = video.getBoundingClientRect();
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                const dist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = video;
                }
            }

            if (closest) {
                let container = closest;
                for (let i = 0; i < 8; i++) {
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    const hasActions = container.querySelector('svg[aria-label="Like"], svg[aria-label="More options"], svg[aria-label="More"]');
                    if (hasActions) return container;
                }
                return closest.parentElement?.parentElement?.parentElement || closest.parentElement;
            }
        }

        return document.querySelector('div[role="dialog"]') || document.querySelector('article[role="presentation"]') || document.querySelector('article');
    }

    function insertInstagramButton({ type, element }, shortcode) {
        if (!element) return;
        if (document.querySelector(`[data-media-id="${shortcode}"][data-platform="instagram"]`)) return;

        const btn = createScanButton({ mediaId: shortcode, platform: 'instagram' });
        if (type === 'after') {
            element.parentElement?.insertBefore(btn, element.nextSibling);
        } else if (type === 'overlay') {
            element.style.position = 'relative';
            btn.classList.add('instaguard-overlay-pos');
            element.appendChild(btn);
        } else {
            element.appendChild(btn);
        }
    }

    function getInstagramFetchOptions() {
        const { wwwClaim, csrfToken } = sessionHeaders;
        return {
            headers: {
                'x-csrftoken': csrfToken,
                'x-ig-app-id': '936619743392459',
                'x-ig-www-claim': wwwClaim,
                'x-requested-with': 'XMLHttpRequest'
            },
            referrer: window.location.href,
            referrerPolicy: 'strict-origin-when-cross-origin',
            method: 'GET',
            mode: 'cors',
            credentials: 'include'
        };
    }

    function convertInstagramShortcodeToPostId(shortcode) {
        let id = BigInt(0);
        for (const ch of shortcode) {
            const idx = IG_SHORTCODE_ALPHABET.indexOf(ch);
            if (idx === -1) continue;
            id = id * BigInt(64) + BigInt(idx);
        }
        return id.toString(10);
    }

    async function fetchInstagramPostData(shortcode) {
        const postId = convertInstagramShortcodeToPostId(shortcode);
        const url = `${IG_BASE_URL}/api/v1/media/${postId}/info/`;

        try {
            const res = await fetch(url, getInstagramFetchOptions());
            if (res.ok) {
                const json = await res.json();
                return parseInstagramMediaItem(json.items?.[0]);
            }
            return await fetchInstagramPostDataGraphQL(shortcode);
        } catch {
            return await fetchInstagramPostDataGraphQL(shortcode);
        }
    }

    async function fetchInstagramPostDataGraphQL(shortcode) {
        const opts = getInstagramFetchOptions();
        opts.method = 'POST';
        opts.headers['content-type'] = 'application/x-www-form-urlencoded';
        opts.headers['x-fb-friendly-name'] = 'PolarisPostActionLoadPostQueryQuery';
        opts.body = new URLSearchParams({
            fb_api_caller_class: 'RelayModern',
            fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
            doc_id: '8845758582119845',
            variables: JSON.stringify({ shortcode })
        }).toString();

        const res = await fetch(`${IG_BASE_URL}/graphql/query/`, opts);
        const json = await res.json();
        const media = json.data?.xdt_shortcode_media;
        if (!media) throw new Error('No media');

        let hasOriginalAudio = true;
        if (media.is_video) {
            if (media.clips_music_attribution_info) hasOriginalAudio = false;
            else if (media.edge_media_to_music && media.edge_media_to_music.edges?.length > 0) hasOriginalAudio = false;
            else if (media.has_audio === false) hasOriginalAudio = false;
        }

        return {
            mediaUrl: media.is_video ? media.video_url : media.display_url,
            isVideo: !!media.is_video,
            hasOriginalAudio,
            caption: media.edge_media_to_caption?.edges?.[0]?.node?.text || '',
            account: {
                id: media.owner?.username || shortcode,
                username: media.owner?.username || null,
                displayName: media.owner?.full_name || media.owner?.username || shortcode
            }
        };
    }

    function parseInstagramMediaItem(item) {
        if (!item) return null;
        const isVideo = item.media_type !== 1;
        const sources = isVideo ? item.video_versions : item.image_versions2?.candidates;
        if (!sources?.length) return null;
        const best = sources.reduce((a, b) => a.width > b.width ? a : b, sources[0]);

        let hasOriginalAudio = true;
        if (isVideo) {
            if (item.clips_metadata) {
                hasOriginalAudio = !!item.clips_metadata.original_sound_info && !item.clips_metadata.music_info;
            } else if (item.has_audio === false) {
                hasOriginalAudio = false;
            }
        }

        return {
            mediaUrl: best.url,
            isVideo,
            hasOriginalAudio,
            caption: item.caption?.text || '',
            account: {
                id: item.user?.username || item.user?.pk || item.pk || null,
                username: item.user?.username || null,
                displayName: item.user?.full_name || item.user?.username || null
            }
        };
    }

    function manageYouTubePolling() {
        if (!youtubePollInterval) {
            youtubePollInterval = setInterval(() => {
                cleanupStaleYouTubeUI();
                tryInjectYouTubeButton();
                tryInjectYouTubeChannelButton();
            }, 1500);
        }
    }

    function getYouTubeVideoIdFromURL() {
        const url = new URL(window.location.href);
        if (url.pathname === '/watch') return url.searchParams.get('v');
        if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
        return null;
    }

    function isYouTubeVideoPage() {
        return !!getYouTubeVideoIdFromURL();
    }

    function getYouTubeChannelIdentifier() {
        const path = window.location.pathname;
        if (!YT_CHANNEL_REGEX.test(path)) return null;
        if (path.startsWith('/watch') || path.startsWith('/shorts')) return null;
        return path.replace(/^\/|\/$/g, '');
    }

    function getCurrentYouTubeAccount() {
        const channelId =
            document.querySelector('ytd-watch-metadata')?.__data?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId ||
            document.querySelector('ytd-reel-video-renderer[is-active]')?.__data?.reelPlayerHeaderSupportedRenderers?.reelPlayerHeaderRenderer?.channelNavigationEndpoint?.browseEndpoint?.browseId ||
            null;
        const displayName = getTextContent(document, [
            'ytd-watch-metadata #owner #channel-name a',
            'ytd-watch-metadata #channel-name a',
            'ytd-reel-video-renderer[is-active] #channel-name',
            '#text.ytd-channel-name'
        ]);
        const handle =
            document.querySelector('link[itemprop="name"]')?.getAttribute('content') ||
            getYouTubeChannelIdentifier() ||
            displayName ||
            channelId;

        if (!handle && !channelId && !displayName) return null;

        return {
            id: channelId || handle,
            channelId: channelId || null,
            username: handle || null,
            displayName: displayName || handle || channelId
        };
    }

    function tryInjectYouTubeButton() {
        const videoId = getYouTubeVideoIdFromURL();
        if (!videoId) return;
        cleanupStaleYouTubeUI(videoId);
        if (document.querySelector(`[data-media-id="${videoId}"][data-platform="youtube"]`)) return;

        const overlayPoint = findYouTubeInsertionPoint();
        if (overlayPoint) {
            insertYouTubeButton(overlayPoint, videoId);
            return;
        }

        const targets = [
            '#above-the-fold #top-row',
            '#above-the-fold #actions-inner',
            '#above-the-fold #owner',
            'ytd-reel-video-renderer[is-active] #actions'
        ];

        let target = null;
        for (const selector of targets) {
            target = document.querySelector(selector);
            if (target) break;
        }

        if (!target) return;

        const btn = createScanButton({ mediaId: videoId, platform: 'youtube' });
        btn.style.marginLeft = '8px';
        target.appendChild(btn);
    }

    function cleanupStaleYouTubeUI(currentVideoId = getYouTubeVideoIdFromURL()) {
        const youtubeUi = document.querySelectorAll(
            '.instaguard-scan-btn[data-platform="youtube"], .instaguard-badge[data-platform="youtube"]'
        );

        for (const node of youtubeUi) {
            if (!currentVideoId || node.dataset.mediaId !== currentVideoId) {
                node.remove();
            }
        }
    }

    function findYouTubeInsertionPoint() {
        const activeVideo = findActiveYouTubeVideo();
        if (!activeVideo) return null;

        let container =
            activeVideo.closest('ytd-reel-video-renderer') ||
            activeVideo.closest('ytd-shorts') ||
            activeVideo.closest('#player-container') ||
            activeVideo.parentElement;

        if (!container) return null;

        // Try to keep the overlay pinned to the visual player area instead of the whole page region.
        const tighterContainer =
            container.querySelector('#player-container') ||
            container.querySelector('#shorts-player') ||
            container.querySelector('.html5-video-player') ||
            activeVideo.parentElement;

        container = tighterContainer || container;
        return { type: 'overlay', element: container };
    }

    function findActiveYouTubeVideo() {
        const videos = Array.from(document.querySelectorAll('video'));
        if (videos.length === 0) return null;

        const viewportCenterX = window.innerWidth / 2;
        const viewportCenterY = window.innerHeight / 2;
        let bestVideo = null;
        let bestScore = Infinity;

        for (const video of videos) {
            const rect = video.getBoundingClientRect();
            if (rect.width < 100 || rect.height < 100) continue;
            if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
            if (rect.right < 0 || rect.left > window.innerWidth) continue;

            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const score = Math.abs(centerX - viewportCenterX) + Math.abs(centerY - viewportCenterY);

            if (score < bestScore) {
                bestScore = score;
                bestVideo = video;
            }
        }

        return bestVideo;
    }

    function insertYouTubeButton({ type, element }, videoId) {
        if (!element) return;
        if (document.querySelector(`[data-media-id="${videoId}"][data-platform="youtube"]`)) return;

        const btn = createScanButton({ mediaId: videoId, platform: 'youtube' });

        if (type === 'overlay') {
            if (getComputedStyle(element).position === 'static') {
                element.style.position = 'relative';
            }
            btn.classList.add('instaguard-overlay-pos');
            btn.style.top = '14px';
            btn.style.left = '14px';
            element.appendChild(btn);
            return;
        }

        element.appendChild(btn);
    }

    function tryInjectYouTubeChannelButton() {
        const account = getCurrentYouTubeAccount();
        const channelId = account?.id || getYouTubeChannelIdentifier();
        if (!channelId) return;
        if (document.querySelector('.instaguard-profile-trust-wrapper[data-platform="youtube"]')) return;

        const targets = [
            '#page-header',
            '#channel-header-container',
            'ytd-c4-tabbed-header-renderer',
            'ytd-page-header-renderer'
        ];

        let target = null;
        for (const selector of targets) {
            target = document.querySelector(selector);
            if (target) break;
        }

        if (!target) return;

        const wrapper = createProfileContainer('youtube');
        target.appendChild(wrapper);

        renderStoredProfileBadge(wrapper, channelId, 'youtube', account?.displayName || channelId).then((hasStoredBadge) => {
            if (!hasStoredBadge && wrapper.isConnected && !wrapper.querySelector('#instaguard-profile-btn-youtube')) {
                wrapper.appendChild(createProfileButton(channelId, 'youtube'));
            }
        });
    }

    function getYouTubeChannelVideoIds() {
        const ids = [];
        const anchors = document.querySelectorAll('a[href]');

        for (const anchor of anchors) {
            const href = anchor.getAttribute('href') || '';
            let id = null;

            if (href.startsWith('/watch')) {
                try {
                    id = new URL(href, window.location.origin).searchParams.get('v');
                } catch {
                    id = null;
                }
            } else if (href.startsWith('/shorts/')) {
                id = href.split('/')[2] || null;
            }

            if (id && !ids.includes(id)) ids.push(id);
        }

        return ids;
    }

    function getYouTubeMetaContent(doc, selector) {
        const node = doc.querySelector(selector);
        if (!node) return '';
        return node.getAttribute('content') || node.getAttribute('href') || '';
    }

    function getTextContent(root, selectors) {
        for (const selector of selectors) {
            const text = root.querySelector(selector)?.textContent?.trim();
            if (text) return text;
        }
        return '';
    }

    function buildYouTubeCaption(title, description) {
        return [title, description].filter(Boolean).join('\n\n').trim();
    }

    function getCurrentYouTubeTitle() {
        return getTextContent(document, [
            'ytd-reel-video-renderer[is-active] #overlay #video-title',
            'ytd-reel-video-renderer[is-active] h2',
            'ytd-watch-metadata h1 yt-formatted-string',
            '#title h1',
            '#shorts-title'
        ]);
    }

    function getCurrentYouTubeDescription() {
        return getTextContent(document, [
            'ytd-reel-video-renderer[is-active] #description-text',
            'ytd-reel-video-renderer[is-active] #metadata-line',
            'ytd-text-inline-expander',
            '#description-inline-expander'
        ]);
    }

    function getCurrentYouTubeVideoData(videoId) {
        if (!isYouTubeVideoPage() || getYouTubeVideoIdFromURL() !== videoId) return null;

        const title =
            getCurrentYouTubeTitle() ||
            getYouTubeMetaContent(document, 'meta[property="og:title"]') ||
            document.title.replace(/\s*-\s*YouTube$/, '');
        const description =
            getCurrentYouTubeDescription() ||
            getYouTubeMetaContent(document, 'meta[name="description"]');
        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

        return {
            mediaUrl: thumbnail,
            isVideo: true,
            hasOriginalAudio: false,
            caption: buildYouTubeCaption(title, description),
            account: getCurrentYouTubeAccount()
        };
    }

    async function fetchYouTubeVideoData(videoId) {
        const current = getCurrentYouTubeVideoData(videoId);
        if (current) return current;

        const res = await fetch(`/watch?v=${encodeURIComponent(videoId)}`, {
            credentials: 'include'
        });
        if (!res.ok) throw new Error('Failed to fetch YouTube page');

        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const title = getYouTubeMetaContent(doc, 'meta[property="og:title"]') || doc.title.replace(/\s*-\s*YouTube$/, '');
        const description = getYouTubeMetaContent(doc, 'meta[name="description"]');
        const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
        const author = getYouTubeMetaContent(doc, 'meta[itemprop="name"]') || getYouTubeMetaContent(doc, 'link[itemprop="name"]');

        return {
            mediaUrl: thumbnail,
            isVideo: true,
            hasOriginalAudio: false,
            caption: buildYouTubeCaption(title, description),
            account: author ? {
                id: author,
                username: author,
                displayName: author
            } : {
                id: getYouTubeChannelIdentifier() || null,
                username: getYouTubeChannelIdentifier() || null,
                displayName: getYouTubeChannelIdentifier() || null
            }
        };
    }

    console.log('[InstaGuard] Content script ready for', PLATFORM);
})();
