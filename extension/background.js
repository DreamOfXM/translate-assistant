/**
 * Background Service Worker。
 *
 * 只做三件事：右键菜单、消息路由、把翻译请求转发给离屏文档里的引擎。
 * 它自己不加载 WASM —— MV3 的 Service Worker 不能创建 Web Worker。
 */

import { MESSAGES, EVENTS, HOST, validateTranslateRequest, isValidDirection, packKey } from './lib/protocol.js';
import { initI18n, refreshI18n, t, uiLang } from './lib/i18n.js';

const OFFSCREEN_DOCUMENT = 'offscreen.html';
const REQUEST_TIMEOUT = 300000;
const STARTUP_TIMEOUT = 30000;
/** SW 被回收后，留给旧离屏文档自己重连回来的宽限期。
 *  离屏文档的重连退避从 150ms 起（见 offscreen.js），1.5s 足够覆盖前几次重试，
 *  又不至于让用户在真的需要重建时干等。 */
const RECONNECT_GRACE = 1500;
/** GET_DIRECTION_STATUS 里「顺手合并引擎内存状态」的超时。
 *  storage 的结果本身已经完整，合并只是锦上添花，所以不能让它拖慢这条高频查询。 */
const STATUS_MERGE_TIMEOUT = 4000;
const MENU_ID = 'translate-selection-local';

let hostPort = null;
let creating = null;
const pending = new Map();
const readyWaiters = new Set();
let serial = 0;

/** 离屏文档连上就广播，不等某一次具体的 ensureHost —— 否则 ready 会在竞态里被丢掉 */
function notifyReady() {
  const waiters = [...readyWaiters];
  readyWaiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForHost(timeout) {
  if (hostPort) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      readyWaiters.delete(waiter);
      reject(new Error('本地翻译引擎启动超时，请重新加载扩展后重试。'));
    }, timeout);
    const waiter = () => {
      clearTimeout(timer);
      resolve();
    };
    readyWaiters.add(waiter);
  });
}

/* ------------------------------- 离屏文档生命周期 ------------------------------ */

/**
 * 当前有哪些离屏文档上下文。
 * 返回 null 表示这个浏览器问不出来（chrome.runtime.getContexts 是 Chrome 116+ 才有），
 * 此时只能靠 createDocument 抛「已存在」来兜底判断。
 */
async function offscreenContexts() {
  if (typeof chrome.runtime.getContexts !== 'function') return null;
  try {
    return await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  } catch {
    return null;
  }
}

/**
 * 创建离屏文档。
 * @returns {Promise<boolean>} false 表示「已经存在一个」，调用方应当先等它重连，而不是当成失败
 */
async function createOffscreenDocument() {
  if (typeof chrome.offscreen?.createDocument !== 'function') {
    throw new Error('当前浏览器不支持离屏文档，请使用 Chrome 109 及以上版本。');
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT),
      reasons: [chrome.offscreen.Reason?.WORKERS ?? 'WORKERS'],
      justification: '在离屏文档中加载本地 WASM 翻译引擎；Chrome 扩展的 Service Worker 无法创建 Web Worker。'
    });
    return true;
  } catch (error) {
    // 已经存在同一个离屏文档不算错误，其它错误照常抛出
    if (/single offscreen|already exists|Only one/i.test(String(error?.message))) return false;
    throw error;
  }
}

/**
 * 等旧离屏文档自己连回来；等不到就关掉，为重建腾位置。
 *
 * 关掉是必须的：只要旧文档还在，createDocument 就会一直被「已存在」挡住。
 */
async function reuseOrDiscardHost() {
  await waitForHost(RECONNECT_GRACE).catch(() => {});
  if (hostPort) return true;
  await chrome.offscreen.closeDocument().catch(() => {});
  return false;
}

async function ensureHost() {
  if (hostPort) return hostPort;
  if (creating) return creating;

  creating = (async () => {
    // 离屏文档比 SW 长寿：SW 空闲 30s 被回收后，它内存里已解压的模型还在，
    // 并且它会在端口断开后自己重连（重连本身就会把 SW 唤醒，见 offscreen.js）。
    // 所以这里优先等它连回来，而不是像以前那样直接 close 重建 —— 重建意味着
    // 重新从 Cache Storage 读 ~50MB、解压、SHA-256 校验、重启 worker、重编译 WASM，
    // 对「隔一会儿再翻一次」这种最常见的间歇使用场景，每次都要白付一遍。
    if ((await offscreenContexts())?.length) {
      if (await reuseOrDiscardHost()) return hostPort;
    }

    if (!await createOffscreenDocument()) {
      // 问不到上下文列表（Chrome 116 以下），或者刚好在这期间文档被建了出来：
      // 同样先给它一次重连机会，等不到就关掉重建。
      if (await reuseOrDiscardHost()) return hostPort;
      // 这里再返回 false 说明状态已经不正常了，交给下面的 waitForHost 超时，
      // 超时后的 catch 会把文档关掉，下一次调用即可恢复。
      await createOffscreenDocument();
    }

    // 注意：createDocument 返回时离屏文档往往已经连上了，
    // 所以必须用「等下一次连接」的方式，而不是在 await 之后才挂一次性 resolve。
    await waitForHost(STARTUP_TIMEOUT);
    return hostPort;
  })().catch(async error => {
    // 启动失败就把离屏文档关掉，否则下次 createDocument 会被「已存在」挡住
    await chrome.offscreen.closeDocument?.().catch(() => {});
    throw error;
  }).finally(() => {
    creating = null;
  });

  return creating;
}

function request(op, payload, timeout = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    if (!hostPort) {
      reject(new Error('翻译引擎未就绪，请重试。'));
      return;
    }
    const id = ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('翻译超时。请检查网络后重试，或删除语言包重新下载。'));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    hostPort.postMessage({ id, op, payload });
  });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== HOST.PORT_NAME) return;
  hostPort = port;

  port.onMessage.addListener(message => {
    if (message?.type === 'progress') {
      forwardProgress(message.tabId, message.progress);
      return;
    }
    // 离屏文档每次（重）连上都会补发一条 ready。onConnect 里已经 notifyReady 过一次，
    // 这里再调一次是幂等的：它确认的是「端口通了且消息处理器已挂好」，
    // 顺便避免这条消息落到下面的 pending 查找里变成没人处理的死信。
    if (message?.type === 'ready') {
      notifyReady();
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      const error = new Error(message.error.message);
      if (message.error.name) error.name = message.error.name;
      entry.reject(error);
    } else {
      entry.resolve(message.result);
    }
  });

  port.onDisconnect.addListener(() => {
    // 只清理「当前这一条」端口。离屏文档会自动重连，新端口可能已经赋给 hostPort 了，
    // 旧端口迟到的 onDisconnect 不能把好端端的连接抹掉。
    if (hostPort === port) hostPort = null;
    // 但挂起的请求必须全部作废：它们是发在这条已死的端口上的，永远等不到回复。
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('翻译引擎已停止，请重试。'));
    }
    pending.clear();
  });

  // 离屏文档可能在任何时刻连上来（包括 ensureHost 还没开始等的时候）
  notifyReady();
});

function forwardProgress(tabId, progress) {
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { type: EVENTS.TRANSLATION_PROGRESS, progress }).catch(() => {});
  }
  chrome.runtime.sendMessage({ type: EVENTS.TRANSLATION_PROGRESS, progress }).catch(() => {});
}

/* ---------------------------------- 语言包状态 -------------------------------- */

/**
 * 语言包的已安装状态只由 Service Worker 落盘。
 * 离屏文档实测拿不到 chrome.storage（那里只有 chrome.runtime），不能在引擎侧写。
 */
async function storedPacks() {
  const storage = await chrome.storage.local.get(null);
  return Object.keys(storage).filter(key => key.startsWith('pack:')).map(key => key.slice(5));
}

async function rememberPacks(packs) {
  if (!packs?.length) return;
  const known = new Set(await storedPacks());
  const writes = {};
  for (const pack of packs) {
    if (/^[a-z]{2,3}(_[a-z]+)?-[a-z]{2,3}(_[a-z]+)?$/.test(pack) && !known.has(pack)) {
      writes[packKey(pack)] = { installedAt: Date.now() };
    }
  }
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
}

/* ---------------------------------- 消息路由 ---------------------------------- */

async function handle(message, sender) {
  switch (message?.type) {
    case MESSAGES.TRANSLATE: {
      const check = validateTranslateRequest(message);
      if (!check.ok) return { error: check.error };
      await ensureHost();
      const result = await request(HOST.OPS.TRANSLATE, {
        text: check.value.text,
        source: check.value.source,
        target: check.value.target,
        tabId: sender.tab?.id ?? null
      });
      await rememberPacks(result.installed);
      return { text: result.text, segments: result.segments ?? 1, engine: result.engine ?? 'bergamot' };
    }

    case MESSAGES.GET_CATALOG: {
      await ensureHost();
      const result = await request(HOST.OPS.CATALOG, {}, 60000);
      return { catalog: result.catalog };
    }

    case MESSAGES.GET_DIRECTION_STATUS: {
      // 已安装列表本来就落盘在 chrome.storage.local（每次翻译/预载后 rememberPacks 都会写），
      // 而 content script 每开一个页面、popup/options 每次打开都要查一遍。
      // 为了读它去 ensureHost() 拉起离屏文档 + WASM 引擎 + 抓 registry 是纯浪费，
      // 所以这里只读 storage，绝不主动启动引擎。
      const installed = await storedPacks();
      // 引擎宿主恰好已经在跑，就顺手合并一下内存里的状态（best-effort）：
      // 覆盖「刚加载完还没落盘」和「storage 被清了但模型还在内存」这两种边界。
      // 用短超时，宿主万一卡住也不能拖死这条高频路径。
      if (!hostPort) return { installed };
      try {
        const result = await request(HOST.OPS.STATUS, {}, STATUS_MERGE_TIMEOUT);
        return { installed: [...new Set([...installed, ...(result.installed ?? [])])] };
      } catch {
        return { installed };
      }
    }

    case MESSAGES.PRELOAD_DIRECTION: {
      if (!isValidDirection(message.direction)) return { error: '语言方向格式无效。' };
      await ensureHost();
      const result = await request(HOST.OPS.PRELOAD, { direction: message.direction });
      await rememberPacks(result.installed);
      return { direction: result.direction, packs: result.packs, direct: result.direct };
    }

    case MESSAGES.DELETE_DIRECTION: {
      if (!isValidDirection(message.direction)) return { error: '语言方向格式无效。' };
      await ensureHost();
      const result = await request(HOST.OPS.DELETE, { direction: message.direction });
      await chrome.storage.local.remove(packKey(message.direction));
      return result;
    }

    case MESSAGES.GET_RUNTIME_STATUS:
      return { ready: Boolean(hostPort) };

    default:
      return { error: `未知的消息类型：${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 进度事件由本文件自己广播，不需要再处理
  if (message?.type === EVENTS.TRANSLATION_PROGRESS) return false;

  handle(message, sender).then(sendResponse).catch(error => sendResponse({ error: error?.message ?? String(error) }));
  return true;
});

/* ---------------------------------- 右键菜单 ---------------------------------- */

async function setupContextMenu() {
  try {
    await initI18n();
    await chrome.contextMenus.removeAll();
    await chrome.contextMenus.create({
      id: MENU_ID,
      title: t('menu_translate_selection'),
      contexts: ['selection']
    });
  } catch {
    /* 没有菜单权限时静默降级，页面内的按钮仍可用 */
  }
}

/* 界面语言是运行时设置，右键菜单和工具栏却只在安装/启动时定一次：
   用户改了语言但不重启浏览器的话，它们会一直停在旧语言，所以这里跟着重建。
   （chrome://extensions 里显示的名称只能由 _locales 按浏览器语言决定，运行时改不了。） */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes && 'uiLang' in changes) {
    refreshI18n().then(applyUiLanguage);
  }
});

/**
 * 工具栏图标与悬停提示跟着界面语言走。
 *
 * 图标是两套 PNG：中文「译」和英文「T」，同一版式（见 icons/icon*-src.svg）。
 * manifest 里的 default_title 已走 _locales，这里覆盖一次是为了让它跟
 * uiLang 而不是浏览器语言——两者可以不一致（浏览器中文 + 界面英文）。
 */
const ACTION_ICONS = {
  zh: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  en: { 16: 'icons/icon-en-16.png', 32: 'icons/icon-en-32.png', 48: 'icons/icon-en-48.png', 128: 'icons/icon-en-128.png' }
};

async function applyUiLanguage() {
  await initI18n();
  const icons = ACTION_ICONS[uiLang()] ?? ACTION_ICONS.zh;
  try {
    await chrome.action.setIcon({ path: icons });
  } catch { /* 图标换不了不影响翻译功能 */ }
  try {
    await chrome.action.setTitle({ title: t('action_title') });
  } catch { /* 同上 */ }
}

// 首次安装时打开欢迎页（更新不弹，避免打扰老用户）
chrome.runtime.onInstalled.addListener(details => {
  setupContextMenu();
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/welcome.html') });
  }
});
chrome.runtime.onStartup.addListener(setupContextMenu);

/* 工具栏图标校正放在模块顶层：SW 每次被唤醒都会跑一遍。
   只挂 onInstalled/onStartup 不够——在 chrome://extensions 点「重新加载」
   不保证触发这两个事件，图标会停在旧语言。 */
applyUiLanguage();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: EVENTS.SHOW_TRANSLATOR, text: info.selectionText });
  } catch {
    // 页面加载扩展之前就打开了，content script 还没注入；提示用户刷新即可
  }
});
