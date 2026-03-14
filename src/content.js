/* ============================================================
   InstaGuard — Content Script (ISOLATED world)
   Injects scan button next to the "..." three-dot menu on posts/reels
   Uses Instagram's internal API (headers from MAIN world)
   ============================================================ */

(function () {
    'use strict';

    const IG_BASE_URL = 'https://www.instagram.com';
    const IG_SHORTCODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const POST_REGEX = /^\/(p|tv|reel|reels)\/([A-Za-z0-9_-]+)/;
    const PROFILE_REGEX = /^\/([A-Za-z0-9_.]+)\/?$/;

    let sessionHeaders = { wwwClaim: '', csrfToken: '' };
    const analysisInProgress = new Set();
    const analysisResults = new Map();
    let injectionObserver = null;

    // ── Request headers from MAIN world ──────────────────────
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

    // ── Listen for background requests ───────────────────────
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'FETCH_POST_DATA') {
            fetchPostData(msg.shortcode)
                .then(data => sendResponse(data || { error: 'Not found' }))
                .catch(err => sendResponse({ error: err.message }));
            return true;
        }
    });

    // ── Get shortcode from current URL ───────────────────────
    function getShortcodeFromURL() {
        const m = window.location.pathname.match(POST_REGEX);
        return m ? m[2] : null;
    }

    let lastHref = window.location.href;
    let reelPollInterval = null;

    // Navigation observer for SPA page changes
    const navObserver = new MutationObserver(() => {
        const currentHref = window.location.href;
        if (currentHref !== lastHref) {
            lastHref = currentHref;
            window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
            setTimeout(tryInjectButton, 600);
            setTimeout(tryInjectProfileButton, 800);
            // Start/stop reel polling based on page type
            manageReelPolling();
        }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });

    // Reel polling: checks every second if the current reel has a scan button.
    // This is much more reliable than scroll/mutation events because Instagram's
    // reel scroller updates the URL asynchronously.
    function manageReelPolling() {
        if (window.location.pathname.includes('/reel')) {
            if (!reelPollInterval) {
                reelPollInterval = setInterval(() => {
                    const sc = getShortcodeFromURL();
                    if (sc && !document.querySelector(`[data-ig="${sc}"]`)) {
                        tryInjectButton();
                    }
                }, 1000);
            }
        } else {
            if (reelPollInterval) {
                clearInterval(reelPollInterval);
                reelPollInterval = null;
            }
        }
    }
    // Start polling if we're already on a reel page
    manageReelPolling();

    // ── Profile injection logic ───────────────────────────────
    function getProfileUsernameFromURL() {
        const path = window.location.pathname;
        if (path === '/' || path.startsWith('/explore/') || path.startsWith('/reels/') || path.startsWith('/direct/')) return null;
        const m = path.match(PROFILE_REGEX);
        return m ? m[1] : null;
    }

    function tryInjectProfileButton() {
        const username = getProfileUsernameFromURL();
        if (!username) return;

        if (document.getElementById('instaguard-profile-btn')) return;

        // Try to find the profile header
        const headerSelectors = [
            'header section', // Typical desktop
            'header'         // Fallback
        ];

        let target = null;
        for (const sel of headerSelectors) {
            target = document.querySelector(sel);
            if (target) break;
        }

        if (target) {
            insertProfileButton(target, username);
        } else {
            // Wait for it
            setTimeout(tryInjectProfileButton, 1000);
        }
    }

    function insertProfileButton(container, username) {
        if (document.getElementById('instaguard-profile-btn')) return;

        // Typically we want to insert it next to the Message/Follow buttons.
        // The easiest way is to just append it to the header section but wrapped nicely.
        const wrapper = document.createElement('div');
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        wrapper.style.marginTop = '15px';
        wrapper.style.marginBottom = '15px';

        const btn = document.createElement('button');
        btn.id = 'instaguard-profile-btn';
        btn.className = 'instaguard-scan-btn';
        btn.style.width = '100%';
        btn.style.justifyContent = 'center';
        btn.style.padding = '8px 16px';
        btn.dataset.username = username;
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>Calculate Trust Score</span>
        `;
        
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            startProfileAnalysis(username, btn);
        });

        wrapper.appendChild(btn);

        // Find a good place within the header section.
        // Usually, `target.children[1]` is the bio or action buttons.
        // If not, just append.
        container.appendChild(wrapper);
    }

    async function startProfileAnalysis(username, btn) {
        if (analysisInProgress.has('profile_' + username)) return;

        btn.classList.add('loading');
        btn.innerHTML = `<div class="instaguard-spinner"></div><span>Analyzing Top Reels…</span>`;
        btn.disabled = true;
        analysisInProgress.add('profile_' + username);

        try {
            // Find the recent posts grid
            // Wait a moment in case it's rendering
            await new Promise(r => setTimeout(r, 1000));
            
            const links = Array.from(document.querySelectorAll('a[href]'));
            const shortcodes = [];
            
            for (const a of links) {
                const href = a.getAttribute('href');
                const m = href.match(POST_REGEX);
                if (m) {
                    const code = m[2];
                    if (!shortcodes.includes(code)) {
                        shortcodes.push(code);
                    }
                }
                if (shortcodes.length >= 3) break;
            }

            if (shortcodes.length === 0) {
                btn.innerHTML = `<span>No posts found.</span>`;
                btn.classList.remove('loading');
                btn.classList.add('error');
                return;
            }

            const result = await chrome.runtime.sendMessage({
                type: 'ANALYZE_PROFILE',
                username,
                shortcodes
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
            analysisInProgress.delete('profile_' + username);
            btn.disabled = false;
        }
    }

    // ── Main injection logic ──────────────────────────────────
    function tryInjectButton() {
        const shortcode = getShortcodeFromURL();
        if (!shortcode) return;
        if (document.querySelector(`[data-ig="${shortcode}"]`)) return;

        // Try immediately first
        const anchored = findInsertionPoint();
        if (anchored) {
            insertButton(anchored, shortcode);
            return;
        }

        // If not found, use a MutationObserver to wait for DOM to render
        if (injectionObserver) injectionObserver.disconnect();
        let attempts = 0;
        injectionObserver = new MutationObserver(() => {
            attempts++;
            if (attempts > 100) { injectionObserver.disconnect(); return; }
            const a = findInsertionPoint();
            if (a) {
                injectionObserver.disconnect();
                insertButton(a, shortcode);
            }
        });
        injectionObserver.observe(document.body, { childList: true, subtree: true });
    }

    /*
     * Find the best insertion point, scoped to the ACTIVE/VISIBLE reel or post.
     * Key insight: Instagram's reel scroller keeps multiple reels in the DOM.
     * We must find the one that's actually visible in the viewport.
     */
    function findInsertionPoint() {
        // First, identify the active container (the one currently visible)
        const activeContainer = findActiveContainer();

        if (activeContainer) {
            // Search for "More options" only within the active container
            const moreButtons = activeContainer.querySelectorAll('button, div[role="button"]');
            for (const btn of moreButtons) {
                const svg = btn.querySelector('svg[aria-label="More options"], svg[aria-label="More"]');
                if (svg) {
                    // Don't insert next to a button that already has our scan button as a sibling
                    if (btn.nextSibling?.dataset?.ig) continue;
                    return { type: 'after', element: btn };
                }
            }

            // Fallback: look for Like button section within active container
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

            // Fallback: overlay on the video itself
            const video = activeContainer.querySelector('video');
            if (video) {
                return { type: 'overlay', element: video.parentElement || activeContainer };
            }
        }

        // Global fallback (for non-reel pages like /p/ posts)
        const moreButtons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of moreButtons) {
            const svg = btn.querySelector('svg[aria-label="More options"], svg[aria-label="More"]');
            if (svg && !btn.nextSibling?.dataset?.ig) {
                return { type: 'after', element: btn };
            }
        }

        return null;
    }

    /*
     * Find the reel/post container that is currently visible in the viewport.
     * For reels: find all videos, check which one is in the viewport center.
     * For posts: find article or dialog.
     */
    function findActiveContainer() {
        const viewportCenter = window.innerHeight / 2;

        // For reels: find the video element closest to viewport center
        const videos = document.querySelectorAll('video');
        if (videos.length > 0) {
            let closest = null;
            let closestDist = Infinity;

            for (const video of videos) {
                const rect = video.getBoundingClientRect();
                // Check if visible in viewport
                if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                const dist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = video;
                }
            }

            if (closest) {
                // Walk up to find a meaningful container (usually 4-6 levels up from the video)
                let container = closest;
                for (let i = 0; i < 8; i++) {
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    // A good container usually has multiple children including action buttons
                    const hasActions = container.querySelector('svg[aria-label="Like"], svg[aria-label="More options"], svg[aria-label="More"]');
                    if (hasActions) return container;
                }
                // Fallback: return a reasonable parent
                return closest.parentElement?.parentElement?.parentElement || closest.parentElement;
            }
        }

        // For regular posts: dialog or article
        return document.querySelector('div[role="dialog"]') || document.querySelector('article[role="presentation"]') || document.querySelector('article');
    }

    function insertButton({ type, element }, shortcode) {
        if (!element) return;
        if (document.querySelector(`[data-ig="${shortcode}"]`)) return;

        const btn = document.createElement('button');
        btn.className = 'instaguard-scan-btn';
        btn.dataset.ig = shortcode;
        btn.setAttribute('aria-label', 'Scan with InstaGuard');
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <span>Scan</span>
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            startAnalysis(shortcode, btn);
        });

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

    // ── Instagram API: fetch post media data ──────────────────
    function getFetchOptions() {
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

    function convertToPostId(shortcode) {
        let id = BigInt(0);
        for (const ch of shortcode) {
            const idx = IG_SHORTCODE_ALPHABET.indexOf(ch);
            if (idx === -1) continue;
            id = id * BigInt(64) + BigInt(idx);
        }
        return id.toString(10);
    }

    async function fetchPostData(shortcode) {
        const postId = convertToPostId(shortcode);
        const url = `${IG_BASE_URL}/api/v1/media/${postId}/info/`;

        try {
            let res = await fetch(url, getFetchOptions());
            if (res.ok) {
                const json = await res.json();
                return parseMediaItem(json.items?.[0]);
            }
            // Fallback to GraphQL
            return await fetchPostDataGraphQL(shortcode);
        } catch {
            return await fetchPostDataGraphQL(shortcode);
        }
    }

    async function fetchPostDataGraphQL(shortcode) {
        const opts = getFetchOptions();
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
        const m = json.data?.xdt_shortcode_media;
        if (!m) throw new Error('No media');

        // Try to guess original audio from GraphQL structure
        let hasOriginalAudio = true;
        if (m.is_video) {
            if (m.clips_music_attribution_info) hasOriginalAudio = false;
            else if (m.edge_media_to_music && m.edge_media_to_music.edges?.length > 0) hasOriginalAudio = false;
            else if (m.has_audio === false) hasOriginalAudio = false;
        }

        return {
            mediaUrl: m.is_video ? m.video_url : m.display_url,
            isVideo: !!m.is_video,
            hasOriginalAudio,
            caption: m.edge_media_to_caption?.edges?.[0]?.node?.text || ''
        };
    }

    function parseMediaItem(item) {
        if (!item) return null;
        const isVideo = item.media_type !== 1;
        const sources = isVideo ? item.video_versions : item.image_versions2?.candidates;
        if (!sources?.length) return null;
        const best = sources.reduce((a, b) => a.width > b.width ? a : b, sources[0]);
        
        let hasOriginalAudio = true;
        if (isVideo) {
            if (item.clips_metadata) {
                // If it has music_info, it's typically a licensed track
                hasOriginalAudio = !!item.clips_metadata.original_sound_info && !item.clips_metadata.music_info;
            } else if (item.has_audio === false) {
                hasOriginalAudio = false;
            }
        }

        return {
            mediaUrl: best.url,
            isVideo,
            hasOriginalAudio,
            caption: item.caption?.text || ''
        };
    }

    // ── Analysis ──────────────────────────────────────────────
    async function startAnalysis(shortcode, btn) {
        if (analysisInProgress.has(shortcode)) return;

        // If we already have results, show them
        if (analysisResults.has(shortcode)) {
            showResult(btn, analysisResults.get(shortcode));
            return;
        }

        analysisInProgress.add(shortcode);
        btn.classList.add('loading');
        btn.innerHTML = `<div class="instaguard-spinner"></div><span>Scanning…</span>`;
        btn.disabled = true;

        try {
            // Refresh headers just before API call
            window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
            await new Promise(r => setTimeout(r, 300));

            const data = await fetchPostData(shortcode);
            if (!data?.mediaUrl) {
                showError(btn, 'Could not fetch media');
                return;
            }

            const result = await chrome.runtime.sendMessage({
                type: 'ANALYZE_MEDIA',
                shortcode,
                mediaUrl: data.mediaUrl,
                mediaType: data.isVideo ? 'video' : 'image',
                hasOriginalAudio: !!data.hasOriginalAudio,
                caption: data.caption,
                thumbnailsBase64: await extractThumbnails(data.mediaUrl, data.isVideo)
            });

            if (result.error) {
                showError(btn, result.message || result.error);
                return;
            }

            analysisResults.set(shortcode, result.analysis);
            showResult(btn, result.analysis);
        } catch (err) {
            console.error('[InstaGuard]', err);
            showError(btn, 'Analysis failed');
        } finally {
            analysisInProgress.delete(shortcode);
            btn.disabled = false;
        }
    }

        // ── Render result badge ───────────────────────────────────
    function showResult(btn, analysis) {
        const aiScore = analysis.aiGenerated?.score ?? 0;
        const misScore = analysis.misinformation?.score ?? 0;
        
        const isAiSus = aiScore >= 50;
        const isMisSus = misScore >= 50;

        let cls, icon, label;
        if (isAiSus && isMisSus)       { cls = 'danger';  icon = '🚨'; label = 'AI + Misinfo'; }
        else if (isAiSus)              { cls = 'warning'; icon = '⚠️'; label = `AI Generated (${aiScore}%)`; }
        else if (isMisSus)             { cls = 'warning'; icon = '⚠️'; label = `Misinformation (${misScore}%)`; }
        else                           { cls = 'safe';    icon = '✅'; label = 'Likely Authentic'; }

        const badge = document.createElement('div');
        badge.className = `instaguard-badge instaguard-${cls}`;
        badge.dataset.ig = btn.dataset.ig;

        // Preserve overlay position class if button had it
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
            if (body.hidden) { body.hidden = false; toggle.textContent = '▲'; }
            else             { body.hidden = true;  toggle.textContent = '▼'; }
        });

        btn.replaceWith(badge);
    }

    // ── Render profile result badge ───────────────────────────
    function showProfileResult(btn, analysis, username) {
        const aiScore = analysis.aiGeneratedScore ?? 0;
        const misScore = analysis.misinformationScore ?? 0;
        
        // Trust score is the inverse of the highest penalty
        const penalty = Math.max(aiScore, misScore);
        const trustScore = 100 - penalty;

        let cls, icon, label;
        if (trustScore < 40)        { cls = 'danger';  icon = '🚨'; label = `Low Trust (${trustScore}%)`; }
        else if (trustScore < 80)   { cls = 'warning'; icon = '⚠️'; label = `Medium Trust (${trustScore}%)`; }
        else                        { cls = 'safe';    icon = '✅'; label = `Highly Trusted (${trustScore}%)`; }

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
                <p class="instaguard-note">Analysis based on the ${analysis.postsAnalyzedCount} most recent reels/posts.</p>
                ${analysis.summary ? `<p class="instaguard-summary">"Overall Profile: ${analysis.summary}"</p>` : ''}
            </div>`;

        badge.querySelector('.instaguard-badge-header').addEventListener('click', (e) => {
            e.stopPropagation();
            const body = badge.querySelector('.instaguard-badge-body');
            const toggle = badge.querySelector('.instaguard-badge-toggle');
            if (body.hidden) { body.hidden = false; toggle.textContent = '▲'; }
            else             { body.hidden = true;  toggle.textContent = '▼'; }
        });

        btn.replaceWith(badge);
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
            startAnalysis(btn.dataset.ig, btn);
        }, { once: true });
    }

    function col(s) {
        return s < 30 ? '#22c55e' : s < 60 ? '#f59e0b' : '#ef4444';
    }

    // ── Boot ──────────────────────────────────────────────────
    setTimeout(tryInjectButton, 1500);

    // ── Thumbnail extraction (runs in page context with DOM access) ──
    // For videos: extract up to 10 JPEG frames (~2000 tokens)
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
                            const onSeeked = () => { video.removeEventListener('seeked', onSeeked); r(); };
                            video.addEventListener('seeked', onSeeked);
                            setTimeout(() => { video.removeEventListener('seeked', onSeeked); r(); }, 1500);
                        });
                        captureFrame();
                    }
                    resolve(frames.length ? frames : null);
                };

                video.addEventListener('loadedmetadata', () => {
                    processFrames();
                });
                video.addEventListener('error', () => resolve(null));
                setTimeout(() => resolve(frames.length ? frames : null), 20000); // timeout safeguard
            } else {
                // For images: fetch and encode here (avoids CORS issues in service worker)
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

    console.log('[InstaGuard] Content script ready');
})();
