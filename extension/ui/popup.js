import { languageName, DEFAULT_TARGET_LANGUAGE } from '../lib/languages.js';
import { initI18n, applyI18n, t, uiLang } from '../lib/i18n.js';
import { languageBarMarkup, bindLanguageBar } from '../lib/langbar.js';
import { translateInSegments } from '../lib/text.js';
import { HOVER_STORAGE_KEY, PAGE_STORAGE_KEY, AUTO_STORAGE_KEY } from '../lib/reader.js';
import { MESSAGES, EVENTS } from '../lib/protocol.js';

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

const ready = initI18n().then(() => { applyI18n(document); });

langbarRoot.innerHTML = languageBarMarkup({ to: DEFAULT_TARGET_LANGUAGE });
const langbar = bindLanguageBar(langbarRoot, {
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

  runButton.disabled = true;
  runButton.classList.add('loading');
  bar.hidden = false;
  barFill.style.width = '0%';
  setStatus(t('status_translating'));

  try {
    const outcome = await translateInSegments(
      text,
      segment => chrome.runtime.sendMessage({
        type: MESSAGES.TRANSLATE, text: segment, source, target
      }).then(response => {
        if (!response) throw new Error('翻译引擎没有响应。');
        if (response.error) throw new Error(response.error);
        return response.text;
      }),
      { onProgress: showProgress }
    );
    showResult(outcome.text, t('output_label_named', { name: languageName(target, uiLang()) }));
    setStatus(outcome.segments > 1 ? t('status_done_segments', { n: outcome.segments }) : t('status_done'), 'ok');
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
  if (message?.type === EVENTS.TRANSLATION_PROGRESS && !bar.hidden) showProgress(message.progress);
  return false;
});

const onboard = $('onboard');
$('onboard-go').onclick = () => chrome.runtime.openOptionsPage();

chrome.runtime.sendMessage({ type: MESSAGES.GET_DIRECTION_STATUS })
  .then(response => {
    const count = response?.installed?.length ?? 0;
    packsLine.textContent = count ? t('packs_count', { n: count }) : t('packs_none');
    // 一个语言包都没装时，把「去安装」引导卡顶在最上面
    onboard.hidden = count > 0;
  })
  .catch(() => {
    packsLine.textContent = t('packs_error');
  });

ready.then(() => {
  showResult('', t('output_label'));
  sourceArea.focus();
});
