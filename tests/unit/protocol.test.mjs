import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateTranslateRequest, readInstalledDirections, buildCatalog,
  planPacks, missingPacks, isDirectionReady, formatBytes,
  isValidDirection, packKey, cacheName, MESSAGES, HOST
} from '../../extension/lib/protocol.js';

const registry = {
  baseUrl: 'https://example.test',
  models: {
    'en-zh': [{
      sourceLanguage: 'en', targetLanguage: 'zh', architecture: 'base',
      files: {
        model: { path: 'models/en-zh/model.bin.gz', uncompressedSize: 42992955, uncompressedHash: 'abc' },
        lexicalShortlist: { path: 'models/en-zh/lex.bin.gz' },
        srcVocab: { path: 'models/en-zh/srcvocab.spm.gz' },
        trgVocab: { path: 'models/en-zh/trgvocab.spm.gz' }
      }
    }],
    'zh-en': [{
      sourceLanguage: 'zh', targetLanguage: 'en', architecture: 'base',
      files: {
        model: { path: 'models/zh-en/model.bin.gz', uncompressedSize: 59461523 },
        lexicalShortlist: { path: 'models/zh-en/lex.bin.gz' },
        vocab: { path: 'models/zh-en/vocab.spm.gz' }
      }
    }],
    'ja-en': [{
      sourceLanguage: 'ja', targetLanguage: 'en',
      files: {
        model: { path: 'models/ja-en/model.bin.gz', uncompressedSize: 59768832 },
        lexicalShortlist: { path: 'models/ja-en/lex.bin.gz' },
        vocab: { path: 'models/ja-en/vocab.spm.gz' }
      }
    }]
  }
};

test('validateTranslateRequest 接受合法请求', () => {
  const result = validateTranslateRequest({ type: MESSAGES.TRANSLATE, text: 'hello', source: 'en', target: 'zh' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { text: 'hello', source: 'en', target: 'zh' });
});

test('validateTranslateRequest 拒绝空文本、非法语言和同语言', () => {
  assert.match(validateTranslateRequest({ text: '   ', source: 'en', target: 'zh' }).error, /请输入/);
  assert.match(validateTranslateRequest({ text: 'hi', source: 'english', target: 'zh' }).error, /源语言/);
  assert.match(validateTranslateRequest({ text: 'hi', source: 'en', target: 'English' }).error, /目标语言/);
  assert.match(validateTranslateRequest({ text: 'hi', source: 'en', target: 'en' }).error, /相同/);
  assert.equal(validateTranslateRequest(null).ok, false);
});

test('readInstalledDirections 只解析语言包键', () => {
  const storage = {
    'pack:en-zh': { installedAt: 1 },
    'pack:zh-en': { installedAt: 2 },
    'other:thing': true,
    'pack:not-a-direction': true
  };
  assert.deepEqual(readInstalledDirections(storage), ['en-zh', 'zh-en']);
  assert.deepEqual(readInstalledDirections({}), []);
  assert.deepEqual(readInstalledDirections(null), []);
});

test('buildCatalog 按目录生成方向并估算下载体积', () => {
  const catalog = buildCatalog(registry);
  assert.equal(catalog.length, 3);
  const enZh = catalog.find(item => item.key === 'en-zh');
  assert.equal(enZh.label, '英语 → 中文（简体）');
  assert.equal(enZh.modelBytes, 42992955);
  // 实测系数 0.85
  assert.equal(enZh.estimateBytes, Math.round(42992955 * 0.85));
  assert.ok(enZh.files.srcVocab, '应保留源语言词表路径');
});

test('buildCatalog 跳过没有模型文件或未知语言的条目', () => {
  const catalog = buildCatalog({
    models: {
      broken: [{ sourceLanguage: 'en', targetLanguage: 'zh', files: {} }],
      unknown: [{
        sourceLanguage: 'xx', targetLanguage: 'en',
        files: { model: { path: 'x' } }
      }]
    }
  });
  assert.deepEqual(catalog, []);
});

test('planPacks 直接方向只需一个语言包', () => {
  const available = buildCatalog(registry).map(item => item.key);
  assert.deepEqual(planPacks('en', 'zh', available), { direct: true, packs: ['en-zh'] });
  assert.deepEqual(planPacks('zh', 'en', available), { direct: true, packs: ['zh-en'] });
});

test('planPacks 非英语互译经英语中转', () => {
  const available = buildCatalog(registry).map(item => item.key);
  const plan = planPacks('ja', 'zh', available);
  assert.equal(plan.direct, false);
  assert.deepEqual(plan.packs, ['ja-en', 'en-zh']);
});

test('planPacks 对不可达方向返回 null', () => {
  const available = buildCatalog(registry).map(item => item.key);
  assert.equal(planPacks('zh', 'ja', available), null, '缺少 en-ja 时无法中转');
  assert.equal(planPacks('zh', 'zh', available), null);
  assert.equal(planPacks('de', 'fr', available), null);
});

test('missingPacks / isDirectionReady 反映中转组合的就绪状态', () => {
  const packs = ['ja-en', 'en-zh'];
  assert.deepEqual(missingPacks(packs, []), packs);
  assert.deepEqual(missingPacks(packs, ['ja-en']), ['en-zh']);
  assert.deepEqual(missingPacks(packs, packs), []);
  assert.equal(isDirectionReady(packs, []), false);
  assert.equal(isDirectionReady(packs, ['ja-en']), false);
  assert.equal(isDirectionReady(packs, packs), true);
  assert.equal(isDirectionReady([], ['en-zh']), false);
});

test('formatBytes 输出可读体积', () => {
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(-1), '—');
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(Math.round(8.5 * 1024 * 1024)), '8.5 MB');
  assert.equal(formatBytes(36507222), '35 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1024 MB');
});

test('isValidDirection 与派生键保持一致', () => {
  assert.equal(isValidDirection('en-zh'), true);
  assert.equal(isValidDirection('zh_hant-en'), true);
  assert.equal(isValidDirection('en'), false);
  assert.equal(isValidDirection('en-zh-hant'), false);
  assert.equal(packKey('en-zh'), 'pack:en-zh');
  assert.equal(cacheName('en-zh'), 'local-translator-en-zh');
});

test('协议常量不会退化', () => {
  assert.equal(MESSAGES.TRANSLATE, 'TRANSLATE');
  assert.equal(HOST.PORT_NAME, 'translator-host');
  assert.deepEqual(Object.values(HOST.OPS), ['translate', 'preload', 'delete', 'status', 'catalog']);
});
