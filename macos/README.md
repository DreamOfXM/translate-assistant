# 翻译助手 · macOS 菜单栏版

在 **任何 App 的输入框**里按下热键，把草稿翻译成目标语言，确认后原地填回。
不只浏览器 —— 备忘录、邮件客户端、聊天工具、Safari 和 Chrome 里的网页，
走的都是同一条路。

不想记热键也行：光标进输入框，它的右上角就会浮出一个「译」按钮，点一下即可。

## 它是怎么做到的

浏览器扩展只能看见自己注入的那个网页。macOS 提供了一个系统级接口——
**辅助功能 API（Accessibility API）**，它读写的是「当前焦点所在的输入框」，
并不关心里面是原生控件还是网页。所以：

- 读：拿焦点控件的文本（`kAXValueAttribute`），顺带看有没有选区。
- 翻：调用与扩展**完全相同**的那套离线引擎（Bergamot WASM + Mozilla 语言包），
  没有网络请求，没有 API Key。
- 写：按用途固定走一条通道 ——「翻译当前输入框」整框覆写（`kAXValueAttribute`），
  「翻译选中文字」只替换选区（`kAXSelectedTextAttribute`）。**两条通道之间不做回退**：
  它们的后果差得太远（覆写全文 vs 只换选中），静默降级会把用户写了一半的正文冲掉。
  写不进去就报错并提示该改用哪条路，不赌。

代价是必须拿到「辅助功能」授权——这是 macOS 对「读写别的 App 内容」这类能力的
统一管控，任何工具都绕不过去。

## 安装

```bash
npm run build:macos          # 需要 macOS + Swift 工具链（Command Line Tools 即可）
npm run start:macos          # 等价于 open macos/dist/TranslateAssistant.app
```

启动后菜单栏出现一个「译」字，程序坞里也会有一个图标。它没有窗口 —— 这两个就是全部入口。

> 程序坞图标默认开着：菜单栏挤的时候系统会把状态项整个挤掉，那时「译」根本不在屏幕上。
> 嫌它占位置可以在菜单里点「从程序坞隐藏」。

> `start:macos` 刻意**不**包含构建步骤：每次重新构建都会换签名、让已给的辅助功能授权失效。
> 只启动就别重建。

### 首次使用：授予辅助功能权限

启动时会弹一个说明窗口，里面直接写着入口在哪、热键是什么。

1. 点那个窗口的「去授权」，在「隐私与安全性 → 辅助功能」里打开 **翻译助手** 的开关。
   列表里已经有它时，先按 `−` 删掉再按 `+` 重新添加 —— 重新构建换过签名，旧条目会失效。
   窗口没出现的话，点菜单栏的「译」→「辅助功能：未授权 —— 点击去授权」。
2. 授权状态会在 2 秒内自动刷新（菜单变成「已授权」并弹出提示）。
   如果仍然显示未授权，点菜单里的「重启应用（授权后如仍无反应就用这个）」。

菜单里会实时显示授权状态。也可以用 `--self-check` 确认：

```bash
macos/dist/TranslateAssistant.app/Contents/MacOS/TranslateAssistant --self-check
```

## 用法

### 输入框旁的「译」按钮

光标一进可输入的文本框（邮件回复框、备忘录正文、聊天输入框……），它的**右上角**
就会出现一个蓝色的小「译」按钮。点它就把这个输入框翻出来，结果浮层贴在输入框旁边。

- 不用记热键——看见就知道能点。这是给第一次用的人准备的入口。
- 按钮是**盖在**输入框上的我方浮层，不是注进对方界面的控件：对方应用和它的窗口
  都不会被改动。（macOS 不允许一个进程往另一个进程的视图树里塞控件。）
- 点按钮**不会**切走焦点，原来的输入框仍是焦点，所以「填入」有落脚点。
- 不想要它：菜单 →「输入框旁显示「译」按钮：关」。

### 热键

| 操作 | 默认热键 | 说明 |
| --- | --- | --- |
| 翻译当前输入框 | `⌃⌥T` | 读整个输入框 → 翻译 → 浮层确认 → 填回 |
| 翻译选中文字 | `⌃⌥Y` | 只翻选中的部分，填回时也只替换选区 |

浮层出现后有四个按钮：

- **填入**：写回原输入框（会先把焦点还给目标 App）。
- **复制**：只复制译文，不动输入框。
- **重新翻译**：换方向或改了设置后重跑。
- **关闭**：`Esc` 同效。

浮层刻意做成**不抢焦点**的（`nonactivatingPanel`），所以你可以一边看着原文
一边决定要不要填回去。

浮层的位置会贴着输入框找空位（下 → 上 → 右 → 左）。邮件回复框那种占掉大半个屏幕的
情况，只有左右还放得下。

> **草稿里带着引用历史时会先提醒。** 邮件、论坛的回复草稿下面常跟着
> `---- Replied Message ----` 之类的引用块。整框翻译会把引用一起翻掉、再整框覆写，
> 所以这种情况下浮层上会多一条橙色提示，建议先选中自己写的那几句再按 `⌃⌥Y`。

## 覆盖范围与盲区

覆盖：所有把焦点信息暴露给系统的输入框——原生 App、Electron 应用、浏览器网页。

已知的盲区（属于平台限制，不是可以修的 bug）：

- **自绘控件**：完全自己画、不暴露无障碍节点的控件读不到。
- **安全输入框**：密码框系统层面就不允许读。
- **光标位置**：Electron 应用普遍不提供 `AXSelectedTextRange`，所以拿不到光标
  位置，只能整框读写（对「读草稿 → 整框填回」这个用法没有影响）。
- **Electron 应用需要唤醒**：这类应用平时不构建无障碍节点树（省电）。App 在读取
  前会临时打开 `AXManualAccessibility` / `AXEnhancedUserInterface`，读完复原。
- **个别 Electron 应用读不到内容** —— 用菜单里的「自检」把报告贴出来可以定位。

关于输入框旁的小「译」按钮，另有两件事要知道：

- **它是浮层，不是对方界面的一部分。** 对方窗口一移动、页面一滚动，位置就得靠重新
  读一次坐标跟上去，跟得不够快时会看到它「跳」一下。这是这类工具的通病
  （PopClip、Grammarly 桌面版是同一套办法）。
- **不暴露无障碍节点的应用不会出现按钮。** 浮标走的是「只读坐标」的轻量路径，
  刻意不打开 Chromium / Electron 的辅助功能增强开关——跟随光标是个持续动作，
  反复开关只会让对方的节点树闪断。这类应用仍然可以用热键，热键那条路会临时打开它。

另外，输入框内容超过上限（默认 2000 字符）会被拒绝：整篇文档贴进来送模型只会卡住。

## 语言包

首次翻译某个方向时会自动下载语言包（约 30–45 MB），之后完全离线。
缓存在系统的应用数据目录里，菜单里可以直接打开：

```
~/Library/Application Support/TranslateAssistant/packs/
```

菜单 →「语言包」提供预下载、打开目录、清空缓存。

## 开发

```bash
npm run build:macos          # debug 构建
npm run build:macos -- --release
npm run build:macos -- --web-only   # 只刷新引擎资源，不重新编译 Swift
```

### 引擎只有一份

`macos/` 里**不存在** `engine.js`、`vendor/` 的副本。构建时从 `extension/`
原样拷进 App 包，所以：

- 改引擎 = 改 `extension/lib/engine.js`（或 `vendor/`），扩展和桌面端同时生效。
- `macos/web/` 只放 macOS 特有的东西：一个宿主页面，和三个让引擎以为
  自己还在扩展里的垫片。

### 三个垫片（`macos/web/shims.js`）

引擎代码一行不改，靠覆盖三个全局对象把它骗进普通网页环境：

| 覆盖 | 为什么 |
| --- | --- |
| `chrome.runtime.getURL` | 引擎用它定位 WASM Worker |
| `fetch` | 语言包在 `storage.googleapis.com` 上，网页里直连会被 CORS 挡掉；改走本机原生侧的 `/proxy` 代下载（原生 HTTP 客户端不受 CORS 约束） |
| `caches` | 引擎用 Cache Storage 缓存语言包，这里换成原生侧落盘（`/cache/*`），缓存语义与校验逻辑保持不变 |

`caches` 必须用 `Object.defineProperty` 覆盖：它在 `Window` 上是个只有 getter 的
访问器属性，直接赋值在严格模式下会抛 `TypeError`，垫片静默失效，浏览器自带的
Cache Storage 顶上——看着能跑，实际缓存没落到我们的目录。垫片失败会记进
`window.__ltShimFailures`，由宿主页面透出来。

### 为什么要一个回环 HTTP 服务

`EngineServer` 在 `127.0.0.1` 上起一个极简 HTTP/1.1 服务，原因是三个都绕不开的约束：

1. 引擎必须跑在 Web Worker 里，而 `file://` 页面创建 Worker 会被 WebKit 拒绝，
   必须有一个真正的 http 源；`http://127.0.0.1` 同时满足「安全上下文」条件。
2. 语言包要挂在 `storage.googleapis.com` 上，页面上直接 fetch 会被 CORS 拦住。
3. 语言包需要一个受我们控制的落盘位置。

服务只监听回环，不对外暴露。

### 自检与排错

```bash
# 引擎链验证：起服务 → 加载 WKWebView → 真翻一句 → 退出（不需要授权）
macos/dist/TranslateAssistant.app/Contents/MacOS/TranslateAssistant --check-engine

# 辅助功能状态 + 焦点控件的可写属性 + 语言包缓存
macos/dist/TranslateAssistant.app/Contents/MacOS/TranslateAssistant --self-check

# 打印引擎服务的每个请求（排引擎问题用）
LT_MAC_DEBUG=1 macos/dist/TranslateAssistant.app/Contents/MacOS/TranslateAssistant --serve
```

菜单里的「自检」会把同样一份报告复制到剪贴板，提 issue 时直接粘贴。

> **从终端跑自检会说谎。** 这样拉起的进程会继承终端的「辅助功能」授权，
> 所以终端里报「已授权」**不代表**双击打开的 App 也有权限 —— 后者才是实际运行的身份。
> 判断真实状态要看菜单栏里那一行。

### 目录结构

```
macos/
├── Package.swift                  SwiftPM 清单（无第三方依赖）
├── Resources/Info.plist           LSUIElement：菜单栏应用
├── Sources/TranslateAssistant/
│   ├── Entry.swift                入口 + --serve / --check-engine / --self-check
│   ├── AppDelegate.swift          菜单栏、热键注册、翻译流程、浮标接线
│   ├── Accessibility.swift        AX 读写层（读输入框 / 回填 / 授权 / 焦点输入框坐标）
│   ├── EngineServer.swift         回环 HTTP 服务 + 语言包代理与磁盘缓存
│   ├── HTTPServer.swift           极简 HTTP 传输层
│   ├── EngineBridge.swift         WKWebView ↔ Swift 的 async 桥
│   ├── FocusTracker.swift         跟着光标走：焦点进了哪个输入框、它挪到哪去了
│   ├── InlinePill.swift           输入框右上角那个常驻的「译」按钮（不抢焦点的浮层）
│   ├── HUDWindow.swift            不抢焦点的结果浮层
│   ├── HotKeyCenter.swift         Carbon 全局热键
│   ├── Preferences.swift          设置与语言方向
│   └── Paths.swift                资源/缓存路径、命令行开关
└── web/
    ├── engine.html                引擎宿主页面
    └── shims.js                   三个垫片
```

## 一个必须处理的坑：重新构建后要重新授权

App 目前用 **ad-hoc 签名**（`codesign --sign -`）。macOS 的 TCC（「辅助功能」授权的
登记处）识别应用的方式与签名有关，而 ad-hoc 签名每次构建都会变，所以
**每次重新构建后，辅助功能授权都会失效**。

失效的表现：菜单里显示「辅助功能：未授权」，输入框旁不会出现「译」按钮，
热键按下去只弹出一句提示。这时去 **隐私与安全性 → 辅助功能**，
把旧条目按 `−` 移除，再按 `+` 把 App 加回来 —— 只切换勾选框不一定够用。
加回来之后两秒内会自动生效（菜单会刷新，并提示可以去点输入框旁的「译」按钮）。

要彻底避免这件事，需要一份稳定的代码签名（自签证书或 Apple Developer 账号）。
在仓库里引入证书不现实，所以开发期按上面的步骤处理即可。

## 许可

与项目一致，MPL-2.0。见仓库根目录的 `LICENSE`。
