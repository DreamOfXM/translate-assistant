<div align="center">

# Translate Assistant

**Translate foreign-language pages locally in your browser — no API keys, no uploads, offline once packs are installed**

[简体中文](README.md) | **English**

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-109%2B-blue.svg)](https://www.google.com/chrome/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/DreamOfXM/translate-assistant/pulls)

<img src="docs/images/bilingual.gif" alt="Bilingual page demo" width="720">

*Open a foreign page and translations appear under each paragraph — fully local, zero configuration*

</div>

---

## ✨ What it does

| | Feature | Details |
| --- | --- | --- |
| 📖 | **Bilingual page** | Open a foreign page and translations appear under each paragraph. Only the article body — nav, ads and comment sections are never touched |
| 🔍 | **Select to translate** | Select any foreign text, click the floating pill, get a result card in place |
| ✍️ | **Reply assistant** | Draft a reply in your language in any comment box, generate a translation, and it's filled in **only after you confirm** — never auto-posted |
| 📴 | **Offline** | Install a language pack once and translation keeps working without a network |
| 🔒 | **Privacy first** | Page text, drafts and translations never leave your device; the only network traffic is the pack download itself |

<p align="center">
  <img src="docs/images/popup-translate.gif" alt="Popup translate" width="300">
  &nbsp;&nbsp;
  <img src="docs/images/selection.gif" alt="Select to translate" width="300">
</p>

## 🌐 Language packs: install once, offline forever

The engine is [bergamot-translator](https://github.com/browsermt/bergamot-translator) embedded in your browser (the same one Firefox Translations uses, MPL-2.0). Models come from Mozilla's public [Firefox Translations](https://github.com/mozilla/firefox-translations-models) catalog (116 directions, MPL-2.0).

<p align="center">
  <img src="docs/images/packs.gif" alt="Language pack manager" width="720">
</p>

- **On-demand download**: a pack (about 25–50 MB) is fetched the first time you use a direction, with the size shown up front
- **Offline runtime**: once installed, translation is fully local — airplane mode included
- **Integrity checked**: model files are SHA-256 verified; corrupted files are discarded automatically
- **Relay for non-English pairs**: Mozilla only publishes X↔English models, so pairs like Chinese↔Japanese relay through English (the UI tells you when two packs are needed)

## 📦 Install

### Option 1: download a build (recommended)

1. Grab the latest `translate-assistant-vX.Y.Z.zip` from [Releases](https://github.com/DreamOfXM/translate-assistant/releases)
2. Unzip it anywhere
3. Open `chrome://extensions` → enable **Developer mode** → click **Load unpacked** → select the unzipped `translate-assistant` folder
4. Refresh already-open pages (the content script only injects into newly loaded ones)

> Unpacked extensions require developer mode; the extension contains zero telemetry, and the source is all here to audit.

### Option 2: build from source (developers)

Requires Chrome 109+ (offscreen documents API) and Node.js 18+.

```bash
npm install
npm run build
```

The build lands in `dist/translate-assistant` (load it as above) and also produces a distributable `dist/translate-assistant-v<version>.zip`.

> ⚠️ Load `dist/`, never `extension/`: `content.js` must be bundled by esbuild into a single classic script.

## 🚀 Quick start

1. **Install a pack**: click the extension icon → "语言包管理" → download the direction you need (e.g. en→zh)
2. **Read foreign pages**: just open them — translations appear automatically; the floating button collapses everything
3. **Reply in foreign languages**: hit "翻译回复" in a comment box, write in your language, generate, confirm, fill in

The UI speaks **中文 / English** — it follows your browser language and can be switched on the welcome page or in the pack manager.

## ⚠️ Known limitations

- Models are English-centric: non-English pairs relay through English, costing some speed and quality
- The WASM runtime is about 5 MB and loaded packs noticeably raise memory (traded for no cold start on the second translation)
- Language and main-content detection are lightweight heuristics; exotic pages may be misjudged (biased toward translating more, never less)
- Some rich-text editors reject programmatic input; the panel then suggests copying instead

## 🧭 Project layout

```text
extension/
  manifest.json       MV3 manifest (minimal permissions: storage / contextMenus / offscreen)
  background.js       service worker: message routing + offscreen lifecycle
  offscreen.html/js   offscreen document: WASM engine host
  content.js          page interactions: selection card / reply panel / bilingual page / hover pill
  lib/                reusable modules (i18n / languages / text / engine bridge / content extraction…)
  ui/                 popup, pack manager, welcome page
  vendor/             bergamot-translator 0.4.9 (MPL-2.0)
tests/unit/           unit tests (node:test + jsdom)
tests/e2e/            Playwright end-to-end smoke tests
scripts/              packaging and engine verification
docs/                 design docs and demo assets
```

## 📄 License

[MPL-2.0](LICENSE). The translation runtime and language models follow their upstream licenses (see "Language packs").
