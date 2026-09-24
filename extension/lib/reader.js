/**
 * 悬停阅读翻译（「读」模式）。
 *
 * 交互：鼠标悬停在段落上，段落右上角出现「译」按钮；点击后在该段落下方
 * 插入一段双语译文（Shadow DOM，不受网页样式影响），可切回原文、复制、收起。
 * 再次点「译」等于显示/隐藏已有的译文。
 *
 * 整页双语对照：右下角悬浮「双语对照」按钮，点击后从上到下逐段自动翻译，
 * 译文逐段插在原文下面（类似沉浸式翻译）；再点一下收起全部译文。
 * 翻译范围限定在页面正文主体（见 lib/content-extract.js），导航、侧栏、广告、页脚、
 * 评论都不插译文；识别不出正文根时退回翻所有合格块，宁可多翻也不漏掉真正的正文。
 *
 * 边界：
 * - 只做「读」的方向：源语言自动识别，目标固定中文；中文段落不出按钮。
 * - 不碰任何输入框（那是「写」模式 / 回复助手的职责）。
 * - 按钮和译文都挂在扩展自己的 Shadow DOM 里，绝不修改页面内容本身。
 */

import { detectLanguageByRatio } from './languages.js';
import { MAX_TEXT_LENGTH } from './text.js';
import { findMainContentRoot, shouldSkipBlock, looksLikeAppPage } from './content-extract.js';
import { t } from './i18n.js';

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

/** DOM 变动的合并窗口：无限滚动/SPA 一次能连着插入几十个节点，逐个重扫没有意义 */
const MUTATION_DEBOUNCE = 400;

const bubbleIdle = () => t('bubble_idle');

const PARA_STYLES = `
:host { all: initial; }
/* 必须显式补一条：all: initial 会把 host 的 display 重置成 inline，
   而它是作者样式，优先级高于 UA 的 [hidden]{display:none}——
   所以凡是靠 hidden 属性控制显隐的面板，都要带上这一行。 */
:host([hidden]) { display: none !important; }
.lt-wrap {
  position: relative;
  /* 短译文（标题、导航项）贴内容宽度，不撑满整行；长段落自然到 100% */
  width: fit-content;
  max-width: 100%;
  margin: 8px 0 4px;
  padding: 10px 14px;
  border-radius: 20px;
  /* 整块淡蓝填充就是「这是译文」的唯一标记，不再叠左竖线。
     必须是半透明：这段要插进任意宿主网页，写死 #E8F0FE 在有色背景上会脏。 */
  background: rgba(26, 115, 232, .10);
  color: #202124;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  animation: lt-para-in 200ms ease-out;
}
@keyframes lt-para-in {
  from { opacity: 0; transform: translateY(3px); }
  to { opacity: 1; transform: none; }
}
.lt-para-text { margin: 0; white-space: pre-wrap; word-break: break-word; }
.lt-para-text.lt-para-error { color: #D93025; }
/* 操作按钮默认隐藏，悬停译文节点时浮现——整页几十段常驻「复制/收起」是纯噪音。
   浮在节点右上角的小胶囊（沉浸式翻译同款位置），不占布局、不把短节点撑高 */
.lt-para-ops {
  position: absolute;
  top: 6px;
  right: 8px;
  display: flex;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .96);
  box-shadow: 0 1px 3px rgba(60, 64, 67, .20), 0 1px 3px 1px rgba(60, 64, 67, .10);
  opacity: 0;
  transition: opacity 150ms;
}
.lt-wrap:hover .lt-para-ops,
.lt-wrap:focus-within .lt-para-ops { opacity: 1; }
.lt-para-ops button {
  border: 0; background: transparent; padding: 3px 8px;
  color: #1A73E8; font-size: 12px; font-weight: 500; cursor: pointer; border-radius: 999px; font-family: inherit;
  transition: background 150ms;
}
.lt-para-ops button:hover { background: rgba(26, 115, 232, .10); }
/* .lt-bubble（右下角悬浮按钮）的样式在 lib/panel-styles.js——它挂在主 shadow root，
   这里只管段落译文节点自己的样子 */
@media (prefers-reduced-motion: reduce) {
  .lt-wrap { animation: none; }
  .lt-para-ops { transition: none; }
}
/* 暗色适配由 JS 检测页面真实背景后加 host.lt-dark（见 isDarkBackground），
   不用 prefers-color-scheme：页面主题（暗色站点）与系统偏好经常不一致 */
:host(.lt-dark) .lt-wrap { background: rgba(138, 180, 248, .16); color: #E8EAED; }
:host(.lt-dark) .lt-para-ops { background: rgba(32, 33, 36, .96); box-shadow: 0 1px 3px rgba(0, 0, 0, .5); }
:host(.lt-dark) .lt-para-ops button { color: #8AB4F8; }
:host(.lt-dark) .lt-para-ops button:hover { background: rgba(138, 180, 248, .16); }
:host(.lt-dark) .lt-para-text.lt-para-error { color: #F28B82; }
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
 * 探测元素所在位置页面的实际背景是否为深色。
 * 页面可能自带暗色主题（data-theme/class 切换），与系统偏好无关——
 * 译文节点必须跟随页面真实背景，否则深色文字会画在深色背景上看不见。
 * 逐层向上找第一个非透明背景色，找不到就回落系统偏好。
 */
function isDarkBackground(el) {
  const view = el.ownerDocument?.defaultView;
  if (!view) return false;
  let node = el;
  while (node && node.nodeType === 1) {
    const bg = view.getComputedStyle?.(node)?.backgroundColor;
    const m = typeof bg === 'string' && bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
      const lum = (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255;
      return lum < 0.5;
    }
    node = node.parentElement;
  }
  try { return view.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false; }
  catch { return false; }
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
      <p class="lt-para-text">${t('para_translating')}</p>
      <div class="lt-para-ops">
        <button class="lt-para-copy" type="button" disabled>${t('para_copy')}</button>
        <button class="lt-para-hide" type="button">${t('para_hide')}</button>
      </div>
    </div>`;

  const textNode = root.querySelector('.lt-para-text');
  const copyButton = root.querySelector('.lt-para-copy');
  root.querySelector('.lt-para-hide').onclick = () => { host.hidden = true; };

  let translation = '';

  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(translation);
      copyButton.textContent = t('para_copied');
      setTimeout(() => { copyButton.textContent = t('para_copy'); }, 1200);
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
    /* message 由调用方整句本地化好（见 t('para_failed')），本层只上样式、不拼前缀 */
    setError: message => {
      textNode.textContent = message;
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
/**
 * @param {object} deps
 * @param {() => void} [deps.onUserIntent]
 *   用户点击了「翻译」类按钮时**同步**回调一次。给调用方一个机会在
 *   transient user activation 还活着的时候去踹需要手势的动作
 *   （Chrome 内建引擎的语言包下载：模型没就绪时没有手势就必然被拒）。
 *   放在这里而不是翻译函数里，是因为翻译链路是异步的，等到那儿手势可能已经过期。
 */
export function createHoverReader({ getHost, getShadow, translateParagraph, onUserIntent }) {
  let enabled = false;
  let target = null;               // 当前悬停的段落
  let pill = null;                 // 段落旁的「译」按钮
  const results = new WeakMap();   // 段落 → 译文节点控制器

  /* ------------------------------ 整页双语对照 ------------------------------ */

  let bubble = null;               // 右下角悬浮按钮
  let pageUi = false;              // 悬浮按钮是否显示
  let liveMode = false;            // 自动模式：段落进入视口就翻
  let bubbleNotice = null;         // 自动翻译未运行时的原因提示 { text, action }，action: 'install'|null
  let bubbleDownload = null;       // 引擎模型下载中的提示：优先于「翻译中 n/m」
  let bubbleEngine = null;         // 本次翻译使用的引擎（Chrome / Bergamot），仅用于按钮展示
  const queue = [];                // 待翻译段落
  const seen = new WeakSet();      // 已发现过的段落（去重）
  let queued = new WeakSet();      // 已入队的段落（去重）；收起译文后重置
  const batchNodes = [];           // 本页插入过的全部译文节点（含单个点的）
  let discovered = 0;
  // 用代号而不是布尔量标记「队列正在被消费」：stop() 之后在途的 pump 可能还卡在 await 上，
  // 裸布尔量会让新的 enqueue 启动第二个 pump，两个循环并发消费同一个队列
  let generation = 0;              // stop() 时递增，在途 pump 靠它判断自己是否已作废
  let running = -1;                // 正在消费队列的 pump 代号，-1 表示空闲
  let observer = null;             // IntersectionObserver：进视口才翻
  let mutationObserver = null;
  let mutationTimer = null;
  const pendingRoots = new Set();  // 页面新插入、等着重扫的子树

  /**
   * 节点是否属于扩展自己。两处要用：
   * 一是鼠标事件——pill 挂在扩展的 Shadow DOM 里，事件冒泡到 document 时 target/relatedTarget
   * 会被重定向成 shadow host，光看选择器认不出来；
   * 二是 MutationObserver——扩展插入译文节点本身就是 DOM 变动，认不出来就会自己触发自己。
   */
  const isOwnUi = node => {
    if (!node) return false;
    const host = getHost();
    if (host && (node === host || host.contains(node))) return true;
    return Boolean(node.closest?.('.lt-para-host'));
  };

  /** 译文节点被页面拿掉后（SPA 重渲染、无限滚动回收）就别再持有它，否则数组会一直涨 */
  const pruneBatchNodes = () => {
    for (let index = batchNodes.length - 1; index >= 0; index--) {
      if (!batchNodes[index].host.isConnected) batchNodes.splice(index, 1);
    }
  };

  /** 当前真正显示着译文的段落数：静默跳过的、被页面移除的自然不会算进去 */
  const translatedCount = () => batchNodes.reduce(
    (total, node) => total + (node.host.isConnected && !node.host.hidden ? 1 : 0), 0);

  /** 队列是否正在被消费；被 stop() 作废的那一轮不算 */
  const isPumping = () => running === generation;

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
    // 胶囊宽度随界面语言变（中文一个字 / 英文一个单词），偏移量必须实测，
    // 写死宽度会让较宽的文案顶出右边界被裁掉
    const w = pill.offsetWidth || 28;
    const h = pill.offsetHeight || 28;
    pill.style.left = `${Math.min(Math.max(8, rect.right - w - 2), window.innerWidth - w - 10)}px`;
    pill.style.top = `${Math.min(Math.max(8, rect.top + 2), window.innerHeight - h - 6)}px`;
  };

  const showPill = el => {
    if (pill && target === el) return;
    hidePill();
    target = el;
    pill = element('button', 'lt-hover-pill', {
      type: 'button',
      title: t('hover_pill_title'),
      textContent: t('hover_pill')
    });
    pill.onclick = () => {
      onUserIntent?.();
      const current = target;
      hidePill();
      handle(current);
    };
    getShadow().append(pill);
    positionPill();
  };

  /**
   * 把一段译文插到段落旁边；已有译文时只是重新展开。
   * @returns {Promise<object|null>} 译文节点控制器；null 表示这段被静默跳过（本身就是中文）
   */
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
    // 插入位置：普通文档流的父容器（block 系）才外插 after，保持「原文在上、
    // 译文在下」；其余情况（列表项、flex/grid/contents/table 系容器）一律把
    // 译文放进元素内部尾部——外插的兄弟节点会被布局引擎挪进相邻格子
    // （日报类 grid/flex 页面的译文错位实测）。
    const view = el.ownerDocument?.defaultView;
    const parentFlow = el.parentElement && view?.getComputedStyle
      ? String(view.getComputedStyle(el.parentElement).display) : '';
    const normalParent = /^(block|flow-root|list-item|inline-block)/.test(parentFlow);
    // 元素自身是 flex/grid 时，内部插入的 host 会成为排到行尾的 item，
    // 让它独占一行（flex 换行 + 占满，grid 跨全部列）
    const selfFlow = view?.getComputedStyle ? String(view.getComputedStyle(el).display) : '';
    const needsFullRow = /flex/.test(selfFlow) || /grid/.test(selfFlow);

    if (isDarkBackground(el)) node.host.classList.add('lt-dark');
    if (el.tagName === 'LI' || !normalParent) {
      el.append(node.host);
      if (needsFullRow) {
        if (/flex/.test(selfFlow)) {
          el.style.flexWrap = 'wrap';
          node.host.style.width = '100%';
        } else {
          node.host.style.gridColumn = '1 / -1';
        }
      }
    } else {
      el.after(node.host);
    }

    try {
      // translateParagraph 由 content.js 注入：返回前已把引擎信息上报给按钮
      const translated = await translateParagraph(text);
      // 译文与原文一样（HTML、TypeScript 这类专有名词引擎原样吐回）：
      // 插一个一模一样的节点纯属噪音，静默撤掉
      if (translated.trim() === text.trim()) {
        node.host.remove();
        results.delete(el);
        queued.delete(el);
        return null;
      }
      node.setText(translated);
    } catch (error) {
      // 段落本身就是目标语言（如混排页面里的纯中文段）：静默撤掉节点，不弹错误卡片
      if (error?.silent) {
        node.host.remove();
        results.delete(el);
        return null;
      }
      node.setError(t('para_failed', { msg: error?.message ?? String(error) }));
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
    if (!rect.width || !rect.height) return false;
    // GitHub 的 sr-only 界面词是 1×1 的 clip 元素：有 rect 但肉眼不可见，
    // 翻它们会在视觉上凭空插出「最新提交」「历史」这类译文块
    if (rect.width < 4 && rect.height < 4) return false;
    // jsdom 单测里没有全局 getComputedStyle，拿不到就当作可见
    const style = el.ownerDocument?.defaultView?.getComputedStyle?.(el);
    return !style || (style.visibility !== 'hidden' && style.display !== 'none');
  };

  /**
   * 收集要翻译的段落：只取「叶子块」（内部不再包含更小的块），
   * 避免 `blockquote > p` 被翻两遍；过滤中文段、输入框，以及导航/侧栏/广告/评论这些非正文块。
   *
   * 整页扫描时先把范围收窄到正文根；识别不出正文根（例如整页就是 body 下几个裸段落）
   * 就退回翻所有合格块——宁可多翻，也不能把真正的正文漏掉。
   * @param {Document|Element} root 扫描范围；传 document 时才做正文根收窄
   */
  const collectBlocks = (root = document) => {
    const contentRoot = findMainContentRoot(document);
    const scope = root === document ? (contentRoot ?? document) : root;
    const candidates = [...scope.querySelectorAll(BLOCK_SELECTOR)];
    // 页面新插入的可能就是一个裸段落，而 querySelectorAll 不含自身，得单独补上
    if (scope.nodeType === 1 && scope.matches(BLOCK_SELECTOR)) candidates.unshift(scope);

    const blocks = [];
    for (const el of candidates) {
      if (blocks.length >= BATCH_LIMIT) break;
      // 认定了正文根之后，正文以外新冒出来的内容（评论区、推荐位）不再翻
      if (contentRoot && !contentRoot.contains(el)) continue;
      if (shouldSkipBlock(el, contentRoot)) continue;
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
    pruneBatchNodes();
    for (const node of batchNodes) node.host.hidden = true;
    queued = new WeakSet();   // 收起后再点「双语对照」要能重新入队
    if (bubble) bubble.textContent = bubbleIdle();
  };

  const updateBubble = () => {
    if (!bubble) return;
    const done = translatedCount();
    // 下载模型比翻译进度更值得说：下载期间段数一直停在 1/4，看着像卡死
    if (bubbleDownload) {
      bubble.textContent = bubbleDownload;
      return;
    }
    if (queue.length) {
      // 总数至少是「已译 + 待译」，否则会出现 3/2 这种倒退的进度
      bubble.textContent = t('bubble_progress', { done, total: Math.max(discovered, done + queue.length) });
      return;
    }
    if (!done && bubbleNotice) {
      bubble.textContent = bubbleNotice.text;
      return;
    }
    if (done) {
      bubble.textContent = t('bubble_done', { n: done });
      // 引擎信息放悬停提示，不占按钮视觉
      bubble.title = bubbleEngine ? `${t('bubble_title')} · ${bubbleEngine}` : t('bubble_title');
      return;
    }
    bubble.title = t('bubble_title');
    bubble.textContent = bubbleIdle();
  };

  /** 队列串行消费：翻译本来就是排队执行的，页面本身不能被卡住 */
  const pump = async () => {
    if (isPumping()) return;   // 已经在消费队列，新段落会被同一个循环带走
    const token = generation;
    running = token;
    let translated = 0;
    try {
      while (queue.length) {
        const el = queue.shift();
        if (!el?.isConnected) continue;
        await translateInto(el);
        // stop() 可能在 await 期间发生：这一轮已经作废，剩下的交给新一轮，别抢同一个队列
        if (token !== generation) return;
        if (++translated % 25 === 0) pruneBatchNodes();
        updateBubble();
        // 每段之间让出主线程，滚动和输入不掉帧
        await new Promise(resolve => setTimeout(resolve, 0));
        if (token !== generation) return;
      }
    } finally {
      if (token === generation) {
        running = -1;
        updateBubble();
      }
    }
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
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        // 走 enqueue 而不是直接 push：queued 去重集合得是唯一的入队口径，
        // 否则同一段落可能被视口和 runAll 各排一次
        enqueue(entry.target);
      }
    }, { rootMargin: '300px 0px' });
    return observer;
  };

  /**
   * 把新出现的段落纳入观察；immediate 或没有观察器时直接入队。
   * @returns {Element[]} 这次扫到的合格段落
   */
  const scan = (root = document, { immediate = false } = {}) => {
    const observerReady = ensureObserver();
    const blocks = collectBlocks(root);
    for (const el of blocks) {
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
    return blocks;
  };

  const flushPendingRoots = () => {
    mutationTimer = null;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    for (const node of roots) {
      if (node.isConnected) scan(node);
    }
  };

  /** 动态页面（无限滚动、SPA）新插入的段落也要翻 */
  const watchDom = () => {
    if (mutationObserver || typeof MutationObserver !== 'function') return;
    mutationObserver = new MutationObserver(mutations => {
      // 只扫新插入的子树。整页重扫既慢，又会被扩展自己插入译文节点的变动再次触发，
      // 形成「插入 → 重扫 → 插入」的自激循环
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1 || isOwnUi(node)) continue;
          pendingRoots.add(node);
        }
      }
      if (!pendingRoots.size) return;
      clearTimeout(mutationTimer);
      mutationTimer = setTimeout(flushPendingRoots, MUTATION_DEBOUNCE);
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
    mutationTimer = null;
    pendingRoots.clear();
  };

  const stop = () => {
    generation += 1;          // 作废在途的那一轮 pump，别让它和新一轮抢同一个队列
    liveMode = false;
    queue.length = 0;
    queued = new WeakSet();   // 停止后重新开始时要能重新入队
    stopWatching();
    pruneBatchNodes();
    updateBubble();
  };

  /** 自动模式：页面加载完就跑，段落滚进视口即翻译。
   *  工具型页面（GitHub、管理后台、表单页）不自动翻——把 Watch→观看 这种界面词
   *  翻得到处都是是纯灾难；悬浮按钮还在，用户手动点「双语对照」仍会执行。 */
  const startLive = () => {
    if (liveMode) return;
    if (looksLikeAppPage(document)) {
      bubbleNotice = { text: t('bubble_tool') };
      updateBubble();
      return;
    }
    liveMode = true;
    scan();
    watchDom();
    pump();
  };

  /** 自动翻译没跑（缺语言包/中文页）时，让按钮把原因说出来而不是静默装死。
   *  action: 'install' 表示点击跳语言包管理页；其余 action 点击仍尝试手动翻。 */
  const setBubbleNotice = notice => {
    bubbleNotice = notice;
    updateBubble();
  };

  /** 引擎模型正在下载：这时候段数一直卡在「翻译中 1/4」，用户更需要知道在下载 */
  const setBubbleDownload = text => {
    bubbleDownload = text ?? null;
    updateBubble();
  };

  /** 翻译完成后按钮上标注本次使用的引擎（Chrome / Bergamot） */
  const setBubbleEngine = engine => {
    bubbleEngine = engine ?? null;
    updateBubble();
  };

  /** 手动点「双语对照」：整页都翻，不只在视口里的 */
  const runAll = () => {
    liveMode = false;
    const blocks = scan(document, { immediate: true });
    // 之前只是被观察着的段落（还没滚到）也一起翻
    for (const el of blocks) enqueue(el);
    watchDom();
    // 这里不能用队列长度判断：enqueue 里的 pump 会同步取走队首，
    // 只剩一段的页面会被误报成「没有需要翻译的段落」
    if (!blocks.length && bubble) {
      bubble.textContent = t('bubble_nothing');
      setTimeout(() => {
        if (!queue.length && bubble) bubble.textContent = bubbleIdle();
      }, 1600);
    }
    pump();
  };

  const ensureBubble = () => {
    if (bubble?.isConnected) return bubble;
    bubble = element('button', 'lt-bubble', {
      type: 'button',
      title: t('bubble_title'),
      textContent: bubbleIdle()
    });
    bubble.onclick = () => {
      if (isPumping() && queue.length) {
        stop();
        return;
      }
      if (translatedCount()) {
        hideAll();
        return;
      }
      // 缺语言包的提示：点击=开始翻译（手动触发允许下载语言包，auto 才禁止）
      bubbleNotice = null;
      onUserIntent?.();
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
    const related = event.relatedTarget;
    // 鼠标从段落移向 pill 时，relatedTarget 会被 Shadow DOM 重定向成扩展的 host
    // （div#local-translator-root），它不匹配 BLOCK_SELECTOR；不拦住这一下，
    // 按钮会在用户点下去之前就消失
    if (isOwnUi(related)) return;
    // 事件是从扩展自己的 UI 里冒出来的（鼠标离开 pill）：不是移回段落就把按钮收掉，别一直留着
    if (isOwnUi(event.target) || event.composedPath?.().includes(getHost())) {
      if (!related?.closest?.(BLOCK_SELECTOR)) hidePill();
      return;
    }
    // 鼠标移出目标段落且不是移向另一个段落时收起按钮
    if (event.target === target && !related?.closest?.(BLOCK_SELECTOR)) hidePill();
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
        bubbleNotice = null;   // 按钮都没了，原因提示自然失效
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
    /** 自动翻译没有跑时的按钮提示（缺语言包/中文页/工具页） */
    setBubbleNotice,
    setBubbleEngine,
    setBubbleDownload,
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
