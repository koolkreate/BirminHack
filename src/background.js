/* ============================================================
   InstaGuard — Background Service Worker
   Handles Gemini API calls and result caching
   ============================================================ */

const GEMINI_MODEL = 'gemini-2.0-flash';
// In-memory cache for this service worker session
const SESSION_CACHE = new Map();

// ── Debug Logger ────────────────────────────────────────────
const DEBUG_LOGS = [];
function logDebug(message, data = null, level = 'info') {
    const entry = { timestamp: Date.now(), message, data, level };
    DEBUG_LOGS.push(entry);
    if (DEBUG_LOGS.length > 100) DEBUG_LOGS.shift(); // keep last 100 logs
    
    // Broadcast to any open debug pages
    chrome.runtime.sendMessage({ type: 'NEW_LOG', log: entry }).catch(() => {});
    
    if (level === 'error') console.error('[InstaGuard]', message, data || '');
    else console.log('[InstaGuard]', message, data || '');
}

// ── Persistent cache backed by chrome.storage.local ─────────
async function getCached(shortcode) {
    if (SESSION_CACHE.has(shortcode)) return SESSION_CACHE.get(shortcode);
    const key = `ig_cache_${shortcode}`;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
        SESSION_CACHE.set(shortcode, stored[key]); // warm in-memory cache
        return stored[key];
    }
    return null;
}

async function setCached(shortcode, result) {
    SESSION_CACHE.set(shortcode, result);
    const key = `ig_cache_${shortcode}`;
    await chrome.storage.local.set({ [key]: result });
}

// ── Listen for messages from content script ─────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE_MEDIA') {
        handleAnalysis(message).then(sendResponse);
        return true; // keep channel open for async response
    }
    if (message.type === 'GET_SETTINGS') {
        getSettings().then(sendResponse);
        return true;
    }
    if (message.type === 'SAVE_SETTINGS') {
        saveSettings(message.settings).then(sendResponse);
        return true;
    }
    if (message.type === 'GET_LOGS') {
        sendResponse({ logs: DEBUG_LOGS });
        return true;
    }
    if (message.type === 'CLEAR_LOGS') {
        DEBUG_LOGS.length = 0;
        sendResponse({ success: true });
        return true;
    }
});

// ── Settings management ─────────────────────────────────────
async function getSettings() {
    const result = await chrome.storage.sync.get({
        apiKey: '',
        enabled: true
    });
    return result;
}

async function saveSettings(settings) {
    await chrome.storage.sync.set(settings);
    return { success: true };
}

// ── Main analysis handler ───────────────────────────────────
async function handleAnalysis({ shortcode, mediaUrl, mediaType, caption, thumbnailBase64 }) {
    // Check persistent cache first — survives service worker restarts
    const cached = await getCached(shortcode);
    if (cached) return cached;

    const settings = await getSettings();
    if (!settings.apiKey) {
        return { error: 'NO_API_KEY', message: 'Please set your G4F Token in the extension popup.' };
    }
    if (!settings.enabled) {
        return { error: 'DISABLED', message: 'InstaGuard is disabled.' };
    }

    try {
        logDebug('Starting analysis', { shortcode, mediaType });
        const result = await analyzeWithPollinations(settings.apiKey, mediaUrl, mediaType, caption, thumbnailBase64);
        logDebug('Analysis complete', { shortcode, success: result.success });
        await setCached(shortcode, result);
        return result;
    } catch (err) {
        logDebug('Analysis error', { message: err.message }, 'error');
        return { error: 'ANALYSIS_FAILED', message: err.message };
    }
}

// ── Pollinations API call ─────────────────────────────────────────
async function analyzeWithPollinations(apiKey, mediaUrl, mediaType, caption, thumbnailBase64) {
    const isVideo = mediaType === 'video';

    let base64Data;
    if (thumbnailBase64) {
        // Content script pre-extracted the thumbnail (or image) — use it directly
        base64Data = thumbnailBase64;
    } else {
        // Fallback: fetch the image URL (should only happen for photos)
        const res = await fetch(mediaUrl);
        const blob = await res.blob();
        base64Data = await blobToBase64(blob);
    }

    const prompt = buildPrompt(caption, isVideo);
    const apiUrl = `https://text.pollinations.ai/openai`;

    const requestBody = {
        model: "openai",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: prompt },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
                ]
            }
        ]
    };

    logDebug('Pollinations Raw Request Body', requestBody);

    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
    });

    logDebug('Pollinations Response Status', { status: response.status, ok: response.ok });

    if (!response.ok) {
        const errText = await response.text();
        logDebug('Pollinations Error Response', { error: errText }, 'error');
        throw new Error(`Pollinations API error ${response.status}: ${errText}`);
    }

    const text = await response.text();
    logDebug('Pollinations Raw Text Response', { text });

    let json;
    try {
        json = JSON.parse(text);
    } catch (e) {
        throw new Error('Failed to parse Pollinations response as JSON');
    }

    const responseContent = json.choices?.[0]?.message?.content;

    if (!responseContent) {
        throw new Error('Empty response content from Pollinations');
    }

    try {
        const analysis = JSON.parse(responseContent);
        return { success: true, analysis };
    } catch (e) {
        logDebug('Failed to parse inner content as JSON, falling back', { returnedText: responseContent });
        // If Pollinations didn't return valid JSON, wrap the text
        return {
            success: true,
            analysis: {
                aiGenerated: { score: 0, confidence: 'unknown', reasons: [text] },
                misinformation: { score: 0, confidence: 'unknown', claims: [] }
            }
        };
    }
}

// ── Prompt builder ──────────────────────────────────────────
function buildPrompt(caption, isVideo) {
    const mediaWord = isVideo ? 'video' : 'image';
    return `You are an expert media forensics analyst and fact-checker. Analyze this ${mediaWord} from an Instagram post.

CAPTION: "${caption || '(no caption)'}"

Perform TWO analyses:

1. **AI Generation Detection**: Examine the ${mediaWord} for signs of AI generation. Look for:
   - Unnatural textures, lighting inconsistencies, or artifacts
   - Distorted hands, faces, text, or objects
   - Repeating patterns or impossible geometry
   - Overly smooth or plastic-looking skin/surfaces
   - Inconsistent shadows, reflections, or perspective
   ${isVideo ? '- Temporal inconsistencies, flickering, or morphing between frames' : ''}

2. **Misinformation Analysis**: Evaluate the caption and ${mediaWord} together for potential misinformation:
   - Does the caption make factual claims that appear false or misleading?
   - Is the ${mediaWord} being used out of context?
   - Are there signs of manipulation to push a narrative?

Respond in this exact JSON format:
{
  "aiGenerated": {
    "score": <number 0-100, where 100 = definitely AI generated>,
    "confidence": "<low|medium|high>",
    "reasons": ["<reason1>", "<reason2>"]
  },
  "misinformation": {
    "score": <number 0-100, where 100 = definitely misinformation>,
    "confidence": "<low|medium|high>",
    "claims": ["<flagged claim or concern>"],
    "corrections": ["<factual correction if applicable>"]
  },
  "summary": "<one-sentence overall assessment>"
}`;
}

// ── Utility: blob → base64 ────────────────────────────────────
function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
