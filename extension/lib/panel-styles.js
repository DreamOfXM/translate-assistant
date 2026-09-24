/**
 * 注入面板的样式。
 *
 * 面板挂在 Shadow DOM 里，避免被宿主网页的 CSS 影响（反之亦然），
 * 所以样式以字符串形式内联，不走 manifest 的 content.css。
 *
 * 配色、圆角、阴影与 ui/tokens.css 保持同步（那里是唯一权威来源）；
 * Shadow DOM 里引用不到外部 CSS 变量，只能内嵌同样的值。
 * 改动任一处颜色时，tokens.css / panel-styles.js / reader.js 的 PARA_STYLES 三处要一起改。
 *
 * 视觉语言（docs/design-history/r03/s02-google.html）：单一实色蓝 #1A73E8、
 * 发丝边 #DADCE0、译文块浅蓝填充 #E8F0FE、容器 20/24 圆角、动作全药丸、
 * 阴影只有中性灰两档，**不用渐变、不用彩色投影**。
 */
export const PANEL_STYLES = `
:host { all: initial; }
/* all: initial 会把 host 的 display 重置成 inline，优先级高于 UA 的
   [hidden]{display:none}；面板 host 上要用 hidden 就得靠这一条。 */
:host([hidden]) { display: none !important; }

.lt-card {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  max-height: min(72vh, 640px);
  overflow: auto;
  padding: 16px;
  border: 0;
  border-radius: 24px;
  background: #fff;
  color: #202124;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 1px 3px rgba(60, 64, 67, .15), 0 4px 8px 3px rgba(60, 64, 67, .10);
  animation: lt-card-in 160ms ease-out;
}
@keyframes lt-card-in {
  from { opacity: 0; transform: translateY(6px) scale(.985); }
  to { opacity: 1; transform: none; }
}
.lt-card * { box-sizing: border-box; font-family: inherit; }

.lt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.lt-title { font-size: 16px; font-weight: 500; margin: 0; }
.lt-sub { margin: 3px 0 0; font-size: 12px; color: #5F6368; }
.lt-close { border: 0; background: transparent; font-size: 18px; line-height: 1; color: #5F6368; cursor: pointer; padding: 5px; border-radius: 50%; transition: background 150ms, color 150ms; }
.lt-close:hover { background: #F1F3F4; color: #202124; }

.lt-note { margin: 0 0 12px; padding: 12px 16px; border-radius: 20px; background: #FEF3C7; font-size: 12px; color: #78350F; }

.lt-field { display: block; margin-bottom: 10px; font-size: 11px; font-weight: 500; color: #80868B; }
.lt-field > textarea {
  display: block;
  width: 100%;
  margin-top: 5px;
  padding: 12px 16px;
  border: 1px solid #DADCE0;
  border-radius: 20px;
  background: #fff;
  color: #202124;
  font-size: 14px;
  font-weight: 400;
  min-height: 92px;
  resize: vertical;
  transition: border-color 150ms, box-shadow 150ms;
}
/* Material 的聚焦态是「发丝边加粗到 2px」，不是外扩光晕 */
.lt-field > textarea:focus { outline: none; border-color: #1A73E8; box-shadow: inset 0 0 0 1px #1A73E8; }
.lt-field > textarea[readonly] { background: #F8F9FA; color: #5F6368; }

/* 语言条：平时就是一行文字（自动检测 · 英语 → 中文），点开才需要选。
   源语言是灰字，目标语言才是当前生效的选择——蓝字 + 2px 下划条。 */
.lt-langbar { display: flex; align-items: center; gap: 2px; margin: 0 0 12px; }
.lt-langbar select {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  border-radius: 8px 8px 0 0;
  background: transparent;
  color: #5F6368;
  font-size: 13px;
  font-weight: 500;
  padding: 5px 8px;
  cursor: pointer;
  max-width: 170px;
  text-overflow: ellipsis;
  transition: background 150ms, color 150ms;
}
.lt-langbar select:hover { background: #F1F3F4; color: #202124; }
.lt-langbar select:focus-visible { outline: 2px solid #1A73E8; outline-offset: 1px; }
.lt-langbar .lt-target { color: #1A73E8; box-shadow: inset 0 -2px 0 #1A73E8; }
.lt-arrow { padding: 0 2px; color: #80868B; font-size: 13px; }
.lt-swap {
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: #5F6368;
  font-size: 14px;
  line-height: 1;
  padding: 5px 7px;
  cursor: pointer;
  transition: background 150ms, color 150ms;
}
.lt-swap:hover { background: #F1F3F4; color: #202124; }

.lt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.lt-button {
  padding: 9px 16px;
  border: 0;
  border-radius: 999px;
  background: #1A73E8;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(60, 64, 67, .10), 0 1px 3px 1px rgba(60, 64, 67, .06);
  transition: background 150ms, box-shadow 150ms;
}
.lt-button:hover:not(:disabled) { background: #174EA6; box-shadow: 0 1px 3px rgba(60, 64, 67, .15), 0 4px 8px 3px rgba(60, 64, 67, .10); }
.lt-button:active:not(:disabled) { box-shadow: 0 1px 2px rgba(60, 64, 67, .10), 0 1px 3px 1px rgba(60, 64, 67, .06); }
.lt-button:disabled { background: #F1F3F4; color: #80868B; cursor: not-allowed; box-shadow: none; }
.lt-button.ghost {
  background: #fff;
  color: #5F6368;
  border: 1px solid #DADCE0;
  box-shadow: none;
}
.lt-button.ghost:hover:not(:disabled) { background: #F1F3F4; color: #202124; }
.lt-button.primary-fill { background: #188038; }
.lt-button.primary-fill:hover:not(:disabled) { background: #137333; }

/* 译文块靠「整块填色」和原文分开，不再叠一条分隔线 */
.lt-output { margin-top: 14px; padding: 12px 16px; border-radius: 20px; background: #E8F0FE; }
.lt-label { font-size: 11px; font-weight: 500; letter-spacing: .2px; color: #80868B; }
.lt-text { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font-size: 15px; line-height: 1.6; min-height: 1.5em; }
.lt-text.placeholder { color: #80868B; }

.lt-bar { height: 3px; margin-top: 12px; border-radius: 999px; background: #D3E3FD; overflow: hidden; }
.lt-bar > i { display: block; height: 100%; width: 0; background: #1A73E8; border-radius: 999px; transition: width 250ms ease; }

.lt-status { margin: 12px 0 0; font-size: 12px; color: #5F6368; min-height: 1em; }
.lt-status.error { color: #D93025; }
.lt-status.ok { color: #188038; }

/* 就地译文条：输入框已有草稿时的紧凑形态，替代完整面板 */
.lt-card.lt-inline { width: auto; max-width: min(420px, calc(100vw - 32px)); padding: 14px 16px; }
.lt-inline-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
.lt-inline-lang { font-size: 12px; font-weight: 500; color: #1A73E8; letter-spacing: .2px; }
.lt-card.lt-inline .lt-result { margin: 2px 0 0; font-size: 14px; }
.lt-card.lt-inline .lt-actions { margin-top: 10px; align-items: center; }
.lt-card.lt-inline .lt-bar { margin-top: 8px; }
.lt-card.lt-inline .lt-status { margin: 8px 0 0; }
.lt-inline-more {
  border: 0;
  background: none;
  padding: 0;
  color: #1A73E8;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  margin-left: auto;
}
.lt-inline-more:hover { text-decoration: underline; }

.lt-float {
  position: fixed;
  z-index: 2147483647;
  border: 0;
  border-radius: 999px;
  padding: 9px 16px;
  background: #1A73E8;
  color: #fff;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 1px 3px rgba(60, 64, 67, .15), 0 4px 8px 3px rgba(60, 64, 67, .10);
  cursor: pointer;
  transition: background 150ms, box-shadow 150ms;
}
.lt-float:hover { background: #174EA6; }
.lt-float:active { background: #1A73E8; box-shadow: 0 1px 2px rgba(60, 64, 67, .10), 0 1px 3px 1px rgba(60, 64, 67, .06); }

/* 悬停阅读：段落右上角的「译」/「Translate」胶囊。
   宽度不写死：中文是单个字（min-width 兜成 28px 圆形），英文是一个单词，
   按钮自己按内容撑开，位置计算见 reader.js 的 positionPill */
.lt-hover-pill {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: 999px;
  background: #1A73E8;
  color: #fff;
  white-space: nowrap;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 1px 3px rgba(60, 64, 67, .20), 0 1px 3px 1px rgba(60, 64, 67, .10);
  cursor: pointer;
  transition: background 150ms, transform 150ms;
}
.lt-hover-pill:hover { background: #174EA6; transform: scale(1.06); }

/* 右下角悬浮按钮（整页双语对照）。它挂在主 shadow root 里，样式必须在这里；
   之前只写在段落节点的 PARA_STYLES 里，bubble 一直是无样式裸按钮。 */
.lt-bubble {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  border: 0;
  border-radius: 999px;
  padding: 10px 16px;
  background: #1A73E8;
  color: #fff;
  font: 500 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 1px 3px rgba(60, 64, 67, .15), 0 4px 8px 3px rgba(60, 64, 67, .10);
  cursor: pointer;
  transition: background 150ms, box-shadow 150ms;
}
.lt-bubble:hover { background: #174EA6; }
.lt-bubble:active { background: #1A73E8; box-shadow: 0 1px 2px rgba(60, 64, 67, .10), 0 1px 3px 1px rgba(60, 64, 67, .06); }

@media (prefers-reduced-motion: reduce) {
  .lt-card { animation: none; }
  .lt-card *, .lt-float, .lt-hover-pill, .lt-button, .lt-bubble { transition: none !important; }
}

@media (prefers-color-scheme: dark) {
  .lt-card { background: #202124; color: #E8EAED;
             box-shadow: 0 1px 3px rgba(0, 0, 0, .5), 0 4px 8px 3px rgba(0, 0, 0, .35); }
  .lt-sub, .lt-label, .lt-status { color: #9AA0A6; }
  .lt-note { background: rgba(245, 158, 11, .16); color: #FDD663; }
  .lt-field { color: #9AA0A6; }
  .lt-field > textarea { background: #171717; color: #E8EAED; border-color: #5F6368; }
  .lt-field > textarea:focus { border-color: #8AB4F8; box-shadow: inset 0 0 0 1px #8AB4F8; }
  .lt-field > textarea[readonly] { background: #2D2F31; color: #BDC1C6; }
  .lt-langbar select { color: #9AA0A6; }
  .lt-langbar select:hover { background: #2D2F31; color: #E8EAED; }
  .lt-langbar select:focus-visible { outline-color: #8AB4F8; }
  .lt-langbar .lt-target { color: #8AB4F8; box-shadow: inset 0 -2px 0 #8AB4F8; }
  .lt-swap, .lt-close { color: #9AA0A6; }
  .lt-swap:hover, .lt-close:hover { background: #2D2F31; color: #E8EAED; }
  .lt-output { background: #283247; }
  .lt-text.placeholder { color: #80868B; }
  .lt-bar { background: #3A4A66; }
  .lt-bar > i { background: #8AB4F8; }
  /* 深色下的实心控件：浅蓝底 + 深字，白字压在中饱和蓝上在这个背景里读不清 */
  .lt-button, .lt-float, .lt-hover-pill, .lt-bubble { background: #8AB4F8; color: #171717; }
  .lt-button:hover:not(:disabled), .lt-float:hover, .lt-hover-pill:hover, .lt-bubble:hover { background: #AECBFA; }
  .lt-button:disabled { background: #2D2F31; color: #80868B; }
  .lt-button.ghost { background: #2D2F31; color: #E8EAED; border-color: #5F6368; }
  .lt-button.ghost:hover:not(:disabled) { background: #3C4043; color: #E8EAED; }
  .lt-button.primary-fill { background: #81C995; }
  .lt-button.primary-fill:hover:not(:disabled) { background: #A0D4AC; }
  .lt-status.error { color: #F28B82; }
  .lt-status.ok { color: #81C995; }
  .lt-inline-lang, .lt-inline-more { color: #8AB4F8; }
}
`;
