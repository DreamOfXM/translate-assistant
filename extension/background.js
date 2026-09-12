import { LatencyOptimisedTranslator, TranslatorBacking } from './vendor/translator.js';

const MENU_ID = 'translate-selection-local';
const REGISTRY_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/db/models.json';
const MODEL_BASE_URL = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data/';
let translator;
let backing;

const supported = new Set(['en-zh', 'zh-en', 'en-ja', 'ja-en', 'en-ko', 'ko-en', 'en-fr', 'fr-en', 'en-de', 'de-en', 'en-es', 'es-en', 'en-it', 'it-en', 'en-pt', 'pt-en', 'en-ru', 'ru-en']);

class MozillaBacking extends TranslatorBacking {
  constructor(options) {
    super({ ...options, registryUrl: REGISTRY_URL });
  }

  async loadModelRegistery() {
    const cached = await caches.open('local-translator-registry');
    const request = new Request(REGISTRY_URL);
    const stored = await cached.match(request);
    const raw = stored ? await stored.json() : await (async () => {
      const response = await fetch(request, { credentials: 'omit' });
      if (!response.ok) throw new Error(`语言包目录下载失败（${response.status}）`);
      await cached.put(request, response.clone());
      return response.json();
    })();
    return Object.entries(raw.models ?? {}).map(([key, entries]) => {
      const files = entries[0]?.files ?? {};
      return {
        from: key.split('-')[0],
        to: key.split('-')[1],
        files: {
          model: { name: MODEL_BASE_URL + files.model.path },
          lex: { name: MODEL_BASE_URL + files.lexicalShortlist.path },
          ...(files.vocab ? { vocab: { name: MODEL_BASE_URL + files.vocab.path } } : {}),
          ...(files.srcVocab ? { srcvocab: { name: MODEL_BASE_URL + files.srcVocab.path } } : {}),
          ...(files.trgVocab ? { trgvocab: { name: MODEL_BASE_URL + files.trgVocab.path } } : {})
        }
      };
    });
  }

  async loadTranslationModel({ from, to }) {
    const registry = await this.registry;
    const key = `${from}-${to}`;
    const entries = registry.filter(item => item.from === from && item.to === to);
    if (!entries.length) throw new Error(`暂不支持 ${from} → ${to}`);
    const files = entries[0].files;
    const cache = await caches.open(`local-translator-${key}`);
    const load = async (url) => {
      const request = new Request(url);
      const saved = await cache.match(request);
      const response = saved ?? await fetch(request, { credentials: 'omit' });
      if (!response.ok) throw new Error(`语言包文件下载失败（${response.status}）`);
      if (!saved) await cache.put(request, response.clone());
      const stream = response.body?.pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream ?? response.body).arrayBuffer();
    };
    const [model, shortlist, ...vocabs] = await Promise.all([
      load(files.model.name),
      load(files.lex.name),
      ...(['vocab', 'srcvocab', 'trgvocab'].filter(name => files[name]).map(name => load(files[name].name)))
    ]);
    return { model, shortlist, vocabs, config: { 'gemm-precision': 'int8shiftAlphaAll' } };
  }
}

async function getTranslator() {
  if (!backing) backing = new MozillaBacking({ downloadTimeout: 180000 });
  if (!translator) {
    translator = new LatencyOptimisedTranslator({
      workerUrl: chrome.runtime.getURL('vendor/worker/translator-worker.js'),
      pivotLanguage: 'en',
      downloadTimeout: 180000
    }, backing);
  }
  return translator;
}

function validDirection(direction) {
  return /^[a-z]{2,3}-[a-z]{2,3}$/.test(direction);
}

async function translate(text, source, target) {
  if (!text?.trim()) throw new Error('请输入要翻译的内容');
  if (source === target) return text;
  const direction = `${source}-${target}`;
  if (!supported.has(direction)) throw new Error(`暂未提供 ${source} → ${target} 的离线语言包`);
  const instance = await getTranslator();
  const response = await instance.translate({ from: source, to: target, text, html: false });
  return response.target.text;
}

async function preload(direction) {
  if (!validDirection(direction)) throw new Error('语言方向格式无效');
  const [from, to] = direction.split('-');
  if (!supported.has(direction)) throw new Error('该语言方向暂未发布可用语言包');
  const instance = await getTranslator();
  await backing.getTranslationModel({ from, to });
  await chrome.storage.local.set({ [`downloaded:${direction}`]: true });
  return { direction, status: 'downloaded' };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll().then(() => chrome.contextMenus.create({ id: MENU_ID, title: '翻译选中文本', contexts: ['selection'] }));
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  await chrome.tabs.sendMessage(tab.id, { type: 'SHOW_TRANSLATOR', text: info.selectionText });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE') {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('翻译超时，请检查网络、语言包下载或重新加载扩展')), 240000));
    Promise.race([translate(message.text, message.source, message.target), timeout]).then(text => sendResponse({ text })).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'PRELOAD_DIRECTION') {
    preload(message.direction).then(sendResponse).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'DELETE_DIRECTION') {
    caches.delete(`local-translator-${message.direction}`).then(() => chrome.storage.local.remove(`downloaded:${message.direction}`)).then(() => sendResponse({ status: 'deleted' }));
    return true;
  }
  if (message.type === 'GET_DIRECTION_STATUS') {
    chrome.storage.local.get(null).then(values => sendResponse({ downloaded: Object.keys(values).filter(key => key.startsWith('downloaded:')).map(key => key.slice(11)) }));
    return true;
  }
});
