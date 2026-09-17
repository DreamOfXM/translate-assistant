import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const macosRoot = join(root, 'macos');
const sourcesRoot = join(macosRoot, 'Sources/TranslateAssistant');
const extensionLib = join(root, 'extension', 'lib');
const buildScript = readFileSync(join(root, 'scripts/build-macos.mjs'), 'utf8');

function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

function relativeImports(file) {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'(\.[^']+)'/g)].map(match => match[1]);
}

/** 从构建脚本里解出「要拷进 App 包的引擎模块」清单 */
function copiedModules() {
  const match = buildScript.match(/const needed = \[([^\]]+)\]/);
  assert.ok(match, '构建脚本里找不到 needed 清单');
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}

test('macOS 端不 fork 引擎，源码只有一份', () => {
  const forked = [
    'macos/lib',
    'macos/vendor',
    'macos/web/lib',
    'macos/web/vendor',
    'macos/Sources/TranslateAssistant/engine.js',
    'macos/Sources/TranslateAssistant/engine.swift'
  ];
  for (const path of forked) {
    assert.ok(!existsSync(join(root, path)), `${path} 不该存在：引擎由构建脚本从 extension/ 拷入，避免两份实现漂移`);
  }
  assert.ok(existsSync(join(extensionLib, 'engine.js')), '引擎本体应当在 extension/lib 下');
});

test('构建脚本拷贝的模块覆盖引擎的依赖闭包', () => {
  const copied = new Set(copiedModules());
  const required = new Set();

  for (const entry of ['engine.js', 'protocol.js']) {
    for (const spec of relativeImports(join(extensionLib, entry))) {
      const resolved = resolve(extensionLib, spec);
      // vendor 整个目录都会拷，不用逐个登记
      if (resolved.split(sep).includes('vendor')) continue;
      required.add(basename(resolved));
    }
  }

  for (const name of required) {
    assert.ok(copied.has(name), `构建脚本没有拷贝 ${name}，macOS 端会 import 失败`);
  }
  for (const name of copied) {
    assert.ok(existsSync(join(extensionLib, name)), `extension/lib/${name} 不存在`);
  }
});

test('垫片用 defineProperty 覆盖全局对象', () => {
  const shims = read('macos/web/shims.js');

  // `caches` 在 Window 上是个只有 getter 的访问器属性：直接赋值在严格模式下抛
  // TypeError，垫片静默失效，浏览器自带的 Cache Storage 顶上，缓存不会落到本机目录。
  assert.doesNotMatch(shims, /globalThis\.caches\s*=/, '禁止直接给 caches 赋值');
  assert.doesNotMatch(shims, /globalThis\.chrome\s*=/, '禁止直接给 chrome 赋值');
  assert.doesNotMatch(shims, /globalThis\.fetch\s*=/, '禁止直接给 fetch 赋值');
  assert.match(shims, /Object\.defineProperty\(globalThis, name/);

  for (const name of ['chrome', 'fetch', 'caches']) {
    assert.match(shims, new RegExp(`override\\('${name}'`), `垫片缺少 ${name}覆写`);
  }

  // 垫片失败要能被宿主看见，否则问题只会表现为「缓存莫名其妙不生效」
  assert.match(shims, /__ltShimFailures/);
});

test('宿主页面在 module 脚本之前加载垫片', () => {
  const html = read('macos/web/engine.html');
  const shimAt = html.indexOf('src="/shims.js"');
  const moduleAt = html.indexOf('type="module"');
  assert.ok(shimAt > 0, 'engine.html 应当引入 shims.js');
  assert.ok(moduleAt > 0, 'engine.html 应当有 module 脚本');
  assert.ok(shimAt < moduleAt, '垫片必须先于 module 执行，否则引擎已经 import 完，垫片来不及生效');
});

test('引擎服务以 application/wasm 提供 WASM', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  // MIME 写错的话 WebAssembly.instantiateStreaming 会直接拒绝加载
  assert.match(server, /case "wasm": return "application\/wasm"/);
});

test('语言包代理显式要求 identity 编码', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  // URLSession 默认会自动解压，而 Content-Length 仍是压缩前的值，
  // 页面上的下载进度（「下载模型… 21.9 / 29.1 MB」）会算错
  assert.match(server, /setValue\("identity", forHTTPHeaderField: "Accept-Encoding"\)/);
});

test('回环服务只监听本机，且响应后关闭连接', () => {
  const server = readFileSync(join(sourcesRoot, 'EngineServer.swift'), 'utf8');
  const transport = readFileSync(join(sourcesRoot, 'HTTPServer.swift'), 'utf8');
  assert.match(server, /requiredInterfaceType = \.loopback/, '引擎服务不应对外暴露');
  assert.match(transport, /merged\["Connection"\] = "close"/);
});

test('Info.plist 是菜单栏应用，且 bundle id 与签名一致', () => {
  const plist = read('macos/Resources/Info.plist');
  assert.match(plist, /<key>LSUIElement<\/key>\s*<true\/>/, '需要 LSUIElement：不占 Dock、不抢焦点');

  const identifier = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  assert.ok(identifier, 'Info.plist 缺少 CFBundleIdentifier');
  // TCC（辅助功能授权）按 bundle id + 签名认应用，两边不一致会导致「授权了却用不了」
  assert.ok(buildScript.includes(`'${identifier}'`), `签名 identifier 必须与 Info.plist 的 ${identifier} 一致`);
});

test('构建脚本在受限环境里关掉 SwiftPM 沙箱', () => {
  // 本机只有 Command Line Tools 时，SwiftPM 自己的 sandbox-exec 会
  // sandbox_apply: Operation not permitted，必须显式 --disable-sandbox
  assert.match(buildScript, /'build', '--disable-sandbox'/);
});

test('macOS 文档说明了重新构建后要重新授权', () => {
  const readme = read('macos/README.md');
  assert.match(readme, /ad-hoc/);
  assert.match(readme, /辅助功能/);
  assert.match(readme, /重新授权|重新授权|重新勾选|重新添加/, '必须写清 ad-hoc 签名导致权限失效这个坑');
});

test('package.json 暴露 macOS 构建命令', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.scripts['build:macos'], '缺少 build:macos 脚本');
  assert.match(pkg.scripts['build:macos'], /build-macos\.mjs/);
});
