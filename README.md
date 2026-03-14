# InstaGuard — AI & Misinformation Detector for Instagram

A Chrome extension that detects AI-generated images/videos and misinformation on Instagram posts using Google's Gemini AI.

## Features

- 🛡️ **AI Generation Detection** — Analyzes images and videos for signs of AI generation (artifacts, unnatural textures, temporal inconsistencies)
- 📰 **Misinformation Analysis** — Evaluates captions and media for misleading claims with fact-check corrections
- 🎯 **One-Click Scanning** — Click "Scan with InstaGuard" on any post to analyze it
- 📊 **Visual Results** — Color-coded badges (✅ safe / ⚠️ warning / 🚨 danger) with expandable detail panels
- ⚡ **Smart Caching** — Results are cached per post to avoid redundant API calls
- 🔒 **Privacy First** — Your API key stays in your browser, media is sent directly to Google's API

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable **Developer Mode** (toggle in top-right)
4. Click **"Load unpacked"** and select this folder
5. Click the InstaGuard icon in your toolbar and enter your [Gemini API key](https://aistudio.google.com/apikey)

## Usage

1. Navigate to any Instagram post, reel, or story
2. Click the **"Scan with InstaGuard"** button that appears below the post
3. Wait for the analysis (usually 3-10 seconds)
4. View the results — click the result badge to expand detailed analysis

## Tech Stack

- **Chrome Manifest V3** — Modern extension architecture
- **Instagram Internal API** — Extracts media URLs using the same approach as [Instagram-Downloader](https://github.com/HOAIAN2/Instagram-Downloader)
- **ReactFiber** — Detects currently-visible posts in Instagram's SPA
- **Gemini 2.0 Flash** — Google's multimodal AI for image/video analysis

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