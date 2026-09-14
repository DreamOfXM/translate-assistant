/**
 * 本地翻译引擎：Mozilla Firefox Translations 模型 + bergamot WASM 运行时。
 *
 * 只能在具备 window / Worker / Cache Storage 的扩展页面里运行（本项目是离屏文档）。
 * MV3 的 Service Worker 不能创建 Web Worker，所以这段代码不能放在 background.js 里。
 */

import { LatencyOptimisedTranslator, TranslatorBacking } from '../vendor/translator.js';
import { buildCatalog, cacheName, planPacks, REGISTRY_CACHE } from './protocol.js';
import { languageName } from './languages.js';

const REGISTRY_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json';
const DEFAULT_BASE_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/';

/** registry 字段名 → 传给 worker 的字段名 */
const VOCAB_FIELDS = [
  ['vocab', 'vocab'],
  ['srcVocab', 'srcvocab'],
  ['trgVocab', 'trgvocab']
];

function fileUrl(base, file) {
  return file?.path ? (file.path.startsWith('http') ? file.path : `${base}${file.path}`) : null;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}

/** 目录里的文件是裸 gzip，服务端不返回 Content-Encoding，浏览器不会自动解压 */
async function decompress(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 目录只需下载一次，用模块级缓存避免 super() 期间读取尚未初始化的字段 */
let registryPromise = null;

async function fetchRegistry() {
  const cache = await caches.open(REGISTRY_CACHE);
  const request = new Request(REGISTRY_URL);
  let stored = null;
  try {
    stored = await cache.match(request);
    if (stored) return await stored.json();
  } catch {
    stored = null;
  }

  const response = await fetch(request, { credentials: 'omit' });
  if (!response.ok) throw new Error(`语言包目录下载失败（${response.status}）`);
  await cache.put(request, response.clone());
  return response.json();
}

function getRegistry() {
  if (!registryPromise) {
    registryPromise = fetchRegistry().catch(error => {
      registryPromise = null; // 允许重试
      throw error;
    });
  }
  return registryPromise;
}

export class MozillaBacking extends TranslatorBacking {
  onProgress = () => {};

  /**
   * 本次会话里真正加载过的语言包。
   * 注意：离屏文档拿不到 chrome.storage（实测只有 chrome.runtime），
   * 所以这里只做内存记录，落盘交给 Service Worker。
   */
  loaded = new Set();

  async loadModelRegistery() {
    const raw = await getRegistry();
    const base = raw.baseUrl ? `${raw.baseUrl}/` : DEFAULT_BASE_URL;

    return Object.values(raw.models ?? {})
      .map(entries => {
        const entry = Array.isArray(entries) ? entries[0] : entries;
        const files = entry?.files ?? {};
        const map = file => {
          const name = fileUrl(base, file);
          return name ? { name, size: file.uncompressedSize ?? 0, hash: file.uncompressedHash ?? null } : undefined;
        };
        return {
          from: entry.sourceLanguage,
          to: entry.targetLanguage,
          files: {
            model: map(files.model),
            lex: map(files.lexicalShortlist),
            ...Object.fromEntries(VOCAB_FIELDS.filter(([key]) => files[key]).map(([key, alias]) => [alias, map(files[key])]))
          }
        };
      })
      .filter(entry => entry.files?.model);
  }

  async catalog() {
    return buildCatalog(await getRegistry());
  }

  async loadTranslationModel({ from, to }) {
    const registry = await this.registry;
    const entry = registry.find(item => item.from === from && item.to === to);
    if (!entry) throw new Error(`暂不支持 ${from} → ${to}`);

    const cache = await caches.open(cacheName(`${from}-${to}`));
    const parts = [
      ['model', entry.files.model, '模型'],
      ['lex', entry.files.lex, '词表'],
      ...VOCAB_FIELDS.filter(([, alias]) => entry.files[alias]).map(([key, alias], index) =>
        [alias, entry.files[alias], index === 0 && entry.files.srcvocab ? '源语言词汇表' : '词汇表'])
    ].filter(([, file]) => Boolean(file));

    const loaded = {};
    for (let index = 0; index < parts.length; index++) {
      const [alias, file, label] = parts[index];
      loaded[alias] = await this.loadFile({ cache, file, label, index, total: parts.length });
    }

    const vocabs = entry.files.vocab
      ? [loaded.vocab]
      : [loaded.srcvocab, loaded.trgvocab].filter(Boolean);

    if (!vocabs.length) throw new Error(`${from} → ${to} 缺少词表文件`);

    this.loaded.add(`${from}-${to}`);
    return {
      model: loaded.model,
      shortlist: loaded.lex,
      vocabs,
      qualityModel: null,
      config: { 'gemm-precision': 'int8shiftAlphaAll' }
    };
  }

  async loadFile({ cache, file, label, index, total }) {
    const request = new Request(file.name);
    const span = total ? 90 / total : 90;
    const base = total ? 5 + span * index : 0;

    const cached = await cache.match(request);
    if (cached) {
      this.onProgress({ phase: 'loading', percent: Math.round(base + span * 0.6), label: `读取已缓存的${label}…` });
      const bytes = await decompress(new Uint8Array(await cached.arrayBuffer()));
      await this.verify(bytes, file, cache, request, label);
      return bytes;
    }

    const response = await fetch(request, { credentials: 'omit' });
    if (!response.ok) throw new Error(`${label}下载失败（${response.status}）`);

    const totalBytes = Number(response.headers.get('content-length')) || 0;
    const reader = response.body?.getReader();
    const chunks = [];
    let received = 0;

    if (!reader) throw new Error(`${label}下载失败：无法读取响应内容`);

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const percent = totalBytes
        ? Math.round(base + span * Math.min(0.95, received / totalBytes))
        : Math.round(base + span * 0.3);
      this.onProgress({
        phase: 'downloading',
        percent,
        label: totalBytes
          ? `下载${label}… ${(received / 1048576).toFixed(1)} / ${(totalBytes / 1048576).toFixed(1)} MB`
          : `下载${label}… ${(received / 1048576).toFixed(1)} MB`
      });
    }

    const merged = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    await cache.put(request, new Response(merged));
    const bytes = await decompress(merged);
    await this.verify(bytes, file, cache, request, label);
    return bytes;
  }

  /** 目录给出模型文件的 sha256，解压后校验；不一致就丢缓存，避免使用损坏的语言包 */
  async verify(bytes, file, cache, request, label) {
    if (!file?.hash) return;
    const actual = await sha256Hex(bytes);
    if (actual === file.hash) return;
    await cache.delete(request);
    throw new Error(`${label}完整性校验失败，已清除缓存，请重新下载`);
  }

  async discard(direction) {
    await caches.delete(cacheName(direction));
  }
}

export function createEngine({ downloadTimeout = 300000 } = {}) {
  let backing = null;
  let translator = null;
  let fatalError = null;
  let catalogPromise = null;

  const getBacking = () => {
    if (!backing) backing = new MozillaBacking({ downloadTimeout });
    return backing;
  };

  const getTranslator = () => {
    if (!translator) {
      translator = new LatencyOptimisedTranslator({
        workerUrl: chrome.runtime.getURL('vendor/worker/translator-worker.js'),
        pivotLanguage: 'en',
        downloadTimeout
      }, getBacking());
      translator.worker.catch(error => {
        fatalError = error;
      });
    }
    return translator;
  };

  const catalog = () => {
    if (!catalogPromise) {
      catalogPromise = getBacking().catalog().catch(error => {
        catalogPromise = null;
        throw error;
      });
    }
    return catalogPromise;
  };

  return {
    setProgressHandler(handler) {
      getBacking().onProgress = handler ?? (() => {});
    },

    async translate({ text, source, target }) {
      if (fatalError) throw new Error(`翻译引擎异常：${fatalError.message}`);
      const response = await getTranslator().translate({ from: source, to: target, text, html: false });
      return response.target.text;
    },

    /**
     * 下载某个方向需要的全部语言包。非英语互译会一次装好中转用的两个包。
     * 存储里只记录真实存在的直接语言包，中转方向的就绪状态由它们推导。
     * @returns {{direction: string, packs: string[], direct: boolean, installed: string[]}}
     */
    async preload(direction) {
      const available = (await catalog()).map(item => item.key);
      const [from, to] = direction.split('-');
      const plan = planPacks(from, to, available);
      if (!plan) throw new Error(`目录中没有 ${direction} 可用的语言包`);

      const installed = new Set(getBacking().loaded);

      await getTranslator().worker;
      const previousProgress = getBacking().onProgress;
      try {
        for (const [index, pack] of plan.packs.entries()) {
          if (getBacking().loaded.has(pack)) continue;
          const [source, target] = pack.split('-');
          // 中转方向要下两个包，标明进度落在哪个包上
          const prefix = plan.packs.length > 1
            ? `语言包 ${index + 1}/${plan.packs.length}（${languageName(source)}→${languageName(target)}）：`
            : '';
          // 单个语言包内部的进度是 0–100，多个包要摊到整体进度上，否则条子会往回跳
          const share = 100 / plan.packs.length;
          getBacking().onProgress = progress => previousProgress?.({
            ...progress,
            percent: Math.round((index + (progress.percent ?? 0) / 100) * share),
            label: `${prefix}${progress.label}`
          });
          await getBacking().getTranslationModel({ from: source, to: target });
        }
      } finally {
        getBacking().onProgress = previousProgress;
      }
      return { direction, packs: plan.packs, direct: plan.direct, installed: [...getBacking().loaded] };
    },

    /** 删除一个直接语言包。不影响其它方向。 */
    async remove(direction) {
      await getBacking().discard(direction);
      getBacking().loaded.delete(direction);
      return { direction };
    },

    /** 本次会话已加载的语言包（离屏文档写不了 storage，由 Service Worker 落盘） */
    installed: () => [...getBacking().loaded],

    catalog
  };
}
