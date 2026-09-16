# 产品级视觉与体验打磨 · 设计方案

> 2026-09-16 · 基于已上线的 v1.0.0 功能基线，只动视觉与交互层，不动翻译引擎与核心逻辑。
> 用户已确认：视觉走**清新友好风**，范围**全面打磨**，产品名保留**「翻译助手」**。

## 目标

把「工程完成」的扩展打磨成「看起来值得付费」的产品：

1. 建立统一的品牌设计系统（token 化，不再是无识别度的 Google 默认风格）
2. 四个用户可见界面全部按新系统重做：popup、翻译卡片（Shadow DOM）、页内元素（悬浮按钮 / 悬停药丸 / 整页译文节点）、语言包管理页
3. 新品牌图标（渐变 + 对话气泡 + 「译」）
4. 首次使用引导页（onInstalled → welcome.html），打通「装包 → 用起来」的转化路径
5. 微交互与深色模式全面配套

## 非目标

- 不改翻译引擎、消息协议、存储结构、正文提取等核心逻辑
- 不加新功能（翻译历史、快捷键、朗读、付费墙等留二期）
- 不做商店截图等营销素材

## 技术路径

**CSS 自定义属性做 design tokens，零新依赖。**

- `extension/ui/tokens.css`：popup / options / welcome 以 `<link>` 引用
- `extension/lib/panel-styles.js`（Shadow DOM）与 `extension/lib/reader.js` 的 `PARA_STYLES`：以字符串内嵌同一套 token 值
- 类名与 DOM 结构**保持不变**（`tests/unit/content.dom.test.mjs` 依赖 `.lt-card`、`.lt-draft`、`.lt-float` 等选择器），重设计只发生在 CSS 层
- token 双处维护的风险用「panel-styles.js 顶部注释指向 tokens.css 为唯一权威来源」约束，改色只改这两处的同步值

## 设计系统

### 色彩（清新友好风）

| Token | 值 | 用途 |
|---|---|---|
| `--brand-400/500/600` | `#38BDF8` / `#0EA5E9` / `#0284C7` | 主色（青蓝） |
| `--brand-gradient` | 135° `#38BDF8 → #14B8A6` | 翻译按钮、logo、悬浮药丸、hero |
| `--accent` | `#F59E0B`（琥珀） | 「需 2 个语言包」等注意点 |
| `--ok` / `--danger` | `#10B981` / `#EF4444` | 成功 / 错误 |
| 中性色 | slate 系：文字 `#0F172A`、次要 `#64748B`、底面 `#F8FAFC`、边框 `#E2E8F0` | 替换 Google 灰 |
| 深色模式 | 底 `#0F172A`、面 `#1E293B`、文字 `#E2E8F0`、次要 `#94A3B8`、边框 `#334155`、品牌亮色 `#7DD3FC` | 全界面配套 |

### 形状与层次

- 圆角四档：8 / 12 / 16 / 20（药丸 999）
- 阴影三档，柔和 + 品牌色投影（如 `0 8px 24px rgba(14,165,233,.18)`）
- 字号 12 / 13 / 14 / 15 / 16 / 22；字体栈维持系统栈
- 动效时长 150 / 250ms；`prefers-reduced-motion: reduce` 下全部关闭

## 界面设计

### 1. Popup（`ui/popup.html` + `popup.css`）

- 品牌头部：渐变小 logo + 「翻译助手」+「本地翻译 · 离线可用」徽标（浅青底圆角 chip）
- 输入框品牌色聚焦环；语言条（`.lt-langbar`）沿用「一行文字」形态，换品牌色
- 翻译按钮：渐变底、hover 抬升、加载时转圈 + 进度条
- 译文卡：浅青底（`#E0F2FE` / 深色对应），复制按钮成功反馈「已复制 ✓」（2s 后还原）
- 三个读模式开关改成带小 SVG 图标的设置卡；开关品牌色
- 页脚：语言包计数 + 管理入口
- **未安装语言包时**顶部出现引导卡：「先装语言包，才能翻译 → 去安装」（装好后自动隐藏）

### 2. 翻译卡片（`lib/panel-styles.js`）

- 卡片顶部 3px 品牌渐变条；更柔和阴影 + 1px 边框；进场淡入（120ms）
- 按钮：主按钮渐变、ghost 换 slate 面；hover 微抬升、active 压下
- 深色模式按新 token 全套重写

### 3. 页内元素（`lib/reader.js` 的 `PARA_STYLES` + panel-styles 中的 `.lt-float` / `.lt-hover-pill`）

- `.lt-float`（右下角悬浮按钮）：渐变药丸 + logo 符号；翻译中显示进度百分比
- `.lt-hover-pill`（悬停「译」）：渐变圆、hover 放大 1.08
- 整页译文节点 `.lt-wrap`：左侧 3px 品牌竖线 + 浅青底（深色对应 `#164E63` 系）+ 淡入；失败态标红保留现有行为

### 4. 语言包管理页（`ui/options.*`）

- hero：渐变标题 + 品牌徽标，副文案保留「本地、无 Key、MPL-2.0 来源」信息
- 「常用组合」改卡片栅格：方向名 + 大小 + 下载按钮 + 进度条；需 2 包的方向用琥珀 chip 标注
- 语言包列表行：状态 chip（已安装 ✓ / 未安装）、大小、操作按钮
- 搜索框、`.empty` 空状态、深色模式全套配套

## 图标

- `icon-src.svg`：135° 渐变（`#38BDF8 → #14B8A6`）圆角方 + 白色对话气泡 + 「译」
- 产出 16 / 32 / 48 / 128 / 512 五个 PNG，替换 `extension/icons/`
- 生成方式：无光栅化依赖时用系统可用工具（qlmanage / Chrome headless）渲染，脚本一次性执行不入库

## 首启引导

- `background.js` 增加 `chrome.runtime.onInstalled`（reason === `install`）→ 打开 `ui/welcome.html`
- welcome 页：品牌 hero → 三步引导卡（① 装语言包 ② 开外文网页自动双语 ③ 选中即译 / 中文写回复）→ 隐私承诺（全部本地、无上传）→ 主 CTA「安装英↔中语言包」（跳语言包管理页）
- 复用 `tokens.css`，风格与 popup 一致

## 验证

1. `npm test`：全部单测通过（类名/DOM 未动，理论上无破坏）
2. `npm run build`：构建产物完整（新增 welcome.html 入 dist）
3. `npm run test:e2e`：四条主路径通过、控制台无新报错
4. 手工：深色模式、`prefers-reduced-motion`、引导卡出现/消失逻辑
5. README「界面」章节同步更新

## 实施顺序

1. `tokens.css` + popup 重设计（含引导卡）
2. `panel-styles.js` + `reader.js` 样式重做
3. options 页重做
4. 图标替换
5. welcome 页 + onInstalled 接线
6. 回归测试 + README + 提交
