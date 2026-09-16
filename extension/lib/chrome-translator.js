/**
 * Chrome 内建翻译引擎封装（window.Translator，Chrome 138+）。
 *
 * Chrome 自带 Google 的端上翻译模型：原生实现（比 WASM 快）、Google 级质量、
 * 模型由浏览器下载和管理——我们只管调用。这是 content script 与离屏文档
 * 共用的模块；两者都运行在 Chrome 的渲染进程里，self.Translator 可用时即可用。
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

/** 语言对 → Translator 实例缓存（创建/模型加载是一次性成本） */
const translators = new Map();

/**
 * 用 Chrome 内建引擎翻译一段文本。
 * @param {string} text 原文（单段；分段由上层负责）
 * @param {string} source 解析后的源语言 BCP-47（来自 chromeTranslatorStatus）
 * @param {string} target 同上
 */
export async function chromeTranslate(text, source, target) {
  const key = `${source}|${target}`;
  let translator = translators.get(key);
  if (!translator) {
    translator = await self.Translator.create({ sourceLanguage: source, targetLanguage: target });
    translators.set(key, translator);
  }
  return translator.translate(text);
}
