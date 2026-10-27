import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShortcut } from '../../extension/lib/shortcut-label.js';

test('mac 的 Command 组合转系统符号（Apple HIG 顺序 ⇧ 在 ⌘ 前）', () => {
  assert.equal(formatShortcut('Command+Shift+U'), '⇧⌘U');
  assert.equal(formatShortcut('Command+T'), '⌘T');
});

test('MacCtrl（mac 上 Ctrl 键的内部名）用 ⌃ 表示', () => {
  assert.equal(formatShortcut('MacCtrl+Shift+U'), '⌃⇧U');
});

test('非 mac 绑定（Alt/Ctrl 开头）原样展示，不符号化', () => {
  assert.equal(formatShortcut('Alt+C'), 'Alt+C');
  assert.equal(formatShortcut('Ctrl+Shift+U'), 'Ctrl+Shift+U');
});

test('绑定串里修饰键顺序不影响输出', () => {
  assert.equal(formatShortcut('Shift+Command+Y'), '⇧⌘Y');
});

test('空绑定返回 null（未设置快捷键）', () => {
  assert.equal(formatShortcut(''), null);
  assert.equal(formatShortcut(null), null);
  assert.equal(formatShortcut(undefined), null);
});

test('键字母统一大写', () => {
  assert.equal(formatShortcut('Alt+c'), 'Alt+C');
});
