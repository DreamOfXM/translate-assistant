(() => {
  let panel;
  let activeInput;
  let lastTranslation;
  const languages = [['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['it', '意大利语'], ['pt', '葡萄牙语'], ['ru', '俄语']];

  const escape = value => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const options = selected => languages.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
  const removePanel = () => { panel?.remove(); panel = undefined; activeInput = undefined; lastTranslation = undefined; };

  function readInput(element) { return element.isContentEditable ? element.innerText : element.value; }

  function fillInput(element, text) {
    element.focus();
    if (element.isContentEditable) {
      document.execCommand('insertText', false, text);
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(element, text); else element.value = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function openPanel({ text = '', input = null } = {}) {
    removePanel();
    activeInput = input;
    panel = document.createElement('aside');
    panel.className = 'lt-panel';
    panel.innerHTML = `<header><div><strong>回复翻译助手</strong><span>本地处理 · 不自动发布</span></div><button class="lt-icon">×</button></header><div class="lt-context">目标语言由你选择；建议先阅读上下文，再确认译文。</div><label>你的草稿（中文）<textarea class="lt-draft" placeholder="输入你想表达的内容">${escape(text)}</textarea></label><div class="lt-row"><label>从<select class="lt-from"><option value="zh" selected>中文</option></select></label><span>→</span><label>翻译成<select class="lt-to">${options(input ? 'en' : 'zh')}</select></label></div><div class="lt-actions"><button class="lt-translate">生成译文</button><button class="lt-fill" disabled>填入评论框</button></div><section class="lt-output" hidden><div class="lt-output-title">译文预览</div><div class="lt-translation"></div><div class="lt-back-title">回译校对（中文）</div><div class="lt-backtranslation">尚未回译</div></section><div class="lt-status">首次使用某个语言方向会下载语言包，之后可离线使用。</div>`;
    document.body.append(panel);

    panel.querySelector('.lt-icon').onclick = removePanel;
    panel.querySelector('.lt-translate').onclick = async () => {
      const draft = panel.querySelector('.lt-draft').value.trim();
      const to = panel.querySelector('.lt-to').value;
      const output = panel.querySelector('.lt-output');
      const status = panel.querySelector('.lt-status');
      if (!draft) { status.textContent = '先输入想表达的内容。'; return; }
      status.textContent = '正在本地翻译，首次使用可能需要下载语言包…';
      panel.querySelector('.lt-translate').disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text: draft, source: 'zh', target: to });
        if (response.error) throw new Error(response.error);
        lastTranslation = response.text;
        panel.querySelector('.lt-translation').textContent = response.text;
        panel.querySelector('.lt-backtranslation').textContent = '回译校对将在下一步启用；请先检查译文。';
        output.hidden = false;
        panel.querySelector('.lt-fill').disabled = !activeInput;
        status.textContent = activeInput ? '请检查译文，确认后再填入评论框。' : '当前没有绑定评论框，可复制译文。';
      } catch (error) { status.textContent = `翻译失败：${error.message}`; }
      panel.querySelector('.lt-translate').disabled = false;
    };
    panel.querySelector('.lt-fill').onclick = () => { if (activeInput && lastTranslation) { fillInput(activeInput, lastTranslation); panel.querySelector('.lt-status').textContent = '已填入评论框，请自行检查并发布。'; } };
  }

  function addInputButton(element) {
    if (element.dataset.ltBound) return;
    element.dataset.ltBound = '1';
    const button = document.createElement('button');
    button.className = 'lt-input-button';
    button.textContent = '翻译回复';
    button.type = 'button';
    document.body.append(button);
    const position = () => { const rect = element.getBoundingClientRect(); button.style.left = `${Math.max(8, rect.right - 92 + scrollX)}px`; button.style.top = `${Math.max(8, rect.top - 34 + scrollY)}px`; };
    position();
    button.onclick = () => openPanel({ text: readInput(element), input: element });
    const remove = () => { button.remove(); element.removeEventListener('scroll', position); };
    element.addEventListener('blur', () => setTimeout(() => { if (!panel?.contains(document.activeElement)) remove(); }, 250), { once: true });
    addEventListener('scroll', position, { passive: true });
  }

  document.addEventListener('focusin', event => {
    const element = event.target;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable) addInputButton(element);
  });
  document.addEventListener('mouseup', () => {
    const selection = window.getSelection()?.toString().trim();
    if (!selection || panel) return;
    const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const button = document.createElement('button');
    button.className = 'lt-selection-button'; button.textContent = '翻译选中';
    button.style.left = `${Math.max(8, rect.left)}px`; button.style.top = `${Math.max(8, rect.top - 38)}px`;
    button.onclick = () => { button.remove(); openPanel({ text: selection }); };
    document.body.append(button); setTimeout(() => button.remove(), 3500);
  });
  chrome.runtime.onMessage.addListener(message => { if (message.type === 'SHOW_TRANSLATOR') openPanel({ text: message.text }); });
})();
