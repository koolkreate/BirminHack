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
    if (message.type === 'CLEAR_CACHE') {
        SESSION_CACHE.clear(); // Clear memory
        chrome.storage.local.clear(() => sendResponse({ success: true })); // Clear persistent
        logDebug('Cache cleared by user request');
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
async function handleAnalysis({ shortcode, mediaUrl, mediaType, caption, thumbnailsBase64 }) {
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
        const result = await analyzeWithPollinations(settings.apiKey, mediaUrl, mediaType, caption, thumbnailsBase64);
        logDebug('Analysis complete', { shortcode, success: result.success });
        await setCached(shortcode, result);
        return result;
    } catch (err) {
        logDebug('Analysis error', { message: err.message }, 'error');
        return { error: 'ANALYSIS_FAILED', message: err.message };
    }
}

// ── Pollinations API call ─────────────────────────────────────────
async function analyzeWithPollinations(apiKey, mediaUrl, mediaType, caption, thumbnailsBase64) {
    const isVideo = mediaType === 'video';

    let base64DataArray = [];
    if (thumbnailsBase64 && Array.isArray(thumbnailsBase64)) {
        base64DataArray = thumbnailsBase64;
    } else if (thumbnailsBase64 && typeof thumbnailsBase64 === 'string') {
        base64DataArray = [thumbnailsBase64];
    } else {
        // Fallback: fetch the image URL (should only happen for photos)
        const res = await fetch(mediaUrl);
        const blob = await res.blob();
        base64DataArray = [await blobToBase64(blob)];
    }

    const prompt = buildPrompt(caption, isVideo);
    const apiUrl = `https://gen.pollinations.ai/v1/chat/completions`;

    const messageContent = [
        { type: "text", text: prompt }
    ];

    for (const b64 of base64DataArray) {
        messageContent.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${b64}` }
        });
    }

    const requestBody = {
        model: "gemini-fast",
        response_format: { type: "json_object" },
        messages: [
            {
                role: "system",
                content: "You are an expert media forensics API. You must strictly output valid JSON matching the exact schema requested, with no extra conversational text."
            },
            {
                role: "user",
                content: messageContent
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

    const responseContent = json.choices?.[0]?.message?.content || '';

    if (!responseContent.trim()) {
        logDebug('Empty response content from Pollinations', { text }, 'error');
        throw new Error('Empty response content from Pollinations. The model may have rejected the request or failed to generate text.');
    }

    try {
        // Attempt strict JSON parse first
        const analysis = JSON.parse(responseContent);
        return { success: true, analysis };
    } catch (e) {
        // If the model enclosed the JSON in markdown code blocks or conversational text, try to extract it
        try {
            // Find the `{` that actually starts the JSON block, not just a stray `{`
            const jsonStr = responseContent.substring(responseContent.indexOf('{'));
            const jsonMatch = jsonStr.match(/\{[\s\S]*"aiGenerated"[\s\S]*\}/);
            
            if (jsonMatch) {
                const analysis = JSON.parse(jsonMatch[0]);
                return { success: true, analysis };
            } else {
                throw new Error('No JSON block found');
            }
        } catch (innerE) {
            logDebug('Failed to parse inner content as JSON, falling back', { returnedText: responseContent });
            
            // Attempt to extract score and confidence from conversational markdown if JSON parsing completely fails
            let extractedScore = 0;
            let extractedConfidence = 'unknown';
            
            const scoreMatch = responseContent.match(/Score\**:\s*(\d+)/i);
            if (scoreMatch) extractedScore = parseInt(scoreMatch[1]);
            
            const confMatch = responseContent.match(/Confidence\**:\s*(low|medium|high)/i);
            if (confMatch) extractedConfidence = confMatch[1].toLowerCase();

            return {
                success: true,
                analysis: {
                    aiGenerated: { score: extractedScore, confidence: extractedConfidence, reasons: [responseContent] },
                    summary: "Model did not return JSON. Displaying raw text analysis:"
                }
            };
        }
    }
}

// ── Prompt builder ──────────────────────────────────────────
function buildPrompt(caption, isVideo) {
    const mediaWord = isVideo ? 'sequence of video frames' : 'image';
    return `You are an expert media forensics analyst and fact-checker. Analyze this ${mediaWord} from an Instagram post.

CAPTION: "${caption || '(no caption)'}"

1. **AI Generation Detection**: Examine the ${mediaWord} for signs of AI generation. Look for:
   - Unnatural textures, lighting inconsistencies, or rendering artifacts
   - Distorted hands, faces, text, clothing, backgrounds, or objects
   - Repeating patterns, duplicated elements, or impossible geometry
   - Overly smooth, plastic-looking, or unnaturally uniform skin/surfaces
   - Inconsistent shadows, reflections, depth, scale, or perspective
   - **Absurd, implausible, or contextually illogical combinations**, such as:
     - objects appearing in places they would not realistically be
     - people interacting with items in bizarre or nonsensical ways
     - unusual hybrids of vehicles, furniture, animals, buildings, or tools
     - scenes that look dreamlike, random, or physically impossible
     - examples like a person sitting on a toilet that is spinning on a helicopter tractor
   ${isVideo ? '- Temporal inconsistencies, flickering, morphing, identity drift, or objects appearing/disappearing between frames' : ''}

2. **Traditional Editing Detection**: Determine if the ${mediaWord} has been conventionally edited or manipulated (e.g., Photoshop, filters, text overlays, splicing, noticeable color grading).
   - CRITICAL: This is distinct from AI Generation. A real photo with a filter or conventional edit is "edited" but NOT "AI Generated".
   - If the media appears strictly traditionally edited with no generative AI elements, the **AI Generated Score must be very low (e.g., 0-10)**.

Respond in this exact JSON format:
{
  "aiGenerated": {
    "score": <number 0-100, where 100 = definitely AI generated, and 0 = likely real or just traditionally edited>,
    "confidence": "<low|medium|high>",
    "reasons": ["<reason1>", "<reason2>"]
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
