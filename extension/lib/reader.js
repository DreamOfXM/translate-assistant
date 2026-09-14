/**
 * 悬停阅读翻译（「读」模式）。
 *
 * 交互：鼠标悬停在段落上，段落右上角出现「译」按钮；点击后在该段落下方
 * 插入一段双语译文（Shadow DOM，不受网页样式影响），可切回原文、复制、收起。
 * 再次点「译」等于显示/隐藏已有的译文。
 *
 * 整页双语对照：右下角悬浮「双语对照」按钮，点击后从上到下逐段自动翻译，
 * 译文逐段插在原文下面（类似沉浸式翻译）；再点一下收起全部译文。
 *
 * 边界：
 * - 只做「读」的方向：源语言自动识别，目标固定中文；中文段落不出按钮。
 * - 不碰任何输入框（那是「写」模式 / 回复助手的职责）。
 * - 按钮和译文都挂在扩展自己的 Shadow DOM 里，绝不修改页面内容本身。
 */

import { detectLanguageByRatio } from './languages.js';
import { MAX_TEXT_LENGTH } from './text.js';

/** popup 与 content script 共用的开关存储键 */
export const HOVER_STORAGE_KEY = 'hoverTranslate';
/** 右下角悬浮按钮（整页双语对照）是否出现 */
export const PAGE_STORAGE_KEY = 'pageBilingual';
/** 打开网页后是否自动逐段翻译，不需要点任何按钮 */
export const AUTO_STORAGE_KEY = 'autoBilingual';

const BLOCK_SELECTOR =
  'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption,td,th,pre';

/** 整页翻译一次最多处理的段落数，防止超长页面把引擎占死 */
const BATCH_LIMIT = 200;

const BUBBLE_IDLE = '双语对照';

const PARA_STYLES = `
:host { all: initial; }
.lt-wrap {
  margin: 8px 0 4px;
  padding: 10px 12px;
  border-left: 3px solid #1a73e8;
  border-radius: 6px;
  background: #f8f9fa;
  color: #202124;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.lt-para-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.lt-para-text.lt-para-error { color: #b3261e; }
.lt-para-ops { margin-top: 6px; display: flex; gap: 10px; }
.lt-para-ops button {
  border: 0; background: transparent; padding: 2px 4px;
  color: #1a73e8; font-size: 12px; cursor: pointer; border-radius: 4px; font-family: inherit;
}
.lt-para-ops button:hover { background: #e8f0fe; }
.lt-bubble {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  border: 0;
  border-radius: 999px;
  padding: 9px 15px;
  background: #1a73e8;
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 3px 10px rgba(0,0,0,.28);
  cursor: pointer;
}
.lt-bubble:hover { background: #1765cc; }
@media (prefers-color-scheme: dark) {
  .lt-wrap { background: #35363a; color: #e8eaed; border-color: #8ab4f8; }
  .lt-para-ops button { color: #8ab4f8; }
  .lt-para-ops button:hover { background: #3c4043; }
  .lt-para-text.lt-para-error { color: #f28b82; }
  .lt-bubble { background: #8ab4f8; color: #202124; }
  .lt-bubble:hover { background: #aecbfa; }
}
`;

function element(tag, className, properties = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, properties);
  return node;
}

/** 段落文本：优先 innerText（贴近用户所见），取不到或为空时退回 textContent */
function paragraphText(el) {
  const visible = typeof el.innerText === 'string' ? el.innerText : '';
  return String(visible.trim() ? visible : el.textContent ?? '').trim();
}

/**
 * 构建插入到段落旁的译文节点。译文插在页面原段落下方，
 * 不再把原文重复一遍——原段落就在上面，重复显示是多余的。
 * @returns {{host: HTMLElement, toggle: () => void, setText: (value: string) => void, setError: (message: string) => void}}
 */
function buildResult() {
  const host = element('div', 'lt-para-host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${PARA_STYLES}</style>
    <div class="lt-wrap">
      <p class="lt-para-text">翻译中…</p>
      <div class="lt-para-ops">
        <button class="lt-para-copy" type="button" disabled>复制</button>
        <button class="lt-para-hide" type="button">收起</button>
      </div>
    </div>`;

  const textNode = root.querySelector('.lt-para-text');
  const copyButton = root.querySelector('.lt-para-copy');
  root.querySelector('.lt-para-hide').onclick = () => { host.hidden = true; };

  let translation = '';

  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(translation);
      copyButton.textContent = '已复制';
      setTimeout(() => { copyButton.textContent = '复制'; }, 1200);
    } catch {
      /* 没有剪贴板权限时静默失败，用户仍可手动选择译文 */
    }
  };

  return {
    host,
    toggle: () => { host.hidden = !host.hidden; },
    setText: value => {
      translation = value;
      textNode.textContent = value;
      textNode.className = 'lt-para-text';
      copyButton.disabled = false;
    },
    setError: message => {
      textNode.textContent = `翻译失败：${message}`;
      textNode.className = 'lt-para-text lt-para-error';
    }
  };
}

/**
 * 创建悬停阅读器。
 * @param {object} deps
 * @param {() => HTMLElement|null} deps.getHost 扩展的根挂载点（用于判断事件是否来自自己的 UI）
 * @param {() => ShadowRoot} deps.getShadow 懒创建 Shadow Root（第一次真正需要显示按钮时才挂载）
 * @param {(text: string) => Promise<string>} deps.translateParagraph 翻译一段文本
 */
export function createHoverReader({ getHost, getShadow, translateParagraph }) {
  let enabled = false;
  let target = null;               // 当前悬停的段落
  let pill = null;                 // 段落旁的「译」按钮
  const results = new WeakMap();   // 段落 → 译文节点控制器

  /* ------------------------------ 整页双语对照 ------------------------------ */

  let bubble = null;               // 右下角悬浮按钮
  let pageUi = false;              // 悬浮按钮是否显示
  let liveMode = false;            // 自动模式：段落进入视口就翻
  let active = false;              // 翻译队列是否还在工作
  let allRequested = false;        // 手动点过「双语对照」：不在视口的也翻
  const queue = [];                // 待翻译段落
  const seen = new WeakSet();      // 已发现过的段落（去重）
  let queued = new WeakSet();      // 已入队的段落（去重）；收起译文后重置
  const batchNodes = [];           // 本页插入过的全部译文节点（含单个点的）
  let discovered = 0;
  let completed = 0;
  let observer = null;             // IntersectionObserver：进视口才翻
  let mutationObserver = null;
  let mutationTimer = null;

  const hidePill = () => {
    pill?.remove();
    pill = null;
    target = null;
  };

  const positionPill = () => {
    if (!pill || !target) return;
    const rect = target.getBoundingClientRect();
    if (!rect.width && !rect.height) {
      hidePill();
      return;
    }
    pill.style.left = `${Math.min(Math.max(8, rect.right - 30), window.innerWidth - 38)}px`;
    pill.style.top = `${Math.min(Math.max(8, rect.top + 2), window.innerHeight - 34)}px`;
  };

  const showPill = el => {
    if (pill && target === el) return;
    hidePill();
    target = el;
    pill = element('button', 'lt-hover-pill', { type: 'button', title: '翻译这一段', textContent: '译' });
    pill.onclick = () => {
      const current = target;
      hidePill();
      handle(current);
    };
    getShadow().append(pill);
    positionPill();
  };

  /** 把一段译文插到段落旁边；已有译文时只是重新展开 */
  const translateInto = async el => {
    const existing = results.get(el);
    if (existing && existing.host.isConnected) {
      existing.host.hidden = false;
      return existing;
    }

    const text = paragraphText(el);
    const node = buildResult();
    results.set(el, node);
    batchNodes.push(node);
    // 列表项把译文放进项内，避免破坏列表结构；其余元素插到后面
    if (el.tagName === 'LI') el.append(node.host);
    else el.after(node.host);

    try {
      node.setText(await translateParagraph(text));
    } catch (error) {
      // 段落本身就是目标语言（如混排页面里的纯中文段）：静默撤掉节点，不弹错误卡片
      if (error?.silent) {
        node.host.remove();
        results.delete(el);
        return null;
      }
      node.setError(error?.message ?? String(error));
    }
    return node;
  };

  const handle = async el => {
    const existing = results.get(el);
    if (existing && existing.host.isConnected) {
      // 页面没有重新渲染：再点一次只是显示 / 收起
      existing.toggle();
      return;
    }
    await translateInto(el);
  };

  /* ------------------------- 整页双语对照：收集与执行 ------------------------ */

  /** 可见性按矩形判断，导航模板、广告位这类 0 尺寸块直接跳过 */
  const isVisible = el => {
    const rect = el.getBoundingClientRect();
    return Boolean(rect.width || rect.height);
  };

  /**
   * 收集要翻译的段落：只取「叶子块」（内部不再包含更小的块），
   * 避免 `blockquote > p` 被翻两遍；过滤中文段和输入框。
   */
  const collectBlocks = (root = document) => {
    const blocks = [];
    for (const el of root.querySelectorAll(BLOCK_SELECTOR)) {
      if (blocks.length >= BATCH_LIMIT) break;
      if (el.closest('input,textarea,select,[contenteditable="true"]')) continue;
      if (el.isContentEditable) continue;
      if (el.querySelector(BLOCK_SELECTOR)) continue;
      if (!isVisible(el)) continue;
      const text = paragraphText(el);
      if (text.length < 2 || text.length > MAX_TEXT_LENGTH) continue;
      if (detectLanguageByRatio(text) === 'zh') continue;
      blocks.push(el);
    }
    return blocks;
  };

  const hideAll = () => {
    for (const node of batchNodes) node.host.hidden = true;
    queued = new WeakSet();   // 收起后再点「双语对照」要能重新入队
    if (bubble) bubble.textContent = BUBBLE_IDLE;
  };

  const updateBubble = () => {
    if (!bubble) return;
    bubble.textContent = queue.length
      ? `翻译中 ${completed}/${Math.max(discovered, completed)} · 点击停止`
      : completed
        ? `已译 ${completed} 段 · 收起`
        : BUBBLE_IDLE;
  };

  /** 队列串行消费：翻译本来就是排队执行的，页面本身不能被卡住 */
  const pump = async () => {
    if (active) return;   // 已经在消费队列，新段落会被同一个循环带走
    active = true;
    while (queue.length) {
      const el = queue.shift();
      if (!el?.isConnected) continue;
      await translateInto(el);
      completed += 1;
      updateBubble();
      // 每段之间让出主线程，滚动和输入不掉帧
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    active = false;
    updateBubble();
  };

  const enqueue = el => {
    if (queued.has(el)) return;
    queued.add(el);
    queue.push(el);
    pump();
  };

  /** 没有 IntersectionObserver 的环境（如 jsdom）直接全量入队 */
  const ensureObserver = () => {
    if (observer || typeof IntersectionObserver !== 'function') return observer;
    observer = new IntersectionObserver(entries => {
      let added = false;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        queue.push(entry.target);
        added = true;
      }
      if (added) pump();
    }, { rootMargin: '300px 0px' });
    return observer;
  };

  /** 把新出现的段落纳入观察；immediate 或没有观察器时直接入队 */
  const scan = (root = document, { immediate = false } = {}) => {
    const observerReady = ensureObserver();
    for (const el of collectBlocks(root)) {
      const existing = results.get(el);
      // 译文节点被页面拿掉了（SPA 重渲染等），这段要当成没翻过，重新来
      const stale = Boolean(existing && !existing.host.isConnected);
      if (stale) {
        seen.delete(el);
        queued.delete(el);
      }
      if (seen.has(el)) continue;
      seen.add(el);
      discovered += 1;
      if (immediate || !observerReady) enqueue(el);
      else observerReady.observe(el);
    }
  };

  /** 动态页面（无限滚动、SPA）新插入的段落也要翻 */
  const watchDom = () => {
    if (mutationObserver || typeof MutationObserver !== 'function') return;
    mutationObserver = new MutationObserver(() => {
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(() => scan(), 400);
    });
    mutationObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true
    });
  };

  const stopWatching = () => {
    observer?.disconnect();
    observer = null;
    mutationObserver?.disconnect();
    mutationObserver = null;
    clearTimeout(mutationTimer);
  };

  const stop = () => {
    active = false;
    liveMode = false;
    allRequested = false;
    queue.length = 0;
    queued = new WeakSet();   // 停止后重新开始时要能重新入队
    stopWatching();
    updateBubble();
  };

  /** 自动模式：页面加载完就跑，段落滚进视口即翻译 */
  const startLive = () => {
    if (liveMode) return;
    liveMode = true;
    allRequested = false;
    scan();
    watchDom();
    pump();
  };

  /** 手动点「双语对照」：整页都翻，不只在视口里的 */
  const runAll = () => {
    allRequested = true;
    liveMode = false;
    scan(document, { immediate: true });
    // 之前只是被观察着的段落（还没滚到）也一起翻
    for (const el of collectBlocks()) enqueue(el);
    watchDom();
    if (!queue.length && bubble) {
      bubble.textContent = '没有需要翻译的段落';
      setTimeout(() => {
        if (!queue.length && bubble) bubble.textContent = BUBBLE_IDLE;
      }, 1600);
    }
    pump();
  };

  const ensureBubble = () => {
    if (bubble?.isConnected) return bubble;
    bubble = element('button', 'lt-bubble', {
      type: 'button',
      title: '整页逐段翻译，译文插在每段原文下面',
      textContent: BUBBLE_IDLE
    });
    bubble.onclick = () => {
      if (active && queue.length) {
        stop();
        return;
      }
      if (batchNodes.some(node => node.host.isConnected && !node.host.hidden)) {
        hideAll();
        return;
      }
      runAll();
    };
    getShadow().append(bubble);
    return bubble;
  };

  const onMouseOver = event => {
    if (!enabled) {
      if (pill) hidePill();
      return;
    }
    if (event.composedPath?.().includes(getHost())) return;

    const el = event.target?.closest?.(BLOCK_SELECTOR);
    if (!el || el === target) return;
    if (el.isContentEditable) return hidePill();
    if (el.closest('input,textarea,select,[contenteditable="true"]')) return hidePill();

    const text = paragraphText(el);
    if (text.length < 2 || text.length > MAX_TEXT_LENGTH) return hidePill();
    // 中文段落对中文读者没有翻译价值，不出按钮
    if (detectLanguageByRatio(text) === 'zh') return hidePill();

    showPill(el);
  };

  const onMouseOut = event => {
    if (!pill || !target) return;
    // 鼠标移出目标段落且不是移向按钮本身时收起按钮
    if (event.target === target && !event.relatedTarget?.closest?.(BLOCK_SELECTOR)) hidePill();
  };

  document.addEventListener('mouseover', onMouseOver, { passive: true });
  document.addEventListener('mouseout', onMouseOut, { passive: true });
  window.addEventListener('scroll', hidePill, { passive: true });
  window.addEventListener('resize', hidePill, { passive: true });

  return {
    /** 悬停出「译」按钮（单段翻译） */
    setEnabled(value) {
      enabled = Boolean(value);
      if (!enabled) hidePill();
    },
    /** 右下角悬浮按钮是否出现（与悬停开关互相独立） */
    setPageUi(value) {
      pageUi = Boolean(value);
      if (!pageUi) {
        stop();
        bubble?.remove();
        bubble = null;
        return;
      }
      ensureBubble();
      updateBubble();
    },
    /** 打开网页后自动逐段翻译，全程不需要点任何按钮 */
    setAuto(value) {
      if (value) {
        if (!pageUi) this.setPageUi(true);
        startLive();
        return;
      }
      if (liveMode) stop();
    },
    /** 供测试注入事件 */
    _onMouseOver: onMouseOver,
    _hidePill: hidePill,
    _collectBlocks: collectBlocks,
    _runAll: runAll,
    _startLive: startLive,
    _stop: stop,
    _bubble: () => bubble
  };
}
