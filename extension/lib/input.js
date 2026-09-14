/**
 * 读写网页输入框。
 *
 * 用原生 setter + 原生事件写入，React / Vue 这类框架才能感知到内容变化。
 * 副作用（选区、execCommand）通过参数注入，便于在没有 DOM 的环境里单元测试。
 */

/** 沿原型链找到 value 的 setter，避免直接赋值被框架的 getter 拦截 */
export function findValueSetter(node) {
  let prototype = node ? Object.getPrototypeOf(node) : null;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) return descriptor.set;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'password', 'email', 'tel', 'number', 'date', 'datetime-local',
  'month', 'week', 'time', 'file', 'checkbox', 'radio', 'hidden', 'button', 'submit', 'range', 'color'
]);

/**
 * 判断元素是否是可以填入文本的输入框。
 * @returns {boolean}
 */
export function isEditableInput(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = String(node.tagName ?? '').toLowerCase();
  if (tag === 'textarea') return true;
  if (tag === 'input') return !NON_TEXT_INPUT_TYPES.has(String(node.type ?? 'text').toLowerCase());
  return false;
}

/** 读取输入框当前内容 */
export function readInput(node) {
  if (!node) return '';
  if (node.isContentEditable) return node.innerText ?? node.textContent ?? '';
  return typeof node.value === 'string' ? node.value : '';
}

function emit(node, type, text) {
  const InputEventCtor = globalThis.InputEvent;
  const EventCtor = globalThis.Event;
  if (!EventCtor || typeof node.dispatchEvent !== 'function') return;
  const event = type === 'input' && InputEventCtor
    ? new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: text })
    : new EventCtor(type, { bubbles: true });
  node.dispatchEvent(event);
}

const defaultSelectAll = node => {
  try {
    const selection = globalThis.window?.getSelection?.();
    const range = globalThis.document?.createRange?.();
    if (!selection || !range) return;
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  } catch {
    /* 页面不支持选区操作时忽略，调用方会退回复制 */
  }
};

const defaultInsertText = text => {
  try {
    return globalThis.document?.execCommand?.('insertText', false, text) ?? false;
  } catch {
    return false;
  }
};

/**
 * 把文本写入输入框。只在用户明确确认后调用，绝不触发提交或发送。
 * @returns {boolean} 是否写入成功
 */
export function writeInput(node, text, { selectAll = defaultSelectAll, insertText = defaultInsertText } = {}) {
  if (!node) return false;
  try {
    node.focus?.();

    if (node.isContentEditable) {
      selectAll(node);
      return insertText(text) === true;
    }

    const setter = findValueSetter(node);
    if (setter) setter.call(node, text);
    else node.value = text;

    emit(node, 'input', text);
    emit(node, 'change', text);
    return node.value === text;
  } catch {
    return false;
  }
}

/**
 * 输入框是否仍然可用（没有被页面重新渲染掉）。
 * 页面卸载或元素被移除时返回 false，此时应要求用户重新选择输入框。
 */
export function isInputAlive(node) {
  if (!node) return false;
  try {
    return globalThis.document?.contains?.(node) ?? true;
  } catch {
    return false;
  }
}
