/**
 * 打包：把 extension/ 复制成 dist/chrome-local-translator 并压缩为 zip，
 * 用于 Chrome 开发者模式加载或提交商店。
 */

import { cpSync, rmSync, mkdirSync, existsSync, statSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(projectRoot, 'extension');
const dist = join(projectRoot, 'dist');
const target = join(dist, 'chrome-local-translator');

// 清理旧产物。删除失败（文件被占用、或环境对批量删除有限制）时不中断，
// 后面的复制会覆盖同名文件，最多留下少量无用旧文件。
try {
  rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch (error) {
  console.log(`ℹ️  未能清空旧目录（${error.code ?? error.message}），将直接覆盖。`);
}
mkdirSync(dist, { recursive: true });
cpSync(source, target, { recursive: true });

/**
 * content script 必须打成单文件经典脚本。
 * 原因：Chrome 不保证支持 content_scripts 的 "type": "module"（实测新版 Chrome for Testing
 * 会把它当普通脚本注入，直接抛 Cannot use import statement outside a module），
 * 而扩展页面（popup / offscreen / Service Worker）里的 ES module 是支持的，可以照常拆模块。
 */
await build({
  entryPoints: [join(source, 'content.js')],
  outfile: join(target, 'content.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome109',
  legalComments: 'none',
  logLevel: 'warning'
});
console.log('✅ content.js 已打包为单文件经典脚本');

// dist 的 manifest 去掉 content_scripts 的 type: module（源文件里保留注释说明）
const manifestPath = join(target, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const script of manifest.content_scripts ?? []) delete script.type;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`✅ 已复制扩展文件到 ${target}`);
console.log(`   名称：${manifest.name} v${manifest.version}`);

const wasm = join(target, 'vendor/worker/bergamot-translator-worker.wasm');
if (existsSync(wasm)) {
  console.log(`   WASM 运行时：${(statSync(wasm).size / 1048576).toFixed(1)} MB`);
}

const zipPath = join(dist, 'chrome-local-translator.zip');
try {
  rmSync(zipPath, { force: true });
} catch {
  /* 旧压缩包删不掉就覆盖写入 */
}

// 清理 zip 中断留下的临时文件：zip 会在压缩包同目录先写 ziXXXXXX 再改名，
// 中途失败（磁盘满、被中断）就会剩下这些 1~2MB 的孤儿文件。
for (const name of readdirSync(dist)) {
  if (/^zi[A-Za-z0-9]{6}$/.test(name)) {
    try {
      rmSync(join(dist, name), { force: true });
    } catch {
      /* 删不掉就算了 */
    }
  }
}

// 压缩包里必须直接是扩展根目录（manifest.json 在顶层）。
// 如果套一层 chrome-local-translator/ 目录，商店上传和「加载已解压」都会失败。
// 优先用 zip；macOS 上没有 zip 时退回 ditto
const zipCommands = [
  ['zip', ['-r', '-q', zipPath, '.']],
  ['ditto', ['-c', '-k', '--sequesterRsrc', '.', zipPath]]
];

let zipped = false;
for (const [command, args] of zipCommands) {
  try {
    execFileSync(command, args, { cwd: target });
    console.log(`✅ 已打包 ${zipPath}（${(statSync(zipPath).size / 1048576).toFixed(1)} MB）`);
    zipped = true;
    break;
  } catch {
    /* 换下一个工具 */
  }
}
if (!zipped) {
  console.log('ℹ️  没有可用的压缩工具，已跳过打包。');
}

// 常见踩坑：选到 dist 这一层会报「清单文件缺失或不可读取」，
// 必须选到里面那层（manifest.json 所在的目录）。
console.log('\n安装：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择下面这个目录');
console.log(`  ${target}`);
