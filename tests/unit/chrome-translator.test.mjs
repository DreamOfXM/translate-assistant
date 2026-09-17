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

/* ------------------------- 用户手势与内建引擎优先 -------------------------
 * 注意：markUserGesture() 会开一个 5 秒的手势窗口，且模块级状态没法重置，
 * 所以「没有手势」的用例必须排在「有手势」的用例前面。
 * ---------------------------------------------------------------------- */

const { chromeTranslateFirst, chromeTranslatorPrimed, chromeTranslatorLastError, markUserGesture } =
  await import('../../extension/lib/chrome-translator.js');

test('没有用户手势时不碰 create：绝不静默下载模型', async () => {
  let created = 0;
  globalThis.self.Translator = {
    availability: async () => 'downloadable',
    create: async () => {
      created += 1;
      return { translate: async text => text };
    }
  };
  const out = await chromeTranslateFirst('hello', 'de', 'fr');
  assert.equal(out, null, '未就绪 + 没有手势 → 交回给调用方回落');
  assert.equal(created, 0, '不该发起 create（那会触发下载）');
  assert.equal(chromeTranslatorPrimed('de', 'fr'), false);
});

test('模型已就绪（available）时无需手势即可翻译', async () => {
  globalThis.self.Translator = {
    availability: async () => 'available',
    create: async ({ sourceLanguage, targetLanguage }) => ({
      translate: async text => `${text}<${sourceLanguage}-${targetLanguage}>`
    })
  };
  assert.equal(await chromeTranslateFirst('hi', 'en', 'zh'), 'hi<en-zh>');
});

test('用户手势窗口内只踹下载，不把握手卡在下载上', async () => {
  let created = 0;
  let ready = false;
  globalThis.self.Translator = {
    availability: async () => (ready ? 'available' : 'downloadable'),
    create: async () => {
      created += 1;
      return { translate: async text => `[${text}]` };
    }
  };
  const phases = [];
  markUserGesture();
  assert.equal(
    await chromeTranslateFirst('one', 'ja', 'zh', { onModel: s => phases.push(s.phase) }),
    null,
    '模型没就绪时这一轮交给本地语言包，不在这里干等'
  );
  assert.equal(created, 1, '手势内应发起 create（下载）');
  assert.equal(chromeTranslatorPrimed('ja', 'zh'), true, '下载中/就绪后应记住这一对');
  assert.deepEqual(phases, ['downloading', 'ready'], '界面能收到「下载中 → 就绪」');

  // 下载完成后 availability 变 available：后面的段落自动用上内建引擎
  ready = true;
  assert.equal(await chromeTranslateFirst('two', 'ja', 'zh'), '[two]');
  assert.equal(created, 1, '不应重复 create');
});

test('create 失败时不留缓存：下一轮还能重试', async () => {
  let created = 0;
  const phases = [];
  globalThis.self.Translator = {
    availability: async () => 'downloadable',
    create: async () => {
      created += 1;
      throw Object.assign(new Error('Requires a user gesture'), { name: 'NotAllowedError' });
    }
  };
  markUserGesture();
  assert.equal(
    await chromeTranslateFirst('x', 'ko', 'zh', { onModel: s => phases.push(s.phase) }),
    null,
    '失败要交回给调用方，而不是抛出去'
  );
  await new Promise(resolve => setTimeout(resolve, 0)); // 等缓存清理与失败回调那一拍
  assert.equal(chromeTranslatorPrimed('ko', 'zh'), false, '失败的 promise 不能留在缓存里');
  assert.deepEqual(phases, ['downloading', 'failed']);
  await chromeTranslateFirst('y', 'ko', 'zh');
  assert.equal(created, 2, '第二轮应重新尝试创建');
  assert.match(String(chromeTranslatorLastError()?.message), /user gesture/, '最后失败原因要留档，方便排查');
});
