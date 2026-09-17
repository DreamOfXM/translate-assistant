import { languageName, directionKey, DEFAULT_TARGET_LANGUAGE } from '../lib/languages.js';
import { initI18n, applyI18n, t, uiLang } from '../lib/i18n.js';
import { languageBarMarkup, bindLanguageBar } from '../lib/langbar.js';
import { translateInSegments } from '../lib/text.js';
import { HOVER_STORAGE_KEY, PAGE_STORAGE_KEY, AUTO_STORAGE_KEY } from '../lib/reader.js';
import { MESSAGES, EVENTS } from '../lib/protocol.js';
import { markUserGesture, chromeTranslateFirst } from '../lib/chrome-translator.js';

const $ = id => document.getElementById(id);

const sourceArea = $('source');
const langbarRoot = $('langbar');
const runButton = $('run');
const copyButton = $('copy');
const bar = $('bar');
const barFill = bar.querySelector('i');
const statusLine = $('status');
const outputLabel = $('output-label');
const result = $('result');
const packsLine = $('packs');

let resultText = '';
let installing = false;   // 引导卡正在装语言包：这段时间进度条归安装用

const ready = initI18n().then(() => {
  applyI18n(document);
  langbarRoot.innerHTML = languageBarMarkup({ to: DEFAULT_TARGET_LANGUAGE });
  langbar = bindLanguageBar(langbarRoot, {
    onChange: reason => {
      if (reason === 'swap' && resultText) {
        // 交换语言时把译文挪回原文框，方便反向翻译
        sourceArea.value = resultText;
        langbar.refresh(sourceArea.value);
        showResult('', t('output_label'));
        setStatus(t('status_swapped'));
        return;
      }
      if (resultText) run();
    }
  });
  langbar.refresh('');
  showResult('', t('output_label'));
  sourceArea.focus();
});

let langbar = null;   // 语言条在 i18n 就绪后创建（选项名随界面语言）

function setStatus(message, kind = '') {
  statusLine.textContent = message ?? '';
  statusLine.className = `status${kind ? ` ${kind}` : ''}`;
}

function showProgress(progress) {
  bar.hidden = false;
  barFill.style.width = `${Math.max(0, Math.min(100, progress.percent ?? 0))}%`;
  if (progress.label) setStatus(progress.label);
}

function showResult(text, label) {
  resultText = text ?? '';
  result.textContent = resultText || t('output_placeholder');
  result.className = resultText ? 'text' : 'text placeholder';
  outputLabel.textContent = label ?? t('output_label');
  copyButton.disabled = !resultText;
}

sourceArea.addEventListener('input', () => langbar.refresh(sourceArea.value));
sourceArea.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run();
});

/**
 * 单段翻译：先试 Chrome 内建引擎（Google 端上模型），不行再交给扩展侧的本地语言包引擎。
 *
 * popup 是扩展页面，自己就是「有用户手势」的文档，所以模型下载可以在这里发起——
 * 离屏文档没有手势，Chrome 会以 NotAllowedError 拒绝下载（见 lib/chrome-translator.js）。
 */
async function translateSegment(segment, source, target) {
  const chromeText = await chromeTranslateFirst(segment, source, target, {
    onModel: ({ phase, percent }) => {
      if (phase !== 'downloading') return;   // 就绪/失败后，进度条交回给本次翻译自己
      showProgress({
        percent: percent ?? 0,
        label: t('bubble_model_downloading', { p: percent === null ? '' : `${percent}%` }).trim()
      });
    }
  });
  if (chromeText !== null) {
    lastEngine = 'chrome';
    return chromeText;
  }
  const response = await chrome.runtime.sendMessage({
    type: MESSAGES.TRANSLATE, text: segment, source, target
  });
  if (!response) throw new Error(t('error_no_response'));
  if (response.error) throw new Error(response.error);
  lastEngine = response.engine ?? lastEngine;
  return response.text;
}

async function run() {
  const text = sourceArea.value;
  if (!text.trim()) {
    setStatus(t('status_empty'), 'error');
    sourceArea.focus();
    return;
  }

  const { source, target, same } = langbar.resolve(text);
  if (same) {
    setStatus(t('status_same_lang', { name: languageName(target, uiLang()) }), 'error');
    return;
  }

  // 用户点了「翻译」= 同意下载 Chrome 内建引擎的语言包（下载必须有用户手势）
  markUserGesture();
  lastEngine = null;

  runButton.disabled = true;
  runButton.classList.add('loading');
  bar.hidden = false;
  barFill.style.width = '0%';
  setStatus(t('status_translating'));

  try {
    const outcome = await translateInSegments(
      text,
      segment => translateSegment(segment, source, target),
      { onProgress: showProgress }
    );
    showResult(outcome.text, t('output_label_named', { name: languageName(target, uiLang()) }));
    const engineLabel = t(lastEngine === 'chrome' ? 'engine_chrome_label' : 'engine_local_label');
    setStatus((outcome.segments > 1 ? t('status_done_segments', { n: outcome.segments }) : t('status_done')) + ' · ' + engineLabel, 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    runButton.disabled = false;
    runButton.classList.remove('loading');
    bar.hidden = true;
  }
}

runButton.onclick = run;

const COPY_LABEL = () => t('copy');
let copyTimer = 0;
copyButton.onclick = async () => {
  try {
    await navigator.clipboard.writeText(resultText);
    setStatus(t('status_copied'), 'ok');
    copyButton.textContent = t('copied');
    copyButton.classList.add('copied');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copyButton.textContent = COPY_LABEL();
      copyButton.classList.remove('copied');
    }, 2000);
  } catch {
    setStatus(t('status_copy_failed'), 'error');
  }
};

$('manage').onclick = () => chrome.runtime.openOptionsPage();

// 读模式的三个开关，content script 通过 storage.onChanged 实时感知。
// 整页双语对照和悬浮按钮默认开（这是主要用法），悬停按钮默认关。
function bindToggle(id, key, defaultValue) {
  const toggle = $(id);
  // 默认开的开关在 popup.html 里已写好 checked，异步读只是校正，
  // 不会出现「打开弹窗时肉眼可见地跳一下」
  chrome.storage.local.get(key)
    .then(stored => {
      toggle.checked = stored?.[key] === undefined ? defaultValue : Boolean(stored[key]);
    })
    .catch(() => {
      toggle.checked = defaultValue; // 读不到就用默认值
    });
  toggle.onchange = () => {
    chrome.storage.local.set({ [key]: toggle.checked });
  };
  return toggle;
}

bindToggle('auto', AUTO_STORAGE_KEY, true);
bindToggle('page', PAGE_STORAGE_KEY, true);
bindToggle('hover', HOVER_STORAGE_KEY, false);

// Service Worker 会把引擎进度广播给扩展页面
chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== EVENTS.TRANSLATION_PROGRESS) return false;
  // 装语言包时弹窗也在等这路广播；翻译时进度条由 run() 自己控制
  if (installing || !bar.hidden) showProgress(message.progress);
  return false;
});

const onboard = $('onboard');
const onboardButton = $('onboard-go');

/** 语言包状态。只读 storage（Service Worker 不会为此拉起引擎），顺带决定引导卡显不显示 */
async function refreshPacks() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGES.GET_DIRECTION_STATUS });
    const count = response?.installed?.length ?? 0;
    packsLine.textContent = count ? t('packs_count', { n: count }) : t('packs_none');
    // 一个语言包都没装时，把「去安装」引导卡顶在最上面
    onboard.hidden = count > 0;
    return count;
  } catch {
    packsLine.textContent = t('packs_error');
    return 0;
  }
}

/**
 * 引导卡的「安装」在弹窗里把默认方向真正下下来。
 *
 * 下载交给 Service Worker + 离屏文档，弹窗被关掉也不影响它继续下；
 * 只有下不动时才退回语言包管理页，留一个能自己动手的地方。
 */
onboardButton.onclick = async () => {
  if (installing) return;
  installing = true;
  onboardButton.disabled = true;
  bar.hidden = false;
  barFill.style.width = '0%';
  setStatus(t('status_downloading'));
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.PRELOAD_DIRECTION,
      direction: directionKey('en', DEFAULT_TARGET_LANGUAGE)
    });
    if (response?.error) throw new Error(response.error);
    onboard.hidden = true;
    setStatus(t('onboard_done'), 'ok');
  } catch (error) {
    setStatus(t('onboard_failed', { msg: error.message }), 'error');
    // 下不动就退回语言包管理页，至少留一个能自己动手的地方
    chrome.runtime.openOptionsPage();
  } finally {
    installing = false;
    onboardButton.disabled = false;
    bar.hidden = true;
    refreshPacks();
  }
};

refreshPacks();


