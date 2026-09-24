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
const extensionPath = join(projectRoot, 'dist', 'translate-assistant');
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

/* 网页版邮箱的形状复刻：写信页本身在一个 iframe 里，正文编辑器再套一层。
   QQ 邮箱就是这个形状（#mainFrame → iframe.qmEditorIfrmEditArea），
   用来验证「翻译回复」能挂进子框架，而不是只听顶层文档的动静。 */
const MAIL_BODY = `<!doctype html><html lang="en"><body style="margin:0">
<div id="mail-editor" contenteditable="true"
     style="min-height:120px;padding:8px;font:14px/1.6 sans-serif">Thanks for the quick turnaround on the deck.</div>
</body></html>`;

const MAIL_FRAME = `<!doctype html><html lang="en"><body style="margin:0">
<iframe id="mail-frame" src="/mail-body.html" style="width:640px;height:200px;border:0"></iframe>
</body></html>`;

/* 另一类编辑器：about:blank 上 document.write 出来（对应清单里的 match_about_blank） */
const MAIL_BLANK = `<!doctype html><html lang="en"><body style="margin:0">
<iframe id="blank-frame" style="width:640px;height:200px;border:0"></iframe>
<script>
  const frame = document.getElementById('blank-frame');
  frame.contentDocument.open();
  frame.contentDocument.write('<div id="blank-editor" contenteditable="true" style="min-height:120px;padding:8px;font:14px/1.6 sans-serif">Please confirm the schedule.</div>');
  frame.contentDocument.close();
</script>
</body></html>`;

function serveTestPage() {
  const routes = new Map([
    ['/', readFileSync(testPage)],
    ['/mail-frame.html', Buffer.from(MAIL_FRAME)],
    ['/mail-body.html', Buffer.from(MAIL_BODY)],
    ['/mail-blank.html', Buffer.from(MAIL_BLANK)]
  ]);
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://127.0.0.1');
    const html = routes.get(pathname);
    if (!html) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}`, url: `http://127.0.0.1:${port}/` });
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
  // 标上「未捕获异常」：末段检查据此一律判为致命。扩展自己抛的 ReferenceError
  // 就是这样露出来的（popup 点翻译毫无反应，只因控制台里多了一行没被归类的报错）。
  page.on('pageerror', error => consoleErrors.push(`[${label}] 未捕获异常：${error.message}`));
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
const { server, url, origin } = await serveTestPage();

const executablePath = resolveExecutable(chromium);
// 默认有头（老 headless 不支持扩展）；新版 headless 已经支持，无人值守时用
// E2E_HEADLESS=1 跑，免得弹窗（也免得在没有图形会话的环境里直接起不来）
const headless = process.env.E2E_HEADLESS === '1';
const context = await chromium.launchPersistentContext(profileDir, {
  headless,
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

  /* 2. 扩展页面可用（固定中文 UI，断言按中文文案走）
     三个开关必须在这里显式写死：它们持久在 .chrome-profile 里，而这套 profile
     会被别的进程共用（录 README 配图的脚本用的就是同一个目录）。上一版只在
     第 6 节才第一次写 pageBilingual，于是前面几节的悬浮按钮在不在，
     取决于上一次谁用过这个 profile —— 红了两条却跟被测代码无关。 */
  await worker.evaluate(() => chrome.storage.local.set({
    uiLang: 'zh', pageBilingual: true, autoBilingual: false, hoverTranslate: false
  }));
  extensionPage = await context.newPage();
  watchPage(extensionPage, 'popup');
  await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await check('popup 打开无脚本报错', async () => {
    await extensionPage.waitForSelector('#source', { timeout: 15000 });
    const title = await extensionPage.textContent('.brand, h1').catch(() => null);
    return title ? `标题「${title.trim()}」` : 'DOM 就绪';
  }, 30000);

  /* 2.5 popup 高度上界
     Chrome 弹窗最高 600px，超出就出现滚动条、页脚那行「已安装 N 个语言包 /
     语言包管理」会被挤出可视区。英文副标题换行成两行，比中文高约 45px，
     所以中英都要量——只在中文下量会漏掉英文的回归。 */
  await check('popup 高度不超 600px（页脚语言包行不用下拉）', async () => {
    const measure = async lang => {
      await worker.evaluate(l => chrome.storage.local.set({ uiLang: l }), lang);
      await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`);
      await extensionPage.waitForSelector('#source', { timeout: 15000 });
      await extensionPage.waitForTimeout(300); // 等 refreshPacks() 落定
      return extensionPage.evaluate(() => {
        const onboard = document.getElementById('onboard');
        const previous = onboard.hidden;
        onboard.hidden = true; // 模拟「已装语言包、引导卡收起」——这时页脚必须直接可见
        const height = document.body.scrollHeight;
        onboard.hidden = previous;
        return height;
      });
    };
    const zh = await measure('zh');
    const en = await measure('en');
    await worker.evaluate(() => chrome.storage.local.set({ uiLang: 'zh' }));
    await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`);
    await extensionPage.waitForSelector('#source', { timeout: 15000 });
    if (zh > 600 || en > 600) {
      throw new Error(`超过 Chrome 弹窗上限：中文 ${zh}px / 英文 ${en}px（上限 600px）`);
    }
    return `中文 ${zh}px · 英文 ${en}px · 上限 600px`;
  }, 90000);

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
      try {
        await extensionPage.waitForFunction(() => {
          const node = document.getElementById('result');
          return node && !node.classList.contains('placeholder') && node.textContent.trim().length > 0;
        }, null, { timeout: 170000 });
      } catch {
        // 超时只能说「没出译文」，把界面上的说法带出来才知道卡在哪一步
        const [result, note] = await extensionPage.evaluate(() => [
          document.getElementById('result')?.textContent?.trim() ?? '',
          document.getElementById('status')?.textContent?.trim() ?? ''
        ]);
        throw new Error(`译文框超时：result=「${result}」status=「${note}」`);
      }
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

  /** 页面里各译文节点的当前文案；超时时用来说明「没翻出来」还是「压根没开始」 */
  const paragraphState = () => page.evaluate(() =>
    [...document.querySelectorAll('.lt-para-host')].map(node =>
      node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim().slice(0, 24) ?? '(空)'
    ));

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
      const paragraph = page.locator(hoverTarget);
      await paragraph.scrollIntoViewIfNeeded();
      /* 「把指针放到段落上」不等于「触发 mouseover」。指针本来就在目标元素里、
         或者上一步的滚动把段落挪到了静止的指针底下，Chromium 都不补发 mouseover，
         扩展压根不知道有段落被悬停 —— 实测三次里漏一次。先甩到左上角空白再回来，
         保证每次都实打实跨一次元素边界。 */
      const hoverOn = async () => {
        await page.mouse.move(4, 4);
        await page.waitForTimeout(150);
        await paragraph.hover();
      };
      await hoverOn();
      const shown = await page.waitForSelector('.lt-hover-pill', { timeout: 6000 })
        .then(() => true).catch(() => false);
      if (!shown) {
        await hoverOn();
        await page.waitForSelector('.lt-hover-pill', { timeout: 6000 });
      }
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
      try {
        await page.waitForFunction(() => {
          const hosts = [...document.querySelectorAll('.lt-para-host')];
          return hosts.length >= 3 && hosts.every(node => {
            const text = node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
            return text.length > 0 && text !== '翻译中…';
          });
        }, null, { timeout: 240000 });
      } catch {
        // 悬浮按钮上写着「为什么不翻」（本来就是中文页 / 缺语言包 / 内建模型待下载），
        // 这是判断「功能坏了」还是「页面没有可翻的东西」的关键证据
        const label = await page.evaluate(() => {
          const root = document.getElementById('local-translator-root')?.shadowRoot;
          return root?.querySelector('.lt-bubble')?.textContent?.trim() ?? '(没有悬浮按钮)';
        });
        throw new Error(`段落译文没齐：${JSON.stringify(await paragraphState())} 按钮=「${label}」`);
      }
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
      try {
        await page.waitForFunction(() => {
          const hosts = [...document.querySelectorAll('.lt-para-host')];
          return hosts.length >= 3 && hosts.every(node => {
            const text = node.shadowRoot?.querySelector('.lt-para-text')?.textContent?.trim() ?? '';
            return text.length > 0 && text !== '翻译中…';
          });
        }, null, { timeout: 240000 });
      } catch {
        throw new Error(`重新打开后没有自动出译文：${JSON.stringify(await paragraphState())}`);
      }
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

  /* 5.1 三种可编辑元素都要能挂上入口。
     富文本（contenteditable）这条尤其要紧：网页版邮箱、工单系统、论坛的正文框
     几乎都是这种，靠 textarea 一条用例保不住。

     注意：上一个输入框失焦后按钮要 300ms 才摘掉，这段窗口里 DOM 上会同时存在
     两个按钮，所以必须等它稳定到只剩一个再断言 —— 否则会看到过期的那个。 */
  const focusEditable = async selector => {
    await page.click(selector);
    await page.waitForSelector('.lt-float', { timeout: 10000 });
    for (let i = 0; i < 20; i += 1) {
      if ((await page.locator('.lt-float').count()) <= 1) break;
      await page.waitForTimeout(100);
    }
    const button = page.locator('.lt-float');
    if ((await button.count()) !== 1) {
      throw new Error(`焦点稳定后应当只剩一个回复入口，实际 ${await button.count()} 个`);
    }
    return button;
  };

  await check('页面：单行输入框也能挂上回复入口', async () => {
    const button = await focusEditable('#title');
    return (await button.textContent()).trim();
  }, 30000);

  await check('页面：富文本编辑器（contenteditable）也能挂上回复入口', async () => {
    const button = await focusEditable('#editor');
    // 顺带确认按钮贴在编辑器旁边，而不是留在上一个输入框那边
    const box = await page.locator('#editor').boundingBox();
    const spot = await button.boundingBox();
    if (!box || !spot) throw new Error('拿不到坐标');
    if (Math.abs(spot.y - box.y) > 80) {
      throw new Error(`按钮没跟着富文本框走：editor.y=${box.y} button.y=${spot.y}`);
    }
    return (await button.textContent()).trim();
  }, 30000);

  /* 5.2 密码框不能挂入口：往密码框里写译文毫无意义，还容易踩到敏感字段 */
  await check('页面：密码框不挂回复入口', async () => {
    await page.click('#secret');
    await page.waitForTimeout(900); // 等最后一个按钮自行摘掉
    const count = await page.locator('.lt-float').count();
    if (count !== 0) throw new Error(`密码框上不该出现回复入口，却找到 ${count} 个`);
    return '密码框没有入口';
  }, 30000);

  /* 5.3 富文本写信框的完整闭环：写草稿 → 出译文 → 确认填入。
     网页版邮箱、工单系统、论坛的回复框几乎都是 contenteditable，
     「能不能在邮件里回信」实际就取决于这一段跑不跑得通。 */
  if (canTranslate) {
    await check('页面：富文本框里的回复闭环（草稿 → 译文 → 确认填入）', async () => {
      const draft = 'The gap is what I work on — visibility for projects that deserve it.';
      await page.fill('#editor', draft);
      await page.click('#editor');

      const button = await focusEditable('#editor');
      await button.click();

      // 已有草稿时走的是「就地出译文条」，不是完整面板
      await page.waitForSelector('.lt-card.lt-inline', { timeout: 15000 });
      await page.waitForSelector('.lt-card.lt-inline .lt-result:not(.placeholder)', { timeout: 60000 });
      const translated = (await page.textContent('.lt-card.lt-inline .lt-result')).trim();
      if (!translated || translated === draft) throw new Error(`译文没出来：${translated}`);
      if (!/[\u4e00-\u9fff]/.test(translated)) throw new Error(`译文里没有中文：${translated}`);

      // 只有点了「填入」才会写回输入框
      await page.click('.lt-fill');
      await page.waitForFunction(
        expected => document.getElementById('editor').innerText.trim() === expected,
        translated,
        { timeout: 15000 }
      );
      const filled = await page.evaluate(() => document.getElementById('editor').innerText.trim());
      if (filled !== translated) throw new Error(`填入结果不符：${filled}`);
      return `「${draft.slice(0, 24)}…」→「${translated.slice(0, 24)}…」`;
    }, 120000);
  } else {
    skip('页面：富文本框里的回复闭环（草稿 → 译文 → 确认填入）', '未安装 en-zh');
  }

  /* 6. 子框架（iframe）里的输入框。
     网页版邮箱、论坛、工单系统的正文框几乎都在 iframe 里，QQ 邮箱还是 mainFrame
     里再套一层编辑器 iframe。这正是「能不能在网页里回邮件」的分水岭：
     清单里没有 all_frames / match_about_blank，焦点事件就不会出现在扩展看得见的文档里。 */
  await extensionPage.evaluate(() => chrome.storage.local.set({
    pageBilingual: true, autoBilingual: false, hoverTranslate: false
  }));

  await check('子框架：iframe 里的富文本编辑器能挂上回复入口', async () => {
    const framePage = await context.newPage();
    watchPage(framePage, 'mail-frame');
    await framePage.goto(`${origin}/mail-frame.html`);
    const inner = framePage.frameLocator('#mail-frame');
    await inner.locator('#mail-editor').click();
    const button = inner.locator('.lt-float');
    await button.waitFor({ timeout: 10000 });
    const label = (await button.textContent()).trim();
    if (!label.includes('翻译回复')) throw new Error(`按钮文案不对：${label}`);
    // 按钮必须挂在这个 iframe 自己的文档里，而不是顶层文档算错坐标后飘过来
    const strays = await framePage.locator('.lt-float').count();
    if (strays !== 0) throw new Error(`顶层文档不该有输入框入口，却找到 ${strays} 个`);
    await framePage.close();
    return label;
  }, 40000);

  await check('子框架：about:blank 里 document.write 的编辑器也能挂上', async () => {
    const framePage = await context.newPage();
    watchPage(framePage, 'mail-blank');
    await framePage.goto(`${origin}/mail-blank.html`);
    const inner = framePage.frameLocator('#blank-frame');
    await inner.locator('#blank-editor').click();
    const button = inner.locator('.lt-float');
    await button.waitFor({ timeout: 10000 });
    // 先读文案再关页面：关掉之后 locator 就没有可查的上下文了
    const label = (await button.textContent()).trim();
    await framePage.close();
    return label;
  }, 40000);

  await check('子框架：不跟着注入整页对照悬浮按钮', async () => {
    const framePage = await context.newPage();
    watchPage(framePage, 'mail-frame');
    await framePage.goto(`${origin}/mail-frame.html`);
    // 顶层文档该有的照旧要有，否则「子框架没有」证明不了什么
    await framePage.locator('.lt-bubble').waitFor({ timeout: 10000 });
    const inner = await framePage.frameLocator('#mail-frame').locator('.lt-bubble').count();
    await framePage.close();
    if (inner !== 0) throw new Error(`子框架里不该出现整页对照按钮，却找到 ${inner} 个`);
    return '顶层有、子框架没有';
  }, 40000);

  /* 7. 控制台干净（CSP / 模块 / WASM 这三类的报错都在这里暴露） */
  await check('控制台没有 CSP / 模块 / WASM 报错', () => {
    const fatal = consoleErrors.filter(text =>
      /未捕获异常|Content Security Policy|Cannot use import statement|WebAssembly|Uncaught/i.test(text)
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
