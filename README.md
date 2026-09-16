<div align="center">

# 翻译助手

**在浏览器里本地翻译网页的外语内容 —— 不用 API Key、不上传文本、装好语言包离线也能用**

**简体中文** | [English](README.en.md)

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](LICENSE)
[![Chrome](https://img.shields.io/badge/Chrome-109%2B-blue.svg)](https://www.google.com/chrome/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/DreamOfXM/translate-assistant/pulls)

<img src="docs/images/bilingual.gif" alt="整页双语对照演示" width="720">

*打开外文网页，译文自动逐段出现在原文下方 —— 全程本地完成，无需任何配置*

</div>

---

## ✨ 它能做什么

| | 能力 | 说明 |
| --- | --- | --- |
| 📖 | **整页双语对照** | 打开外文网页，译文自动逐段插在原文下方；只翻正文，导航/广告/评论区一律不碰 |
| 🔍 | **选中即译** | 随便选一段外文，点「翻译选中」，结果卡片就地弹出 |
| ✍️ | **回复助手** | 在评论框用中文写草稿，一键生成译文，**确认后**才填入，绝不替你发送 |
| 📴 | **离线可用** | 语言包下载一次后，断网照常翻译 |
| 🔒 | **隐私优先** | 文本、草稿、译文全部留在你的设备上；唯一的网络请求是下载语言包本身 |

<p align="center">
  <img src="docs/images/popup-translate.gif" alt="一键翻译" width="300">
  &nbsp;&nbsp;
  <img src="docs/images/selection.gif" alt="选中即译" width="300">
</p>

## 🌐 语言包：下载一次，离线终生

翻译引擎是内嵌在浏览器里的 [bergamot-translator](https://github.com/browsermt/bergamot-translator)（Firefox 翻译同款，MPL-2.0），模型来自 [Mozilla Firefox Translations](https://github.com/mozilla/firefox-translations-models) 的公开模型库（116 个方向，MPL-2.0）。

<p align="center">
  <img src="docs/images/packs.gif" alt="语言包管理" width="720">
</p>

- **按需下载**：第一次使用某个语言方向时才下载对应语言包（单个约 25–50 MB），下载前会明确告诉你体积
- **离线运行**：装好之后翻译完全本地完成，断网、内网、飞行模式都能用
- **完整性校验**：模型文件带 SHA-256 校验，损坏自动丢弃重下
- **非英语对经英语中转**：Mozilla 只发布「各语言 ↔ 英语」模型，中文 ↔ 日语这类方向会自动经英语中转（界面会注明需要两个语言包）

## 📦 安装

### 方式一：直接下载（推荐）

1. 到 [Releases](https://github.com/DreamOfXM/translate-assistant/releases) 下载最新的 `translate-assistant-vX.Y.Z.zip`
2. 解压到任意目录
3. 打开 `chrome://extensions` → 开启右上角「开发者模式」→ 点「加载已解压的扩展程序」→ 选择解压出的 `translate-assistant` 文件夹
4. 刷新已经打开的网页（content script 只注入新加载的页面）

> 未打包上架商店的扩展需要开发者模式加载；扩展不含任何遥测，介意的话可以审查源码。

### 方式二：从源码构建（开发者）

要求 Chrome 109+（用到离屏文档 API）、Node.js 18+。

```bash
npm install
npm run build
```

构建产物在 `dist/translate-assistant`（同上方式加载），同时生成可分发的 `dist/translate-assistant-v版本.zip`。

> ⚠️ 必须加载 `dist/` 而不是 `extension/`：`content.js` 需经 esbuild 打包成单文件经典脚本。

## 🚀 快速开始

1. **装语言包**：点扩展图标 → 「语言包管理」→ 下载你需要的方向（如 英语→中文）
2. **读外文网页**：直接打开，译文自动出现；点右下角按钮可整页收起/展开
3. **写外文回复**：在评论框点「翻译回复」，用中文写草稿 → 生成译文 → 确认填入

界面支持 **中文 / English**，默认跟随浏览器语言，欢迎页与「语言包管理」页均可切换。

## ⚠️ 已知限制

- 模型以英语为中心：中文 ↔ 非英语语言需经英语中转，速度与质量略降
- WASM 运行时约 5 MB，加载语言包后内存占用会明显上升（换取第二次翻译免冷启动）
- 语言识别与正文识别均为轻量启发式，个别特殊页面可能误判（宁可多翻，不漏翻）
- 部分富文本编辑器不接受程序化填入，此时面板会提示改用复制

## 🧭 项目结构

```text
extension/
  manifest.json       MV3 清单（最小权限：storage / contextMenus / offscreen）
  background.js       Service Worker：消息路由 + 离屏文档生命周期
  offscreen.html/js   离屏文档：WASM 翻译引擎宿主
  content.js          页面交互：选中翻译 / 回复面板 / 整页双语 / 悬停翻译
  lib/                可复用模块（i18n / 语言 / 文本 / 引擎桥 / 正文提取…）
  ui/                 popup、语言包管理页、欢迎页
  vendor/             bergamot-translator 0.4.9（MPL-2.0）
tests/unit/           单元测试（node:test + jsdom）
tests/e2e/            Playwright 端到端冒烟测试
scripts/              打包与引擎验证脚本
docs/                 设计文档与演示素材
```

## 📄 许可证

[MPL-2.0](LICENSE)。翻译运行时与语言模型分别遵循其上游许可证（见「语言包」一节）。
