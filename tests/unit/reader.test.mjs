/**
 * 悬停阅读（reader.js）的界面文案回归测试。
 *
 * 这些字符串很容易被写死成中文，界面切成英文时就不跟着变。所以断言的不是
 * 「等于某个字面量」，而是「跟着 uiLang 走」——写死的中文过一次就露馅。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
  <p id="para">Local translation runs entirely on your device.</p>
  <p id="para2">Another local paragraph for the English case.</p>
  <div id="root"></div>
</body></html>`, { url: 'https://example.test/' });

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

// i18n 初始化要读 chrome.storage；给个空实现即可（没设 uiLang 时跟随 navigator）
let gestureCalls = 0;
globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: () => {}, remove: () => {} } }
};

const { createHoverReader } = await import('../../extension/lib/reader.js');
const { initI18n, setUiLang, t } = await import('../../extension/lib/i18n.js');

await initI18n();

const root = window.document.getElementById('root');
const shadow = root.attachShadow({ mode: 'open' });

const reader = createHoverReader({
  getHost: () => root,
  getShadow: () => shadow,
  translateParagraph: async () => { throw new Error('engine down'); },
  onUserIntent: () => { gestureCalls += 1; }
});
reader.setEnabled(true);

const pill = () => shadow.querySelector('.lt-hover-pill');

/** 悬停某个段落。「换段落」同时起到收起按钮的作用，下一条断言就能重新建按钮 */
const hover = id => window.document.getElementById(id)
  .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

/** 译文文案挂在 .lt-para-host 自己的 shadow root 里，按 host 逐个找 */
const paraTexts = () => [...window.document.querySelectorAll('.lt-para-host')]
  .map(host => host.shadowRoot?.querySelector('.lt-para-text')?.textContent);

const latestParaText = () => paraTexts().at(-1);

test('悬停胶囊的文案跟随界面语言，不是写死的中文', () => {
  setUiLang('zh');
  hover('para');
  assert.equal(pill()?.textContent, '译');
  assert.equal(pill()?.title, '翻译这一段');

  setUiLang('en');
  hover('para2');
  assert.equal(pill()?.textContent, 'Translate');
  assert.equal(pill()?.title, 'Translate this paragraph');
});

test('段落翻译失败的文案不重复拼前缀，也不在英文界面里漏出中文', async () => {
  setUiLang('zh');
  hover('para');
  pill().click();
  await new Promise(resolve => setTimeout(resolve, 0));

  // t('para_failed') 自己已经带「翻译失败：」，再拼一次会变成「翻译失败：翻译失败：…」
  assert.equal(latestParaText(), t('para_failed', { msg: 'engine down' }));

  setUiLang('en');
  hover('para2');
  pill().click();
  await new Promise(resolve => setTimeout(resolve, 0));

  assert.equal(latestParaText(), t('para_failed', { msg: 'engine down' }));
  assert.ok(!/[一-鿿]/.test(latestParaText()), '英文界面下的失败文案不该是中文');
});

test('点胶囊时同步告知调用方「用户意图」，好在手势窗口内触发下载', () => {
  const before = gestureCalls;
  hover('para');
  pill().click();
  assert.equal(gestureCalls, before + 1);
});
