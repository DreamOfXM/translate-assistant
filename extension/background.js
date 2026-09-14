/**
 * Background Service Worker。
 *
 * 只做三件事：右键菜单、消息路由、把翻译请求转发给离屏文档里的引擎。
 * 它自己不加载 WASM —— MV3 的 Service Worker 不能创建 Web Worker。
 */

import { MESSAGES, EVENTS, HOST, validateTranslateRequest, isValidDirection, packKey } from './lib/protocol.js';

const OFFSCREEN_DOCUMENT = 'offscreen.html';
const REQUEST_TIMEOUT = 300000;
const STARTUP_TIMEOUT = 30000;
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

async function createOffscreenDocument() {
  if (typeof chrome.offscreen?.createDocument !== 'function') {
    throw new Error('当前浏览器不支持离屏文档，请使用 Chrome 109 及以上版本。');
  }
  const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] }) ?? [];

  // Service Worker 重启后，上一次的离屏文档可能还在，但它的端口已经断开且不会自己重连。
  // 与其等它超时，不如直接关掉重建，保证拿到一个会主动连回来的实例。
  if (existing.length) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }

  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_DOCUMENT),
      reasons: [chrome.offscreen.Reason?.WORKERS ?? 'WORKERS'],
      justification: '在离屏文档中加载本地 WASM 翻译引擎；Chrome 扩展的 Service Worker 无法创建 Web Worker。'
    });
  } catch (error) {
    // 已经存在同一个离屏文档时忽略，其它错误照常抛出
    if (!/single offscreen|already exists|Only one/i.test(String(error?.message))) throw error;
  }
}

async function ensureHost() {
  if (hostPort) return hostPort;
  if (creating) return creating;

  creating = (async () => {
    await createOffscreenDocument();
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
    hostPort = null;
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
      return { text: result.text, segments: result.segments ?? 1 };
    }

    case MESSAGES.GET_CATALOG: {
      await ensureHost();
      const result = await request(HOST.OPS.CATALOG, {}, 60000);
      return { catalog: result.catalog };
    }

    case MESSAGES.GET_DIRECTION_STATUS: {
      await ensureHost();
      const result = await request(HOST.OPS.STATUS, {}, 60000);
      return { installed: [...new Set([...(await storedPacks()), ...(result.installed ?? [])])] };
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
    await chrome.contextMenus.removeAll();
    await chrome.contextMenus.create({
      id: MENU_ID,
      title: '翻译选中文本（本地）',
      contexts: ['selection']
    });
  } catch {
    /* 没有菜单权限时静默降级，页面内的按钮仍可用 */
  }
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: EVENTS.SHOW_TRANSLATOR, text: info.selectionText });
  } catch {
    // 页面加载扩展之前就打开了，content script 还没注入；提示用户刷新即可
  }
});
