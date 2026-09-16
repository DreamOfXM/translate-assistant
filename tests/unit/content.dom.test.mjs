/**
 * 用 jsdom 直接驱动 content.js，验证页面交互逻辑：
 * 入口按钮、结果卡片、确认填入、以及「不自动写入」这条底线。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM(`<!doctype html><html><body>
  <p id="para">Local translation runs entirely on your device.</p>
  <p id="para2">Another local paragraph for batch tests.</p>
  <p id="zhpara">这一段本来就是中文。</p>
  <textarea id="comment"></textarea>
  <input id="title" type="text" />
  <div id="editor" contenteditable="true"></div>
  <input id="secret" type="password" />
</body></html>`, { url: 'https://example.test/' });

const { window } = dom;

// jsdom 的布局恒为 0，给出非零矩形才能触发选区按钮
window.Range.prototype.getBoundingClientRect = () => ({
  left: 20, top: 40, right: 220, bottom: 62, width: 200, height: 22, x: 20, y: 40
});
// 悬停阅读同样依赖元素矩形（元素不可见时应收起按钮）
window.Element.prototype.getBoundingClientRect = () => ({
  left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40, x: 10, y: 20
});

globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.Event = window.Event;
globalThis.InputEvent = window.InputEvent ?? window.Event;
globalThis.Node = window.Node;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
globalThis.HTMLInputElement = window.HTMLInputElement;

const translateCalls = [];
const storageListeners = [];
let hoverSetting = false;
let installedPacks = [];   // 自动翻译前会先查语言包，为空则不自动翻（默认不自动，避免污染其它用例）

globalThis.chrome = {
  runtime: {
    onMessage: { addListener: () => {} },
    openOptionsPage: () => {},
    sendMessage: async message => {
      if (message.type === 'TRANSLATE') {
        translateCalls.push(message);
        return { text: `译文<${message.text.slice(0, 8)}>` };
      }
      if (message.type === 'GET_DIRECTION_STATUS') {
        return { installed: installedPacks.slice() };
      }
      return {};
    }
  },
  storage: {
    local: {
      get: async () => ({ hoverTranslate: hoverSetting }),
      set: async () => {}
    },
    onChanged: { addListener: listener => storageListeners.push(listener) }
  }
};

await import('../../extension/content.js');

const host = () => window.document.getElementById('local-translator-root');
const shadow = () => host().shadowRoot;
const tick = async () => {
  for (let index = 0; index < 10; index++) await new Promise(resolve => setTimeout(resolve, 0));
};
const reset = () => {
  // 面板是懒挂载的，第一次 focusin 之前还没有 shadow root
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  host()?.shadowRoot?.querySelectorAll('.lt-float').forEach(node => node.remove());
  host()?.shadowRoot?.querySelectorAll('.lt-hover-pill').forEach(node => node.remove());
  window.document.querySelectorAll('.lt-para-host').forEach(node => node.remove());
  for (const id of ['comment', 'title', 'editor']) {
    const node = window.document.getElementById(id);
    if (node) {
      delete node.dataset.ltBound;
      // 就地译文条按「输入框是否已有草稿」分流，残留文字会污染后面的用例
      if ('value' in node) node.value = '';
    }
  }
  translateCalls.length = 0;
  // 恢复悬停翻译默认关闭
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: false } }, 'local'));
  // 重建悬浮按钮，清掉上一个用例遗留的「缺语言包/中文页」提示
  storageListeners.forEach(listener => listener({ pageBilingual: { newValue: false } }, 'local'));
  storageListeners.forEach(listener => listener({ pageBilingual: { newValue: true } }, 'local'));
};

test('聚焦 textarea 会出现「翻译回复」入口', () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));

  const button = shadow().querySelector('.lt-float');
  assert.ok(button, '应出现入口按钮');
  assert.equal(button.textContent, '翻译回复');
});

test('密码框不会出现入口按钮', () => {
  reset();
  const secret = window.document.getElementById('secret');
  secret.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  assert.equal(shadow().querySelector('.lt-float'), null, '密码框不应绑定翻译入口');
});

test('回复面板：译文出现前不能填入，确认后才写入输入框', async () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  assert.ok(card, '应打开回复面板');

  const fillButton = card.querySelector('.lt-fill');
  assert.equal(fillButton.disabled, true, '译文生成前「填入输入框」必须是禁用的');

  card.querySelector('.lt-draft').value = '这是一段中文草稿';
  card.querySelector('.lt-translate').click();
  await tick();

  assert.equal(card.querySelector('.lt-result').textContent, '译文<这是一段中文草稿>');
  assert.equal(fillButton.disabled, false, '有了译文才允许填入');

  let inputEvents = 0;
  comment.addEventListener('input', () => { inputEvents++; });

  fillButton.click();
  await tick();

  assert.equal(comment.value, '译文<这是一段中文草稿>', '译文应写入输入框');
  assert.equal(inputEvents, 1, '必须派发原生 input 事件，否则 React/Vue 感知不到');
  assert.match(card.querySelector('.lt-status').textContent, /已填入/);
});

test('整页双语对照：flex 容器里的段落译文插在元素内部，不挤进相邻格子', async () => {
  reset();
  installedPacks = ['en-zh'];
  const box = window.document.createElement('div');
  box.style.display = 'flex';
  const p = window.document.createElement('p');
  p.textContent = 'Flexible paragraph inside a grid card layout.';
  box.append(p);
  window.document.body.append(box);

  shadow().querySelector('.lt-bubble').click();
  await tick();

  const host = p.querySelector(':scope > .lt-para-host');
  assert.ok(host, 'flex 容器内的段落译文应插入元素内部尾部');
  assert.equal(p.nextElementSibling?.classList.contains('lt-para-host') ?? false, false, '不应插成兄弟节点被布局挪进相邻格子');
  box.remove();
});

test('整页双语对照：table-row 容器里的段落同样内部插入', async () => {
  reset();
  installedPacks = ['en-zh'];
  const row = window.document.createElement('div');
  row.style.display = 'table-row';
  const p = window.document.createElement('p');
  p.textContent = 'Show HN: a long enough sentence inside a table row layout.';
  row.append(p);
  window.document.body.append(row);

  shadow().querySelector('.lt-bubble').click();
  await tick();

  assert.ok(p.querySelector(':scope > .lt-para-host'), 'table-row 容器内应内部插入，避免被表格布局挪位');
  row.remove();
});

test('就地译文条：输入框已有草稿时不再打开完整面板，填入后自动收尾', async () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.value = '听起来是的';
  comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card.lt-inline');
  assert.ok(card, '草稿已存在时应出现就地译文条');
  assert.equal(card.querySelector('.lt-draft'), null, '不该有草稿编辑区');
  await tick();

  assert.equal(card.querySelector('.lt-result').textContent, '译文<听起来是的>', '应自动翻译输入框里的草稿');

  const fillButton = card.querySelector('.lt-fill');
  assert.equal(fillButton.disabled, false, '有译文且输入框有效时允许填入');

  fillButton.click();
  await tick();

  assert.equal(comment.value, '译文<听起来是的>', '确认后写入输入框');
  assert.equal(shadow().querySelector('.lt-card'), null, '填入成功后译文条自动关闭');
  // 清掉填入的译文，避免「输入框已有草稿」泄漏到后面的用例
  comment.value = '';
});

test('就地译文条：空输入框仍打开完整面板', async () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  assert.ok(card, '空输入框应打开面板');
  assert.ok(card.querySelector('.lt-draft'), '面板带草稿编辑区');
  assert.equal(shadow().querySelector('.lt-card.lt-inline'), null, '不应出现就地译文条');
});

test('回复面板：只填入译文，不触发任何提交', async () => {
  reset();
  let submitted = 0;
  window.document.addEventListener('submit', () => { submitted++; });

  const title = window.document.getElementById('title');
  title.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  card.querySelector('.lt-draft').value = '你好';
  card.querySelector('.lt-translate').click();
  await tick();
  card.querySelector('.lt-fill').click();
  await tick();

  assert.equal(title.value, '译文<你好>');
  assert.equal(submitted, 0, '绝不能触发提交');
});

test('选中文本翻译：结果卡片展示译文，且不动任何输入框', async () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.value = '原始草稿';

  const paragraph = window.document.getElementById('para');
  const range = window.document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  paragraph.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));

  const button = shadow().querySelector('.lt-selection');
  assert.ok(button, '选区旁应出现「翻译选中」按钮');
  button.click();
  await tick();

  const card = shadow().querySelector('.lt-card');
  assert.ok(card, '应打开结果卡片');
  assert.equal(card.querySelector('.lt-source').value, 'auto', '默认不要求用户选源语言');
  assert.match(
    card.querySelector('.lt-source option[value="auto"]').textContent,
    /英语/,
    '应把自动识别的结果显示在语言条上'
  );
  assert.equal(card.querySelector('.lt-target').value, 'zh', '中文用户默认译成中文');
  assert.equal(translateCalls[0].source, 'en', '实际请求要用自动识别出来的源语言');
  assert.equal(translateCalls[0].target, 'zh');
  assert.equal(card.querySelector('.lt-result').textContent, '译文<Local tr>');
  assert.equal(comment.value, '原始草稿', '选中翻译不得修改任何输入框');
  assert.equal(card.querySelector('.lt-fill'), null, '结果卡片不应提供填入按钮');
});

test('选中文本翻译：日语原文的目标语言仍是中文', async () => {
  reset();
  const paragraph = window.document.getElementById('para');
  paragraph.textContent = 'これは日本語のテキストです。';

  const range = window.document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  paragraph.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  shadow().querySelector('.lt-selection').click();
  await tick();

  const card = shadow().querySelector('.lt-card');
  assert.equal(card.querySelector('.lt-target').value, 'zh');
  assert.equal(translateCalls[0].source, 'ja', '日语应被自动识别出来');
});

test('回复面板：中文草稿默认译成英语，不会「自己译自己」', async () => {
  reset();
  window.document.getElementById('comment')
    .dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  assert.equal(card.querySelector('.lt-target').value, 'en', '中文草稿应默认译成英语');

  card.querySelector('.lt-draft').value = '这个方案可行。';
  card.querySelector('.lt-translate').click();
  await tick();

  assert.equal(translateCalls[0].source, 'zh');
  assert.equal(translateCalls[0].target, 'en');
  assert.match(card.querySelector('.lt-output-label').textContent, /英语/, '译文标题应标出目标语言');
});

test('交换语言：从「自动检测 → 中文」翻成「中文 → 英语」', async () => {
  reset();
  window.document.getElementById('comment')
    .dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  assert.equal(card.querySelector('.lt-source').value, 'auto');
  card.querySelector('.lt-swap').click();

  assert.equal(card.querySelector('.lt-source').value, 'en', '交换后源语言变成原来的目标语言');
  assert.equal(card.querySelector('.lt-target').value, 'zh', '目标语言变成推荐语言');
});

test('长文本自动分段请求，不静默截断', async () => {
  reset();
  const paragraph = window.document.getElementById('para');
  paragraph.textContent = 'word '.repeat(600);

  const range = window.document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  paragraph.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  shadow().querySelector('.lt-selection').click();
  await tick();

  assert.ok(translateCalls.length > 1, `长文本应分段请求，实际 ${translateCalls.length} 次`);
  assert.ok(translateCalls.every(call => call.text.length <= 900), '单次请求不得超过上限');
  assert.match(shadow().querySelector('.lt-status').textContent, /已分 \d+ 段/);
});

test('翻译失败时展示错误并保留草稿', async () => {
  reset();
  const original = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async () => ({ error: '语言包下载失败' });

  try {
    const comment = window.document.getElementById('comment');
    comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    shadow().querySelector('.lt-float').click();

    const card = shadow().querySelector('.lt-card');
    card.querySelector('.lt-draft').value = '别丢了我的草稿';
    card.querySelector('.lt-translate').click();
    await tick();

    assert.match(card.querySelector('.lt-status').textContent, /语言包下载失败/);
    assert.equal(card.querySelector('.lt-draft').value, '别丢了我的草稿', '失败时不能清空草稿');
    assert.equal(card.querySelector('.lt-fill').disabled, true);
  } finally {
    globalThis.chrome.runtime.sendMessage = original;
  }
});

test('输入框被页面移除后，填入按钮失效并给出提示', async () => {
  reset();
  const editor = window.document.getElementById('editor');
  // jsdom 不实现 contenteditable 的 isContentEditable 属性，这里手动补上
  Object.defineProperty(editor, 'isContentEditable', { value: true, configurable: true });
  editor.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();

  const card = shadow().querySelector('.lt-card');
  card.querySelector('.lt-draft').value = '测试';
  card.querySelector('.lt-translate').click();
  await tick();
  assert.equal(card.querySelector('.lt-fill').disabled, false);

  editor.remove();
  card.querySelector('.lt-fill').click();
  await tick();

  assert.match(card.querySelector('.lt-status').textContent, /失效/);
  assert.equal(card.querySelector('.lt-fill').disabled, true);
});

test('Esc 关闭面板', () => {
  reset();
  const comment = window.document.getElementById('comment');
  comment.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
  shadow().querySelector('.lt-float').click();
  assert.ok(shadow().querySelector('.lt-card'));

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(shadow().querySelector('.lt-card'), null);
});

test('悬停翻译默认关闭：鼠标停在段落上不出按钮', () => {
  reset();
  window.document.getElementById('para')
    .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(shadow().querySelector('.lt-hover-pill'), null, '开关关闭时不应出现「译」按钮');
});

test('悬停翻译：开启后停在段落上出现「译」，点击就地插入双语译文', async () => {
  reset();
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  // 前面的测试可能改写过这段文本，这里固定成短句，保证单次请求
  const para = window.document.getElementById('para');
  para.textContent = 'Local translation runs entirely on your device.';
  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));

  const pill = shadow().querySelector('.lt-hover-pill');
  assert.ok(pill, '开关打开后应出现「译」按钮');
  pill.click();
  await tick();

  const inserted = para.nextElementSibling;
  assert.ok(inserted, '译文应插在段落后面');
  assert.equal(inserted.className, 'lt-para-host');
  assert.match(inserted.shadowRoot.querySelector('.lt-para-text').textContent, /译文/);
  assert.equal(translateCalls[0].target, 'zh', '阅读模式固定译成中文');

  // 译文节点只放译文，不重复原文（原段落就在页面上方，重印是多余的）
  assert.equal(
    inserted.shadowRoot.querySelector('.lt-para-original'),
    null,
    '译文节点不应重复展示原文（原段落已在页面上方）'
  );
});

test('悬停翻译：再点一次「译」收起译文，不重复翻译', async () => {
  reset();
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const para = window.document.getElementById('para');
  para.textContent = 'Local translation runs entirely on your device.';
  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  shadow().querySelector('.lt-hover-pill').click();
  await tick();
  assert.equal(translateCalls.length, 1);

  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  shadow().querySelector('.lt-hover-pill').click();
  await tick();

  assert.equal(translateCalls.length, 1, '已有译文时不应再次请求翻译');
  assert.equal(para.nextElementSibling.hidden, true, '应切换为收起状态');
});

test('悬停翻译：中文段落不出按钮，输入框不出按钮', () => {
  reset();
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const para = window.document.getElementById('para');
  para.textContent = '这一段本来就是中文，不需要翻译。';
  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(shadow().querySelector('.lt-hover-pill'), null, '中文段落不应出现「译」按钮');

  window.document.getElementById('comment')
    .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  assert.equal(shadow().querySelector('.lt-hover-pill'), null, '输入框不应出现「译」按钮');
});

test('混排段落：英文为主、夹几个汉字，按英文翻译而不是报「语言相同」', async () => {
  reset();
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const para = window.document.getElementById('para');
  // 模拟 redstarline.be 这类中英混排页面：整段以英文为主，混入品牌名/导航里的中文
  para.textContent = 'Plan your visit to the museum 家庭 and see the collection 展览 with us.';
  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  shadow().querySelector('.lt-hover-pill').click();
  await tick();

  assert.equal(translateCalls.length, 1, '混排段落应正常发起翻译');
  assert.equal(translateCalls[0].source, 'en', '英文为主的段落应按英文处理');
  assert.match(para.nextElementSibling.shadowRoot.querySelector('.lt-para-text').textContent, /译文/);
});

test('竞态兜底：收集时是英文、翻译时变成了中文，静默跳过不弹错误卡片', async () => {
  reset();
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const para = window.document.getElementById('para');
  // 模拟收集后页面脚本改写了这段文字（SPA 常见）
  para.textContent = 'Local translation runs entirely on your device.';
  para.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
  const pill = shadow().querySelector('.lt-hover-pill');
  para.textContent = '这一段是完整的中文，翻译成中文没有意义。';
  pill.click();
  await tick();

  assert.equal(translateCalls.length, 0, '中文段不应发起翻译请求');
  assert.equal(para.nextElementSibling?.classList.contains('lt-para-host') ?? false, false,
    '不应留下错误卡片');
});

test('整页双语对照：开启后出现悬浮按钮，点击逐段插入译文', async () => {
  reset();
  installedPacks = ['en-zh'];   // 语言包就绪，手动点击不需要再下载
  storageListeners.forEach(listener => listener({ autoBilingual: { newValue: false } }, 'local'));

  // 前面的用例会把 #para 改写成中文，这里固定回英文
  window.document.getElementById('para').textContent = 'Local translation runs entirely on your device.';

  const bubble = shadow().querySelector('.lt-bubble');
  assert.ok(bubble, '开启悬停翻译后应出现「双语对照」悬浮按钮');
  await tick();   // autoStart 异步查语言包状态，等它清掉上一次的 notice
  assert.equal(bubble.textContent, '双语对照');

  bubble.click();
  await tick();

  // 两个英文段落都有译文，中文段没有
  const para = window.document.getElementById('para');
  const para2 = window.document.getElementById('para2');
  const zhpara = window.document.getElementById('zhpara');
  assert.ok(para.nextElementSibling?.classList.contains('lt-para-host'), '第一段后应插入译文');
  assert.ok(para2.nextElementSibling?.classList.contains('lt-para-host'), '第二段后应插入译文');
  assert.equal(zhpara.nextElementSibling?.classList.contains('lt-para-host') ?? false, false, '中文段不应翻译');
  assert.equal(translateCalls.length, 2, '应恰好翻译两个非中文段落');
  assert.equal(translateCalls[0].target, 'zh');
  assert.match(para.nextElementSibling.shadowRoot.querySelector('.lt-para-text').textContent, /译文/);
  assert.equal(bubble.textContent, '已译 2 段 · 收起', '跑完后按钮应显示已译段数');
});

test('整页双语对照：再点收起全部译文，第三次点恢复且不重复翻译', async () => {
  reset();
  installedPacks = ['en-zh'];
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const para = window.document.getElementById('para');
  para.textContent = 'Local translation runs entirely on your device.';
  const bubble = shadow().querySelector('.lt-bubble');

  bubble.click();
  await tick();
  assert.equal(translateCalls.length, 2);

  bubble.click();   // 收起
  assert.equal(para.nextElementSibling.hidden, true, '收起后译文应隐藏');
  assert.equal(bubble.textContent, '双语对照');

  bubble.click();   // 再展开
  await tick();
  assert.equal(para.nextElementSibling.hidden, false, '应重新展开而不是重新翻译');
  assert.equal(translateCalls.length, 2, '已有译文不应再次请求翻译');
});

test('整页双语对照：收段时跳过容器块，只翻叶子段落', async () => {
  reset();
  installedPacks = ['en-zh'];
  storageListeners.forEach(listener => listener({ hoverTranslate: { newValue: true } }, 'local'));

  const quote = window.document.createElement('blockquote');
  quote.innerHTML = '<p>Nested paragraph inside a quote.</p>';
  const para = window.document.getElementById('para');
  para.textContent = 'Local translation runs entirely on your device.';
  para.after(quote);

  // 直接触发一次整页翻译，断言引用块本身没有产生额外翻译请求
  shadow().querySelector('.lt-bubble').click();
  await tick();

  const hosts = window.document.querySelectorAll('.lt-para-host');
  // para、para2、quote 里的 p —— 恰好 3 段，blockquote 容器不翻
  assert.equal(hosts.length, 3, `应插入了 3 段译文，实际 ${hosts.length}`);
  assert.equal(translateCalls.length, 3);
  quote.remove();
});

test('整页双语对照：语言包就绪时打开网页自动翻译，不用点任何按钮', async () => {
  reset();
  installedPacks = ['en-zh', 'ja-en'];
  window.document.getElementById('para').textContent = 'Local translation runs entirely on your device.';
  window.document.getElementById('para2').textContent = 'Another local paragraph for batch tests.';

  storageListeners.forEach(listener => listener({ autoBilingual: { newValue: true } }, 'local'));
  await tick();

  assert.ok(translateCalls.length >= 2, `应自动翻译至少两段，实际 ${translateCalls.length}`);
  const hosts = window.document.querySelectorAll('.lt-para-host');
  assert.equal(hosts.length, translateCalls.length, '每段译文都应有独立的译文节点');
  assert.match(
    window.document.getElementById('para').nextElementSibling.shadowRoot
      .querySelector('.lt-para-text').textContent,
    /译文/
  );
  installedPacks = [];
});

test('整页双语对照：语言包没装好时不自动翻译（绝不偷偷下载）', async () => {
  reset();
  installedPacks = [];
  storageListeners.forEach(listener => listener({ autoBilingual: { newValue: true } }, 'local'));
  await tick();

  assert.equal(translateCalls.length, 0, '语言包缺失时不应发起翻译');
  assert.equal(window.document.querySelectorAll('.lt-para-host').length, 0);
});

test('整页双语对照：中文网页不自动翻译', async () => {
  reset();
  installedPacks = ['en-zh'];
  for (const id of ['para', 'para2']) {
    window.document.getElementById(id).textContent = '这是一段中文内容，本来就能看懂。';
  }
  window.document.getElementById('zhpara').textContent = '这也是中文。';

  storageListeners.forEach(listener => listener({ autoBilingual: { newValue: true } }, 'local'));
  await tick();

  assert.equal(translateCalls.length, 0, '中文网页不应自动翻译');
  installedPacks = [];
});
