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
async function getCached(cacheKey) {
    if (SESSION_CACHE.has(cacheKey)) return SESSION_CACHE.get(cacheKey);
    const key = `ig_cache_${cacheKey}`;
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) {
        SESSION_CACHE.set(cacheKey, stored[key]); // warm in-memory cache
        return stored[key];
    }
    return null;
}

async function setCached(cacheKey, result) {
    SESSION_CACHE.set(cacheKey, result);
    const key = `ig_cache_${cacheKey}`;
    await chrome.storage.local.set({ [key]: result });
}

// ── Listen for messages from content script ─────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ANALYZE_MEDIA') {
        handleAnalysis(message).then(sendResponse);
        return true; // keep channel open for async response
    }
    if (message.type === 'ANALYZE_PROFILE') {
        handleProfileAnalysis(message.username, message.shortcodes, sender.tab.id, message.platform || 'instagram').then(sendResponse);
        return true;
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
    // Add default elevenLabs key so it works out of the box with the user's provided key.
    const result = await chrome.storage.sync.get({
        apiKey: '',
        elevenLabsKey: 'sk_242029524305339d19a34edc22d8e75af631fda8973ca4d2',
        enabled: true
    });
    return result;
}

async function saveSettings(settings) {
    await chrome.storage.sync.set(settings);
    return { success: true };
}

// ── Main analysis handler ───────────────────────────────────
async function handleAnalysis({ shortcode, mediaUrl, mediaType, hasOriginalAudio, caption, thumbnailsBase64, platform = 'instagram' }) {
    // Check persistent cache first — survives service worker restarts
    const cacheKey = `${platform}_${shortcode}`;
    const cached = await getCached(cacheKey);
    if (cached) return cached;

    const settings = await getSettings();
    if (!settings.apiKey) {
        return { error: 'NO_API_KEY', message: 'Please set your Pollinations Token in the extension popup.' };
    }
    if (!settings.enabled) {
        return { error: 'DISABLED', message: 'InstaGuard is disabled.' };
    }

    try {
        let transcript = null;
        if (mediaType === 'video' && hasOriginalAudio && settings.elevenLabsKey) {
            transcript = await transcribeAudio(settings.elevenLabsKey, mediaUrl);
        }

        logDebug('Starting analysis', { shortcode, platform, mediaType, hasTranscript: !!transcript });
        const result = await analyzeWithPollinations(settings.apiKey, mediaUrl, mediaType, caption, thumbnailsBase64, transcript, platform);
        logDebug('Analysis complete', { shortcode, platform, success: result.success });
        await setCached(cacheKey, result);
        return result;
    } catch (err) {
        logDebug('Analysis error', { message: err.message }, 'error');
        return { error: 'ANALYSIS_FAILED', message: err.message };
    }
}

// ── Profile Analysis Handler ──────────────────────────────────────
async function handleProfileAnalysis(username, shortcodes, tabId, platform = 'instagram') {
    const settings = await getSettings();
    if (!settings.apiKey) {
        return { error: 'NO_API_KEY', message: 'Please set your Pollinations Token.' };
    }

    logDebug('Starting profile analysis', { username, shortcodes, platform });
    
    let totalAi = 0;
    let totalMis = 0;
    let successfulAnalyses = 0;
    const reasons = [];

    // Analyze up to 3 posts
    for (const code of shortcodes.slice(0, 3)) {
        try {
            // Ask the content script to fetch the media data for this shortcode
            // because the content script has the proper Instagram headers (CSRF, etc.)
            const postData = await new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(tabId, { type: 'FETCH_MEDIA_DATA', shortcode: code, platform }, (response) => {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(response);
                });
            });

            if (!postData || postData.error) {
                logDebug('Failed to fetch post data for profile analysis', { code });
                continue;
            }

            // Execute the analysis
            const res = await handleAnalysis({
                shortcode: code,
                mediaUrl: postData.mediaUrl,
                mediaType: postData.isVideo ? 'video' : 'image',
                hasOriginalAudio: postData.hasOriginalAudio,
                caption: postData.caption || '',
                platform
            });

            if (res.success && res.analysis) {
                totalAi += res.analysis.aiGenerated?.score || 0;
                totalMis += res.analysis.misinformation?.score || 0;
                if (res.analysis.summary) reasons.push(res.analysis.summary);
                successfulAnalyses++;
            }
        } catch (err) {
            logDebug('Profile post analysis failed', { code, error: err.message });
        }
    }

    if (successfulAnalyses === 0) {
        return { error: 'ANALYSIS_FAILED', message: 'Could not analyze any posts.' };
    }

    const avgAi = Math.round(totalAi / successfulAnalyses);
    const avgMis = Math.round(totalMis / successfulAnalyses);

    let summary = '';
    if (avgAi > 50 && avgMis > 50) summary = 'High rate of AI-generated content and misinformation.';
    else if (avgAi > 50) summary = 'Frequent use of AI-generated media discovered.';
    else if (avgMis > 50) summary = 'Frequent spread of factual misinformation detected.';
    else summary = 'Generally authentic and factually reliable content.';

    return {
        success: true,
        analysis: {
            aiGeneratedScore: avgAi,
            misinformationScore: avgMis,
            postsAnalyzedCount: successfulAnalyses,
            reasons: reasons,
            summary: summary
        }
    };
}

// ── Audio Transcription ─────────────────────────────────────────
async function transcribeAudio(apiKey, mediaUrl) {
    if (!apiKey) return null;
    try {
        logDebug('Fetching audio for transcription', { mediaUrl });
        const res = await fetch(mediaUrl);
        const blob = await res.blob();
        
        const formData = new FormData();
        formData.append('file', blob, 'audio.mp4'); 
        formData.append('model_id', 'scribe_v1');

        logDebug('Sending audio to ElevenLabs Scribe');
        const transcriptionRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
            method: 'POST',
            headers: {
                'xi-api-key': apiKey
            },
            body: formData
        });

        if (!transcriptionRes.ok) {
            const errText = await transcriptionRes.text();
            throw new Error(`ElevenLabs API Error: ${transcriptionRes.status} ${errText}`);
        }

        const data = await transcriptionRes.json();
        logDebug('ElevenLabs Transcription Success', { transcriptSample: data.text?.substring(0, 50) });
        return data.text || null;
    } catch (err) {
        logDebug('Transcription failed', { error: err.message }, 'error');
        return null;
    }
}

// ── Pollinations API call ─────────────────────────────────────────
async function analyzeWithPollinations(apiKey, mediaUrl, mediaType, caption, thumbnailsBase64, transcript, platform = 'instagram') {
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

    const prompt = buildPrompt(caption, isVideo, transcript, platform);
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

            let misScore = 0;
            const misScoreMatch = responseContent.match(/Misinformation[\s\S]{0,50}?Score\**:\s*(\d+)/i) || responseContent.match(/Misinformation:\s*(\d+)/i);
            if (misScoreMatch) misScore = parseInt(misScoreMatch[1]);

            return {
                success: true,
                analysis: {
                    aiGenerated: { score: extractedScore, confidence: extractedConfidence, reasons: [responseContent] },
                    misinformation: { score: misScore, confidence: "unknown", claims: [], corrections: [] },
                    summary: "Model did not return JSON. Displaying raw text analysis:"
                }
            };
        }
    }
}

// ── Prompt builder ──────────────────────────────────────────
function buildPrompt(caption, isVideo, transcript, platform = 'instagram') {
    const mediaWord = isVideo ? 'sequence of video frames' : 'image';
    const sourceLabel = platform === 'youtube' ? 'YouTube video or Short' : 'Instagram post';
    let transcriptSection = '';
    const captionSection = caption ? `\n\nVISIBLE TEXT / TITLE / DESCRIPTION:\n"${caption}"` : '';
    
    if (transcript) {
        transcriptSection = `\n\nAUDIO TRANSCRIPT:\n"${transcript}"`;
    }

    return `You are an expert media forensics analyst and fact-checker. Analyze this ${mediaWord} from a ${sourceLabel}.${captionSection}

${transcriptSection}

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

3. **Misinformation & Fact-Checking**: Evaluate the factual accuracy of the claims made in the AUDIO TRANSCRIPT.
   - Provide a highly concise summary of what is being claimed in the audio transcript (if any).
   - Cross-reference these claims against objective realities and established facts.
   - If false, misleading, or pseudoscientific claims are made, provide corrections and cite credible source types.
   - **CRITICAL SCORING RULE:** If the post contains NO objective, factual claims (e.g., it is just a joke, a personal vlog, people dancing, opinions, or music) OR if there is no audio transcript, the misinformation score MUST BE EXACTLY 0. Do not give positive scores for subjective content.

Respond in this exact JSON format:
{
  "aiGenerated": {
    "score": <number 0-100, where 100 = definitely AI generated, and 0 = likely real or just traditionally edited>,
    "confidence": "<low|medium|high>",
    "reasons": ["<reason1>", "<reason2>"]
  },
  "misinformation": {
    "score": <number 0-100, where 100 = definitely false/misleading, and 0 = true or no objective claims made>,
    "confidence": "<low|medium|high>",
    "audioSummary": "<1-2 sentence summary of what the audio transcript says, or null if no transcript>",
    "claims": ["<claim1>"],
    "corrections": ["<correction for claim1 with source citations>"]
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
