/**
 * 词典完整性守卫。
 *
 * 这类问题的根因几乎都一样：新增文案只往一种语言里加，或者把中文直接留在
 * 代码里没进词典。前者的症状是英文界面突然蹦出一句中文，后者连 key 都没有。
 * 两个用例分别盯住这两种。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

globalThis.chrome = {
  storage: { local: { get: async () => ({}), set: () => {}, remove: () => {} } }
};

const { t, initI18n, setUiLang, applyI18n } = await import('../../extension/lib/i18n.js');
await initI18n();

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../extension/ui');

/** 从 t() 反推两套词典的 key：缺失时 t 会原样返回 key */
const KEYS = [
  'app_name', 'badge', 'placeholder', 'translate', 'copy', 'copied',
  'action_title', 'brand_mark',
  'output_label', 'output_placeholder', 'onboard_title', 'onboard_sub', 'onboard_go',
  'onboard_done', 'onboard_failed',
  'toggle_auto', 'toggle_page', 'toggle_hover', 'toggle_hover_sub',
  'packs_none', 'packs_manage', 'packs_count', 'packs_error',
  'status_empty', 'status_translating', 'status_downloading',
  'options_title', 'options_lead', 'ui_language', 'target_language',
  'welcome_lead', 'step1_t', 'step2_t', 'step3_t', 'privacy', 'cta_install',
  'sel_title', 'field_source', 'retranslate', 'float_reply', 'float_select',
  'reply_title', 'draft', 'generate', 'fill',
  'translating_pack', 'inline_retry', 'inline_more',
  'bubble_idle', 'bubble_title', 'bubble_progress', 'bubble_done',
  'bubble_nothing', 'bubble_tool', 'bubble_zh', 'bubble_pack',
  'bubble_google', 'bubble_model_downloading', 'bubble_site',
  'para_translating', 'para_copy', 'para_copied', 'para_hide', 'para_failed', 'close',
  'hover_pill', 'hover_pill_title', 'menu_translate_selection',
  'error_no_response', 'engine_chrome_label', 'engine_local_label',
  'error_updated', 'error_connect', 'error_no_response_reload'
];

test('每个 key 在中英两套文案里都有值', () => {
  const missing = [];
  for (const lang of ['zh', 'en']) {
    setUiLang(lang);
    for (const key of KEYS) {
      if (t(key) === key) missing.push(`${lang}:${key}`);
    }
  }
  assert.deepEqual(missing, [], `这些 key 没有文案：${missing.join(', ')}`);
});

test('英文文案里不残留汉字', () => {
  setUiLang('en');
  const leaked = KEYS.filter(key => /[\u4e00-\u9fff]/.test(t(key, { msg: 'x', n: 1, p: '', name: 'x', packs: '', size: '', done: 1, total: 1, label: 'x' })));
  assert.deepEqual(leaked, [], `英文文案里混进了中文：${leaked.join(', ')}`);
});

test('界面语言切换后取到的文案确实变了（词典没有共用同一份对象）', () => {
  setUiLang('zh');
  const zh = t('hover_pill');
  setUiLang('en');
  assert.notEqual(t('hover_pill'), zh);
});

test('扩展页面头部的品牌标记跟着界面语言走', () => {
  // 头部那枚「译」是内联 SVG 里写死的 <text>，英文界面会显示成「译 Translate Assistant」
  for (const page of ['popup.html', 'options.html', 'welcome.html']) {
    const dom = new JSDOM(readFileSync(join(uiRoot, page), 'utf8'));

    setUiLang('zh');
    applyI18n(dom.window.document);
    const mark = dom.window.document.querySelector('[data-i18n="brand_mark"]');
    assert.ok(mark, `${page} 的品牌标记没有挂 data-i18n="brand_mark"`);
    assert.equal(mark.textContent, '译');

    setUiLang('en');
    applyI18n(dom.window.document);
    assert.equal(mark.textContent, 'T');
  }
});

test('页面的 <html lang> 跟着界面语言走', () => {
  // 三个页面都写死 lang="zh-CN"，英文界面下不影响观感，但屏幕阅读器会按中文读
  for (const page of ['popup.html', 'options.html', 'welcome.html']) {
    const dom = new JSDOM(readFileSync(join(uiRoot, page), 'utf8'));

    setUiLang('en');
    applyI18n(dom.window.document);
    assert.equal(dom.window.document.documentElement.lang, 'en', `${page} 英文界面下 lang 没跟着切`);

    setUiLang('zh');
    applyI18n(dom.window.document);
    assert.equal(dom.window.document.documentElement.lang, 'zh-CN', `${page} 中文界面下 lang 不对`);
  }
});
