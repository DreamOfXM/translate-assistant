/**
 * 「在 App 里翻译这个页面」——注入到 WKWebView 里宿主页面的脚本。
 *
 * 只复用引擎，不复用扩展的运行时：正文识别、双语节点、进视口逐段翻译全部
 * 来自 extension/lib/reader.js，一份实现两个宿主。
 * 翻译请求不发 service worker，走 webkit.messageHandlers 交给原生侧的
 * Bergamot 引擎，所以这条路不要求用户打开任何浏览器开发者开关。
 */

import { createHoverReader } from '../../extension/lib/reader.js';
import { detectLanguageByRatio } from '../../extension/lib/languages.js';
import { translateInSegments } from '../../extension/lib/text.js';
import { PANEL_STYLES } from '../../extension/lib/panel-styles.js';
import { initI18n } from '../../extension/lib/i18n.js';

/** 由原生侧拼在本脚本前面：{ target: 'zh' | 'en' } */
const CONFIG = globalThis.__ltPageConfig ?? {};
const TARGET = CONFIG.target === 'en' ? 'en' : 'zh';

/** 单段翻译的最坏等待：原生侧崩了也要把话回给页面，否则整条队列卡死 */
const REQUEST_TIMEOUT = 90000;

const HOST_ID = 'local-translator-root';

let host = null;
let shadow = null;

function mount() {
  if (host && document.body?.contains(host)) return { host, shadow };
  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_STYLES;
  shadow.append(style);
  (document.body ?? document.documentElement).append(host);
  return { host, shadow };
}

/* ------------------------------ 与原生侧的往返 ------------------------------ */

const pending = new Map();
let sequence = 0;

function bridgeTranslate(text, from, to) {
  const handler = globalThis.webkit?.messageHandlers?.ltPageTranslate;
  if (!handler) return Promise.reject(new Error('原生翻译桥未就绪'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error('原生侧没有回应（引擎可能仍在下载语言包）'));
    }, REQUEST_TIMEOUT);
    pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    try {
      handler.postMessage({ id, text, from, to });
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

globalThis.__ltPageResolve = (id, text) => {
  const task = pending.get(id);
  if (task) { pending.delete(id); task.resolve(text); }
};

globalThis.__ltPageReject = (id, message) => {
  const task = pending.get(id);
  if (task) { pending.delete(id); task.reject(new Error(message)); }
};

async function translateParagraph(text) {
  const source = detectLanguageByRatio(text);
  if (source === TARGET) {
    const error = new Error('这段已经是目标语言。');
    error.silent = true;
    throw error;
  }
  const outcome = await translateInSegments(
    text,
    segment => bridgeTranslate(segment, source, TARGET)
  );
  return outcome.text;
}

/* --------------------------------- 启动 ---------------------------------- */

function start() {
  // 页面可能压根没有 body（框架页、错误页），此时什么都不做
  if (!document.body) return;

  const reader = createHoverReader({
    targetLanguage: TARGET,
    getHost: () => host,
    getShadow: () => mount().shadow,
    translateParagraph,
    onUserIntent: () => {}
  });

  reader.setEnabled(true);
  reader.setPageUi(true);
  reader.setAuto(true);

  globalThis.__ltPageReader = reader;
  globalThis.webkit?.messageHandlers?.ltPageState?.postMessage({
    kind: 'ready', target: TARGET, href: location.href
  });
}

initI18n().then(start).catch(start);
