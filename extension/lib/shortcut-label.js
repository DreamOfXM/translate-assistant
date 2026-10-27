/**
 * Chrome commands 快捷键绑定串 → 适合展示的标签。
 *
 * chrome.commands.getAll() 返回的是用户配置里的实际绑定（含用户改过的、
 * 首装定格的旧值、空值），mac 上形如 "Command+Shift+U"，其余平台形如
 * "Ctrl+Shift+U" / "Alt+C"。展示时 mac 组合用系统符号（⇧⌘U），其他平台原样。
 */

const MAC_SYMBOLS = { command: '⌘', macctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };

/** 修饰键按 Apple HIG 的显示顺序 */
const MAC_ORDER = ['⌃', '⌥', '⇧', '⌘'];

export function formatShortcut(shortcut) {
  const parts = String(shortcut ?? '').split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = (parts.pop() ?? '').toUpperCase();
  const mods = parts.map(p => MAC_SYMBOLS[p.toLowerCase()] ?? p);
  if (!mods.length) return key;                       // 单键
  const looksMac = parts.some(p => /^(command|macctrl)$/i.test(p));
  if (!looksMac) return [...parts, key].join('+');    // win/linux 绑定原样展示
  mods.sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  return [...mods, key].join('');
}
