# InstaGuard — AI & Misinformation Detector for Social Media

A Chrome extension that detects AI-generated images/videos and misinformation on Instagram and YouTube posts using Google's Gemini AI.

## Features

- **AI Generation Detection**: Analyzes images and videos for signs of AI generation (artifacts, unnatural textures, temporal inconsistencies).
- **Misinformation Analysis**: Evaluates post captions and video transcripts for misleading claims and provides fact-check corrections.
- **Profile Reliability Score**: Builds a trust score for user profiles based on the history of their analyzed posts.
- **One-Click Scanning**: A "Scan" button is injected directly into the UI for any post or video.
- **Visual Results**: Presents analysis through color-coded badges (Safe / Warning / Danger) with expandable detail panels.
- **Smart Caching**: Results are cached per post to avoid redundant API calls and speed up repeated views.
- **Privacy First**: Your API key is stored locally in your browser. Media is sent directly to the analysis API.

## Installation

1. Clone or download this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer Mode** (toggle in top-right).
4. Click **"Load unpacked"** and select the extension's folder.
5. Click the InstaGuard icon in your toolbar and enter your Gemini API key from Google AI Studio.

## Usage

1. Navigate to an Instagram post/reel or a YouTube video/short.
2. Click the **"Scan"** button that appears on the post or near the video player.
3. Wait for the analysis (usually 3-10 seconds).
4. View the results. Click the result badge to expand the detailed analysis.

## Tech Stack

- **Chrome Manifest V3**: The modern extension architecture for security, performance, and privacy.
- **Service Worker**: Handles all background processing, including API calls and caching.
- **Gemini via Pollinations AI**: Uses the `gemini-fast` model for multimodal analysis of images, video frames, and text.
- **Platform-Specific Data Extraction**: Uses a combination of internal API endpoints and page scraping to fetch media URLs and metadata from Instagram and YouTube.

## File Structure

```
BirminHack/
├── manifest.json          # Extension manifest (MV3)
├── icons/                 # Extension icons (16/48/128px)
├── src/
│   ├── detector.js        # MAIN world — ReactFiber post detection
│   ├── content.js         # ISOLATED world — API calls & UI rendering
│   ├── background.js      # Service worker — Gemini API integration
│   └── overlay.css        # Styles for scan buttons & result cards
└── popup/
    ├── popup.html         # Settings popup
    ├── popup.css          # Popup styles
    └── popup.js           # Settings logic
```

## Built for BirminHack 2026 🚀