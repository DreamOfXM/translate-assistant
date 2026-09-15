# Chrome Web Store 上架套件

> 目标：把 `dist/translate-assistant.zip` 发布到 Chrome Web Store。
> 上传包、账号注册、后台提交必须由扩展作者本人在浏览器完成（涉及 Google 账号与 $5 开发者注册费），
> 本文备好所有需要粘贴的文案与选择项。

## 0. 一次性准备

1. 打开 https://chrome.google.com/webstore/devconsole
2. 用发布用的 Google 账号登录，一次性支付 **$5** 注册开发者
3. 建议：该账号与 GitHub 身份（DreamOfXM）对应，避免用公司账号/公司邮箱

## 1. 上传包

- 本地先跑 `npm run build`，上传 **`dist/translate-assistant.zip`**
- zip 顶层就是 `manifest.json`（build 脚本保证），不要再多套一层目录
- 当前版本：**1.0.0**

## 2. 商店文案（Store listing）

### 商品名称（≤45 字符）

```text
中文（默认语言）：翻译助手 - 本地离线网页翻译
English：Translate Assistant: 100% Offline Translator
```

### 摘要（≤132 字符）

```text
中文：100% 在你的浏览器里完成的翻译：选中即译、悬停译段、整页双语对照、回复草稿填入。不联网、无 API Key、不上传任何文字。
English：Translation that happens entirely inside your browser. Select, hover, full-page bilingual, reply drafts. No servers, no API key, nothing uploaded.
```

### 完整描述

中文（粘贴到「说明」）：

```text
你的文本从不离开浏览器。

翻译助手是一款完全本地/离线的翻译扩展：翻译由内置的开源 WASM 引擎（bergamot-translator + Mozilla 公开语言模型）在你的设备上完成。除了首次下载语言包，扩展不发起任何网络请求——没有翻译服务器、没有 API Key、没有账号，也没有任何人能看到你在读什么、写什么。

■ 四种用法
· 选中翻译：选中任意外语文字 → 点「翻译选中」→ 原文与译文并排显示
· 悬停翻译：鼠标停在段落上出现「译」，点一下在该段下方插入译文
· 整页双语对照：打开外文网页自动逐段翻译，译文插在每段原文下面（类似沉浸式翻译）；只翻正文主体，导航、侧栏、广告、页脚、评论不会插译文
· 回复助手：在评论框旁点「翻译回复」，用中文写草稿 → 生成译文 → 你确认后才填入，绝不替你点发送

■ 隐私（这是它和所有云端翻译器的本质区别）
· 网页文本、选区、草稿、译文全部只在浏览器进程内流转，不上传
· 网络请求只有两类：拉取 Mozilla 模型目录、下载语言包（storage.googleapis.com）
· 只申请 storage / contextMenus / offscreen 三个权限，无 tabs、无历史、无 Cookie
· 全部代码开源可审计：github.com/DreamOfXM/translate-assistant

■ 离线可用
语言包（约 25–50 MB/方向）下载完成后不需要任何网络，飞行模式下照样能翻译。

■ 语言
源语言自动识别，目标默认中文；支持英语、日语、韩语、法语、德语、西班牙语、俄语、葡萄牙语、意大利语、中文等 116 个方向（Mozilla 官方模型清单）。非英语互译经英语中转，自动完成。

■ 说明
· 首次使用需要联网下载语言包（自动模式不会偷偷下载）
· 中文段落不会出现在翻译范围（对中文读者没有翻译价值）
· 遇到问题或想支持新项目：GitHub Issues 见上方仓库地址
```

English（添加 en 语言版本时粘贴）：

```text
Your text never leaves your browser.

Translate Assistant is a fully local/offline translation extension. Translation runs on an open-source WASM engine (bergamot-translator + Mozilla's public language models) right on your device. Apart from one-time language-pack downloads, the extension makes zero network requests — no translation servers, no API key, no account, and nobody can see what you read or write.

■ Four ways to use it
· Selection: select foreign text → "Translate selection" → source and translation side by side
· Hover: hover over a paragraph, click the "译" pill, translation inserted below
· Full-page bilingual: open a foreign page and the article is translated paragraph by paragraph (like Immersive Translate) — only the main content; nav, sidebars, ads, footers and comments stay untouched
· Reply assistant: write a draft in your language, generate the translation, and it is filled into the input only after you confirm. It never clicks "send" for you.

■ Privacy (the fundamental difference from cloud translators)
· Page text, selections, drafts and translations never leave the browser process
· The only network requests: fetching Mozilla's model catalog and downloading language packs (storage.googleapis.com)
· Only three permissions: storage, contextMenus, offscreen. No tabs, no history, no cookies.
· Fully open source and auditable: github.com/DreamOfXM/translate-assistant

■ Offline
Once a language pack (~25–50 MB per direction) is downloaded, translation works with the network off — airplanes, intranets, confidential documents.

■ Languages
Auto source detection, Chinese target by default; 116 directions supported (Mozilla's official model list) including English, Japanese, Korean, French, German, Spanish, Russian, Portuguese, Italian and Chinese. Non-English pairs route through English automatically.

■ Notes
· First use of a direction needs internet to download its pack (auto mode never downloads silently)
· Chinese paragraphs are skipped by design
· Issues & source: repository link above
```

### 类别 / 语言

- 类别：**Productivity（效率工具）**（备选 Communication）
- 语言：添加 `中文` 与 `English` 两个 locale，分别粘贴上面两套文案

## 3. 隐私与权限申报（Privacy tab）

| 表单问题 | 应选项 |
| --- | --- |
| Single purpose（单一用途声明） | 见下方文案 |
| Does your extension handle sensitive user data? | 选「处理用户生成内容/网页内容」后按下方说明 |
| 是否将数据用于功能之外（分析/广告/转售） | **全部 No** |
| 是否向第三方发送用户数据 | **No**（文本不出浏览器，可附下方说明） |
| 是否有远程代码 | **No**（WASM 运行时打包在 zip 内；语言包是数据文件，不是代码） |

**Single purpose 声明（粘贴）：**

```text
This extension translates text (selections, paragraphs, pages, and user drafts) entirely on the user's device using a bundled WASM engine and locally stored language models. All features serve this single translation purpose.
```

**数据用途说明（若表单要求说明文本处理）：**

```text
Selected/page/draft text is processed 100% locally by the bundled engine. It is never transmitted, logged, stored remotely, or shared with any third party. The only outbound requests are model catalog fetches and language-pack downloads from Mozilla's public storage.
```

**权限用途说明（reviewer 逐项要求 justification 时粘贴）：**

```text
contextMenus: adds the "翻译选中内容" right-click entry, the core selection-translation flow.
storage: persists user toggles and the installed-language-pack list; no user content is stored.
offscreen: hosts the WASM translation engine, required because MV3 service workers cannot create Web Workers.
Content script on all URLs: translation must work on any web page the user visits — that is the product's purpose. It only renders UI in Shadow DOM and never reads page content unless the user triggers a translation.
Host permission https://storage.googleapis.com/*: download Mozilla's public translation models (data files) once per language direction. No user data is ever sent to this host.
```

## 4. 素材清单

| 素材 | 要求 | 状态 |
| --- | --- | --- |
| 图标 | 96×96 ~ 512×512 PNG | ✅ 用 `extension/icons/icon-512.png` |
| 截图 ×3~5 | 1280×800 或 640×400（≤8 张） |  需实拍，方法见下 |
| 宣传图（可选） | Marquee 1280×800 / Tile 440×280 | ⬜ 可后置 |

**截图怎么拍（3 张即够）：**

1. `npm run build` 后在 `chrome://extensions` 加载 `dist/translate-assistant`
2. 打开 `tests/e2e/test-page.html`（或任一英文网页），先手动翻出一两段
3. 用 macOS 自带截图框选浏览器可视区（`⇧⌘4` 后按 `空格` 点窗口，自动得到窗口尺寸图；不足 1280×800 时把窗口拉大或用 `⌘+` 缩放页面）
4. 建议三张：① 悬停「译」按钮+译文 ② 整页双语对照效果 ③ 回复助手面板（体现"确认后填入"）
5. 若尺寸不合规：`sips -z 800 1280 shot.png --out shot-1280x800.png`（注意保持比例，必要时先裁切）

## 5. 提交与审核

1. devconsole → 「新增项目」→ 上传 zip → 自动解析
2. 依次填 Store listing / Privacy / 上传截图 → 「提交供审核」
3. 可见性选 **公开（Public）**；若想先小范围验证可选「不公开（Unlisted）」拿链接自用，随时可切公开
4. 新扩展审核通常 1~3 天；被拒最常见原因是权限说明不充分或「单一用途」存疑——照第 3 节文案回复申诉即可
5. Release notes（首次提交）：

```text
Initial release. Fully local translation: selection, hover, full-page bilingual (main-content only), and reply drafts. Zero text upload; offline after language packs are installed.
```

## 6. 上架之后（涨星动作，按优先级）

1. README 顶部加商店链接 + 「Chrome Web Store 一键安装」徽章（shields.io 有现成模板）
2. 投稿：小众软件 / 少数派 / V2EX `/go/分享创造` / 即刻
3. 英文渠道：Show HN（标题打 "Your text never leaves your browser"）、r/privacy、r/Translator
4. 提 PR 进 awesome-chrome-extensions、awesome-privacy 清单
5. 商店页本身会带来搜索流量——名称里的「本地/离线」就是差异化关键词
