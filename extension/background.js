import { LatencyOptimisedTranslator } from './vendor/translator.js';

const MENU_ID = 'translate-selection-local';
let translator;

async function getTranslator() {
  if (!translator) {
    translator = new LatencyOptimisedTranslator({
      workerUrl: chrome.runtime.getURL('vendor/worker/translator-worker.js'),
      registryUrl: 'https://bergamot.s3.amazonaws.com/models/index.json',
      downloadTimeout: 120000
    });
  }
  return translator;
}

async function translate(text, source, target) {
  const instance = await getTranslator();
  const from = source === 'auto' ? 'en' : source;
  if (from === target) return text;
  const response = await instance.translate({ from, to: target, text, html: false });
  return response.target.text;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '翻译选中文本',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !info.selectionText) return;
  await chrome.tabs.sendMessage(tab.id, {
    type: 'SHOW_TRANSLATOR',
    text: info.selectionText,
    anchor: { x: info.x, y: info.y }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TRANSLATE') {
    translate(message.text, message.source ?? 'auto', message.target).then(text => sendResponse({ text })).catch(error => sendResponse({ error: error.message }));
    return true;
  }
  if (message.type === 'GET_SETTINGS') {
    chrome.storage.local.get({ sourceLanguage: 'auto', targetLanguage: 'zh', installedDirections: [] }).then(sendResponse);
    return true;
  }
  if (message.type === 'SET_LANGUAGE_DIRECTION') {
    chrome.storage.local.get({ installedDirections: [] }).then(({ installedDirections }) => {
      const next = installedDirections.includes(message.direction)
        ? installedDirections
        : [...installedDirections, message.direction];
      return chrome.storage.local.set({ installedDirections: next }).then(() => ({ installedDirections: next }));
    }).then(sendResponse);
    return true;
  }
});
