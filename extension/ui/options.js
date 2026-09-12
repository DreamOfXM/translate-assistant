const directions = [['zh','en','中文 → 英语'],['en','zh','英语 → 中文'],['zh','ja','中文 → 日语'],['ja','zh','日语 → 中文'],['zh','ko','中文 → 韩语'],['ko','zh','韩语 → 中文'],['zh','fr','中文 → 法语'],['fr','zh','法语 → 中文'],['zh','de','中文 → 德语'],['de','zh','德语 → 中文'],['zh','es','中文 → 西班牙语'],['es','zh','西班牙语 → 中文'],['zh','it','中文 → 意大利语'],['it','zh','意大利语 → 中文'],['zh','pt','中文 → 葡萄牙语'],['pt','zh','葡萄牙语 → 中文'],['zh','ru','中文 → 俄语'],['ru','zh','俄语 → 中文']];
const root = document.querySelector('#directions');
const status = document.querySelector('#status');
let downloaded = [];
function render() {
  root.replaceChildren(...directions.map(([from, to, label]) => {
    const direction = `${from}-${to}`;
    const row = document.createElement('div'); row.className = 'direction';
    const text = document.createElement('span'); text.innerHTML = `<strong>${label}</strong><small>${downloaded.includes(direction) ? '已下载，可离线使用' : '未下载，首次使用时下载'}</small>`;
    const button = document.createElement('button'); button.textContent = downloaded.includes(direction) ? '删除' : '下载'; button.className = downloaded.includes(direction) ? 'installed' : '';
    button.onclick = async () => {
      button.disabled = true; status.textContent = downloaded.includes(direction) ? '正在删除语言包…' : '正在下载并校验语言包，首次可能需要一些时间…';
      const response = await chrome.runtime.sendMessage({ type: downloaded.includes(direction) ? 'DELETE_DIRECTION' : 'PRELOAD_DIRECTION', direction });
      if (response.error) status.textContent = `操作失败：${response.error}`;
      else { downloaded = downloaded.includes(direction) ? downloaded.filter(item => item !== direction) : [...downloaded, direction]; status.textContent = downloaded.includes(direction) ? '语言包已下载，可离线使用。' : '语言包已删除。'; render(); }
      button.disabled = false;
    };
    row.append(text, button); return row;
  }));
}
chrome.runtime.sendMessage({ type: 'GET_DIRECTION_STATUS' }).then(response => { downloaded = response.downloaded ?? []; render(); });
