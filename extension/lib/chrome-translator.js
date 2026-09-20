/**
 * Chrome 内建翻译引擎封装（window.Translator，Chrome 138+）。
 *
 * Chrome 自带 Google 的端上翻译模型：原生实现（比 WASM 快）、Google 级质量、
 * 模型由浏览器下载和管理——我们只管调用。这是 content script 与离屏文档
 * 共用的模块；两者都运行在 Chrome 的渲染进程里，self.Translator 可用时即可用。
 *
 * ★ 语言包下载需要「用户手势」（实测 Chrome 151/153）：
 *   模型未就绪（availability 为 downloadable/downloading）时，
 *   `Translator.create()` 会直接抛
 *     NotAllowedError: Requires a user gesture when availability is
 *                     "downloading" or "downloadable".
 *   而 transient user activation 只能在有用户交互的文档里产生，离屏文档是隐藏
 *   文档、永远拿不到。所以：
 *     - 需要触发下载时，必须在**页面里的点击回调**中发起 create()（见 primeChromeTranslator）；
 *     - 模型已 available 时，任何上下文都能 create()，包括离屏文档。
 *   调用方（content.js）负责决定「谁在什么时机踹这一脚」，本模块只如实报告状态。
 *
 * 回落策略由调用方决定：本模块只如实报告可用性，绝不静默降级。
 */

/** 我们的语言代码 → BCP-47 候选标签（按优先级） */
function bcp47Candidates(code) {
  switch (code) {
    case 'zh_hant': return ['zh-Hant', 'zh-TW'];
    case 'zh': return ['zh'];
    default: return [code];
  }
}

/** 当前环境是否具备 Chrome 内建翻译 API */
export function chromeTranslatorAvailable() {
  try {
    return typeof self !== 'undefined' && typeof self.Translator !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * 查询该语言对在内建引擎上的可用性。
 *
 * @returns {Promise<{status: string, source?: string, target?: string}>}
 *   status: 'no-api'（环境不支持）| 'available'（模型已就绪）
 *         | 'downloadable' | 'downloading'（模型待下载，需调用方决定是否触发）
 *         | 'unavailable'（该语言对不受支持）
 *   source/target 是解析后的 BCP-47 标签，创建 Translator 时要用
 */
export async function chromeTranslatorStatus(source, target) {
  if (!chromeTranslatorAvailable()) return { status: 'no-api' };
  for (const s of bcp47Candidates(source)) {
    for (const t of bcp47Candidates(target)) {
      try {
        const status = await self.Translator.availability({ sourceLanguage: s, targetLanguage: t });
        if (status && status !== 'unavailable') return { status, source: s, target: t };
      } catch { /* 该组合不支持，试下一个候选 */ }
    }
  }
  return { status: 'unavailable' };
}

/**
 * 语言对 → Translator 实例的 Promise 缓存。
 *
 * 缓存的是 Promise 不是实例：下载要等几十秒到几分钟，期间所有调用方都要挂在
 * 同一个 Promise 上等，而不是各创建一份（create 期间再 create 会重复触发下载）。
 */
const translators = new Map();

const pairKey = (source, target) => `${source}|${target}`;

/** 最近一次 create/translate 失败的原因，出问题时先看它 */
let lastError = null;

/** 最近一次引擎失败的原始错误（诊断用；没有失败则 null） */
export function chromeTranslatorLastError() {
  return lastError;
}

/** 该语言对是否已经有（下好或正在下的）Translator —— 同步查询，不 await */
export function chromeTranslatorPrimed(source, target) {
  return translators.has(pairKey(source, target));
}

/**
 * 把下载进度折算成百分比。
 * Chrome 的 DownloadProgressEvent.loaded 在不同版本里既有 0~1 的小数也有字节数，
 * total 为 1 时按小数算，拿不准就返回 null（调用方显示一个不带百分比的文案）。
 */
function percentOf(event) {
  const loaded = Number(event?.loaded);
  const total = Number(event?.total);
  if (!Number.isFinite(loaded)) return null;
  if (Number.isFinite(total) && total > 0 && total !== 1) {
    return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
  }
  return Math.max(0, Math.min(100, Math.round(loaded * 100)));
}

/**
 * 用给定语言对创建 Translator（必要时会触发 Chrome 的模型下载）。
 *
 * ★ 必须在用户手势里（点击回调）调用：模型未就绪时 Chrome 只认手势，
 *   错过的调用会以 NotAllowedError 立即失败。
 *
 * 幂等：同语言对重复调用复用同一个 Promise。失败会把这个 Promise 从缓存里摘掉，
 * 否则一次失败（比如网络断了）会把这条路永久钉死。
 *
 * @param {string} source 已解析的 BCP-47 源语言
 * @param {string} target 已解析的 BCP-47 目标语言
 * @param {{ onProgress?: (percent: number|null) => void }} [options]
 * @returns {Promise<object>|null} Translator 实例的 Promise；不支持 API 时返回 null
 */
export function primeChromeTranslator(source, target, { onProgress } = {}) {
  if (!chromeTranslatorAvailable()) return null;
  const key = pairKey(source, target);
  const cached = translators.get(key);
  if (cached) return cached;

  const options = { sourceLanguage: source, targetLanguage: target };
  if (typeof onProgress === 'function') {
    options.monitor = monitor => {
      monitor.addEventListener('downloadprogress', event => {
        try {
          onProgress(percentOf(event));
        } catch { /* 进度回调出错不能拖垮下载 */ }
      });
    };
  }

  let promise;
  try {
    promise = self.Translator.create(options);
  } catch (error) {
    lastError = error;
    return null;
  }

  // 看门狗：组件下载服务不可用（如 Chrome for Testing 禁用了 component updater，
  // 或网络黑洞）时 create() 会永远挂着——零进度事件、不 resolve 也不 reject。
  // 15 秒没等到第一个进度事件就判死：摘缓存、置失败原因，让调用方回落本地引擎，
  // 而不是让用户对着一动不动的「下载中」干等。
  const WATCHDOG_MS = 15000;
  const key2 = key;
  let sawProgress = false;
  if (options.monitor) {
    const rawMonitor = options.monitor;
    options.monitor = monitor => {
      rawMonitor(monitor);
      monitor.addEventListener('downloadprogress', () => { sawProgress = true; });
    };
  }
  const watchdog = setTimeout(() => {
    if (!sawProgress && translators.get(key2) === promise) {
      const err = new Error('模型下载无响应（组件服务不可用或网络受阻）');
      err.name = 'DownloadStalled';
      lastError = err;
      translators.delete(key2);
      promise.catch(() => {});   // 摘掉后真正的失败由看门狗代表
      promise = Promise.reject(err);
      translators.set(key2, promise);
      promise.catch(() => {});   // 防未处理拒绝
      // 下次调用重新走 create（重新计时），不把这条路永久钉死
      setTimeout(() => { if (translators.get(key2) === promise) translators.delete(key2); }, 1000);
    }
  }, WATCHDOG_MS);
  promise.finally(() => clearTimeout(watchdog)).catch(() => {});
  translators.set(key, promise);
  promise.catch(error => {
    lastError = error;
    // 只摘掉自己那一份：期间可能有新的一轮覆盖过缓存
    if (translators.get(key) === promise) translators.delete(key);
  });
  return promise;
}

/**
 * 用 Chrome 内建引擎翻译一段文本。
 *
 * @param {string} text 原文（单段；分段由上层负责）
 * @param {string} source 解析后的源语言 BCP-47（来自 chromeTranslatorStatus）
 * @param {string} target 同上
 */
export async function chromeTranslate(text, source, target) {
  const translator = await (primeChromeTranslator(source, target) ?? Promise.reject(new Error('Translator API 不可用')));
  return translator.translate(text);
}

/* ------------------------------ 用户手势与「优先走内建引擎」 ------------------------------ */

/**
 * 下载失败的页面级熔断：Chrome 引擎一次失败（挂死/网络断）后，本页面的
 * 剩余生命周期不再反复尝试——否则每次刷新都弹「正在下载」、每次都失败，
 * 用户看到的就是永无止境的假下载。刷新/导航后自然重置。
 */
let engineDisabled = false;

/** Chrome 的 transient user activation 大约 5 秒；只在用户明确点了翻译按钮时记账 */
const GESTURE_WINDOW_MS = 5000;
let gestureAt = 0;

/**
 * 在「翻译」类按钮的点击回调里**最先**调用一次。
 *
 * 只在扩展自己的翻译入口记账，不监听页面上的任意点击：模型下载要用户同意，
 * 「用户点了翻译」才算同意；随手点一下页面不算。
 */
export function markUserGesture() {
  gestureAt = Date.now();
}

function withinUserGesture() {
  return Date.now() - gestureAt < GESTURE_WINDOW_MS;
}

/**
 * 翻译单段文本，尽量走 Chrome 内建引擎（Google 端上模型）。
 *
 * 返回 null 表示「这一轮用不上内建引擎」——调用方应当回落到本地语言包引擎。
 * 本函数不会抛错，也绝不会在用户没有点头的情况下触发模型下载。
 *
 * 规则：
 *   1. availability 为 available（模型已就绪）→ 直接用内建引擎翻译；
 *   2. 否则（downloadable / downloading）：
 *      - 正处于用户手势窗口内（刚点了翻译）→ 踹一脚下载，然后**立刻**返回 null，
 *        让这一轮走本地语言包。大模型下载可能要几分钟，把握手卡在「翻译中」
 *        比慢一点糟糕得多；下载在后台继续，下好之后（availability 变 available）
 *        后面的段落自然就用上了内建引擎。
 *      - 不在手势窗口内（自动翻译）→ 什么都不做，绝不静默下载模型。
 *   进度通过 options.onModel 汇报给界面。
 *
 * @param {object} [options]
 * @param {(state: {phase: 'downloading'|'ready'|'failed', percent: number|null}) => void} [options.onModel]
 */
export async function chromeTranslateFirst(text, source, target, { onModel } = {}) {
  if (source === 'auto' || !chromeTranslatorAvailable()) return null;
  // 熔断只拦「再触发下载」：模型若已就绪（比如 Chrome 后台自己下完了），
  // 正常翻译不受影响
  if (engineDisabled) {
    try {
      const ready = await chromeTranslatorStatus(source, target);
      if (ready.status === 'available') return await chromeTranslate(text, ready.source, ready.target);
    } catch { /* 熔断期的探测失败就回落本地引擎 */ }
    return null;
  }

  let status;
  try {
    status = await chromeTranslatorStatus(source, target);
  } catch {
    return null;
  }
  if (!status || status.status === 'unavailable' || status.status === 'no-api') return null;

  if (status.status !== 'available') {
    const key = { source: status.source, target: status.target };
    if (withinUserGesture() && !chromeTranslatorPrimed(key.source, key.target)) {
      const pending = primeChromeTranslator(key.source, key.target, {
        onProgress: percent => onModel?.({ phase: 'downloading', percent })
      });
      onModel?.({ phase: 'downloading', percent: null });
      pending?.then(
        () => onModel?.({ phase: 'ready', percent: 100 }),
        error => {
          lastError = error;
          engineDisabled = true;   // 熔断：本页面不再反复假下载
          onModel?.({ phase: 'failed', percent: null });
        }
      );
    }
    return null;
  }

  try {
    return await chromeTranslate(text, status.source, status.target);
  } catch (error) {
    lastError = error;
    return null;
  }
}

