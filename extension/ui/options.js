const directions = [['en','zh','英语 → 中文'],['zh','en','中文 → 英语'],['ja','zh','日语 → 中文'],['zh','ja','中文 → 日语'],['ko','zh','韩语 → 中文'],['zh','ko','中文 → 韩语'],['es','zh','西班牙语 → 中文'],['fr','zh','法语 → 中文']];
const root = document.querySelector('#directions');
const status = document.querySelector('#status');
function render(installed) {
  root.replaceChildren(...directions.map(([from, to, label]) => {
    const direction = `${from}-${to}`;
    const row = document.createElement('div');
    row.className = 'direction';
    const text = document.createElement('span'); text.textContent = label;
    const button = document.createElement('button'); button.textContent = installed.includes(direction) ? '已选择' : '选择'; button.className = installed.includes(direction) ? 'installed' : '';
    button.onclick = async () => {
      if (installed.includes(direction)) return;
      const response = await chrome.runtime.sendMessage({ type: 'SET_LANGUAGE_DIRECTION', direction });
      render(response.installedDirections);
      status.textContent = '已记录选择。模型下载将在翻译运行时接入后启用。';
    };
    row.append(text, button); return row;
  }));
}
chrome.storage.local.get({ installedDirections: [] }).then(({ installedDirections }) => render(installedDirections));
