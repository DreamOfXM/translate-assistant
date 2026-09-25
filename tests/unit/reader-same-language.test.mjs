/**
 * 「当前语言不翻成当前语言」的三条判据。
 *
 * 现场（用户实拍）：英文页做完整页双语后，Chrome 内置翻译又把整页正文原地换成中文，
 * 我们的中文译文气泡一条不撤，形成「中文原文 + 中文译文」的双层重复。
 * 根因是整页判定只在加载时做一次，而原文是会被换掉的。
 *
 * 顺带钉住第二条：目标语言不能写死中文——App 侧的方向可以是 en，
 * 写死会让「中译英」的整页双语一段都不翻。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const ZH_TEXT = '本地优先软件把数据存在用户自己的设备上。';
const EN_TEXT = 'Local-first software keeps data on the user own device.';

const dom = new JSDOM(`<!doctype html><html><body><main><p id="a">${EN_TEXT}</p></main></body></html>`,
  { url: 'https://example.test/' });
const { window } = dom;

window.Element.prototype.getBoundingClientRect = () => ({
  left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40, x: 10, y: 20
});

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
globalThis.Node = window.Node;
globalThis.Element = window.Element;
// reader.js 读的是裸标识符 MutationObserver；Node 全局没有这个，不补的话
// watchDom() 直接早退，本文件的用例等于没测到监听
globalThis.MutationObserver = window.MutationObserver;

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: () => {}, remove: () => {} } }
};

const { createHoverReader } = await import('../../extension/lib/reader.js');
const { initI18n, setUiLang } = await import('../../extension/lib/i18n.js');
await initI18n();
// jsdom 的 navigator 是 en-US，initI18n 会跟着走英文；断言的是中文文案，钉死成 zh
setUiLang('zh');

/** 每个用例一套干净的 reader，互不继承译文节点和 seen 记录 */
let previous = null;
function makeReader(targetLanguage) {
  // 上一个 reader 的 body 监听还挂着的话，下面重置 innerHTML 会被它当成
  // 「页面新插入正文」，于是同一句话被两个 reader 各翻一遍，计数对不上
  previous?._stop();
  window.document.querySelector('main').innerHTML = `<p id="a">${EN_TEXT}</p>`;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const reader = createHoverReader({
    ...(targetLanguage ? { targetLanguage } : {}),
    getHost: () => host,
    getShadow: () => shadow,
    translateParagraph: async text => `【译文】${text.slice(0, 8)}`
  });
  reader.setPageUi(true);
  previous = reader;
  return { reader, shadow, para: window.document.getElementById('a') };
}

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));
/** 译文节点挂在 .lt-para-host 自己的 shadow root 里，按可见的逐个找 */
const visibleHosts = shadow => [...shadow.ownerDocument.querySelectorAll('.lt-para-host')]
  .filter(h => !h.hidden);

test('目标语言是中文时，中文段落不进翻译队列', () => {
  const { reader, para } = makeReader();
  para.textContent = ZH_TEXT;
  assert.deepEqual(reader._collectBlocks().length, 0);
});

test('目标语言换成英文时，中文段落要翻（App 侧中译英方向）', () => {
  const { reader, para } = makeReader('en');
  para.textContent = ZH_TEXT;
  assert.equal(reader._collectBlocks().length, 1, '中文段在 en 方向下是外语，必须进队列');
});

test('原文被原地换成目标语言后，已插入的译文自动撤掉', async () => {
  const { reader, shadow, para } = makeReader();
  reader._runAll();
  await settle(200);
  assert.equal(visibleHosts(shadow).length, 1, '前置条件：英文原文下面有译文');

  // Chrome 整页翻译不改结构，只把文本节点的内容换掉
  para.firstChild.nodeValue = ZH_TEXT;
  await settle(1200);

  assert.equal(visibleHosts(shadow).length, 0, '原文已经是中文，这条译文属于中文译中文，该撤');
  assert.match(shadow.querySelector('.lt-bubble').textContent, /本页原文已切换为中文（简体）/);
});

test('原文换回外语时不撤译文（撤的判据只有语言本身）', async () => {
  const { reader, shadow, para } = makeReader();
  reader._runAll();
  await settle(200);
  para.firstChild.nodeValue = `${EN_TEXT} Still english here.`;
  await settle(1200);
  assert.equal(visibleHosts(shadow).length, 1);
});
