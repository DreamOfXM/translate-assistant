# 翻译助手 · Chrome 扩展

> 🌐 [English version](README.en.md)

在浏览器里**本地**翻译网页上的外语文本，或把中文草稿翻译成目标语言后填回输入框。
不需要 API Key、不需要本地后台服务、不上传任何文本。

- **选中翻译**：选中外语 → 点「翻译选中」→ 结果卡片显示在选区旁边
- **悬停翻译**（读）：popup 打开开关 → 鼠标停在段落上出现「译」→ 段落下方就地插入译文，可收起
- **整页双语对照**（读）：打开外文网页自动逐段翻译，译文插在每段原文下面（类似沉浸式翻译），不用点任何按钮
- **回复助手**（写）：在评论框里点「翻译回复」→ 用中文写草稿 → 生成译文 → **确认后**才填入
- **不用选语言**：翻译卡片里上面放原文、下面直接出译文。源语言自动识别，目标默认中文
- **离线可用**：语言包下载完成后，断网也能翻译

## 界面

翻译卡片（选中 / 回复）都是同一种结构：**上面原文、下面译文**，中间只有一行语言条。
注意「整页双语对照」是例外：译文直接插在页面原段落下方，原段落就在上面，所以译文节点**不再重复显示原文**。

```text
┌─ 原文 ─────────────────────────┐
│ Local translation runs on …    │
└────────────────────────────────┘
  自动检测 · 英语  ⇄  中文          ← 一行文字，点开才需要选
┌─ 译文 · 中文 ───────────────────┐
│ 本地翻译在你的设备上完成…        │
└────────────────────────────────┘
```

语言条平时只是一行说明文字，不是必填项。想改再点：

- 左半边默认「自动检测」，识别结果会直接显示在上面（如「自动检测 · 英语」）
- 右半边是目标语言，默认中文；写中文草稿时自动变成英语，不会「自己译自己」
- `⇄` 交换语言，并把译文挪回原文框方便反向翻译

### 读：悬停翻译

popup 里打开「悬停翻译」开关后，鼠标停在段落上，段落右上角出现一个圆形「译」按钮；
点击就在该段落下方插入双语译文（挂在 Shadow DOM 里，不受网页样式影响），
可以随时「显示原文 / 显示译文 / 复制 / 收起」。再点一次「译」等于收起。

中文段落不会出现按钮（对中文读者没有翻译价值），输入框里也不会（那是「写」模式的地盘）。

### 读：整页双语对照（默认开启）

**打开外文网页就直接逐段出译文，全程不用点任何按钮** —— 译文插在每段原文下面，
像沉浸式翻译那样整页分段展示。popup 里三个开关可以调：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 整页双语对照 | 开 | 页面加载完自动逐段翻译；段落滚进视口才翻，长页面不浪费引擎 |
| 右下角悬浮按钮 | 开 | 手动点「双语对照」翻整页，或收起全部译文 |
| 悬停出「译」按钮 | 关 | 鼠标停在段落上出现「译」，单段翻译 |

行为细节：

- 按钮实时显示进度「翻译中 N/M · 点击停止」，随时可停
- 只翻叶子段落：`blockquote > p` 这类嵌套结构不会翻两遍；隐藏的模板、广告位跳过
- 中文网页不自动翻译；单次最多处理 200 段，防止超长页面把引擎占死
- **译文节点只放译文**：原段落就停在页面上方，译文节点不再把原文重复一遍（避免界面变啰嗦）；
  失败时节点原地标红显示错误，照样能看出是哪段没成功
- **混排段落按主体语言处理**：英文为主的段落里夹几个汉字（导航、品牌名常见）照样翻译，
  不会报「源语言和目标语言相同」；汉字占多数的段落才是真中文，静默跳过且不弹错误卡片
- **自动模式绝不偷偷下载语言包**：所需语言包没装好时不会自动开始，避免打开网页就跑掉几十 MB 流量
- 动态页面（无限滚动、SPA）新插入的段落也会被翻
- 完成后按钮变「已译 N 段 · 收起」，点击收起；再点恢复显示，不会重新请求翻译
- 段落翻译失败只影响那一段（原地显示错误），不影响后面的段落


## 安装

```bash
npm run build
```

1. Chrome 打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `dist/translate-assistant`
4. **刷新已经打开的网页**（content script 只在新加载的页面注入）

打包成 zip：`npm run build` 会同时生成 `dist/translate-assistant.zip`。

要求 Chrome 109 及以上（用到离屏文档 API）。

**必须加载 `dist/` 而不是 `extension/`** —— `content.js` 由 esbuild 打包成单文件后才注入，
源码目录里的 `content.js` 带 ES module 的 `import`，直接加载会报
`Cannot use import statement outside a module`。

### 两个踩过的坑（改动时别踩回去）

1. **content script 不能用 ES module。** manifest 的 `content_scripts` 里写 `"type": "module"`
   在实测的 Chrome 上不生效，脚本会被当成普通脚本注入并直接报错。所以 `npm run build`
   会把 `content.js` 用 esbuild 打成 IIFE（`bundle: true, format: 'iife'`）。
   扩展页面（popup / 选项页 / 离屏文档）和 Service Worker 里的 ES module 是正常支持的，照常拆分模块。
2. **扩展页默认 CSP 不允许编译 WebAssembly。** MV3 默认 `script-src 'self'`，
   bergamot 的 WASM 会报
   `WebAssembly.instantiateStreaming(): violates Content Security Policy`，
   于是引擎永远起不来、界面上只看到「启动超时」。manifest 里必须声明：
   `"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`。

## 它是怎么跑起来的

```text
网页
 └─ content.js（Shadow DOM 面板 · 选中识别 · 确认后填回）
      │  chrome.runtime.sendMessage
      ▼
background.js（Service Worker：菜单 · 消息路由 · 状态）
      │  runtime.connect 长连接
      ▼
offscreen.html / offscreen.js（离屏文档）
      │  new Worker()
      ▼
vendor/worker/translator-worker.js → bergamot WASM 运行时
      │
      ▼
Mozilla Firefox Translations 语言包（Cache Storage + 完整性校验）
```

**关键点：引擎为什么不在 Service Worker 里？**
MV3 的 Service Worker 运行在 Worker 全局作用域，没有 `window`，也**不能 `new Worker()`**，
而 bergamot 的 WASM 运行时必须有 DOM 侧的 Worker 能力。所以引擎放在
`chrome.offscreen` 离屏文档里，Service Worker 只做消息代理和生命周期管理
（按需创建、端口断开后自动重建）。

## 语言包

语言包来自 Mozilla 的公开模型目录（116 个方向），许可证 **MPL-2.0**，
运行时是 [bergamot-translator](https://github.com/browsermt/bergamot-translator)（同为 MPL-2.0）。

**Mozilla 只发布「各语言 ↔ 英语」的模型**（外加 en-zh / zh-en）。
所以中文 ↔ 日语这类方向没有直接模型，插件会**经英语中转**：

```text
日语 → 中文  =  (日语 → 英语)  +  (英语 → 中文)
```

这需要在语言包管理页一次装好两个包，界面上会明确标出「需要 2 个语言包」。
中转由 bergamot 在运行时内部完成，用户无感。

单个语言包约 **25–50 MB**，下载后解压到 Cache Storage，并校验模型文件的
SHA-256（`models.json` 里提供），校验失败会丢弃缓存并提示重新下载。

## 隐私

- 网页文本、草稿、译文**都不上传**，只在浏览器进程内流转
- 草稿默认只存在面板内存里，不写入持久化存储
- 网络请求只有两类：拉取模型目录、下载语言包（都是 `storage.googleapis.com`）
- Manifest 只申请 `storage`、`contextMenus`、`offscreen` 三个权限
- 面板挂在 Shadow DOM 里，不污染页面样式，也不读取无关页面内容

## 开发

```bash
npm install
npm test              # 单元测试（语言识别、消息协议、文本分段、输入框填充、manifest 校验）
npm run build         # 打包到 dist/
npm run verify:engine # 在 Node 里跑通一次真实翻译，验证运行时与线上模型兼容
npm run test:e2e      # 真 Chrome 加载 dist/ 里的扩展，跑一遍四条主路径（需先 build）
```

`npm test` 除了纯逻辑测试，还用 jsdom 直接驱动 `content.js`，覆盖真实交互：
输入框入口按钮、结果卡片、确认填入、长文本分段、翻译失败保留草稿、输入框失效提示等。
验收标准里「未经用户确认不修改输入框」「确认后只填入不发布」这两条就是由它守住的。

`npm run verify:engine` 不需要浏览器：vendor 代码自带 Node 兼容层，会真的下载一个语言包
并完成翻译，用来确认「WASM 运行时 + Mozilla 线上模型」这对最大的技术风险没坏。
默认验证 `en-zh`，也可以指定方向：`npm run verify:engine zh-en`。

`npm run test:e2e` 起一个真 Chrome（默认有头）加载 `dist/translate-assistant`，
自动跑完 popup 翻译、选中翻译、悬停翻译、回复助手四条路径，并检查控制台没有
CSP / ESM / WASM 报错。这层专门拦只在真浏览器里才暴露的问题，细节见 `tests/e2e/README.md`。

更细的交互与离线能力仍用 `tests/e2e/test-page.html` 手工验证，清单见 `tests/e2e/README.md`。

### 目录结构

```text
extension/
  manifest.json
  background.js       Service Worker：路由 + 离屏文档生命周期
  offscreen.html/js   离屏文档：WASM 引擎宿主
  content.js          页面交互（选中翻译 / 回复面板 / 确认填入）
  lib/                可复用模块（语言、文本、协议、输入、引擎、语言条、悬停阅读、样式）
  ui/                 popup 与语言包管理页
  vendor/             bergamot-translator 0.4.9（MPL-2.0）
tests/unit/           单元测试
tests/e2e/            自动化冒烟脚本 + 手工测试页与清单
scripts/              打包与引擎验证脚本
```

`extension/vendor/translator.js` 相对上游
`@browsermt/bergamot-translator@0.4.9` 只有一处改动：允许调用方通过
`workerUrl` 指定 worker 地址（原实现用 `import.meta.url` 相对定位，在离屏文档里会指错目录）。

## 已知限制

- 语言包以英语为中心，中文与非英语语言互译需要中转，体积和时间翻倍
- WASM 运行时约 5 MB，加上语言包，内存占用在加载后会明显上升
- 语言识别是基于字符区间和常见虚词的轻量启发式，只作为建议，界面上可手动改
- 部分自定义编辑器（如某些富文本框架）不接受程序化填入，此时面板会提示改用复制
- 扩展安装后需要刷新已打开的网页
