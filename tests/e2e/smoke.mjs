/**
 * 真实浏览器端到端冒烟测试。
 *
 * 单元测试跑在 jsdom 里，验证不了三件真正会炸的事：
 *   1. content script 打成 ESM 后 Chrome 直接抛 Cannot use import statement；
 *   2. MV3 的 CSP 默认禁止 WebAssembly，引擎起不来；
 *   3. Service Worker / offscreen 的启动竞态，表现为「本地翻译引擎启动超时」。
 * 这些只有在真 Chrome 里加载扩展才会暴露，所以这里用 Playwright 起一个带扩展的
 * 浏览器，把四条主路径全部走一遍。
 *
 * 用法：
 *   npm run build && npm run test:e2e            # 用已有语言包跑
 *   npm run test:e2e -- --install en-zh          # 缺包时先下载（约 40 MB）
 *   CHROME_PROFILE=/tmp/lt-profile npm run test:e2e
 *
 * 说明：
 * - 默认有头模式（headless 老版本不支持扩展）。CI 里可用 xvfb。
 * - profile 目录固定复用，语言包存在 Cache Storage 里，换 profile 要重新下载。
 */

import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..', '..');
const extensionPath = join(projectRoot, 'dist', 'chrome-local-translator');
const profileDir = process.env.CHROME_PROFILE ?? join(here, '.chrome-profile');
const testPage = join(here, 'test-page.html');

const args = process.argv.slice(2);
const wantInstall = args.includes('--install');
const installIndex = args.indexOf('--install');
const installDirection = wantInstall ? (args[installIndex + 1] ?? 'en-zh') : null;

const CJK = /[㐀-鿿぀-ヿ]/;

/* ------------------------------- 环境准备 ------------------------------- */

async function loadChromium() {
  const managed = join(homedir(), '.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js');
  const candidates = ['playwright-core', 'playwright', managed];
  const failures = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const module = candidate.endsWith('.js')
        ? await import(pathToFileURL(candidate).href)
        : await import(candidate);
      const playwright = module.chromium ? module : module.default;
      if (playwright?.chromium) return playwright.chromium;
      failures.push(`${candidate}：没有导出 chromium`);
    } catch (error) {
      failures.push(`${candidate}：${String(error.message).split('\n')[0]}`);
    }
  }

  throw new Error(
    `需要 playwright-core（本项目 devDependencies 里没有，避免每个人都被迫下载浏览器）。\n` +
    `任选一种：\n` +
    `  npm i -D playwright-core && npx playwright install chromium\n` +
    `  cd ~/.workbuddy/binaries/node/workspace && npm i playwright-core\n` +
    `失败原因：\n  ${failures.join('\n  ')}`
  );
}

/**
 * 找到能用的 Chrome。
 * playwright-core 自带的 chromium 版本经常和缓存里的对不上（报 Executable doesn't exist），
 * 所以依次回退：环境变量 → playwright 自带 → 系统 Chrome → ms-playwright 缓存里任意一份。
 */
function resolveExecutable(chromium) {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH 指向的文件不存在：${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }

  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    /* 没下载过就继续找 */
  }

  const candidates = [];

  // Chrome for Testing / Chromium 排在系统 Chrome 前面：
  // Chrome 152 稳定版实测直接忽略 --load-extension（profile 里 extensions.settings 为空，
  // 打开扩展页面得到 ERR_BLOCKED_BY_CLIENT），而 Chrome for Testing 正常。
  const cacheRoot = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cacheRoot)) {
    const builds = readdirSync(cacheRoot)
      .filter(name => /^chromium-\d+$/.test(name))
      .sort()
      .reverse();
    for (const build of builds) {
      const base = join(cacheRoot, build, 'chrome-mac-arm64');
      candidates.push(join(base, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'));
      candidates.push(join(base, 'Chromium.app/Contents/MacOS/Chromium'));
    }
  }

  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');

  const found = candidates.find(path => existsSync(path));
  if (!found) {
    throw new Error(
      '没有可用的 Chrome。任选一种：\n' +
      '  npx playwright install chromium\n' +
      '  CHROME_PATH=/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome npm run test:e2e'
    );
  }
  return found;
}

function serveTestPage() {
  const html = readFileSync(testPage);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

/* ------------------------------- 断言框架 ------------------------------- */

const results = [];
const consoleErrors = [];

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
    })
  ]);
}

async function check(name, fn, timeout = 180000) {
  const started = Date.now();
  try {
    const detail = await withTimeout(Promise.resolve().then(fn), timeout, name);
    results.push({ name, ok: true });
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`❌ ${name} — ${error.message}`);
  }
}

function skip(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log(`⏭️  ${name} — 跳过：${reason}`);
}

function watchPage(page, label) {
  page.on('pageerror', error => consoleErrors.push(`[${label}] ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`[${label}] ${message.text()}`);
  });
}

/* --------------------------------- 主流程 -------------------------------- */

if (!existsSync(join(extensionPath, 'manifest.json'))) {
  console.error(`没有找到构建产物：${extensionPath}\n先执行 npm run build。`);
  process.exit(1);
}

const chromium = await loadChromium();
const { server, url } = await serveTestPage();

const executablePath = resolveExecutable(chromium);
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  executablePath,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check'
  ],
  viewport: { width: 1280, height: 900 }
});

console.log(`\n扩展目录：${extensionPath}`);
console.log(`浏览器：${executablePath}`);
console.log(`浏览器 profile：${profileDir}`);
console.log(`测试页：${url}\n`);

let extensionId = null;
let extensionPage = null; // 复用一个扩展页面来调 chrome.runtime

try {
  /* 1. Service Worker 就绪 */
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await withTimeout(context.waitForEvent('serviceworker'), 30000, '等待 Service Worker');
  extensionId = new URL(worker.url()).host;
  await check('扩展加载：Service Worker 就绪', () => `id=${extensionId}`, 30000);

  /* 2. 扩展页面可用 */
  extensionPage = await context.newPage();
  watchPage(extensionPage, 'popup');
  await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await check('popup 打开无脚本报错', async () => {
    await extensionPage.waitForSelector('#source', { timeout: 15000 });
    const title = await extensionPage.textContent('.brand, h1').catch(() => null);
    return title ? `标题「${title.trim()}」` : 'DOM 就绪';
  }, 30000);

  /* 3. 语言包状态 */
  let installed = [];
  await check('查询已安装语言包', async () => {
    const response = await extensionPage.evaluate(
      () => chrome.runtime.sendMessage({ type: 'GET_DIRECTION_STATUS' })
    );
    if (!response) throw new Error('Service Worker 没有响应 GET_DIRECTION_STATUS');
    installed = response.installed ?? [];
    return installed.length ? installed.join(', ') : '（还没有语言包）';
  }, 90000);

  const needPacks = !installed.includes('en-zh');
  if (needPacks && wantInstall) {
    await check(`下载语言包 ${installDirection}`, async () => {
      // 下载期间 Service Worker 会把进度广播成 TRANSLATION_PROGRESS，
      // options 页面能看到；这里只等结果，避免页面里轮询把消息协议搞乱。
      const response = await extensionPage.evaluate(
        direction => chrome.runtime.sendMessage({ type: 'PRELOAD_DIRECTION', direction }),
        installDirection
      );
      if (response?.error) throw new Error(response.error);
      return `packs=${(response?.packs ?? []).join('+')}`;
    }, 600000);
    const again = await extensionPage.evaluate(
      () => chrome.runtime.sendMessage({ type: 'GET_DIRECTION_STATUS' })
    );
    installed = again?.installed ?? [];
  }

  const canTranslate = installed.includes('en-zh');

  /* 4. popup 翻译闭环 */
  if (canTranslate) {
    await check('popup：英→中翻译闭环', async () => {
      await extensionPage.fill('#source', 'Local machine translation runs entirely on your device.');
      await extensionPage.click('#run');
      await extensionPage.waitForFunction(() => {
        const node = document.getElementById('result');
        return node && !node.classList.contains('placeholder') && node.textContent.trim().length > 0;
      }, null, { timeout: 170000 });
      const text = (await extensionPage.textContent('#result')).trim();
      if (!CJK.test(text)) throw new Error(`译文不像中文：${text}`);
      return text.slice(0, 40);
    });
  } else {
    skip('popup：英→中翻译闭环', '未安装 en-zh，加 --install en-zh 自动下载');
  }

  /* 5. 页面内路径 */
  const page = await context.newPage();
  watchPage(page, 'test-page');
  await page.goto(url);
  await page.waitForSelector('#english-paragraph');

  if (canTranslate) {
    await check('页面：选中文本翻译', async () => {
      await page.evaluate(() => {
        const paragraph = document.getElementById('english-paragraph');
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      });
      await page.waitForSelector('.lt-float.lt-selection', { timeout: 10000 });
      await page.click('.lt-float.lt-selection');
      // 注意：waitForFunction / evaluate 跑在页面上下文里，不会穿透 Shadow DOM，
      // 必须自己拿到 #local-translator-root 的 shadowRoot 再查。
      await page.waitForFunction(() => {
        const root = document.getElementById('local-translator-root')?.shadowRoot;
        const node = root?.querySelector('.lt-card .lt-result');
        return Boolean(node && !node.classList.contains('placeholder') && node.textContent.trim());
      }, null, { timeout: 170000 });
      const text = await page.evaluate(() => {
        const root = document.getElementById('local-translator-root')?.shadowRoot;
        return root?.querySelector('.lt-card .lt-result')?.textContent?.trim() ?? '';
      });
      if (!CJK.test(text)) throw new Error(`译文不像中文：${text.slice(0, 60)}`);
      return text.slice(0, 40);
    });
    await page.click('.lt-close').catch(() => {});
  } else {
    skip('页面：选中文本翻译', '未安装语言包');
  }

  if (canTranslate) {
    // 日文段落要经过 ja-en + en-zh 中转，只有两个包都装好了才用它，
    // 否则测试会在无人察觉的情况下再下一个 40 MB 的包（实测拖到 158s）。
    const hoverReady = installed.includes('ja-en') && installed.includes('en-zh');
    const hoverTarget = hoverReady ? '#japanese-paragraph' : '#english-paragraph';

    await check(`页面：悬停翻译（读模式 · ${hoverReady ? '日语中转' : '英语'}）`, async () => {
      await extensionPage.evaluate(() => chrome.storage.local.set({ hoverTranslate: true }));
      await page.waitForTimeout(300);
      const paragraph = page.locator(hoverTarget);
      await paragraph.scrollIntoViewIfNeeded();
      await paragraph.hover();
      await page.waitForSelector('.lt-hover-pill', { timeout: 10000 });
      // 不能用 locator.click()：Playwright 点击前会「滚动到可视区域」，
      // 而 content script 监听 scroll 收起按钮，一滚按钮就没了。
      // 这里直接在页面里派发 click，跳过滚动。
      await page.evaluate(() => {
        const root = document.getElementById('local-translator-root')?.shadowRoot;
        root?.querySelector('.lt-hover-pill')?.click();
      });
      // 译文节点先插入再异步填内容，占位文案是「翻译中…」，
      // 只判断「非空」会读到占位符，必须等它真的被替换掉。
      await page.waitForFunction(() => {
        const host = document.querySelector('.lt-para-host');
        const text = host?.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
        return text.length > 0 && text !== '翻译中…';
      }, null, { timeout: 170000 });
      const text = await page.evaluate(() => {
        const host = document.querySelector('.lt-para-host');
        return host?.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
      });
      if (text.startsWith('翻译失败')) throw new Error(text);
      if (!CJK.test(text)) throw new Error(`译文不像中文：${text.slice(0, 60)}`);
      return text.slice(0, 40);
    });

    await check('页面：整页双语对照', async () => {
      await page.evaluate(() => {
        const root = document.getElementById('local-translator-root')?.shadowRoot;
        root?.querySelector('.lt-bubble')?.click();
      });
      // 测试页有 3 个非中文块级段落（英/日/长文），等它们全部出现真实译文
      await page.waitForFunction(() => {
        const hosts = [...document.querySelectorAll('.lt-para-host')];
        return hosts.length >= 3 && hosts.every(node => {
          const text = node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
          return text.length > 0 && text !== '翻译中…';
        });
      }, null, { timeout: 240000 });
      const label = await page.evaluate(() => {
        const root = document.getElementById('local-translator-root')?.shadowRoot;
        return root?.querySelector('.lt-bubble')?.textContent?.trim() ?? '';
      });
      return `按钮状态「${label}」`;
    }, 250000);

    // 真正的「实时」：重新打开页面，一行代码都不点，译文自己出现
    await check('页面：打开网页自动出译文（全程不点任何按钮）', async () => {
      await extensionPage.evaluate(() => chrome.storage.local.set({ autoBilingual: true }));
      await page.reload();
      await page.waitForFunction(() => {
        const hosts = [...document.querySelectorAll('.lt-para-host')];
        return hosts.length >= 3 && hosts.every(node => {
          const text = node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
          return text.length > 0 && text !== '翻译中…';
        });
      }, null, { timeout: 240000 });
      const count = await page.evaluate(() => document.querySelectorAll('.lt-para-host').length);
      return `自动译出 ${count} 段`;
    }, 250000);
  } else {
    skip('页面：悬停翻译（读模式）', '未安装语言包');
    skip('页面：整页双语对照', '未安装语言包');
  }

  await check('页面：回复助手按钮（写模式）', async () => {
    await page.click('#comment');
    await page.waitForSelector('.lt-float', { timeout: 10000 });
    const label = (await page.textContent('.lt-float')).trim();
    if (!label.includes('翻译回复')) throw new Error(`按钮文案不对：${label}`);
    return label;
  }, 30000);

  /* 6. 控制台干净（CSP / 模块 / WASM 这三类的报错都在这里暴露） */
  await check('控制台没有 CSP / 模块 / WASM 报错', () => {
    const fatal = consoleErrors.filter(text =>
      /Content Security Policy|Cannot use import statement|WebAssembly|Uncaught/i.test(text)
    );
    if (fatal.length) throw new Error(`\n    ${fatal.slice(0, 5).join('\n    ')}`);
    return `共收集 ${consoleErrors.length} 条日志，无致命错误`;
  }, 10000);
} finally {
  await context.close().catch(() => {});
  server.close();
}

const failed = results.filter(item => !item.ok);
const skipped = results.filter(item => item.skipped);
console.log(`\n${'─'.repeat(52)}`);
console.log(`通过 ${results.length - failed.length - skipped.length} · 跳过 ${skipped.length} · 失败 ${failed.length}`);
if (failed.length) {
  console.log('\n失败项：');
  for (const item of failed) console.log(`  - ${item.name}：${item.error}`);
  process.exit(1);
}
