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

test('writeInput 用 value setter 写入并派发 input / change 事件', () => {
  const area = new FakeTextArea();
  assert.equal(writeInput(area, 'Hello there'), true);
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

test('writeInput 处理 contenteditable 时先选中再插入', () => {
  let selected = false;
  let inserted = null;
  const editable = {
    isContentEditable: true,
    innerText: 'old',
    focus() {},
    dispatchEvent() { return true; }
  };

  const ok = writeInput(editable, '新内容', {
    selectAll: () => { selected = true; },
    insertText: text => { inserted = text; return true; }
  });

  assert.equal(ok, true);
  assert.equal(selected, true, '应先全选再插入，避免残留旧内容');
  assert.equal(inserted, '新内容');
});

test('受限编辑器插入失败时返回 false，提示用户改用复制', () => {
  const editable = { isContentEditable: true, focus() {}, dispatchEvent() { return true; } };
  const ok = writeInput(editable, 'text', { selectAll: () => {}, insertText: () => false });
  assert.equal(ok, false);
});

test('writeInput 出错时返回 false 而不抛异常', () => {
  const broken = {
    isContentEditable: false,
    focus() { throw new Error('focus 失败'); },
    dispatchEvent() { return true; }
  };
  assert.equal(writeInput(broken, 'x'), false);
  assert.equal(writeInput(null, 'x'), false);
});

test('isInputAlive 判断输入框是否还在文档里', () => {
  const node = {};
  globalThis.document = { contains: target => target === node };
  assert.equal(isInputAlive(node), true);
  assert.equal(isInputAlive({}), false);
  assert.equal(isInputAlive(null), false);
  delete globalThis.document;
});
