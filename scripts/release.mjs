#!/usr/bin/env node
/**
 * 一键发版：版本号 → 测试 → 构建 → 提交 → 打 tag → 创建双语 GitHub Release。
 *
 * 用法：
 *   npm run release             # 补丁版本（1.1.0 → 1.1.1）
 *   npm run release -- minor    # 次版本（1.1.0 → 1.2.0）
 *   npm run release -- major    # 主版本（1.1.0 → 2.0.0）
 *   npm run release -- 2.0.0    # 直接指定版本号
 *
 * Release 说明 = CHANGELOG 入口（按「保持一个空行」分隔追加），中英双语。
 * 需要已登录的 gh CLI（gh auth status 通过）。
 * 跳过推送：环境变量 DRY_RUN=1（只构建与打草稿，不推送不建 Release）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, {
  cwd: projectRoot, encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', ...opts
});

const bump = process.argv[2] ?? 'patch';

/* ------------------------------ 版本号 ------------------------------ */

const manifestPath = join(projectRoot, 'extension/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pkgPath = join(projectRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const current = manifest.version;
if (pkg.version !== current) {
  console.error(`✖ manifest.json (${current}) 与 package.json (${pkg.version}) 版本不一致，先手工同步。`);
  process.exit(1);
}

let next;
if (/^\d+\.\d+\.\d+$/.test(bump)) {
  next = bump;
} else if (['patch', 'minor', 'major'].includes(bump)) {
  const [major, minor, patch] = current.split('.').map(Number);
  next = bump === 'major' ? `${major + 1}.0.0`
    : bump === 'minor' ? `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`;
} else {
  console.error('✖ 版本参数只能是 patch / minor / major 或 X.Y.Z');
  process.exit(1);
}
if (next <= current) {
  console.error(`✖ 新版本 ${next} 必须大于当前版本 ${current}`);
  process.exit(1);
}

console.log(`📦 发版：v${current} → v${next}（${bump}）`);

/* ------------------------------ 版本号写盘 ------------------------------ */

manifest.version = next;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

/* ------------------------------ 测试与构建 ------------------------------ */

console.log('\n🧪 单元测试…');
run('npm', ['test']);

console.log('\n🔨 构建…');
const buildOut = run('npm', ['run', 'build'], { capture: true });
console.log(buildOut.split('\n').filter(l => /✅|WASM/.test(l)).join('\n'));

const zipName = `translate-assistant-v${next}.zip`;
const zipPath = join(projectRoot, 'dist', zipName);
if (!existsSync(zipPath)) {
  console.error(`✖ 构建产物 ${zipName} 不存在`);
  process.exit(1);
}

/* ------------------------------ Release 说明（双语模板） ------------------------------ */

const zhNotes = process.env.RELEASE_NOTES_ZH
  ?? `- 更新点 1（中文）
- 更新点 2（中文）`;
const enNotes = process.env.RELEASE_NOTES_EN
  ?? `- Change 1 (English)
- Change 2 (English)`;

const releaseBody = `## 📦 安装 / Install

1. 下载下方 \`${zipName}\` 并解压 / Download \`${zipName}\` below and unzip it
2. 打开 \`chrome://extensions\` → 开启「开发者模式」 / open \`chrome://extensions\` → enable \"Developer mode\"
3. 「加载已解压的扩展程序」→ 选择解压出的文件夹 / \"Load unpacked\" → select the unzipped folder
4. 刷新网页即可使用 / refresh the page and you're done

## ✨ 更新内容（中文）

${zhNotes}

## ✨ What's New (English)

${enNotes}

**Full Changelog**: https://github.com/DreamOfXM/translate-assistant/compare/v${current}...v${next}`;

/* ------------------------------ 提交与推送 ------------------------------ */

if (process.env.DRY_RUN) {
  console.log(`\n[DRY_RUN] 已就绪：版本 ${next}、${zipName}、Release 说明已生成（见上）。未提交未推送。`);
  process.exit(0);
}

console.log('\n📝 提交版本号变更…');
run('git', ['add', 'extension/manifest.json', 'package.json']);
run('git', ['commit', '-m', `chore(release): v${next}`]);

console.log('\n🚀 推送…');
run('git', ['push', 'origin', 'main']);

/* ------------------------------ GitHub Release ------------------------------ */

console.log('\n🏷️  创建 Release…');
const notesFile = join(projectRoot, 'dist', 'release-notes.md');
writeFileSync(notesFile, releaseBody);
try {
  run('gh', ['release', 'create', `v${next}`, zipPath,
    '--title', `v${next}`,
    '--notes-file', notesFile]);
} finally {
  // 说明文件留在 dist/ 里（已被 .gitignore 忽略），不打扰工作区
}

console.log(`\n✅ v${next} 发布完成`);
console.log(`   https://github.com/DreamOfXM/translate-assistant/releases/tag/v${next}`);
