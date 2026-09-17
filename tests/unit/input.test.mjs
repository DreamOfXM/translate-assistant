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

test('writeInput 处理 contenteditable 时先全选，并等到下一帧才写入', async () => {
  const trace = [];
  const editable = { isContentEditable: true, innerText: 'old', focus() {}, dispatchEvent() { return true; } };

  const ok = await writeInput(editable, '新内容', {
    selectAll: () => { trace.push('select'); },
    frame: () => { trace.push('frame'); return Promise.resolve(); },
    insertText: text => { trace.push('insert'); editable.innerText = text; return true; }
  });

  assert.equal(ok, true);
  assert.equal(editable.innerText, '新内容');
  assert.deepEqual(trace.slice(0, 3), ['select', 'frame', 'insert'],
    '必须先把选区交给框架同步一轮，再写入');
});

test('同一帧里写入时富文本编辑器会拦下 beforeinput，这正是必须分帧的原因', async () => {
  // 复刻 Lexical 的行为：编辑器读到的是自己上一次的光标，而不是刚设好的全选，
  // 于是整段草稿纹丝不动，而 execCommand 依旧返回 true。
  let inserted = false;
  const editable = { isContentEditable: true, innerText: '请翻译这段草稿', focus() {}, dispatchEvent() { return true; } };

  const ok = await writeInput(editable, '译文', {
    selectAll: () => {},
    frame: () => Promise.resolve(),
    insertText: () => { inserted = true; return true; },   // 编辑器自称成功
    pasteText: () => false
  });

  assert.equal(inserted, true, '确实尝试写入了');
  assert.equal(ok, false, '内容没变就不能报成功，否则用户看到的就是「点了没反应」');
});

test('内容纹丝不动时退回粘贴通道', async () => {
  let pasted = null;
  const editable = { isContentEditable: true, innerText: '草稿', focus() {}, dispatchEvent() { return true; } };

  const ok = await writeInput(editable, '译文', {
    selectAll: () => {},
    frame: () => Promise.resolve(),
    insertText: () => true,
    pasteText: (node, text) => { pasted = text; editable.innerText = text; }
  });

  assert.equal(ok, true);
  assert.equal(pasted, '译文', '多数编辑器都会处理粘贴事件');
});

test('写入后内容已经变了但不完整时，不再写第二遍', async () => {
  let pasteCalls = 0;
  const editable = { isContentEditable: true, innerText: '草稿', focus() {}, dispatchEvent() { return true; } };

  const ok = await writeInput(editable, '译文', {
    selectAll: () => {},
    frame: () => Promise.resolve(),
    insertText: () => { editable.innerText = '被改写了一半'; return true; },
    pasteText: () => { pasteCalls += 1; }
  });

  assert.equal(ok, false);
  assert.equal(pasteCalls, 0, '已经动过就别再补，免得用户拿到一半原文一半译文');
});

test('受限编辑器插入失败时返回 false，提示用户改用复制', async () => {
  const editable = {
    isContentEditable: true, innerText: 'draft', focus() {}, dispatchEvent() { return true; }
  };
  const ok = await writeInput(editable, 'text', {
    selectAll: () => {}, frame: () => Promise.resolve(), insertText: () => false, pasteText: () => false
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
