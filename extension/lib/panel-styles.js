/**
 * 注入面板的样式。
 *
 * 面板挂在 Shadow DOM 里，避免被宿主网页的 CSS 影响（反之亦然），
 * 所以样式以字符串形式内联，不走 manifest 的 content.css。
 *
 * 配色、圆角、阴影与 ui/tokens.css 保持同步（那里是唯一权威来源）；
 * Shadow DOM 里引用不到外部 CSS 变量，只能内嵌同样的值。
 */
export const PANEL_STYLES = `
:host { all: initial; }

.lt-card {
  position: fixed;
  z-index: 2147483647;
  box-sizing: border-box;
  width: min(420px, calc(100vw - 32px));
  max-height: min(72vh, 640px);
  overflow: auto;
  padding: 18px 16px 16px;
  border: 1px solid #E2E8F0;
  border-radius: 16px;
  background: #fff;
  color: #0F172A;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 12px rgba(15, 23, 42, .08), 0 12px 36px rgba(15, 23, 42, .14);
  animation: lt-card-in 160ms ease-out;
}
@keyframes lt-card-in {
  from { opacity: 0; transform: translateY(6px) scale(.985); }
  to { opacity: 1; transform: none; }
}
.lt-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  border-radius: 16px 16px 0 0;
  background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%);
}
.lt-card * { box-sizing: border-box; font-family: inherit; }

.lt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.lt-title { font-size: 15px; font-weight: 700; margin: 0; }
.lt-sub { margin: 2px 0 0; font-size: 12px; color: #64748B; }
.lt-close { border: 0; background: transparent; font-size: 20px; line-height: 1; color: #64748B; cursor: pointer; padding: 2px 6px; border-radius: 8px; transition: background 150ms, color 150ms; }
.lt-close:hover { background: #F1F5F9; color: #0F172A; }

.lt-note { margin: 0 0 12px; padding: 9px 11px; border-radius: 10px; background: #FEF3C7; font-size: 12px; color: #78350F; }

.lt-field { display: block; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: #64748B; }
.lt-field > textarea {
  display: block;
  width: 100%;
  margin-top: 5px;
  padding: 9px 11px;
  border: 1px solid #E2E8F0;
  border-radius: 12px;
  background: #fff;
  color: #0F172A;
  font-size: 14px;
  font-weight: 400;
  min-height: 92px;
  resize: vertical;
  transition: border-color 150ms, box-shadow 150ms;
}
.lt-field > textarea:focus { outline: none; border-color: #0EA5E9; box-shadow: 0 0 0 3px rgba(56, 189, 248, .18); }
.lt-field > textarea[readonly] { background: #F8FAFC; color: #475569; }

/* 语言条：平时就是一行文字（自动检测 · 英语 → 中文），点开才需要选 */
.lt-langbar { display: flex; align-items: center; gap: 2px; margin: 0 0 12px; }
.lt-langbar select {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #0284C7;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 6px;
  cursor: pointer;
  max-width: 170px;
  text-overflow: ellipsis;
  transition: background 150ms;
}
.lt-langbar select:hover { background: #F1F5F9; }
.lt-langbar select:focus-visible { outline: 2px solid #0EA5E9; outline-offset: 1px; }
.lt-arrow { padding: 0 2px; color: #94A3B8; font-size: 13px; }
.lt-swap {
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #64748B;
  font-size: 14px;
  line-height: 1;
  padding: 5px 7px;
  cursor: pointer;
  transition: background 150ms, color 150ms;
}
.lt-swap:hover { background: #F1F5F9; color: #0284C7; }

.lt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.lt-button {
  padding: 9px 14px;
  border: 0;
  border-radius: 12px;
  background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(14, 165, 233, .3);
  transition: transform 150ms, box-shadow 150ms, filter 150ms;
}
.lt-button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.04); }
.lt-button:active:not(:disabled) { transform: translateY(0); box-shadow: 0 1px 4px rgba(14, 165, 233, .3); }
.lt-button:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
.lt-button.ghost {
  background: #fff;
  color: #0F172A;
  border: 1px solid #E2E8F0;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .05);
}
.lt-button.ghost:hover:not(:disabled) { background: #F1F5F9; filter: none; }
.lt-button.primary-fill { background: linear-gradient(135deg, #10B981, #059669); box-shadow: 0 4px 14px rgba(16, 185, 129, .3); }
.lt-button.primary-fill:hover:not(:disabled) { filter: brightness(1.05); }

.lt-output { margin-top: 14px; padding: 12px; border-radius: 14px; background: rgba(56, 189, 248, .12); }
.lt-label { font-size: 11px; font-weight: 700; letter-spacing: .4px; color: #0284C7; }
.lt-text { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font-size: 15px; min-height: 1.5em; }
.lt-text.placeholder { color: #94A3B8; }

.lt-bar { height: 6px; margin-top: 12px; border-radius: 999px; background: #E2E8F0; overflow: hidden; }
.lt-bar > i { display: block; height: 100%; width: 0; background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%); border-radius: 999px; transition: width 250ms ease; }

.lt-status { margin: 12px 0 0; font-size: 12px; color: #64748B; min-height: 1em; }
.lt-status.error { color: #DC2626; }
.lt-status.ok { color: #059669; }

/* 就地译文条：输入框已有草稿时的紧凑形态，替代完整面板 */
.lt-card.lt-inline { width: auto; max-width: min(420px, calc(100vw - 32px)); padding: 12px 14px; }
.lt-inline-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 6px; }
.lt-inline-lang { font-size: 12px; font-weight: 700; color: #0284C7; letter-spacing: .3px; }
.lt-card.lt-inline .lt-result { margin: 2px 0 0; font-size: 14px; }
.lt-card.lt-inline .lt-actions { margin-top: 10px; align-items: center; }
.lt-card.lt-inline .lt-bar { margin-top: 8px; }
.lt-card.lt-inline .lt-status { margin: 8px 0 0; }
.lt-inline-more {
  border: 0;
  background: none;
  padding: 0;
  color: #0284C7;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-left: auto;
}
.lt-inline-more:hover { text-decoration: underline; }

.lt-float {
  position: fixed;
  z-index: 2147483647;
  border: 0;
  border-radius: 999px;
  padding: 9px 15px;
  background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%);
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 20px rgba(14, 165, 233, .35);
  cursor: pointer;
  transition: transform 150ms, box-shadow 150ms, filter 150ms;
}
.lt-float:hover { transform: translateY(-1px); filter: brightness(1.05); }
.lt-float:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(14, 165, 233, .3); }

/* 悬停阅读：段落右上角的「译」按钮 */
.lt-hover-pill {
  position: fixed;
  z-index: 2147483647;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%);
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 3px 12px rgba(14, 165, 233, .4);
  cursor: pointer;
  transition: transform 150ms, filter 150ms;
}
.lt-hover-pill:hover { transform: scale(1.1); filter: brightness(1.05); }

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
  background: linear-gradient(135deg, #38BDF8 0%, #14B8A6 100%);
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 6px 20px rgba(14, 165, 233, .35);
  cursor: pointer;
  transition: transform 150ms, box-shadow 150ms, filter 150ms;
}
.lt-bubble:hover { transform: translateY(-1px); filter: brightness(1.05); }
.lt-bubble:active { transform: translateY(0); box-shadow: 0 2px 8px rgba(14, 165, 233, .3); }

@media (prefers-reduced-motion: reduce) {
  .lt-card { animation: none; }
  .lt-card *, .lt-float, .lt-hover-pill, .lt-button, .lt-bubble { transition: none !important; }
}

@media (prefers-color-scheme: dark) {
  .lt-card { background: #1E293B; border-color: #334155; color: #E2E8F0;
             box-shadow: 0 4px 14px rgba(0, 0, 0, .45), 0 12px 36px rgba(0, 0, 0, .5); }
  .lt-sub, .lt-label, .lt-status { color: #94A3B8; }
  .lt-note { background: rgba(245, 158, 11, .16); color: #FCD34D; }
  .lt-field { color: #94A3B8; }
  .lt-field > textarea { background: #0F172A; color: #E2E8F0; border-color: #334155; }
  .lt-field > textarea:focus { border-color: #38BDF8; box-shadow: 0 0 0 3px rgba(56, 189, 248, .15); }
  .lt-field > textarea[readonly] { background: #28374E; color: #CBD5E1; }
  .lt-langbar select { color: #7DD3FC; }
  .lt-langbar select:hover, .lt-swap:hover, .lt-close:hover { background: #28374E; }
  .lt-swap { color: #94A3B8; }
  .lt-close { color: #94A3B8; }
  .lt-close:hover { color: #E2E8F0; }
  .lt-output { background: rgba(56, 189, 248, .13); }
  .lt-label { color: #7DD3FC; }
  .lt-text.placeholder { color: #64748B; }
  .lt-bar { background: #334155; }
  .lt-button.ghost { background: #28374E; color: #E2E8F0; border-color: #334155; }
  .lt-button.ghost:hover:not(:disabled) { background: #334155; }
  .lt-status.error { color: #F87171; }
  .lt-status.ok { color: #34D399; }
  .lt-inline-lang, .lt-inline-more { color: #7DD3FC; }
}
`;
