/**
 * Content Script：识别输入框、处理选中文本、展示翻译结果，并在用户确认后填回译文。
 *
 * 原则：
 * - 只在用户显式点击后触发翻译，不自动翻译整页。
 * - 只在用户点击「填入」后才修改输入框，绝不触发发送、回车或提交。
 * - 所有界面挂在 Shadow DOM 里，不污染宿主页面，也不受宿主页面样式影响。
 */

import {
  languageName, detectLanguage, detectLanguageByRatio, suggestTarget, DEFAULT_TARGET_LANGUAGE
} from './lib/languages.js';
import { languageBarMarkup, bindLanguageBar } from './lib/langbar.js';
import { translateInSegments, planTranslation, MAX_TEXT_LENGTH } from './lib/text.js';
import {
  createHoverReader, HOVER_STORAGE_KEY, PAGE_STORAGE_KEY, AUTO_STORAGE_KEY
} from './lib/reader.js';
import { MESSAGES, EVENTS, planPacks, isDirectionReady } from './lib/protocol.js';
import { PANEL_STYLES } from './lib/panel-styles.js';
import { readInput, writeInput, isEditableInput, isInputAlive } from './lib/input.js';

const HOST_ID = 'local-translator-root';
const SELECTION_BUTTON_LIFETIME = 4000;

let host = null;       // #local-translator-root
let shadow = null;     // ShadowRoot
let card = null;       // 当前打开的面板
let boundInput = null; // 面板绑定的输入框

/* ---------------------------------- 基础设施 --------------------------------- */

function mount() {
  if (host && document.body?.contains(host)) return { host, shadow };
  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = PANEL_STYLES;
  shadow.append(style);
  (document.body ?? document.documentElement).append(host);
  return { host, shadow };
}

function element(tag, className, properties = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  Object.assign(node, properties);
  return node;
}

function closeCard() {
  card?.remove();
  card = null;
  boundInput = null;
}

/** 把面板夹在可视区域内，避免贴边被裁掉 */
function place(node, x, y, height) {
  node.style.left = `${Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 440))}px`;
  node.style.top = `${Math.min(Math.max(8, y), Math.max(8, window.innerHeight - height))}px`;
}

function status(node, message, kind = '') {
  node.textContent = message ?? '';
  node.className = `lt-status${kind ? ` ${kind}` : ''}`;
}

/** 目标语言还没产出译文时的占位文案 */
const RESULT_PLACEHOLDER = '译文会出现在这里。';

/**
 * 把译文写进结果区。没有译文时显示占位文案，避免面板塌成一块空白。
 */
function showResult({ result, label, copyButton }, text, targetName) {
  const value = text ?? '';
  result.textContent = value || RESULT_PLACEHOLDER;
  result.className = value ? 'lt-text lt-result' : 'lt-text lt-result placeholder';
  if (label) label.textContent = targetName ? `译文 · ${targetName}` : '译文';
  if (copyButton) copyButton.disabled = !value;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 某些页面没有剪贴板权限，退回临时 textarea
    const area = element('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.append(area);
    area.select();
    const ok = document.execCommand?.('copy') ?? false;
    area.remove();
    return ok;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

/* ------------------------------------ 翻译 ----------------------------------- */

async function requestTranslation(text, source, target) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: MESSAGES.TRANSLATE, text, source, target });
  } catch (error) {
    throw new Error(String(error?.message ?? error).includes('Extension context')
      ? '扩展已更新，请刷新页面后重试。'
      : `无法连接翻译引擎：${error?.message ?? error}`);
  }
  if (!response) throw new Error('翻译引擎没有响应，请重新加载扩展后重试。');
  if (response.error) throw new Error(response.error);
  return response.text;
}

/** 长文本自动分段逐段翻译，不做静默截断 */
async function translate({ text, source, target, onProgress }) {
  return translateInSegments(
    text,
    segment => requestTranslation(segment, source, target),
    { onProgress }
  );
}

/* ---------------------------------- 结果卡片 --------------------------------- */

/** 选中文本后的结果卡片：展示原文与译文，提供复制，不写入任何输入框 */
function openResultCard({ text, rect }) {
  mount();
  closeCard();

  const target = suggestTarget(detectLanguage(text), DEFAULT_TARGET_LANGUAGE);

  card = element('section', 'lt-card');
  card.innerHTML = `
    <div class="lt-head">
      <div>
        <p class="lt-title">选中文本翻译</p>
        <p class="lt-sub">本地运行 · 不上传 · 不修改页面</p>
      </div>
      <button class="lt-close" type="button" title="关闭">×</button>
    </div>
    <label class="lt-field">原文
      <textarea class="lt-original" readonly rows="3">${escapeHtml(text)}</textarea>
    </label>
    ${languageBarMarkup({ to: target })}
    <div class="lt-actions">
      <button class="lt-button lt-translate" type="button">重新翻译</button>
      <button class="lt-button ghost lt-copy" type="button" disabled>复制译文</button>
    </div>
    <div class="lt-bar" hidden><i></i></div>
    <p class="lt-status"></p>
    <div class="lt-output">
      <div class="lt-label lt-output-label">译文</div>
      <p class="lt-text lt-result placeholder">${RESULT_PLACEHOLDER}</p>
    </div>
  `;
  shadow.append(card);
  place(card, rect.left, (rect.bottom || rect.top) + 8, 400);

  const translateButton = card.querySelector('.lt-translate');
  const copyButton = card.querySelector('.lt-copy');
  const outputLabel = card.querySelector('.lt-output-label');
  const result = card.querySelector('.lt-result');
  const bar = card.querySelector('.lt-bar');
  const barFill = bar.querySelector('i');
  const message = card.querySelector('.lt-status');

  card.querySelector('.lt-close').onclick = closeCard;

  const showProgress = progress => {
    bar.hidden = false;
    barFill.style.width = `${Math.max(0, Math.min(100, progress.percent ?? 0))}%`;
    if (progress.label) status(message, progress.label);
  };

  let translated = '';

  const langbar = bindLanguageBar(card, { onChange: () => { if (translated) run(); } });
  langbar.refresh(text);

  const run = async () => {
    const { source, target: to, same } = langbar.resolve(text);
    if (same) {
      status(message, `识别出的源语言和目标语言都是${languageName(to)}，请换一个目标语言。`, 'error');
      return;
    }
    translateButton.disabled = true;
    bar.hidden = false;
    barFill.style.width = '0%';
    status(message, '正在本地翻译…');
    try {
      const outcome = await translate({ text, source, target: to, onProgress: showProgress });
      translated = outcome.text;
      showResult({ result, label: outputLabel, copyButton }, translated, languageName(to));
      status(message, outcome.segments > 1 ? `已分 ${outcome.segments} 段翻译完成。` : '翻译完成。', 'ok');
    } catch (error) {
      status(message, error.message, 'error');
    } finally {
      translateButton.disabled = false;
      bar.hidden = true;
    }
  };

  translateButton.onclick = run;
  copyButton.onclick = async () => {
    const ok = await copyText(translated);
    status(message, ok ? '译文已复制到剪贴板。' : '复制失败，请手动选择译文复制。', ok ? 'ok' : 'error');
  };

  run();
}

/* ---------------------------------- 回复面板 --------------------------------- */

/** 回复翻译面板：母语写草稿 → 翻译成目标语言 → 用户确认后填入输入框 */
function openReplyPanel({ input = null, text = '' } = {}) {
  mount();
  closeCard();
  boundInput = input;

  const draft = text || (input ? readInput(input) : '');
  // 空草稿按中文处理：中文用户打开回复框通常是要把中文译出去
  const detected = draft.trim() ? detectLanguage(draft) : 'zh';
  const target = suggestTarget(detected, DEFAULT_TARGET_LANGUAGE);

  card = element('section', 'lt-card');
  card.innerHTML = `
    <div class="lt-head">
      <div>
        <p class="lt-title">回复翻译助手</p>
        <p class="lt-sub">本地处理 · 只在你确认后填入 · 不自动发布</p>
      </div>
      <button class="lt-close" type="button" title="关闭">×</button>
    </div>
    <p class="lt-note">用母语写下想表达的内容，确认译文后再手动填入。插件不会替你点击发送。</p>
    <label class="lt-field">草稿
      <textarea class="lt-draft" placeholder="例如：这个方案我觉得可行，但预算需要再确认一下。"></textarea>
    </label>
    ${languageBarMarkup({ to: target })}
    <div class="lt-actions">
      <button class="lt-button lt-translate" type="button">生成译文</button>
      <button class="lt-button primary-fill lt-fill" type="button" disabled>填入输入框</button>
      <button class="lt-button ghost lt-copy" type="button" disabled>复制</button>
    </div>
    <div class="lt-bar" hidden><i></i></div>
    <p class="lt-status"></p>
    <div class="lt-output">
      <div class="lt-label lt-output-label">译文</div>
      <p class="lt-text lt-result placeholder">${RESULT_PLACEHOLDER}</p>
    </div>
  `;
  card.querySelector('.lt-draft').value = draft;
  shadow.append(card);
  place(card, Math.max(8, window.innerWidth - 440), 84, 520);

  const draftArea = card.querySelector('.lt-draft');
  const translateButton = card.querySelector('.lt-translate');
  const fillButton = card.querySelector('.lt-fill');
  const copyButton = card.querySelector('.lt-copy');
  const outputLabel = card.querySelector('.lt-output-label');
  const result = card.querySelector('.lt-result');
  const bar = card.querySelector('.lt-bar');
  const barFill = bar.querySelector('i');
  const message = card.querySelector('.lt-status');

  card.querySelector('.lt-close').onclick = closeCard;

  let translation = '';

  const langbar = bindLanguageBar(card, { onChange: () => { if (translation) run(); } });
  langbar.refresh(draft);

  const showProgress = progress => {
    bar.hidden = false;
    barFill.style.width = `${Math.max(0, Math.min(100, progress.percent ?? 0))}%`;
    if (progress.label) status(message, progress.label);
  };

  const refreshFillState = () => {
    const alive = Boolean(boundInput) && isInputAlive(boundInput);
    fillButton.disabled = !(translation && alive);
    if (translation && boundInput && !alive) {
      status(message, '原来的输入框已失效，请重新点击输入框上的「翻译回复」。', 'error');
    }
  };

  const run = async () => {
    const plan = planTranslation(draftArea.value);
    if (!plan.ok) {
      status(message, plan.message, 'error');
      return;
    }
    const { source, target: to, same } = langbar.resolve(draftArea.value);
    if (same) {
      status(message, `识别出的源语言和目标语言都是${languageName(to)}，请换一个目标语言。`, 'error');
      return;
    }
    translateButton.disabled = true;
    bar.hidden = false;
    barFill.style.width = '0%';
    status(message, '正在本地翻译，首次使用需要下载语言包…');
    try {
      const outcome = await translate({
        text: draftArea.value,
        source,
        target: to,
        onProgress: showProgress
      });
      translation = outcome.text;
      showResult({ result, label: outputLabel, copyButton }, translation, languageName(to));
      refreshFillState();
      status(message, input ? '请检查译文，确认后再填入。' : '当前没有绑定输入框，可复制译文使用。', 'ok');
    } catch (error) {
      status(message, error.message, 'error');
    } finally {
      translateButton.disabled = false;
      bar.hidden = true;
    }
  };

  translateButton.onclick = run;

  fillButton.onclick = () => {
    if (!translation) return;
    if (!boundInput || !isInputAlive(boundInput)) {
      refreshFillState();
      return;
    }
    if (writeInput(boundInput, translation)) {
      status(message, '已填入输入框。请自行检查后发布——插件不会替你发送。', 'ok');
    } else {
      status(message, '这个编辑器不接受自动填入，请复制译文后手动粘贴。', 'error');
    }
  };

  copyButton.onclick = async () => {
    const ok = await copyText(translation);
    status(message, ok ? '译文已复制。' : '复制失败，请手动选择译文复制。', ok ? 'ok' : 'error');
  };
  draftArea.addEventListener('input', () => langbar.refresh(draftArea.value));
  draftArea.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run();
  });

  status(message, draft ? '确认草稿后点击「生成译文」。' : '写下草稿后点击「生成译文」。');
  draftArea.focus();
}

/* ---------------------------------- 页面交互 --------------------------------- */

document.addEventListener('focusin', event => {
  if (isEditableInput(event.target)) {
    mount();
    attachInputButton(event.target);
  }
});

/** 在获得焦点的输入框旁挂一个入口按钮 */
function attachInputButton(inputNode) {
  if (inputNode.dataset.ltBound) return;
  inputNode.dataset.ltBound = '1';

  const button = element('button', 'lt-float', { type: 'button', textContent: '翻译回复' });
  shadow.append(button);

  const reposition = () => {
    const rect = inputNode.getBoundingClientRect();
    if (!rect.width && !rect.height) return;
    button.style.left = `${Math.min(Math.max(8, rect.right - 96), window.innerWidth - 108)}px`;
    button.style.top = `${Math.max(8, rect.top - 36)}px`;
    button.hidden = rect.bottom < 0 || rect.top > window.innerHeight;
  };

  const detach = () => {
    button.remove();
    window.removeEventListener('scroll', reposition);
    window.removeEventListener('resize', reposition);
    delete inputNode.dataset.ltBound;
  };

  button.onclick = () => openReplyPanel({ input: inputNode });
  inputNode.addEventListener('blur', () => setTimeout(() => {
    if (!card) detach();
  }, 300));
  reposition();
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
}

document.addEventListener('mouseup', event => {
  if (host && event.composedPath?.().includes(host)) return;
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || text.length > MAX_TEXT_LENGTH) return;

  let rect;
  try {
    rect = selection.getRangeAt(0).getBoundingClientRect();
  } catch {
    return;
  }
  if (!rect.width && !rect.height) return;

  mount();
  // 只清掉上一个「翻译选中」按钮，保留输入框旁的「翻译回复」按钮
  shadow.querySelectorAll('.lt-selection').forEach(node => node.remove());
  const button = element('button', 'lt-float lt-selection', { type: 'button', textContent: '翻译选中' });
  button.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 108)}px`;
  button.style.top = `${Math.max(8, rect.top - 36)}px`;
  button.onclick = () => {
    button.remove();
    openResultCard({ text, rect });
  };
  shadow.append(button);
  setTimeout(() => button.remove(), SELECTION_BUTTON_LIFETIME);
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCard();
});

/* --------------------------------- 悬停阅读 ---------------------------------- */

/** 「读」模式的固定目标语言：看网页时默认译成中文 */
const READ_TARGET_LANGUAGE = 'zh';

async function translateParagraph(text) {
  const source = detectLanguageByRatio(text);
  // 混排页面里真正的中文段落：没有翻译价值，静默跳过，不弹错误卡片
  if (source === READ_TARGET_LANGUAGE) {
    const error = new Error('这段本来就是中文，无需翻译。');
    error.silent = true;
    throw error;
  }
  const outcome = await translateInSegments(
    text,
    segment => requestTranslation(segment, source, READ_TARGET_LANGUAGE)
  );
  return outcome.text;
}

const hoverReader = createHoverReader({
  getHost: () => host,
  getShadow: () => {
    mount();
    return shadow;
  },
  translateParagraph
});

/** 页面文字取样，用来判断整页是什么语言 */
function pageSample() {
  const body = document.body;
  const text = typeof body?.innerText === 'string' && body.innerText.trim()
    ? body.innerText
    : (body?.textContent ?? '');
  return text.slice(0, 800);
}

/** 判断整页是什么语言：按中英文字占比，汉字占多数才算中文页（见 languages.js） */
function pageLanguage() {
  const text = pageSample();
  if (!text.trim()) return null;
  return detectLanguageByRatio(text);
}

/**
 * 自动翻译前先确认语言包已经装好。
 * 自动模式绝不能偷偷下载几十 MB 的包——那必须让用户显式点一次。
 */
async function directionReady(source) {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_DIRECTION_STATUS });
    const installed = response?.installed ?? [];
    const plan = planPacks(source, READ_TARGET_LANGUAGE, installed);
    return plan ? isDirectionReady(plan.packs, installed) : false;
  } catch {
    return false;
  }
}

async function autoStart() {
  const source = pageLanguage();
  if (!source) return;
  // 中文网页对中文读者没有翻译价值
  if (source === READ_TARGET_LANGUAGE) return;
  if (!(await directionReady(source))) return;
  hoverReader.setAuto(true);
}

const READER_KEYS = [HOVER_STORAGE_KEY, PAGE_STORAGE_KEY, AUTO_STORAGE_KEY];

function applyReaderSettings(stored) {
  hoverReader.setEnabled(Boolean(stored?.[HOVER_STORAGE_KEY]));
  // 悬浮按钮与自动翻译默认开：整页双语对照是这个扩展的主要用法
  hoverReader.setPageUi(stored?.[PAGE_STORAGE_KEY] !== false);
  if (stored?.[AUTO_STORAGE_KEY] !== false) autoStart();
  else hoverReader.setAuto(false);
}

async function restoreReaderSettings() {
  try {
    applyReaderSettings(await chrome.storage.local.get(READER_KEYS));
  } catch {
    hoverReader.setEnabled(false);
  }
}

restoreReaderSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;
  if (Object.prototype.hasOwnProperty.call(changes, HOVER_STORAGE_KEY)) {
    hoverReader.setEnabled(Boolean(changes[HOVER_STORAGE_KEY].newValue));
  }
  if (Object.prototype.hasOwnProperty.call(changes, PAGE_STORAGE_KEY)) {
    hoverReader.setPageUi(changes[PAGE_STORAGE_KEY].newValue !== false);
  }
  if (Object.prototype.hasOwnProperty.call(changes, AUTO_STORAGE_KEY)) {
    if (changes[AUTO_STORAGE_KEY].newValue !== false) autoStart();
    else hoverReader.setAuto(false);
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === EVENTS.SHOW_TRANSLATOR) {
    const selected = window.getSelection()?.toString().trim() || message.text || '';
    if (!selected) return;
    let rect = { left: 80, top: 120, bottom: 160 };
    try {
      rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    } catch {
      /* 没有选区时用默认位置 */
    }
    openResultCard({ text: selected, rect });
  }
  return false;
});
