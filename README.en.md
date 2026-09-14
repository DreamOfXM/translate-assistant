> 🌐 [中文版](README.md)

# Translate Assistant · Chrome Extension

Translate foreign text on web pages **locally** in your browser, or translate a Chinese draft into the target language and paste it back into an input field. No API key, no local backend service, and no text is ever uploaded.

- **Selection translation**: select foreign text → click "Translate selection" → a result card appears next to the selection
- **Hover translation** (read): toggle it on in the popup → hover over a paragraph and a "译" (Translate) button appears at its corner → the translation is inserted right below the paragraph and can be collapsed
- **Full-page bilingual view** (read): open a foreign page and it translates paragraph by paragraph automatically, inserting each translation under its original (like immersive-translate), with no button to click
- **Reply assistant** (write): click "Translate reply" in a comment box → write a draft in Chinese → produce the translation → it is only filled in **after you confirm**
- **No language picking needed**: in the translation card the source sits on top and the translation appears below. The source language is auto-detected; the target defaults to Chinese
- **Works offline**: once the language packs are downloaded, translation works without a network connection

## Interface

The translation cards (selection / reply) share the same layout: **source on top, translation below**, with just one language bar in between. Note that "full-page bilingual view" is the exception: the translation is inserted directly under the original paragraph on the page, and since the original is already right there, the translation node **does not repeat the source text**.

```text
┌─ Source ─────────────────────────┐
│ Local translation runs on …    │
└────────────────────────────────┘
  Auto-detect · English  ⇄  Chinese          ← one line of text; only expand if you want to pick
┌─ Translation · Chinese ───────────┐
│ Translation happens on your device…        │
└────────────────────────────────┘
```

The language bar is normally just a line of description, not a required field. Click to change it if you want:

- The left side defaults to "Auto-detect"; the detected result is shown directly above (e.g. "Auto-detect · English")
- The right side is the target language, defaulting to Chinese; when you write a Chinese draft it automatically becomes English, so it never "translates itself"
- `⇄` swaps the languages and moves the translation back to the source box for reverse translation

### Read: Hover translation

After enabling the "Hover translation" toggle in the popup, hovering over a paragraph shows a round "译" (Translate) button at its top-right corner; clicking inserts a bilingual translation below that paragraph (mounted in a Shadow DOM, unaffected by page styles), where you can "show source / show translation / copy / collapse" at any time. Clicking "译" again collapses it.

Chinese paragraphs show no button (no translation value for Chinese readers), and neither do input fields (that is the "write" mode's territory).

### Read: Full-page bilingual view (on by default)

**Open a foreign page and translations appear paragraph by paragraph automatically — no button to click throughout** — each translation is inserted under its original, shown segment by segment across the whole page like immersive-translate. Three toggles in the popup let you adjust it:

| Toggle | Default | Effect |
| --- | --- | --- |
| Full-page bilingual view | On | Auto-translate paragraph by paragraph after the page loads; only translates paragraphs that scroll into the viewport, so long pages don't waste the engine |
| Bottom-right floating button | On | Manually click "Bilingual view" to translate the whole page, or collapse all translations |
| Hover "译" button | Off | Hover over a paragraph to show "译", translating that single paragraph |

Behavior details:

- The button shows live progress "Translating N/M · click to stop", and can be stopped at any time
- Only translates leaf blocks: nested structures like `blockquote > p` are not translated twice; hidden templates and ad slots are skipped
- Chinese pages are not auto-translated; at most 200 paragraphs per run, to keep a very long page from freezing the engine
- **Translation nodes show only the translation**: the original paragraph stays above on the page, so the node does not repeat the source (avoids a noisy UI); on failure the node shows the error in red in place, still making it clear which paragraph failed
- **Mixed-language paragraphs are handled by their dominant language**: an English-dominant paragraph with a few Chinese characters (common in nav bars, brand names) is still translated, and won't report "source and target languages are the same"; a paragraph that is mostly Chinese characters is treated as genuinely Chinese, silently skipped, and shows no error card
- **Auto mode does not download language packs automatically**: if the required pack is not installed, auto mode won't start, avoiding tens of MB of traffic the moment you open a page
- Dynamic pages (infinite scroll, SPA) get newly inserted paragraphs translated too
- When done the button becomes "Translated N paragraphs · collapse"; clicking collapses; clicking again restores without re-requesting translation
- A paragraph that fails to translate only affects that one paragraph (error shown in place) and does not affect the ones after it

## Installation

```bash
npm run build
```

1. Open `chrome://extensions` in Chrome
2. Turn on "Developer mode" in the top-right corner
3. Click "Load unpacked" and select `dist/translate-assistant`
4. **Refresh already-open pages** (content scripts are only injected into newly loaded pages)

To package as a zip: `npm run build` also produces `dist/translate-assistant.zip`.

Requires Chrome 109 or newer (uses the offscreen document API).

**Load `dist/`, not `extension/`** — `content.js` is only injected after esbuild bundles it into a single file; the `content.js` in the source directory uses ES module `import`, and loading it directly throws `Cannot use import statement outside a module`.

## Language packs

Language packs come from Mozilla's public model catalog (116 directions), licensed **MPL-2.0**, and the runtime is [bergamot-translator](https://github.com/browsermt/bergamot-translator) (also MPL-2.0).

**Mozilla only publishes "each language ↔ English" models** (plus en-zh / zh-en). So directions like Chinese ↔ Japanese have no direct model, and the extension **routes through English**:

```text
Japanese → Chinese  =  (Japanese → English)  +  (English → Chinese)
```

This requires installing two packs at once on the language-pack management page, which the UI clearly marks as "needs 2 language packs". The routing is done internally by bergamot at runtime and is invisible to the user.

A single language pack is about **25–50 MB**; after download it is unpacked into Cache Storage and the model files' SHA-256 (provided in `models.json`) is verified — on verification failure the cache is discarded and the user is prompted to re-download.

## Privacy

- Web-page text, drafts, and translations are **never uploaded**; they only flow within the browser process
- Drafts exist only in the panel's memory by default and are not written to persistent storage
- Network requests are only of two kinds: fetching the model catalog and downloading language packs (both from `storage.googleapis.com`)
- The manifest only requests three permissions: `storage`, `contextMenus`, `offscreen`
- The panel is mounted in a Shadow DOM, so it neither pollutes page styles nor reads unrelated page content

## Development

```bash
npm install
npm test              # unit tests (language detection, message protocol, text segmentation, input filling, manifest validation)
npm run build         # bundle into dist/
npm run verify:engine # run one real translation in Node to verify the runtime against the live models
npm run test:e2e      # load dist/ in a real Chrome and run the four main paths (build first)
```

Besides pure-logic tests, `npm test` also drives `content.js` directly via jsdom to cover real interactions: input-entry buttons, result cards, confirmed fill-back, long-text segmentation, draft retention on translation failure, and input-invalidation prompts. The acceptance criteria "don't modify the input until the user confirms" and "only fill, never submit, after confirmation" are exactly what this guards.

`npm run verify:engine` needs no browser: the vendor code ships a Node compatibility layer that really downloads a language pack and completes a translation, to confirm that the biggest technical risk — "WASM runtime + Mozilla's live models" — still holds. It validates `en-zh` by default, or specify a direction: `npm run verify:engine zh-en`.

`npm run test:e2e` launches a real Chrome (headed by default) loading `dist/translate-assistant`, automatically runs the four paths — popup translation, selection translation, hover translation, reply assistant — and checks the console for no CSP / ESM / WASM errors. This layer specifically catches problems that only surface in a real browser; see `tests/e2e/README.md` for details.

Finer-grained interactions and offline capabilities are still verified manually with `tests/e2e/test-page.html`; the checklist is in `tests/e2e/README.md`.

### Directory structure

```text
extension/
  manifest.json
  background.js       Service Worker: routing + offscreen document lifecycle
  offscreen.html/js   offscreen document: WASM engine host
  content.js          page interaction (selection translation / reply panel / confirmed fill-back)
  lib/                reusable modules (language, text, protocol, input, engine, language bar, hover reader, styles)
  ui/                 popup and language-pack management page
  vendor/             bergamot-translator 0.4.9 (MPL-2.0)
tests/unit/           unit tests
tests/e2e/            automated smoke scripts + manual test page and checklist
scripts/              bundling and engine-verification scripts
```

`extension/vendor/translator.js` differs from upstream `@browsermt/bergamot-translator@0.4.9` in exactly one place: it lets the caller specify the worker URL via `workerUrl` (the original used `import.meta.url` for relative resolution, which points to the wrong directory inside the offscreen document).

## Known limitations

- Language packs are English-centric; translating between Chinese and non-English languages needs routing, doubling size and time
- The WASM runtime is about 5 MB; with language packs, memory usage rises noticeably after loading
- Language detection is a lightweight heuristic based on character ranges and common function words; it is only a suggestion and can be changed manually in the UI
- Some custom editors (e.g. certain rich-text frameworks) reject programmatic filling, in which case the panel prompts you to use copy instead
- After installing the extension you need to refresh already-open pages
