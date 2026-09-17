import test from 'node:test';
import assert from 'node:assert/strict';

import { readInput, writeInput, isEditableInput, findValueSetter, isInputAlive } from '../../extension/lib/input.js';

/** 模拟一个 textarea：value 定义在原型上，和真实 DOM 一致 */
class FakeTextArea {
  nodeType = 1;
  tagName = 'TEXTAREA';
  isContentEditable = false;
  events = [];
  focused = false;
  #value = '';

  get value() { return this.#value; }
  set value(next) { this.#value = next; }

  focus() { this.focused = true; }
  dispatchEvent(event) { this.events.push(event); return true; }
}

const fakeElement = (tagName, properties = {}) => ({
  nodeType: 1,
  tagName,
  ...properties
});

test('isEditableInput 识别 textarea、普通 input 和 contenteditable', () => {
  assert.equal(isEditableInput(fakeElement('TEXTAREA')), true);
  assert.equal(isEditableInput(fakeElement('INPUT', { type: 'text' })), true);
  assert.equal(isEditableInput(fakeElement('INPUT', { type: 'search' })), true);
  assert.equal(isEditableInput(fakeElement('DIV', { isContentEditable: true })), true);
});

test('isEditableInput 排除密码、文件、勾选框等不可用输入', () => {
  for (const type of ['password', 'file', 'checkbox', 'radio', 'hidden', 'date', 'number']) {
    assert.equal(isEditableInput(fakeElement('INPUT', { type })), false, `${type} 不应被视为文本输入`);
  }
  assert.equal(isEditableInput(fakeElement('DIV')), false);
  assert.equal(isEditableInput(null), false);
  assert.equal(isEditableInput({ nodeType: 3 }), false);
});

test('readInput 读取普通输入框与 contenteditable', () => {
  const area = new FakeTextArea();
  area.value = 'draft';
  assert.equal(readInput(area), 'draft');
  assert.equal(readInput({ isContentEditable: true, innerText: '你好' }), '你好');
  assert.equal(readInput(null), '');
});

test('writeInput 用 value setter 写入并派发 input / change 事件', async () => {
  const area = new FakeTextArea();
  assert.equal(await writeInput(area, 'Hello there'), true);
  assert.equal(area.value, 'Hello there');
  assert.equal(area.focused, true, '写入前应先聚焦');
  assert.deepEqual(area.events.map(event => event.type), ['input', 'change']);
  assert.equal(area.events[0].bubbles, true, '框架依赖冒泡事件感知变化');
});

test('findValueSetter 沿原型链找到 value 的 setter', () => {
  const area = new FakeTextArea();
  const setter = findValueSetter(area);
  assert.equal(typeof setter, 'function');
  setter.call(area, 'x');
  assert.equal(area.value, 'x');
  assert.equal(findValueSetter(null), null);
});

/** 模拟一个 contenteditable：内容可被写入通道改掉 */
const fakeEditable = (initial = '') => {
  let text = initial;
  return {
    isContentEditable: true,
    get innerText() { return text; },
    set textContent(next) { text = next; },
    focus() {},
    dispatchEvent() { return true; },
    setText(next) { text = next; }
  };
};

test('writeInput 处理 contenteditable 时先全选、让出一帧，再写入', async () => {
  const trace = [];
  const editable = fakeEditable('old draft');

  const ok = await writeInput(editable, '新内容', {
    selectAll: () => { trace.push('select'); return true; },
    selectionText: () => 'old draft',
    frame: () => { trace.push('frame'); return Promise.resolve(); },
    insertText: text => { trace.push('insert'); editable.setText(text); return true; },
    pasteText: () => { trace.push('paste'); },
    undo: () => { trace.push('undo'); }
  });

  assert.equal(ok, true);
  assert.equal(editable.innerText, '新内容');
  assert.deepEqual(trace, ['select', 'frame', 'insert', 'frame'],
    '必须先把选区交给框架同步一轮，再写入');
});

test('默认全选把选区锚在文本节点上，而不是元素上', async () => {
  // 锚在元素上的选区会被 Lexical 一类编辑器丢掉，译文就会插到光标处变成追加
  const first = { nodeType: 3, textContent: '第一段' };
  const last = { nodeType: 3, textContent: '最后一段' };
  const nodes = [first, last];
  let index = 0;
  const walker = {
    currentNode: null,
    nextNode() {
      this.currentNode = nodes[index] ?? null;
      index += 1;
      return this.currentNode;
    }
  };
  const anchored = [];
  const selection = { range: null, removeAllRanges() {}, addRange(range) { this.range = range; } };

  globalThis.document = {
    createTreeWalker: () => walker,
    createRange: () => ({
      setStart: (node, offset) => anchored.push(['start', node, offset]),
      setEnd: (node, offset) => anchored.push(['end', node, offset])
    })
  };
  globalThis.window = { getSelection: () => selection };

  try {
    const editable = fakeEditable('第一段最后一段');
    const ok = await writeInput(editable, '译文', {
      selectionText: () => '第一段最后一段',
      frame: () => Promise.resolve(),
      insertText: text => { editable.setText(text); return true; }
    });
    assert.equal(ok, true);
    assert.deepEqual(anchored, [['start', first, 0], ['end', last, last.textContent.length]],
      '锚点必须是文本节点，编辑器才认得出这是「全选」');
    assert.equal(selection.range !== null, true, '设好的选区要交给文档');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('编辑器把选区抢回光标处时，一个字都不写', async () => {
  // Reddit 的 Lexical 就是这样：DOM 选区被它收掉，此时写下去只会追加在原文后面
  let wrote = false;
  const editable = fakeEditable('一段挺长的草稿文字');

  const ok = await writeInput(editable, '译文', {
    selectAll: () => true,
    selectionText: () => '',
    frame: () => Promise.resolve(),
    insertText: () => { wrote = true; return true; },
    pasteText: () => { wrote = true; }
  });

  assert.equal(ok, false);
  assert.equal(wrote, false, '选区都没盖住草稿，写了也只会追加');
});

test('insertText 无效时改用粘贴通道，并且同样要求整段替换', async () => {
  const editable = fakeEditable('old draft');
  const ok = await writeInput(editable, '译文', {
    selectAll: () => true,
    selectionText: () => 'old draft',
    frame: () => Promise.resolve(),
    insertText: () => true,                       // 编辑器自称成功，其实内容没动
    pasteText: (node, text) => { node.setText(text); },
    undo: () => true
  });
  assert.equal(ok, true);
  assert.equal(editable.innerText, '译文');
});

test('译文被追加在原文后面不算成功，并把草稿撤回来', async () => {
  const editable = fakeEditable('原草稿');
  let undone = 0;

  const ok = await writeInput(editable, '译文', {
    selectAll: () => true,
    selectionText: () => '原草稿',
    frame: () => Promise.resolve(),
    insertText: () => { editable.setText('原草稿译文'); return true; },   // 只追加
    pasteText: () => {},
    undo: () => { undone += 1; editable.setText('原草稿'); return true; }
  });

  assert.equal(ok, false, '「插在原文旁边」是用户报的那个 bug，不能算填入成功');
  assert.equal(undone, 1, '写坏了要撤回，别把草稿搅成半成品');
  assert.equal(editable.innerText, '原草稿');
});

test('受限编辑器三条通道都无效时返回 false，交给界面提示用户手工粘贴', async () => {
  const editable = fakeEditable('draft');
  const ok = await writeInput(editable, 'text', {
    selectAll: () => true,
    selectionText: () => 'draft',
    frame: () => Promise.resolve(),
    insertText: () => false,
    pasteText: () => {},
    undo: () => true
  });
  assert.equal(ok, false);
});

test('writeInput 出错时返回 false 而不抛异常', async () => {
  const broken = {
    isContentEditable: false,
    focus() { throw new Error('focus 失败'); },
    dispatchEvent() { return true; }
  };
  assert.equal(await writeInput(broken, 'x'), false);
  assert.equal(await writeInput(null, 'x'), false);
});

test('isInputAlive 判断输入框是否还在文档里', () => {
  const node = {};
  globalThis.document = { contains: target => target === node };
  assert.equal(isInputAlive(node), true);
  assert.equal(isInputAlive({}), false);
  assert.equal(isInputAlive(null), false);
  delete globalThis.document;
});
