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

/** 让出一帧：把「设好选区」和「写入」放到不同的帧里执行 */
const defaultFrame = () => new Promise(resolve => {
  if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(() => resolve());
  else setTimeout(resolve, 0);
});

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
 * 合成一次粘贴事件。
 *
 * 富文本编辑器普遍自己接管 beforeinput 并把 document.execCommand('insertText')
 * 挡在外面，但它们都会老老实实处理粘贴事件，所以这是一条保险的兜底写入通道。
 */
const defaultPasteText = (node, text) => {
  try {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    node.dispatchEvent?.(event);
    return true;
  } catch {
    return false;
  }
};

/** 比较两段文本时忽略编辑器自己加的换行和多余空格 */
const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * 判断译文是否真的进了输入框。
 *
 * execCommand('insertText') 在富文本编辑器里会返回 true，即使内容一个字都没变
 * （框架拦下了 beforeinput 并自行处理）。只看返回值会把「什么都没发生」误报成
 * 「写入成功」，用户侧就是点了按钮没反应，所以这里一律以内容为准。
 */
function landed(after, before, text) {
  const now = normalize(after);
  if (now === normalize(text)) return true;                    // 完整替上去了
  return now !== normalize(before) && now.includes(normalize(text));
}

/**
 * 把文本写入输入框。只在用户明确确认后调用，绝不触发提交或发送。
 *
 * contenteditable 走异步流程，因为必须先把选区交给框架同步一轮再写入：
 * Lexical / ProseMirror 这类编辑器拦截 beforeinput，若在同一帧里「全选 + 写入」，
 * 它会拿着自己上一次的光标位置去处理，结果是整段草稿纹丝不动。
 *
 * @returns {Promise<boolean>} 写入是否被编辑器真正接受了
 */
export async function writeInput(node, text, {
  selectAll = defaultSelectAll,
  insertText = defaultInsertText,
  pasteText = defaultPasteText,
  frame = defaultFrame
} = {}) {
  if (!node) return false;
  try {
    node.focus?.();

    if (node.isContentEditable) {
      selectAll(node);
      await frame();
      const before = readInput(node);
      insertText(text);
      await frame();
      const after = readInput(node);

      if (landed(after, before, text)) return true;
      // 内容已经被动过就别再写第二遍，免得给用户留下一半原文一半译文
      if (after !== before) return false;

      selectAll(node);
      await frame();
      pasteText(node, text);
      await frame();
      return landed(readInput(node), before, text);
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
