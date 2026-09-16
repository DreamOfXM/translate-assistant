/**
 * Chrome 内建翻译引擎封装的单元测试。
 * jsdom 没有 Translator，测试里用 mock 替换 self.Translator，
 * 验证可用性查询、候选标签回退与实例缓存的纯逻辑。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.test/' });
globalThis.window = dom.window;
globalThis.self = dom.window;

const { chromeTranslatorAvailable, chromeTranslatorStatus, chromeTranslate } =
  await import('../../extension/lib/chrome-translator.js');

test('没有 Translator API 时如实报告 no-api', async () => {
  delete globalThis.self.Translator;
  assert.equal(chromeTranslatorAvailable(), false);
  assert.deepEqual(await chromeTranslatorStatus('en', 'zh'), { status: 'no-api' });
});

test('availability 查询透传，并返回解析后的 BCP-47 标签', async () => {
  const calls = [];
  globalThis.self.Translator = {
    availability: async ({ sourceLanguage, targetLanguage }) => {
      calls.push([sourceLanguage, targetLanguage]);
      return sourceLanguage === 'en' && targetLanguage === 'zh' ? 'available' : 'unavailable';
    }
  };
  assert.equal(chromeTranslatorAvailable(), true);
  const st = await chromeTranslatorStatus('en', 'zh');
  assert.deepEqual(st, { status: 'available', source: 'en', target: 'zh' });
  assert.deepEqual(calls, [['en', 'zh']]);
});

test('繁体中文按候选顺序回退：zh-Hant 不可用则试 zh-TW', async () => {
  const probed = [];
  globalThis.self.Translator = {
    availability: async ({ sourceLanguage, targetLanguage }) => {
      probed.push(targetLanguage);
      return targetLanguage === 'zh-TW' ? 'available' : 'unavailable';
    }
  };
  const st = await chromeTranslatorStatus('en', 'zh_hant');
  assert.equal(st.status, 'available');
  assert.equal(st.target, 'zh-TW');
  assert.deepEqual(probed, ['zh-Hant', 'zh-TW']);
});

test('语言对完全不支持时报告 unavailable', async () => {
  globalThis.self.Translator = {
    availability: async () => 'unavailable'
  };
  assert.equal((await chromeTranslatorStatus('en', 'xx')).status, 'unavailable');
});

test('chromeTranslate 复用同语言对的 Translator 实例', async () => {
  let created = 0;
  const instances = [];
  globalThis.self.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage }) => {
      created += 1;
      const inst = {
        from: sourceLanguage,
        translate: async text => `${text}<${sourceLanguage}-${targetLanguage}>`
      };
      instances.push(inst);
      return inst;
    }
  };
  const one = await chromeTranslate('a', 'en', 'zh');
  const two = await chromeTranslate('b', 'en', 'zh');
  assert.equal(created, 1, '同语言对只创建一次（第二次命中缓存）');
  assert.equal(instances.length, 1, '实例应只有一个');
  assert.equal(one, 'a<en-zh>');
  assert.equal(two, 'b<en-zh>');
});
