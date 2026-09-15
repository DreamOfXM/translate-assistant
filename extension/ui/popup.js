import { languageName, DEFAULT_TARGET_LANGUAGE } from '../lib/languages.js';
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

const PLACEHOLDER = '译文会出现在这里。';
let resultText = '';

langbarRoot.innerHTML = languageBarMarkup({ to: DEFAULT_TARGET_LANGUAGE });
const langbar = bindLanguageBar(langbarRoot, {
  onChange: reason => {
    if (reason === 'swap' && resultText) {
      // 交换语言时把译文挪回原文框，方便反向翻译
      sourceArea.value = resultText;
      langbar.refresh(sourceArea.value);
      showResult('', '译文');
      setStatus('已交换语言，可把译文改回原文再翻一次。');
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
  result.textContent = resultText || PLACEHOLDER;
  result.className = resultText ? 'text' : 'text placeholder';
  outputLabel.textContent = label ?? '译文';
  copyButton.disabled = !resultText;
}

sourceArea.addEventListener('input', () => langbar.refresh(sourceArea.value));
sourceArea.addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') run();
});

async function run() {
  const text = sourceArea.value;
  if (!text.trim()) {
    setStatus('先把要翻译的内容粘进来。', 'error');
    sourceArea.focus();
    return;
  }

  const { source, target, same } = langbar.resolve(text);
  if (same) {
    setStatus(`识别出的源语言和目标语言都是${languageName(target)}，请换一个目标语言。`, 'error');
    return;
  }

  runButton.disabled = true;
  bar.hidden = false;
  barFill.style.width = '0%';
  setStatus('正在本地翻译…');

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
    showResult(outcome.text, `译文 · ${languageName(target)}`);
    setStatus(outcome.segments > 1 ? `已分 ${outcome.segments} 段翻译完成。` : '翻译完成。', 'ok');
  } catch (error) {
    setStatus(error.message, 'error');
  } finally {
    runButton.disabled = false;
    bar.hidden = true;
  }
}

runButton.onclick = run;

copyButton.onclick = async () => {
  try {
    await navigator.clipboard.writeText(resultText);
    setStatus('译文已复制。', 'ok');
  } catch {
    setStatus('复制失败，请手动选择译文复制。', 'error');
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

chrome.runtime.sendMessage({ type: MESSAGES.GET_DIRECTION_STATUS })
  .then(response => {
    const count = response?.installed?.length ?? 0;
    packsLine.textContent = count ? `已安装 ${count} 个语言包` : '尚未安装语言包';
  })
  .catch(() => {
    packsLine.textContent = '语言包状态不可用';
  });

showResult('', '译文');
sourceArea.focus();
