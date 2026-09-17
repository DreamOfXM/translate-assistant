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

/** 当前文档里选中的文字 */
const defaultSelectionText = () => {
  try {
    return globalThis.window?.getSelection?.()?.toString?.() ?? '';
  } catch {
    return '';
  }
};

/**
 * 全选输入框里的内容。
 *
 * 两个锚点必须落在**真正的文本节点**上（首字之前的 0 位 → 末字之后）。
 * 用 `selectNodeContents` 那种锚在元素上的选区，富文本编辑器认不出来，
 * 会当成「没有选区」，译文就插到光标处、变成追加在原文后面。
 */
const defaultSelectAll = node => {
  try {
    const doc = globalThis.document;
    const selection = globalThis.window?.getSelection?.();
    const walker = doc?.createTreeWalker?.(node, 4 /* NodeFilter.SHOW_TEXT */);
    if (!doc || !selection || !walker) return false;

    let first = null;
    let last = null;
    while (walker.nextNode()) {
      if (!first) first = walker.currentNode;
      last = walker.currentNode;
    }
    if (!first || !last) return false;

    const range = doc.createRange();
    range.setStart(first, 0);
    range.setEnd(last, (last.textContent ?? '').length);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
};

/** 浏览器自己的全选（等同 ⌘A 那条原生命令），有些编辑器只认它 */
const defaultSelectAllNative = () => {
  try {
    return globalThis.document?.execCommand?.('selectAll') === true;
  } catch {
    return false;
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
 * 很多编辑器把 `execCommand('insertText')` 挡在外面，却老老实实处理粘贴事件。
 * 但粘贴是**落在当前光标处**的，不会替掉整段草稿 —— Reddit 的 Lexical 就是这样，
 * 所以调用前必须先把全选选区摆好、并确认它没被编辑器抢回去。
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

/** 撤销刚写进去的东西：写坏了要把用户草稿还原回来 */
const defaultUndo = () => {
  try {
    return globalThis.document?.execCommand?.('undo') === true;
  } catch {
    return false;
  }
};

/** 比较两段文本时忽略编辑器自己加的换行和多余空格 */
const normalize = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** 内容是不是已经**整段**变成译文了（而不是插在原文旁边） */
const replaced = (after, text) => normalize(after) === normalize(text);

/**
 * 选区有没有真的盖住整段草稿。
 *
 * 编辑器会把选区抢回自己的光标处（Lexical 一类的框架自己掌管状态），
 * 这时候写下去只会变成追加，所以必须先确认。
 */
function coversDraft(selected, draft) {
  const want = normalize(draft).length;
  if (!want) return true;
  return normalize(selected).length >= want;
}

/** 「填入」要落在真正的编辑宿主上，选区和编辑命令才会被编辑器接纳 */
function editingHost(node) {
  try {
    return node?.closest?.('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') ?? node;
  } catch {
    return node;
  }
}

/**
 * 把文本写入输入框。只在用户明确确认后调用，绝不触发提交或发送。
 *
 * contenteditable 走异步，因为富文本编辑器自己掌管状态，DOM 只是它的投影：
 *   1. 先把全选选区摆好、让出一帧，等编辑器把选区同步进自己的模型；
 *   2. 确认选区没被抢回光标处 —— 抢回去了就一个字都别写，否则只会追加；
 *   3. 逐条通道尝试（插入 → 原生全选再插入 → 粘贴），每条都要求**整段等于译文**；
 *   4. 内容被改坏又不是译文，就撤回，别把用户草稿搅成半成品。
 *
 * @returns {Promise<boolean>} 译文是否真的替掉了原文
 */
export async function writeInput(node, text, {
  selectAll = defaultSelectAll,
  selectAllNative = defaultSelectAllNative,
  insertText = defaultInsertText,
  pasteText = defaultPasteText,
  undo = defaultUndo,
  selectionText = defaultSelectionText,
  frame = defaultFrame
} = {}) {
  if (!node) return false;
  try {
    node.focus?.();

    if (node.isContentEditable) {
      const host = editingHost(node);
      host?.focus?.();
      const before = readInput(host);

      const attempt = async (select, write) => {
        select();
        await frame();
        if (!coversDraft(selectionText(), before)) return 'selection-lost';
        write();
        await frame();
        const after = readInput(host);
        if (replaced(after, text)) return 'ok';
        return after === before ? 'noop' : 'dirty';
      };

      const plan = [
        () => attempt(() => selectAll(host), () => insertText(text)),
        () => attempt(selectAllNative, () => insertText(text)),
        () => attempt(() => selectAll(host), () => pasteText(host, text))
      ];

      for (const step of plan) {
        const outcome = await step();
        if (outcome === 'ok') return true;
        if (outcome === 'dirty') {
          // 写坏了（多半是追加在原文后面）：撤回去。有的编辑器一次撤不干净，
          // 但每撤一次都要复核 —— 一旦回到原样就立刻停手，别把草稿越撤越少。
          for (let tries = 0; tries < 2 && readInput(host) !== before; tries += 1) {
            undo();
            await frame();
          }
          return false;
        }
      }
      return false;
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
