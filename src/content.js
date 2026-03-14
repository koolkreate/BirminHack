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

    // ── Get shortcode from current URL ───────────────────────
    function getShortcodeFromURL() {
        const m = window.location.pathname.match(POST_REGEX);
        return m ? m[2] : null;
    }

    let lastHref = window.location.href;
    const navObserver = new MutationObserver(() => {
        const currentHref = window.location.href;
        if (currentHref !== lastHref) {
            lastHref = currentHref;
            // request fresh headers and try injecting button
            window.postMessage({ type: 'INSTAGUARD_REQUEST_HEADERS' }, '*');
            setTimeout(tryInjectButton, 900);
        } else if (currentHref.includes('/reel') || currentHref.includes('/reels')) {
            // Actively try to inject on reel scroll, since URL might not change fast enough
            tryInjectButton();
        }
    });
    navObserver.observe(document.documentElement, { childList: true, subtree: true });

    // ── Main injection logic ──────────────────────────────────
    function tryInjectButton() {
        const shortcode = getShortcodeFromURL();
        if (!shortcode) return;
        if (document.querySelector(`[data-ig="${shortcode}"]`)) return;

        // Use a MutationObserver to wait for the right DOM element to appear
        if (injectionObserver) injectionObserver.disconnect();

        let attempts = 0;
        injectionObserver = new MutationObserver(() => {
            attempts++;
            if (attempts > 200) { injectionObserver.disconnect(); return; }

            const anchored = findInsertionPoint(shortcode);
            if (anchored) {
                injectionObserver.disconnect();
                insertButton(anchored, shortcode);
            }
        });
        injectionObserver.observe(document.body, { childList: true, subtree: true });

        // Also try immediately
        const anchored = findInsertionPoint(shortcode);
        if (anchored) {
            injectionObserver.disconnect();
            insertButton(anchored, shortcode);
        }
    }

    /*
     * Find the best insertion point.
     * Strategy: look for the three-dot "more options" button (SVG with specific paths)
     * or a section element that contains the like/comment buttons.
     * We insert our pill button right before/after that.
     */
    function findInsertionPoint(shortcode) {
        // ── Strategy 1: Reel/Post page - find the right-column action buttons ──
        // On a reel page the actions (like, comment, share, ...) are a vertical column
        // The "..." button is typically the last one. We insert after it.

        // Look for the More-options SVG (three-dot menu button)
        const moreButtons = document.querySelectorAll('button, div[role="button"]');
        for (const btn of moreButtons) {
            const svgs = btn.querySelectorAll('svg');
            for (const svg of svgs) {
                if (svg.getAttribute('aria-label') === 'More options' ||
                    svg.getAttribute('aria-label') === 'More') {
                    return { type: 'after', element: btn };
                }
            }
        }

        // ── Strategy 2: look for section with SVG action buttons ──
        const svgLike = document.querySelector('svg[aria-label="Like"], svg[aria-label="Unlike"]');
        if (svgLike) {
            // Walk up to find the section or row container
            let el = svgLike;
            for (let i = 0; i < 8; i++) {
                if (!el.parentElement) break;
                el = el.parentElement;
                const tag = el.tagName.toLowerCase();
                if (tag === 'section' || (el.children.length > 2 && el.getAttribute('role') !== 'button')) {
                    return { type: 'append', element: el };
                }
            }
        }

        // ── Strategy 3: fallback - just look for any article/main and a video ──
        const video = document.querySelector('video[src], video > source');
        if (video) {
            const parent = video.closest('article') || video.parentElement;
            if (parent) return { type: 'overlay', element: video.parentElement || parent };
        }

        return null;
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

        return {
            mediaUrl: m.is_video ? m.video_url : m.display_url,
            isVideo: !!m.is_video,
            caption: m.edge_media_to_caption?.edges?.[0]?.node?.text || ''
        };
    }

    function parseMediaItem(item) {
        if (!item) return null;
        const isVideo = item.media_type !== 1;
        const sources = isVideo ? item.video_versions : item.image_versions2?.candidates;
        if (!sources?.length) return null;
        const best = sources.reduce((a, b) => a.width > b.width ? a : b, sources[0]);
        return {
            mediaUrl: best.url,
            isVideo,
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
                <div class="instaguard-row">
                    <span>Misinformation</span>
                    <div class="instaguard-bar"><div class="instaguard-bar-fill" style="width:${misScore}%;background:${col(misScore)}"></div></div>
                    <span>${misScore}%</span>
                </div>
                ${(analysis.aiGenerated?.reasons || []).slice(0, 2).map(r => `<p class="instaguard-note">• ${r}</p>`).join('')}
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
