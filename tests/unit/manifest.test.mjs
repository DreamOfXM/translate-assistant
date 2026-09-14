import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../extension');
const manifest = JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8'));

test('manifest 是 Manifest V3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('只申请完成功能所需的最小权限', () => {
  const allowed = new Set(['storage', 'contextMenus', 'offscreen']);
  for (const permission of manifest.permissions ?? []) {
    assert.ok(allowed.has(permission), `多余权限：${permission}`);
  }
  assert.ok(manifest.permissions.includes('offscreen'), '缺少 offscreen 权限，WASM 引擎无法运行');
  assert.equal(manifest.host_permissions?.length, 1, '主机权限应当只有模型下载地址');
  assert.match(manifest.host_permissions[0], /^https:\/\/storage\.googleapis\.com\//);
});

test('manifest 里引用的文件都真实存在', () => {
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    ...(manifest.content_scripts ?? []).flatMap(entry => entry.js ?? [])
  ];
  for (const file of referenced) {
    assert.ok(existsSync(join(extensionRoot, file)), `缺少文件：${file}`);
  }
  assert.ok(existsSync(join(extensionRoot, 'offscreen.html')), '缺少离屏文档');
});

test('content script 不是 ESM，且不再注入页面级 CSS', () => {
  const [entry] = manifest.content_scripts;
  // 实测 Chrome 会把带 "type": "module" 的 content script 当普通脚本注入，
  // 直接抛 Cannot use import statement outside a module。所以必须是打包后的经典脚本。
  assert.equal(entry.type, undefined, 'content script 不能用 ESM，必须由 build 打包成 IIFE');
  assert.equal(entry.css, undefined, '面板样式已改为 Shadow DOM 内联，不应再污染页面');
});

test('扩展页 CSP 允许编译 WebAssembly', () => {
  // 少了 wasm-unsafe-eval，bergamot 的 WASM 起不来，界面上只会看到「启动超时」
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(csp, /wasm-unsafe-eval/, '扩展页 CSP 必须放开 wasm-unsafe-eval');
  assert.match(csp, /script-src 'self'/, '其余脚本仍应限制在扩展自身');
});

test('不暴露不必要的 web accessible resources', () => {
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('WASM 运行时与 worker 文件就位', () => {
  for (const file of [
    'vendor/worker/translator-worker.js',
    'vendor/worker/bergamot-translator-worker.js',
    'vendor/worker/bergamot-translator-worker.wasm'
  ]) {
    assert.ok(existsSync(join(extensionRoot, file)), `缺少 ${file}`);
  }
});

test('离屏文档与后台脚本都声明为模块', () => {
  assert.equal(manifest.background.type, 'module');
  const offscreen = readFileSync(join(extensionRoot, 'offscreen.html'), 'utf8');
  assert.match(offscreen, /type="module"/);
  assert.match(offscreen, /offscreen\.js/);
});
