import { languageName, COMMON_LANGUAGE_CODES, directionKey } from '../lib/languages.js';
import { initI18n, applyI18n, t, uiLang, setUiLang } from '../lib/i18n.js';
import { planPacks, missingPacks, formatBytes, EVENTS, MESSAGES } from '../lib/protocol.js';

const $ = id => document.getElementById(id);

const totalsLine = $('totals');
const statusLine = $('status');
const bar = $('bar');
const barFill = bar.querySelector('i');
const comboList = $('combos');
const packList = $('packs');
const searchInput = $('search');

let catalog = [];
let installed = [];
let busy = false;
let keyword = '';

function setStatus(message, kind = '') {
  statusLine.textContent = message ?? '';
  statusLine.className = `status${kind ? ` ${kind}` : ''}`;
}

function progress(percent) {
  bar.hidden = false;
  barFill.style.width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;
}

// Service Worker 会把引擎的下载进度广播给扩展页面
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === EVENTS.TRANSLATION_PROGRESS && busy) {
    progress(message.progress.percent);
    if (message.progress.label) setStatus(message.progress.label);
  }
  return false;
});

function row({ name, meta, metaKind = '', actions = [] }) {
  const node = document.createElement('div');
  node.className = 'row';

  const info = document.createElement('div');
  info.className = 'info';
  const title = document.createElement('span');
  title.className = 'name';
  title.textContent = name;
  const subtitle = document.createElement('span');
  subtitle.className = `meta${metaKind ? ` ${metaKind}` : ''}`;
  subtitle.textContent = meta;
  info.append(title, subtitle);

  const buttons = document.createElement('div');
  buttons.className = 'actions';
  for (const { label, className = '', onClick, disabled = false } of actions) {
    const button = document.createElement('button');
    button.className = `action${className ? ` ${className}` : ''}`;
    button.type = 'button';
    button.textContent = label;
    button.disabled = disabled || busy;
    button.onclick = onClick;
    buttons.append(button);
  }

  node.append(info, buttons);
  return node;
}

function packLabel(pack, lang = uiLang()) {
  const [from, to] = pack.split('-');
  return `${languageName(from, lang)}→${languageName(to, lang)}`;
}

function estimateBytes(packs) {
  return packs.reduce((total, pack) => {
    const entry = catalog.find(item => item.key === pack);
    return total + (entry?.estimateBytes ?? 0);
  }, 0);
}

async function runTask(direction, label) {
  if (busy) return;
  busy = true;
  setStatus(`${label}…`);
  progress(2);
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.PRELOAD_DIRECTION,
      direction
    });
    if (response?.error) throw new Error(response.error);
    await loadState();
    setStatus(`${label}完成。`, 'ok');
  } catch (error) {
    setStatus(`${label}失败：${error.message}`, 'error');
  } finally {
    busy = false;
    bar.hidden = true;
    render();
  }
}

async function removePack(direction) {
  if (busy) return;
  busy = true;
  setStatus('正在删除语言包…');
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGES.DELETE_DIRECTION,
      direction
    });
    if (response?.error) throw new Error(response.error);
    await loadState();
    setStatus('语言包已删除。', 'ok');
  } catch (error) {
    setStatus(`删除失败：${error.message}`, 'error');
  } finally {
    busy = false;
    render();
  }
}

function renderCombos() {
  const lang = uiLang();
  const available = catalog.map(item => item.key);
  const others = COMMON_LANGUAGE_CODES.filter(code => !['zh', 'zh_hant', 'en'].includes(code));
  const combos = [];

  for (const code of others) {
    for (const [from, to] of [[code, 'zh'], ['zh', code]]) {
      const plan = planPacks(from, to, available);
      if (plan) combos.push({ key: directionKey(from, to), from, to, plan });
    }
  }

  if (!combos.length) {
    comboList.innerHTML = `<p class="empty">${t('options_none_catalog')}</p>`;
    return;
  }

  comboList.replaceChildren(...combos.map(({ key, from, to, plan }) => {
    const missing = missingPacks(plan.packs, installed);
    const ready = missing.length === 0;
    const packNames = plan.packs.map(pack => packLabel(pack, lang)).join(' + ');
    const meta = ready
      ? t('options_ready_pair', { packs: packNames })
      : t('options_needs', { n: plan.packs.length, packs: packNames, size: formatBytes(estimateBytes(missing)) });

    return row({
      name: `${languageName(from, lang)} → ${languageName(to, lang)}`,
      meta,
      metaKind: ready ? 'ready' : '',
      actions: ready
        ? []
        : [{ label: t('download_progress', { done: missing.length, total: plan.packs.length }), onClick: () => runTask(key, `${t('download')} ${languageName(from, lang)} → ${languageName(to, lang)}`) }]
    });
  }));
}

function renderPacks() {
  const lang = uiLang();
  let items = catalog;
  if (keyword) {
    const lower = keyword.toLowerCase();
    items = catalog.filter(item =>
      item.key.includes(lower) ||
      languageName(item.from).toLowerCase().includes(lower) ||
      languageName(item.to).toLowerCase().includes(lower) ||
      languageName(item.from, 'en').toLowerCase().includes(lower) ||
      languageName(item.to, 'en').toLowerCase().includes(lower));
  }

  if (!items.length) {
    packList.innerHTML = `<p class="empty">${t('options_none_match')}</p>`;
    return;
  }

  packList.replaceChildren(...items.map(item => {
    const ready = installed.includes(item.key);
    const name = `${languageName(item.from, lang)} → ${languageName(item.to, lang)}`;
    return row({
      name,
      meta: ready ? t('options_ready_pack') : t('options_estimate', { size: formatBytes(item.estimateBytes) }),
      metaKind: ready ? 'ready' : '',
      actions: ready
        ? [{ label: t('remove'), className: 'remove', onClick: () => removePack(item.key) }]
        : [{ label: t('download'), onClick: () => runTask(item.key, `${t('download')} ${name}`) }]
    });
  }));
}

function render() {
  renderCombos();
  renderPacks();
  totalsLine.textContent = installed.length
    ? t('options_totals', { n: installed.length })
    : t('options_totals_none');
}

async function loadState() {
  const [catalogResponse, statusResponse] = await Promise.all([
    chrome.runtime.sendMessage({ type: MESSAGES.GET_CATALOG }),
    chrome.runtime.sendMessage({ type: MESSAGES.GET_DIRECTION_STATUS })
  ]);

  if (catalogResponse?.error) throw new Error(catalogResponse.error);
  if (statusResponse?.error) throw new Error(statusResponse.error);

  catalog = catalogResponse?.catalog ?? [];
  installed = statusResponse?.installed ?? [];
}

async function refresh() {
  setStatus('');
  try {
    await loadState();
    render();
    if (navigator.storage?.estimate) {
      const { usage } = await navigator.storage.estimate();
      if (usage) {
        totalsLine.textContent += ` · ${t('options_usage', { size: formatBytes(usage) })}`;
      }
    }
  } catch (error) {
    setStatus(`读取语言包状态失败：${error.message}`, 'error');
  }
}

searchInput.addEventListener('input', () => {
  keyword = searchInput.value.trim();
  renderPacks();
  // 空态引导：搜不到时给出「清空关键词」的一键动作，而不是死胡同
  const empty = packList.querySelector('.empty');
  if (empty && keyword) {
    const clear = document.createElement('button');
    clear.className = 'link';
    clear.style.cssText = 'display:block;margin:10px auto 0';
    clear.textContent = '← ' + t('options_clear_search');
    clear.onclick = () => { searchInput.value = ''; keyword = ''; renderPacks(); };
    empty.append(clear);
  }
});

$('refresh').onclick = refresh;

// ── AI 引擎（BYO Key）──
const $ai = id => document.getElementById(id);

async function loadAiConfig() {
  try {
    const { aiConfig: cfg } = await chrome.storage.local.get('aiConfig');
    $ai('ai-enabled').checked = Boolean(cfg?.enabled);
    $ai('ai-baseurl').value = cfg?.baseUrl ?? '';
    $ai('ai-key').value = cfg?.apiKey ?? '';
    $ai('ai-model').value = cfg?.model ?? '';
  } catch { /* 读取失败用空表单 */ }
}

function aiStatus(message, kind = '') {
  const node = $ai('ai-status');
  node.textContent = message ?? '';
  node.className = `status${kind ? ` ${kind}` : ''}`;
}

async function saveAiConfig() {
  const cfg = {
    enabled: $ai('ai-enabled').checked,
    baseUrl: $ai('ai-baseurl').value.trim().replace(/\/+$/, ''),
    apiKey: $ai('ai-key').value.trim(),
    model: $ai('ai-model').value.trim()
  };
  if (cfg.enabled && (!cfg.baseUrl || !cfg.apiKey || !cfg.model)) {
    aiStatus('启用 AI 引擎需要填写接口地址、API Key 和模型。', 'error');
    return;
  }
  if (cfg.enabled) {
    // 向该服务商的 origin 申请跨域权限（MV3 后台 fetch 受 CORS 约束）
    let origin;
    try { origin = new URL(cfg.baseUrl).origin; } catch {
      aiStatus('接口地址不是合法的 URL。', 'error');
      return;
    }
    try {
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) { aiStatus(t('ai_permission_denied'), 'error'); return; }
    } catch (e) {
      aiStatus(String(e?.message ?? e), 'error');
      return;
    }
  }
  await chrome.storage.local.set({ aiConfig: cfg });
  aiStatus(t('ai_saved'), 'ok');
}

// 界面语言：切换后存盘并刷新页面，全部文案按新语言重画
$('ui-lang').onchange = event => {
  setUiLang(event.target.value);
  location.reload();
};

// ── 生词本 ──
async function renderWordbook() {
  try {
    const { wordbook = [] } = await chrome.storage.local.get('wordbook');
    document.getElementById('wb-count').textContent = t('wordbook_count', { n: wordbook.length });
    const list = document.getElementById('wordbook-list');
    if (!wordbook.length) {
      list.innerHTML = `<p class="empty">${t('wordbook_empty')}</p>`;
      return;
    }
    list.replaceChildren(...wordbook.slice(0, 200).map(item => {
      const row = document.createElement('div');
      row.className = 'wb-row';
      const w = document.createElement('span'); w.className = 'wb-word'; w.textContent = item.word;
      const tr = document.createElement('span'); tr.className = 'wb-trans'; tr.textContent = item.translation;
      const h = document.createElement('span'); h.className = 'wb-host'; h.textContent = item.host ?? '';
      row.append(w, tr, h);
      return row;
    }));
  } catch { /* 忽略 */ }
}

document.getElementById('wb-export').onclick = async () => {
  const { wordbook = [] } = await chrome.storage.local.get('wordbook');
  if (!wordbook.length) return;
  // Anki 友好 CSV：正面=原文，背面=译文，标签=来源站点
  const esc = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const csv = ['word,translation,tags', ...wordbook.map(w => [esc(w.word), esc(w.translation), esc(w.host)].join(','))].join('\n');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = `wordbook-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};

document.getElementById('wb-clear').onclick = async () => {
  await chrome.storage.local.set({ wordbook: [] });
  renderWordbook();
};

initI18n().then(() => {
  applyI18n(document);
  loadAiConfig();
  renderWordbook();
  $ai('ai-save').onclick = saveAiConfig;
  chrome.storage.local.get('uiLang').then(stored => {
    $('ui-lang').value = stored?.uiLang ?? '';
  }).catch(() => {});
  refresh();
});
