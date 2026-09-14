/**
 * 端到端验证：在 Node 里跑通 bergamot WASM 运行时 + Mozilla 线上模型。
 *
 * vendor 代码自带 Node 兼容层（node:worker_threads），所以不需要浏览器就能验证
 * “运行时与线上模型格式是否兼容”这个最大的技术风险。
 *
 * 用法：node scripts/verify-engine.mjs [方向]   例如 node scripts/verify-engine.mjs en-zh
 */

import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data';
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workerDir = join(projectRoot, 'extension', 'vendor', 'worker');

const direction = process.argv[2] ?? 'en-zh';
const cacheDir = mkdtempSync(join(tmpdir(), 'lt-verify-'));

/** vendor 的 worker 是 CommonJS，需要放进一个 type=commonjs 的临时目录才能被 Node 直接跑 */
function prepareWorkerSandbox() {
  const sandbox = join(cacheDir, 'worker');
  mkdirSync(sandbox, { recursive: true });
  writeFileSync(join(sandbox, 'package.json'), '{"type":"commonjs"}');
  for (const file of ['translator-worker.js', 'bergamot-translator-worker.js', 'bergamot-translator-worker.wasm']) {
    copyFileSync(join(workerDir, file), join(sandbox, file));
  }
  return sandbox;
}

const sandbox = prepareWorkerSandbox();
const worker = new Worker(join(sandbox, 'translator-worker.js'));

let serial = 0;
const pending = new Map();

worker.on('message', ({ id, result, error }) => {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  if (error) entry.reject(Object.assign(new Error(), error));
  else entry.accept(result);
});
worker.on('error', error => {
  console.error('\n❌ Worker 崩溃:', error.message);
  process.exit(1);
});

const call = (name, ...args) => new Promise((accept, reject) => {
  const id = ++serial;
  pending.set(id, { accept, reject });
  worker.postMessage({ id, name, args });
});

async function download(url) {
  const file = join(cacheDir, createHash('sha1').update(url).digest('hex'));
  if (existsSync(file)) return new Uint8Array(readFileSync(file));

  const started = Date.now();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  const compressed = Buffer.from(await response.arrayBuffer());
  // 目录里的文件是裸 gzip，服务端不带 Content-Encoding，需要手动解压
  const raw = compressed[0] === 0x1f && compressed[1] === 0x8b ? gunzipSync(compressed) : compressed;
  writeFileSync(file, raw);
  console.log(`   ↓ ${(compressed.length / 1048576).toFixed(1)} MB（压缩）→ ${(raw.length / 1048576).toFixed(1)} MB，${((Date.now() - started) / 1000).toFixed(1)}s`);
  return new Uint8Array(raw);
}

const toArrayBuffer = view => view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);

(async () => {
  console.log(`\n=== 验证 ${direction} ===`);

  console.log('1. 拉取模型目录…');
  const registry = await (await fetch(`${BASE}/db/models.json`)).json();
  const entry = (registry.models[direction] ?? [])[0];
  if (!entry) throw new Error(`目录中没有 ${direction}，可用方向：${Object.keys(registry.models).join(' ')}`);
  console.log(`   ${entry.sourceLanguage} → ${entry.targetLanguage}（架构 ${entry.architecture}）`);

  console.log('2. 初始化 WASM 运行时…');
  await call('initialize', {});
  console.log('   ✅ 运行时就绪');

  console.log('3. 下载并解压模型…');
  const model = await download(`${BASE}/${entry.files.model.path}`);
  const shortlist = await download(`${BASE}/${entry.files.lexicalShortlist.path}`);
  const vocabs = [];
  for (const key of ['vocab', 'srcVocab', 'trgVocab']) {
    if (entry.files[key]) vocabs.push(await download(`${BASE}/${entry.files[key].path}`));
  }
  console.log(`   ✅ 模型 ${(model.length / 1048576).toFixed(1)} MB，词表 ${vocabs.length} 个`);

  console.log('4. 载入模型…');
  const started = Date.now();
  await call('loadTranslationModel', { from: entry.sourceLanguage, to: entry.targetLanguage }, {
    model: toArrayBuffer(model),
    shortlist: toArrayBuffer(shortlist),
    vocabs: vocabs.map(toArrayBuffer),
    config: { 'gemm-precision': 'int8shiftAlphaAll' }
  });
  console.log(`   ✅ 模型就绪（${((Date.now() - started) / 1000).toFixed(1)}s）`);

  console.log('5. 翻译…');
  const samples = direction.startsWith('zh')
    ? ['你好，这是一段本地翻译测试。', '这个插件不会把你的文字上传到任何服务器。']
    : ['Hello, this translation runs entirely in your browser.', 'The extension never uploads your text to a server.'];

  const responses = await call('translate', {
    models: [{ from: entry.sourceLanguage, to: entry.targetLanguage }],
    texts: samples.map(text => ({ text, html: false, qualityScores: false }))
  });

  for (let index = 0; index < samples.length; index++) {
    console.log(`   原文：${samples[index]}`);
    console.log(`   译文：${responses[index].target.text}`);
  }

  const ok = responses.every(response => {
    const text = response.target.text?.trim();
    return Boolean(text) && text !== samples[0];
  });
  console.log(ok ? `\n✅ ${direction} 端到端验证通过` : '\n❌ 译文异常');
  process.exit(ok ? 0 : 1);
})()
  .catch(error => {
    console.error('\n❌ 验证失败：', error.message);
    process.exit(1);
  })
  .finally(() => {
    worker.terminate();
    rmSync(cacheDir, { recursive: true, force: true });
  });
