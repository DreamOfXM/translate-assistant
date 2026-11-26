#!/usr/bin/env node
/**
 * 一键发版：版本号 → 测试 → 构建 → 提交 → 打 tag → 创建双语 GitHub Release。
 *
 * 用法：
 *   RELEASE_NOTES_ZH="…" RELEASE_NOTES_EN="…" npm run release             # 补丁版本（1.1.0 → 1.1.1）
 *   RELEASE_NOTES_ZH="…" RELEASE_NOTES_EN="…" npm run release -- minor    # 次版本（1.1.0 → 1.2.0）
 *   RELEASE_NOTES_ZH="…" RELEASE_NOTES_EN="…" npm run release -- major    # 主版本（1.1.0 → 2.0.0）
 *   RELEASE_NOTES_ZH="…" RELEASE_NOTES_EN="…" npm run release -- 2.0.0    # 直接指定版本号
 *
 * Release 说明是中英双语，必须由 RELEASE_NOTES_ZH / RELEASE_NOTES_EN 给出：
 * 缺任何一个都会拒绝发版（没有占位默认值）。
 * 需要已登录的 gh CLI（gh auth status 通过）。
 * 跳过推送：环境变量 DRY_RUN=1（只构建并打印 Release 正文，不推送不建 Release；演练可以不带说明）。
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
// 逐段数值比较：直接用 <= 会把 '1.2.10' 判成不大于 '1.2.9'（字典序 '1'<'9'）
const versionOrder = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return (pa[0] - pb[0]) || (pa[1] - pb[1]) || ((pa[2] ?? 0) - (pb[2] ?? 0));
};
if (versionOrder(next, current) <= 0) {
  console.error(`✖ 新版本 ${next} 必须大于当前版本 ${current}`);
  process.exit(1);
}

/* ------------------------------ Release 说明必须显式给出 ------------------------------ */

// 这里曾留着一个占位默认值（「更新点 1（中文）」），不传说明也照常发版，
// v1.2.2 / 1.2.3 / 1.2.5 / 1.2.6 四个 Release 就这样带着占位说明发了出去。
// 版本号一旦写盘就收不回来，所以这道闸放在所有检查的最前面；演练不发布任何东西，可以不带说明。
const notesZh = (process.env.RELEASE_NOTES_ZH ?? '').trim();
const notesEn = (process.env.RELEASE_NOTES_EN ?? '').trim();
if (!process.env.DRY_RUN && !(notesZh && notesEn)) {
  console.error('✖ 缺少 Release 说明：正式发版必须同时给出中英文说明，不再回退到占位文案。');
  console.error('  RELEASE_NOTES_ZH="- …" RELEASE_NOTES_EN="- …" npm run release');
  process.exit(1);
}

// 2026-10-27 事故：gh 活动账号切到小号后 git push 仍成功（凭据独立），
// 但 gh release create 对仓库 404——版本号已写盘提交、Release 却发不出去。
// 发版前核对 gh 活动账号就是仓库 owner，不一致直接停。
const remoteUrl = run('git', ['remote', 'get-url', 'origin'], { capture: true }).trim();
const repoOwner = (remoteUrl.match(/[:/]([^/]+)\/[^/]+?(?:\.git)?$/) ?? [])[1];
const ghUser = run('gh', ['api', 'user', '--jq', '.login'], { capture: true }).trim();
if (repoOwner && ghUser && ghUser.toLowerCase() !== repoOwner.toLowerCase()) {
  console.error(`✖ gh 活动账号是 ${ghUser}，仓库属主是 ${repoOwner}——发版会推不出去。`);
  console.error(`  先执行：gh auth switch -u ${repoOwner}`);
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

const zhNotes = notesZh || '- （演练未提供 Release 说明；正式发版会在这里被拒绝）';
const enNotes = notesEn || '- (No release notes supplied for this dry run; a real release is refused here)';

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
  console.log('\n---------- 将要发布的 Release 正文 ----------\n');
  console.log(releaseBody);
  console.log(`\n[DRY_RUN] 已就绪：版本 ${next}、${zipName}。未提交未推送。`);
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
