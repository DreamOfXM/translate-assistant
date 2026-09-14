/**
 * 注入面板的样式。
 *
 * 面板挂在 Shadow DOM 里，避免被宿主网页的 CSS 影响（反之亦然），
 * 所以样式以字符串形式内联，不走 manifest 的 content.css。
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
  padding: 16px;
  border: 1px solid #dadce0;
  border-radius: 16px;
  background: #fff;
  color: #202124;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 12px 40px rgba(0,0,0,.22);
}
.lt-card * { box-sizing: border-box; font-family: inherit; }

.lt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
.lt-title { font-size: 15px; font-weight: 600; margin: 0; }
.lt-sub { margin: 2px 0 0; font-size: 12px; color: #5f6368; }
.lt-close { border: 0; background: transparent; font-size: 20px; line-height: 1; color: #5f6368; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.lt-close:hover { background: #f1f3f4; }

.lt-note { margin: 0 0 12px; padding: 8px 10px; border-radius: 8px; background: #f1f3f4; font-size: 12px; color: #3c4043; }

.lt-field { display: block; margin-bottom: 10px; font-size: 12px; font-weight: 600; color: #5f6368; }
.lt-field > textarea {
  display: block;
  width: 100%;
  margin-top: 5px;
  padding: 9px 10px;
  border: 1px solid #dadce0;
  border-radius: 9px;
  background: #fff;
  color: #202124;
  font-size: 14px;
  font-weight: 400;
  min-height: 92px;
  resize: vertical;
}
.lt-field > textarea:focus { outline: 2px solid #1a73e8; outline-offset: -1px; border-color: #1a73e8; }
.lt-field > textarea[readonly] { background: #f8f9fa; color: #3c4043; }

/* 语言条：平时就是一行文字（自动检测 · 英语 → 中文），点开才需要选 */
.lt-langbar { display: flex; align-items: center; gap: 2px; margin: 0 0 12px; }
.lt-langbar select {
  appearance: none;
  -webkit-appearance: none;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #1a73e8;
  font-size: 13px;
  font-weight: 600;
  padding: 5px 6px;
  cursor: pointer;
  max-width: 170px;
  text-overflow: ellipsis;
}
.lt-langbar select:hover { background: #f1f3f4; }
.lt-langbar select:focus-visible { outline: 2px solid #1a73e8; }
.lt-arrow { padding: 0 2px; color: #9aa0a6; font-size: 13px; }
.lt-swap {
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #5f6368;
  font-size: 14px;
  line-height: 1;
  padding: 5px 7px;
  cursor: pointer;
}
.lt-swap:hover { background: #f1f3f4; color: #1a73e8; }

.lt-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.lt-button {
  padding: 9px 14px;
  border: 0;
  border-radius: 8px;
  background: #1a73e8;
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.lt-button:hover:not(:disabled) { background: #1765cc; }
.lt-button:disabled { opacity: .45; cursor: not-allowed; }
.lt-button.ghost { background: #f1f3f4; color: #202124; }
.lt-button.ghost:hover:not(:disabled) { background: #e8eaed; }
.lt-button.primary-fill { background: #188038; }
.lt-button.primary-fill:hover:not(:disabled) { background: #146c2e; }

.lt-output { margin-top: 14px; padding: 12px; border-radius: 10px; background: #f8f9fa; }
.lt-label { font-size: 12px; font-weight: 600; color: #5f6368; }
.lt-text { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font-size: 15px; min-height: 1.5em; }
.lt-text.placeholder { color: #9aa0a6; }

.lt-bar { height: 6px; margin-top: 12px; border-radius: 999px; background: #e8eaed; overflow: hidden; }
.lt-bar > i { display: block; height: 100%; width: 0; background: #1a73e8; border-radius: 999px; transition: width .2s ease; }

.lt-status { margin: 12px 0 0; font-size: 12px; color: #5f6368; min-height: 1em; }
.lt-status.error { color: #b3261e; }
.lt-status.ok { color: #188038; }

.lt-float {
  position: fixed;
  z-index: 2147483647;
  border: 0;
  border-radius: 999px;
  padding: 8px 14px;
  background: #1a73e8;
  color: #fff;
  font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 14px rgba(0,0,0,.28);
  cursor: pointer;
}
.lt-float:hover { background: #1765cc; }

/* 悬停阅读：段落右上角的「译」按钮 */
.lt-hover-pill {
  position: fixed;
  z-index: 2147483647;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: #1a73e8;
  color: #fff;
  font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  box-shadow: 0 3px 10px rgba(0,0,0,.28);
  cursor: pointer;
}
.lt-hover-pill:hover { background: #1765cc; }

@media (prefers-color-scheme: dark) {
  .lt-card { background: #292a2d; border-color: #3c4043; color: #e8eaed; }
  .lt-sub, .lt-label, .lt-status { color: #9aa0a6; }
  .lt-note { background: #35363a; color: #e8eaed; }
  .lt-field { color: #9aa0a6; }
  .lt-field > textarea { background: #202124; color: #e8eaed; border-color: #3c4043; }
  .lt-field > textarea[readonly] { background: #35363a; color: #e8eaed; }
  .lt-langbar select { color: #8ab4f8; }
  .lt-langbar select:hover, .lt-swap:hover { background: #35363a; }
  .lt-swap { color: #9aa0a6; }
  .lt-output { background: #35363a; }
  .lt-text.placeholder { color: #80868b; }
  .lt-bar { background: #3c4043; }
  .lt-close { color: #9aa0a6; }
  .lt-close:hover { background: #35363a; }
  .lt-hover-pill { background: #8ab4f8; color: #202124; }
  .lt-hover-pill:hover { background: #aecbfa; }
  .lt-button.ghost { background: #3c4043; color: #e8eaed; }
  .lt-status.error { color: #f28b82; }
  .lt-status.ok { color: #81c995; }
}
`;
