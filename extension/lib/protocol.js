/**
 * 消息协议与语言包状态。
 * 所有跨上下文（content script / 扩展页面 / Service Worker / 离屏文档）通信都使用这里定义的类型，
 * 避免各处硬编码字符串导致协议漂移。纯函数，可在 Node 中单元测试。
 */

import { parseDirectionKey, languageName, isKnownLanguage, directionKey } from './languages.js';

/** 扩展页面 → Service Worker */
export const MESSAGES = {
  TRANSLATE: 'TRANSLATE',
  PRELOAD_DIRECTION: 'PRELOAD_DIRECTION',
  DELETE_DIRECTION: 'DELETE_DIRECTION',
  GET_DIRECTION_STATUS: 'GET_DIRECTION_STATUS',
  GET_CATALOG: 'GET_CATALOG',
  GET_RUNTIME_STATUS: 'GET_RUNTIME_STATUS'
};

/** Service Worker → content script 等 */
export const EVENTS = {
  SHOW_TRANSLATOR: 'SHOW_TRANSLATOR',
  TRANSLATION_PROGRESS: 'TRANSLATION_PROGRESS'
};

/** Service Worker ↔ 离屏文档 */
export const HOST = {
  PORT_NAME: 'translator-host',
  OPS: {
    TRANSLATE: 'translate',
    PRELOAD: 'preload',
    DELETE: 'delete',
    STATUS: 'status',
    CATALOG: 'catalog'
  }
};

/** 语言包在 chrome.storage.local 中的键前缀 */
export const PACK_KEY_PREFIX = 'pack:';

/** 语言包文件在 Cache Storage 中的缓存名前缀 */
export const CACHE_PREFIX = 'local-translator-';

/** 模型目录缓存名 */
export const REGISTRY_CACHE = 'local-translator-registry';

export function packKey(direction) {
  return `${PACK_KEY_PREFIX}${direction}`;
}

export function cacheName(direction) {
  return `${CACHE_PREFIX}${direction}`;
}

/**
 * 从 storage 快照中读出已下载的语言方向列表。
 * @param {Record<string, unknown>} storage
 * @returns {string[]}
 */
export function readInstalledDirections(storage) {
  if (!storage || typeof storage !== 'object') return [];
  return Object.keys(storage)
    .filter(key => key.startsWith(PACK_KEY_PREFIX))
    .map(key => key.slice(PACK_KEY_PREFIX.length))
    .filter(direction => parseDirectionKey(direction) !== null)
    .sort();
}

/**
 * 校验语言方向字符串。
 */
export function isValidDirection(direction) {
  return parseDirectionKey(direction) !== null;
}

/**
 * 校验一条 TRANSLATE 请求。
 * @returns {{ok: true, value: {text: string, source: string, target: string}} | {ok: false, error: string}}
 */
export function validateTranslateRequest(message) {
  if (!message || typeof message !== 'object') return { ok: false, error: '请求格式无效。' };
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) return { ok: false, error: '请输入要翻译的内容。' };

  const source = typeof message.source === 'string' ? message.source : '';
  const target = typeof message.target === 'string' ? message.target : '';
  if (!/^[a-z]{2,3}(_[a-z]+)?$/.test(source)) return { ok: false, error: '源语言代码无效。' };
  if (!/^[a-z]{2,3}(_[a-z]+)?$/.test(target)) return { ok: false, error: '目标语言代码无效。' };
  if (source === target) return { ok: false, error: '源语言和目标语言相同，无需翻译。' };

  return { ok: true, value: { text, source, target } };
}

/**
 * 把 Mozilla 模型目录整理成界面可用的语言方向列表。
 * @param {{models: Record<string, Array<object>>}} registry
 * @returns {Array<{key:string, from:string, to:string, modelBytes:number, estimateBytes:number, files:object, releaseStatus:string|null, architecture:string|null}>}
 */
export function buildCatalog(registry) {
  const models = registry?.models ?? {};
  const directions = [];

  for (const entries of Object.values(models)) {
    const entry = Array.isArray(entries) ? entries[0] : entries;
    if (!entry?.files?.model?.path) continue;

    const from = entry.sourceLanguage ?? null;
    const to = entry.targetLanguage ?? null;
    if (!from || !to || !isKnownLanguage(from) || !isKnownLanguage(to)) continue;

    const modelBytes = Number(entry.files.model.uncompressedSize) || 0;
    directions.push({
      key: directionKey(from, to),
      from,
      to,
      label: `${languageName(from)} → ${languageName(to)}`,
      modelBytes,
      // 实测：完整语言包的 gzip 下载体积约为模型解压后体积的 0.85 倍
      estimateBytes: Math.round(modelBytes * 0.85),
      files: entry.files,
      architecture: entry.architecture ?? null,
      releaseStatus: entry.releaseStatus ?? null
    });
  }

  return directions.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 人类可读的体积。
 */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** 中转语言：Mozilla 的语言包以英语为中心，非英语互译需要经过英语 */
export const PIVOT_LANGUAGE = 'en';

/**
 * 计算某个语言方向实际需要下载哪些语言包。
 *
 * Mozilla 只发布「X ↔ 英语」方向的模型，因此中文 → 日语这类方向没有直接模型，
 * 需要先 X → 英语，再英语 → Y，由 bergamot 在运行时完成中转。
 *
 * @param {string} from
 * @param {string} to
 * @param {Iterable<string>} available 目录中已有的直接方向
 * @returns {{direct: boolean, packs: string[]} | null} null 表示无法翻译
 */
export function planPacks(from, to, available) {
  if (!from || !to || from === to) return null;
  const known = new Set(available);
  const direct = directionKey(from, to);
  if (known.has(direct)) return { direct: true, packs: [direct] };

  if (from === PIVOT_LANGUAGE || to === PIVOT_LANGUAGE) return null;

  const outbound = directionKey(from, PIVOT_LANGUAGE);
  const inbound = directionKey(PIVOT_LANGUAGE, to);
  if (!known.has(outbound) || !known.has(inbound)) return null;

  return { direct: false, packs: [outbound, inbound] };
}

/**
 * 方向是否已经可用（所需语言包全部就绪）。
 */
export function isDirectionReady(packs, installed) {
  if (!packs?.length) return false;
  const ready = new Set(installed ?? []);
  return packs.every(pack => ready.has(pack));
}

/**
 * 还缺哪些语言包。
 */
export function missingPacks(packs, installed) {
  const ready = new Set(installed ?? []);
  return (packs ?? []).filter(pack => !ready.has(pack));
}
