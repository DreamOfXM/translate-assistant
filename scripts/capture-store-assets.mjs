#!/usr/bin/env node
/**
 * 抓 Chrome 应用商店的配图。
 *
 * 商店对图的硬性口径（2026-09-29 从 developer.chrome.com/docs/webstore/images 抄下）：
 *   截图 1280x800 或 640x400，方角、full bleed、不留白边，至少 1 张、最多 5 张；
 *   小宣传图 440x280 必给；128x128 图标要打进 zip 里。
 * 所以这里视口写死 1280x800，且只截真实渲染出来的页面，不做任何合成。
 *
 * 用法：
 *   npm run build && node scripts/capture-store-assets.mjs
 *   LOCALE=en node scripts/capture-store-assets.mjs   # 界面切英文再出一套
 *   OUT=dist/store-en node scripts/capture-store-assets.mjs
 *
 * 依赖 tests/e2e/.chrome-profile 里已装好的语言包（缺包时先跑一次
 * `npm run test:e2e -- --install en-zh`）。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');
const extensionPath = join(projectRoot, 'dist', 'translate-assistant');
const profileDir = process.env.CHROME_PROFILE ?? join(projectRoot, 'tests/e2e/.chrome-profile');
const outDir = join(projectRoot, process.env.OUT ?? 'dist/store');
const uiLang = process.env.LOCALE === 'en' ? 'en' : 'zh';

const SHOT = { width: 1280, height: 800 };
const ARTICLE = 'https://en.wikipedia.org/wiki/Local-first_software';
/* headless 起的 Chrome 不一定接得到 macOS 系统代理，这里显式传；
   PROXY=none 可以关掉，改成本机直连也能到达的站点再用。 */
const PROXY = process.env.PROXY ?? 'http://127.0.0.1:7890';
/* 截图里出现的示例草稿：挑一句机器翻得干净的话，商店配图会被很多人当成质量样本 */
const DRAFT = 'Could you send me the final numbers before Friday? Thanks.';

const TEXTAREA_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Reply</title></head>
<body style="margin:0;padding:40px 0 0;font:15px/1.6 -apple-system,Helvetica,Arial,sans-serif;background:#f6f7f9">
<div style="width:860px;margin:0 auto;background:#fff;border:1px solid #dfe1e5;border-radius:10px;padding:24px 28px 28px">
<div style="font-weight:600;font-size:17px;margin-bottom:16px">New message</div>
<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid #eceef1"><span style="width:56px;color:#8a9099">To</span><span style="flex:1">product@acme.example</span></div>
<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-top:1px solid #eceef1"><span style="width:56px;color:#8a9099">Subject</span><span style="flex:1">Q3 figures</span></div>
<div id="editor" contenteditable="true" style="min-height:230px;margin-top:14px;padding:14px;border:1px solid #d0d7de;border-radius:8px;font:15px/1.8 sans-serif"></div>
<div style="display:flex;justify-content:flex-end;margin-top:16px"><span style="background:#2f6fed;color:#fff;border-radius:6px;padding:9px 20px;font-weight:600">Send</span></div>
</div></body></html>`;

function log(...a) { console.log(...a); }

async function loadChromium() {
  const managed = join(homedir(), '.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js');
  for (const candidate of ['playwright-core', 'playwright', managed]) {
    try {
      const mod = candidate.endsWith('.js') ? await import(pathToFileURL(candidate).href) : await import(candidate);
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw.chromium;
    } catch { /* 下一个 */ }
  }
  throw new Error('找不到 playwright-core，先在 translate-assistant 目录里 npm i');
}

/* Chrome 152 稳定版实测忽略 --load-extension，优先用 Playwright 自带的 Chrome for Testing */
function resolveExecutable() {
  const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cacheRoot)) {
    for (const build of readdirSync(cacheRoot).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const base = join(cacheRoot, build, 'chrome-mac-arm64');
      for (const app of ['Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'Chromium.app/Contents/MacOS/Chromium']) {
        const p = join(base, app);
        if (existsSync(p)) return p;
      }
    }
  }
  throw new Error('没有 Chrome for Testing，跑一次 npx playwright install chromium');
}

function serve(port0Page) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(port0Page);
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(page, name) {
  const file = join(outDir, `${name}.png`);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, ...SHOT } });
  log(`  📸 ${file}`);
  return file;
}

if (!existsSync(join(extensionPath, 'manifest.json'))) {
  console.error(`没有构建产物 ${extensionPath}，先 npm run build`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const chromium = await loadChromium();
const { server, url: localPage } = await serve(TEXTAREA_PAGE);
const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  executablePath: resolveExecutable(),
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    ...(PROXY === 'none' ? ['--no-proxy-server'] : [`--proxy-server=${PROXY}`]),
  ],
  viewport: SHOT,
  deviceScaleFactor: 1,
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 30000 });
const extensionId = new URL(worker.url()).host;
log(`扩展 id=${extensionId} · 界面语言=${uiLang}`);

await worker.evaluate(lang => chrome.storage.local.set({
  uiLang: lang, pageBilingual: true, autoBilingual: true, hoverTranslate: false,
}), uiLang);

const page = await context.newPage();
page.on('console', message => {
  const text = message.text();
  if (text.includes('翻译助手')) log(`  [content] ${text.slice(0, 140)}`);
});
const written = [];

/* 译文在 Shadow DOM 里，页面上下文的选择器穿不进去，必须自己取 shadowRoot。
   超时口径抄 tests/e2e/smoke.mjs：整页 240s、选中 170s。 */
const shadowText = () => {
  const root = document.getElementById('local-translator-root')?.shadowRoot;
  const node = root?.querySelector('.lt-card .lt-result');
  return Boolean(node && !node.classList.contains('placeholder') && node.textContent.trim());
};
const parasDone = () => {
  const hosts = [...document.querySelectorAll('.lt-para-host')];
  // 译文是逐段出的，只要 3 段就会提前通过；配图要的是"整页都翻完了"的样子
  return hosts.length >= 8 && hosts.slice(0, 8).every(node => {
    const text = node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
    return text.length > 0 && text !== '翻译中…';
  });
};

/* 1. 整页双语对照（自动出译文，不点任何按钮） */
try {
  const resp = await page.goto(ARTICLE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log(`  打开 ${page.url()} → HTTP ${resp?.status() ?? '无响应'}，正文 ${await page.evaluate(() => document.body.innerText.length)} 字`);
  await page.waitForFunction(parasDone, null, { timeout: 240000 });
  const hosts = await page.evaluate(() => document.querySelectorAll('.lt-para-host').length);
  log(`  自动译出 ${hosts} 段`);
  await sleep(1500);
  written.push(await shot(page, '01-bilingual'));
} catch (e) {
  log(`  ⚠️ 01-bilingual 失败：${e.message.split('\n')[0]}`);
}

/* 2. 选中文本 → 「翻译选中」按钮 → 结果卡片 */
try {
  await page.evaluate(() => {
    for (const p of document.querySelectorAll('p')) {
      const node = p.firstChild;
      if (node && node.nodeType === 3 && node.textContent.length >= 90) {
        p.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -110);
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 90);
        const sel = document.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return;
      }
    }
    throw new Error('找不到可截取的长段落');
  });
  await page.waitForSelector('button.lt-float.lt-selection', { timeout: 20000 });
  await page.click('button.lt-float.lt-selection');
  await page.waitForFunction(shadowText, null, { timeout: 170000 });
  await sleep(1200);
  log(`  选中卡片：${await page.evaluate(() => document.getElementById('local-translator-root')?.shadowRoot?.querySelector('.lt-card .lt-result')?.textContent?.trim().slice(0, 30))}`);
  written.push(await shot(page, '02-selection'));
} catch (e) {
  log(`  ⚠️ 02-selection 失败：${e.message.split('\n')[0]}`);
}

/* 3. 回复助手：英文草稿 → 就地出译文条 */
try {
  const mail = await context.newPage();
  await mail.goto(localPage, { waitUntil: 'domcontentloaded' });
  await mail.fill('#editor', DRAFT);
  await mail.click('#editor');
  await mail.waitForSelector('button.lt-float', { timeout: 20000 });
  await sleep(600);
  await mail.click('button.lt-float');
  await mail.waitForSelector('.lt-card.lt-inline .lt-result:not(.placeholder)', { timeout: 60000 });
  await sleep(1200);
  log(`  译文条：${(await mail.textContent('.lt-card.lt-inline .lt-result')).trim().slice(0, 30)}`);
  written.push(await shot(mail, '03-writeback'));
  await mail.close();
} catch (e) {
  log(`  ⚠️ 03-writeback 失败：${e.message}`);
}

/* 4. 语言包管理页（扩展自己的页面，整窗打开） */
try {
  const opts = await context.newPage();
  await opts.goto(`chrome-extension://${extensionId}/ui/options.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  written.push(await shot(opts, '04-packs'));
  await opts.close();
} catch (e) {
  log(`  ⚠️ 04-packs 失败：${e.message}`);
}

/* 5. 首次使用引导页 */
try {
  const hello = await context.newPage();
  await hello.goto(`chrome-extension://${extensionId}/ui/welcome.html`, { waitUntil: 'domcontentloaded' });
  await sleep(1200);
  written.push(await shot(hello, '05-welcome'));
  await hello.close();
} catch (e) {
  log(`  ⚠️ 05-welcome 失败：${e.message.split('\n')[0]}`);
}

await context.close();
server.close();
log(`\n成图 ${written.length} 张 → ${outDir}`);
process.exit(written.length === 0 ? 1 : 0);
