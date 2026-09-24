#!/usr/bin/env node
/**
 * 组装 macOS 菜单栏 App。
 *
 * 关键约定：翻译引擎（lib/ 与 vendor/）**不在 macos/ 里 fork 一份**。
 * 构建时从 extension/ 原样拷进来，一份源码两个宿主 ——
 * 改引擎只需要改 extension/，网页端和桌面端同时生效。
 *
 * 用法：
 *   node scripts/build-macos.mjs             # debug 构建
 *   node scripts/build-macos.mjs --release   # release 构建
 *   node scripts/build-macos.mjs --web-only  # 只刷新 dist/web（不起 swift build）
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const macos = path.join(root, 'macos');
// 刻意不用 .build：那是 SwiftPM 自己的目录，swift package clean 会连产物一起删
const buildDir = path.join(macos, 'dist');
const webDir = path.join(buildDir, 'web');
const appDir = path.join(buildDir, 'TranslateAssistant.app');
const bundleId = 'com.dreamofxm.translate-assistant';

const release = process.argv.includes('--release');
const webOnly = process.argv.includes('--web-only');

/** 引擎资源的唯一来源：extension/。改这里，不要改 macos/ 下的副本 */
async function assembleWeb() {
  await rm(webDir, { recursive: true, force: true });
  // 目标目录必须先不存在，否则 Node 的 cp 会像 cp -R 一样往里再套一层
  await cp(path.join(macos, 'web'), webDir, { recursive: true });

  // 只拷 engine.js 及其依赖闭包（protocol.js → languages.js），
  // 其余模块是扩展专属的，放进来只会让人以为桌面端也用得上
  const needed = ['engine.js', 'protocol.js', 'languages.js'];
  await mkdir(path.join(webDir, 'lib'), { recursive: true });
  for (const name of needed) {
    await cp(path.join(root, 'extension', 'lib', name), path.join(webDir, 'lib', name));
  }

  await cp(path.join(root, 'extension', 'vendor'), path.join(webDir, 'vendor'), { recursive: true });

  const wasm = path.join(webDir, 'vendor', 'worker', 'bergamot-translator-worker.wasm');
  if (!existsSync(wasm)) throw new Error(`引擎 WASM 缺失：${wasm}`);

  /**
   * 整页双语的注入脚本。和扩展的 content.js 同理：WKWebView 里注入的是经典脚本，
   * 必须打包成单文件。它 import 的是 extension/lib/reader.js —— 正文识别与
   * 双语节点只有一份实现，桌面端不 fork。
   */
  await build({
    entryPoints: [path.join(macos, 'web', 'page-translate.js')],
    outfile: path.join(webDir, 'page-bundle.js'),
    bundle: true,
    format: 'iife',
    target: 'safari15',
    legalComments: 'none',
    logLevel: 'warning'
  });
  // 打包产物才是被注入的那份，未打包的源码留在 web 根目录只会让人以为两处都在跑
  await rm(path.join(webDir, 'page-translate.js'), { force: true });

  return needed;
}

async function swiftBuild() {
  const configuration = release ? 'release' : 'debug';
  // 本机只有 Command Line Tools，SwiftPM 自己的沙箱在受限环境里会
  // sandbox_apply 失败，必须显式关掉
  execFileSync('swift', ['build', '--disable-sandbox', '-c', configuration], { cwd: macos, stdio: 'inherit' });
  const binPath = execFileSync('swift', ['build', '--disable-sandbox', '-c', configuration, '--show-bin-path'], {
    cwd: macos,
    encoding: 'utf8'
  }).trim();
  return path.join(binPath, 'TranslateAssistant');
}

async function assembleApp(binary) {
  await rm(appDir, { recursive: true, force: true });
  const contents = path.join(appDir, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'), { recursive: true });

  await cp(binary, path.join(contents, 'MacOS', 'TranslateAssistant'));
  await cp(path.join(macos, 'Resources', 'Info.plist'), path.join(contents, 'Info.plist'));
  await cp(webDir, path.join(contents, 'Resources', 'web'), { recursive: true });

  const license = path.join(root, 'LICENSE');
  if (existsSync(license)) await cp(license, path.join(contents, 'Resources', 'LICENSE'));

  // ad-hoc 签名：本机自用足够。注意签名里没有证书，TCC 是按签名哈希认应用的，
  // 所以每次重新构建都要重新勾一次「辅助功能」。
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', bundleId, appDir], { stdio: 'inherit' });
}

async function main() {
  // 这个目标只能在 macOS 上构建。其他平台上的 npm install / npm test / npm run build
  // 都不受影响，只有显式执行 build:macos 才会走到这里 —— 给一句人话，别扔 ENOENT。
  if (process.platform !== 'darwin') {
    console.error(`macOS 菜单栏版只能在 macOS 上构建（当前平台：${process.platform}）。`);
    console.error('浏览器扩展请改用 npm run build。');
    process.exit(1);
  }

  const modules = await assembleWeb();
  console.log(`引擎资源已就绪：${path.relative(root, webDir)}（lib: ${modules.join(', ')}）`);

  if (webOnly) return;

  if (!existsSync(path.join(macos, 'Sources', 'TranslateAssistant'))) {
    throw new Error('找不到 macos/Sources/TranslateAssistant');
  }

  const binary = await swiftBuild();
  await assembleApp(binary);

  console.log('');
  console.log(`已生成：${path.relative(root, appDir)}`);
  console.log(`启动：  open "${appDir}"`);
}

main().catch(error => {
  console.error(`构建失败：${error.message}`);
  process.exit(1);
});
