/**
 * 共用的「语言条」：左边源语言（默认自动检测）、右边目标语言、中间一个交换按钮。
 *
 * 设计目标：默认状态下用户什么都不用选——上面写原文，下面直接出译文。
 * 语言条看起来只是一行文字（自动检测 · 英语 → 中文），想改再点，不是必填项。
 *
 * 被 popup 与 content script 的两种面板共用，纯 DOM 逻辑，不依赖 Chrome API。
 */

import {
  AUTO_DETECT, DEFAULT_TARGET_LANGUAGE,
  languageName, orderedLanguageCodes, detectLanguage, resolveDirection, suggestTarget
} from './languages.js';

export const AUTO_LABEL = '自动检测';

function option(value, label, selected) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

/**
 * 生成语言条的 HTML。需要放在已经存在的容器里，再由 bindLanguageBar 绑定行为。
 * @param {{from?: string, to?: string}} [state]
 */
export function languageBarMarkup({ from = AUTO_DETECT, to = DEFAULT_TARGET_LANGUAGE } = {}) {
  const codes = orderedLanguageCodes();
  return `
    <div class="lt-langbar">
      <select class="lt-source" aria-label="源语言" title="源语言，默认自动检测">
        ${option(AUTO_DETECT, AUTO_LABEL, from)}
        ${codes.map(code => option(code, languageName(code), from)).join('')}
      </select>
      <span class="lt-arrow" aria-hidden="true">→</span>
      <select class="lt-target" aria-label="目标语言" title="目标语言">
        ${codes.map(code => option(code, languageName(code), to)).join('')}
      </select>
      <button class="lt-swap" type="button" title="交换语言">⇄</button>
    </div>`;
}

/**
 * 绑定语言条行为。
 * @param {ParentNode} root 包含 .lt-source / .lt-target / .lt-swap 的容器
 * @param {{onChange?: (reason: 'source'|'target'|'swap') => void}} [handlers]
 */
export function bindLanguageBar(root, { onChange } = {}) {
  const sourceSelect = root.querySelector('.lt-source');
  const targetSelect = root.querySelector('.lt-target');
  const swapButton = root.querySelector('.lt-swap');
  const autoOption = () => sourceSelect.querySelector(`option[value="${AUTO_DETECT}"]`);
  let lastText = '';

  /** 自动检测时把识别结果写进选项文字：让用户看见结论，又不必动手选 */
  const refresh = text => {
    if (text !== undefined) lastText = String(text ?? '');
    const automatic = sourceSelect.value === AUTO_DETECT;
    autoOption().textContent = automatic && lastText.trim()
      ? `${AUTO_LABEL} · ${languageName(detectLanguage(lastText))}`
      : AUTO_LABEL;
  };

  /**
   * 解析出本次翻译真正使用的语言，并把「撞车时自动改的目标语言」同步回界面。
   * @returns {{source: string, target: string, same: boolean}}
   */
  const resolve = text => {
    refresh(text);
    const direction = resolveDirection(text, sourceSelect.value, targetSelect.value);
    if (direction.flipped && direction.target !== targetSelect.value) {
      targetSelect.value = direction.target;
    }
    return {
      source: direction.source,
      target: direction.target,
      same: direction.source === direction.target
    };
  };

  sourceSelect.onchange = () => {
    refresh();
    onChange?.('source');
  };
  targetSelect.onchange = () => onChange?.('target');
  swapButton.onclick = () => {
    const { value: to } = targetSelect;
    if (sourceSelect.value === AUTO_DETECT) {
      // 从「自动检测 → 中文」翻成「中文 → 英语」这类反向写法
      sourceSelect.value = to;
      targetSelect.value = suggestTarget(to, DEFAULT_TARGET_LANGUAGE);
    } else {
      const from = sourceSelect.value;
      sourceSelect.value = to;
      targetSelect.value = from;
    }
    refresh('');
    onChange?.('swap');
  };

  return { sourceSelect, targetSelect, refresh, resolve };
}
