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
import { findMainContentRoot, isNeverAutoSite, MIN_CJK_FOR_ZH_PAGE } from './lib/content-extract.js';
import { chromeTranslatorAvailable, chromeTranslatorStatus } from './lib/chrome-translator.js';
import { PANEL_STYLES } from './lib/panel-styles.js';
import { readInput, writeInput, isEditableInput, isInputAlive } from './lib/input.js';
import { initI18n, t, uiLang } from './lib/i18n.js';

const HOST_ID = 'local-translator-root';
const SELECTION_BUTTON_LIFETIME = 4000;

let host = null;       // #local-translator-root
let shadow = null;     // ShadowRoot
let card = null;       // 当前打开的面板
let boundInput = null;       // 面板绑定的输入框

// UI 文案按界面语言生成；focusin/mouseup/autoStart 都会先等它就绪
const i18nReady = initI18n();

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
const RESULT_PLACEHOLDER = () => t('output_placeholder');

/**
 * 把译文写进结果区。没有译文时显示占位文案，避免面板塌成一块空白。
 */
function showResult({ result, label, copyButton }, text, targetName) {
  const value = text ?? '';
  result.textContent = value || RESULT_PLACEHOLDER;
  result.className = value ? 'lt-text lt-result' : 'lt-text lt-result placeholder';
  if (label) label.textContent = targetName ? t('output_label_named', { name: targetName }) : t('output_label');
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
      ? t('error_updated')
      : t('error_connect', { msg: error?.message ?? String(error) }));
  }
  if (!response) throw new Error(t('error_no_response_reload'));
  if (response.error) throw new Error(response.error);
  return { text: response.text, engine: response.engine };
}

/** 长文本自动分段逐段翻译，不做静默截断 */
async function translate({ text, source, target, onProgress }) {
  let engine = null;
  const outcome = translateInSegments(
    text,
    segment => requestTranslation(segment, source, target).then(part => {
      engine = part.engine ?? engine;
      return part.text;
    }),
    { onProgress }
  );
  outcome.engine = engine;
  return outcome;
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
        <p class="lt-title">${t('sel_title')}</p>
        <p class="lt-sub">${t('sel_sub')}</p>
      </div>
      <button class="lt-close" type="button" title="关闭">×</button>
    </div>
    <label class="lt-field">${t('field_source')}
      <textarea class="lt-original" readonly rows="3">${escapeHtml(text)}</textarea>
    </label>
    ${languageBarMarkup({ to: target })}
    <div class="lt-actions">
      <button class="lt-button lt-translate" type="button">${t('retranslate')}</button>
      <button class="lt-button ghost lt-copy" type="button" disabled>${t('copy_translation')}</button>
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
      status(message, t('status_same_lang', { name: languageName(to, uiLang()) }), 'error');
      return;
    }
    translateButton.disabled = true;
    bar.hidden = false;
    barFill.style.width = '0%';
    status(message, t('status_translating'));
    try {
      const outcome = await translate({ text, source, target: to, onProgress: showProgress });
      translated = outcome.text;
      showResult({ result, label: outputLabel, copyButton }, translated, languageName(to));
      const engineLabel = t(outcome.engine === 'chrome' ? 'engine_chrome_label' : 'engine_local_label');
      status(message, (outcome.segments > 1 ? t('status_result_segmented', { n: outcome.segments }) : t('status_result_done')) + ' · ' + engineLabel, 'ok');
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
    status(message, ok ? t('status_copied') : t('status_copy_failed'), ok ? 'ok' : 'error');
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
        <p class="lt-title">${t('reply_title')}</p>
        <p class="lt-sub">${t('reply_sub')}</p>
      </div>
      <button class="lt-close" type="button" title="关闭">×</button>
    </div>
    <p class="lt-note">${t('reply_note')}</p>
    <label class="lt-field">${t('draft')}
      <textarea class="lt-draft" placeholder="${t('draft_ph')}"></textarea>
    </label>
    ${languageBarMarkup({ to: target })}
    <div class="lt-actions">
      <button class="lt-button lt-translate" type="button">${t('generate')}</button>
      <button class="lt-button primary-fill lt-fill" type="button" disabled>${t('fill')}</button>
      <button class="lt-button ghost lt-copy" type="button" disabled>${t('copy')}</button>
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
      status(message, t('input_gone'), 'error');
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
      status(message, t('status_same_lang', { name: languageName(to, uiLang()) }), 'error');
      return;
    }
    translateButton.disabled = true;
    bar.hidden = false;
    barFill.style.width = '0%';
    status(message, t('translating_pack'));
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
      status(message, input ? t('review_fill') : t('no_input'), 'ok');
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
      status(message, t('filled'), 'ok');
    } else {
      status(message, t('fill_rejected'), 'error');
    }
  };

  copyButton.onclick = async () => {
    const ok = await copyText(translation);
    status(message, ok ? t('status_copied') : t('status_copy_failed'), ok ? 'ok' : 'error');
  };
  draftArea.addEventListener('input', () => langbar.refresh(draftArea.value));
  draftArea.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run();
  });

  status(message, draft ? t('reply_status_has_draft') : t('reply_status_empty'));
  draftArea.focus();
}

/**
 * 就地译文条：输入框里已经有草稿时，点「翻译回复」不再打开完整面板，
 * 直接在输入框下方出一条紧凑译文（自动翻译 → 填入 / 重译 / 复制）。
 * 填入成功即收尾；「更多选项」切换到完整面板继续编辑草稿。
 */
function openInlineTranslation({ input }) {
  mount();
  closeCard();
  boundInput = input;
  const draft = readInput(input).trim();

  card = element('section', 'lt-card lt-inline');
  card.innerHTML = `
    <div class="lt-inline-head">
      <span class="lt-inline-lang"></span>
      <button class="lt-close" type="button" title="关闭">×</button>
    </div>
    <p class="lt-text lt-result placeholder">${t('para_translating')}</p>
    <div class="lt-bar" hidden><i></i></div>
    <div class="lt-actions">
      <button class="lt-button primary-fill lt-fill" type="button" disabled>${t('fill')}</button>
      <button class="lt-button ghost lt-retry" type="button" disabled>${t('inline_retry')}</button>
      <button class="lt-button ghost lt-copy" type="button" disabled>${t('copy')}</button>
      <button class="lt-inline-more" type="button">完整面板</button>
    </div>
    <p class="lt-status"></p>
  `;
  shadow.append(card);
  const rect = input.getBoundingClientRect();
  place(card, rect.left, (rect.bottom || rect.top) + 8, Math.max(300, Math.min(rect.width, 400)));

  const fillButton = card.querySelector('.lt-fill');
  const retryButton = card.querySelector('.lt-retry');
  const copyButton = card.querySelector('.lt-copy');
  const result = card.querySelector('.lt-result');
  const bar = card.querySelector('.lt-bar');
  const barFill = bar.querySelector('i');
  const message = card.querySelector('.lt-status');
  const langLabel = card.querySelector('.lt-inline-lang');

  card.querySelector('.lt-close').onclick = closeCard;
  card.querySelector('.lt-inline-more').onclick = () => openReplyPanel({ input, text: draft });

  let translation = '';
  const detected = detectLanguage(draft);
  const target = suggestTarget(detected, DEFAULT_TARGET_LANGUAGE);
  langLabel.textContent = `${languageName(detected, uiLang())} → ${languageName(target, uiLang())}`;

  const showProgress = progress => {
    bar.hidden = false;
    barFill.style.width = `${Math.max(0, Math.min(100, progress.percent ?? 0))}%`;
    if (progress.label) status(message, progress.label);
  };

  const run = async () => {
    fillButton.disabled = retryButton.disabled = copyButton.disabled = true;
    bar.hidden = false;
    barFill.style.width = '0%';
    result.textContent = RESULT_PLACEHOLDER;
    result.classList.add('placeholder');
    status(message, t('status_translating'));
    try {
      const outcome = await translate({ text: draft, source: detected, target, onProgress: showProgress });
      translation = outcome.text;
      showResult({ result, label: null, copyButton }, translation, null);
      status(message, input ? t('inline_ready') : t('inline_copy_hint'), 'ok');
    } catch (error) {
      status(message, error.message, 'error');
    } finally {
      retryButton.disabled = copyButton.disabled = false;
      fillButton.disabled = !(translation && boundInput && isInputAlive(boundInput));
      bar.hidden = true;
    }
  };

  fillButton.onclick = () => {
    if (!translation) return;
    if (!boundInput || !isInputAlive(boundInput)) {
      status(message, t('input_gone'), 'error');
      fillButton.disabled = true;
      return;
    }
    if (writeInput(boundInput, translation)) {
      closeCard();
    } else {
      status(message, t('fill_rejected'), 'error');
    }
  };

  retryButton.onclick = run;
  copyButton.onclick = async () => {
    const ok = await copyText(translation);
    status(message, ok ? t('status_copied') : t('status_copy_failed'), ok ? 'ok' : 'error');
  };

  run();
}

/* ---------------------------------- 页面交互 --------------------------------- */

document.addEventListener('focusin', async event => {
  await i18nReady;
  if (isEditableInput(event.target)) {
    mount();
    attachInputButton(event.target);
  }
});

/** 在获得焦点的输入框旁挂一个入口按钮 */
function attachInputButton(inputNode) {
  if (inputNode.dataset.ltBound) return;
  inputNode.dataset.ltBound = '1';

  const button = element('button', 'lt-float', { type: 'button', textContent: t('float_reply') });
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

  button.onclick = () => {
    // 输入框里已经有草稿：就地出译文条，不打开完整面板
    const existing = inputNode && isInputAlive(inputNode) ? readInput(inputNode).trim() : '';
    if (existing) openInlineTranslation({ input: inputNode });
    else openReplyPanel({ input: inputNode });
  };
  inputNode.addEventListener('blur', () => setTimeout(() => {
    if (!card) detach();
  }, 300));
  reposition();
  window.addEventListener('scroll', reposition, { passive: true });
  window.addEventListener('resize', reposition);
}

document.addEventListener('mouseup', async event => {
  await i18nReady;
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
  const button = element('button', 'lt-float lt-selection', { type: 'button', textContent: t('float_select') });
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
    segment => requestTranslation(segment, source, READ_TARGET_LANGUAGE).then(part => part.text)
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

/**
 * 页面文字取样，用来判断整页是什么语言。
 * 不用 body.innerText：它会强制整页重排，而且这只在页面加载时跑一次，不值得。
 * 也不用 textContent：它会把 script/style 里的代码当成正文文字，污染语言判定。
 * 改为自顶向下走 DOM，攒够 800 字立刻停手。
 */
function pageSample() {
  const body = document.body ?? document.documentElement;
  if (!body) return '';
  const limit = 800;
  let out = '';
  const walk = node => {
    for (const child of node.childNodes) {
      if (out.length >= limit) return;
      if (child.nodeType === Node.TEXT_NODE) out += child.data;
      else if (child.nodeType === Node.ELEMENT_NODE &&
        !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(child.tagName)) walk(child);
    }
  };
  walk(body);
  return out.slice(0, limit);
}

/** 判断整页是什么语言：按中英文字占比，汉字占多数才算中文页（见 languages.js）。
 *
 *  判定范围优先取正文根而不是整页采样：GitHub 的界面全是英文，中文 README 页
 *  若按 body 采样会被误判成英文页，整页对照就会绕过中文正文、去翻那些零星的
 *  英文界面词——正是「分不清中英文，见到单词就翻」的观感来源。 */
function pageLanguage() {
  // 日语守卫（必须最先做）：日语书写大量使用汉字，按汉字数量判「中文页」
  // 会把日文页面误判成中文而拒绝翻译。页面假名达到这个量级即可断定是日语。
  const kana = (String(document.body?.textContent ?? '').match(/[぀-ヿ]/g) ?? []).length;
  if (kana >= 80) return 'ja';

  let root = null;
  try { root = findMainContentRoot(document); } catch { /* 判定失败退回 body 采样 */ }
  if (root) {
    const text = String(root.textContent ?? '');
    if (text.trim()) return detectLanguageByRatio(text);
  }
  // 没有正文根时保守判中文：页面里已有可观的中文，自动双语只会翻出
  // 零星界面词的噪音；真正的外文页面不会带这么多汉字
  const body = document.body;
  if (body) {
    const cjk = (String(body.textContent ?? '').match(/[㐀-䶿一-鿿]/g) ?? []).length;
    if (cjk >= MIN_CJK_FOR_ZH_PAGE) return 'zh';
  }
  const text2 = pageSample();
  return text2.trim() ? detectLanguageByRatio(text2) : null;
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

/**
 * Chrome 内建引擎（138+）支持该方向时，整页对照不需要任何语言包——
 * 模型由浏览器管理，已就绪即用。只认 available：downloadable 意味着
 * 要触发浏览器级大模型下载，不能在自动模式里静默发生。
 */
async function chromeEngineStatus(source, target) {
  if (!chromeTranslatorAvailable()) return { status: 'no-api' };
  try {
    return await chromeTranslatorStatus(source, target);
  } catch {
    return { status: 'no-api' };
  }
}

async function autoStart() {
  await i18nReady;
  // 站点黑名单先行：GitHub 这类应用型站点每一页都是界面零件，
  // 主流做法（Chrome「永不翻译这些网站」、沉浸式翻译「永不翻译此网站」）
  // 都是站点级开关；手动点「双语对照」仍然可翻。
  if (isNeverAutoSite(globalThis.location?.hostname ?? window.location?.hostname)) {
    hoverReader.setBubbleNotice({ text: t('bubble_site') });
    return;
  }
  const source = pageLanguage();
  if (!source) return;
  // 中文网页对中文读者没有翻译价值；把原因说在按钮上，别让用户猜
  if (source === READ_TARGET_LANGUAGE) {
    hoverReader.setBubbleNotice({ text: t('bubble_zh') });
    return;
  }
  // Chrome 内建引擎模型尚未下载（downloadable）时：自动模式绝不静默触发下载，
  // 但按钮会明确告诉用户「点一下就开始下载并翻译」——用户的点击即同意。
  const chrome = await chromeEngineStatus(source, READ_TARGET_LANGUAGE);
  if (chrome.status === 'downloadable' || chrome.status === 'downloading') {
    hoverReader.setBubbleNotice({ text: t('bubble_google') });
    return;
  }
  if (!(await directionReady(source)) && chrome.status !== 'available') {
    // 不静默装死：告诉用户为什么没翻；点击按钮=开始翻译（手动触发允许下载）
    hoverReader.setBubbleNotice({ text: t('bubble_pack') });
    return;
  }
  hoverReader.setBubbleNotice(null);
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
