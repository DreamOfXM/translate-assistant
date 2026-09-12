(() => {
  let card;
  let activeInput;

  const languages = [
    ['auto', '自动检测'],
    ['zh', '中文'],
    ['en', '英语'],
    ['ja', '日语'],
    ['ko', '韩语'],
    ['es', '西班牙语'],
    ['fr', '法语'],
    ['de', '德语'],
    ['it', '意大利语'],
    ['pt', '葡萄牙语'],
    ['ru', '俄语']
  ];

  function removeCard() {
    card?.remove();
    card = undefined;
  }

  function getInputText(element) {
    return element.isContentEditable ? element.innerText : element.value;
  }

  function setInputText(element, text) {
    if (element.isContentEditable) {
      element.focus();
      document.execCommand('insertText', false, text);
      return;
    }
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
    if (setter) setter.call(element, text); else element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function selectOptions(selected) {
    return languages.map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
  }

  function showCard({ text = '', x = 16, y = 16, input = null } = {}) {
    removeCard();
    activeInput = input;
    card = document.createElement('section');
    card.className = 'lt-card';
    card.style.left = `${Math.max(12, Math.min(x, innerWidth - 400))}px`;
    card.style.top = `${Math.max(12, Math.min(y, innerHeight - 240))}px`;
    card.innerHTML = `<div><strong>本地翻译</strong></div><div class="lt-muted">文字只在浏览器本地处理</div><textarea class="lt-source" placeholder="输入要翻译的内容">${text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</textarea><select class="lt-source-language">${selectOptions(input ? 'zh' : 'auto')}</select><select class="lt-target">${selectOptions(input ? 'en' : 'zh')}</select><div><button class="lt-translate">翻译</button><button class="lt-fill lt-secondary" ${input ? '' : 'hidden'}>填入输入框</button><button class="lt-close lt-secondary">关闭</button></div><div class="lt-result" hidden></div>`;
    document.body.append(card);

    card.querySelector('.lt-close').onclick = removeCard;
    card.querySelector('.lt-translate').onclick = async () => {
      const result = card.querySelector('.lt-result');
      result.hidden = false;
      result.textContent = '翻译中…';
      try {
        const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE', text: card.querySelector('textarea').value, source: card.querySelector('.lt-source-language').value, target: card.querySelector('.lt-target').value });
        if (response.error) throw new Error(response.error);
        result.textContent = response.text;
        card.dataset.translation = response.text;
      } catch (error) {
        result.textContent = `翻译失败：${error.message}`;
      }
    };
    card.querySelector('.lt-fill').onclick = () => {
      if (activeInput && card.dataset.translation) setInputText(activeInput, card.dataset.translation);
    };
  }

  document.addEventListener('mouseup', () => {
    const selection = window.getSelection()?.toString().trim();
    if (!selection || card?.contains(document.activeElement)) return;
    const range = window.getSelection().getRangeAt(0).getBoundingClientRect();
    const button = document.createElement('button');
    button.className = 'lt-floating-button';
    button.textContent = '翻译';
    button.style.left = `${Math.max(8, range.left)}px`;
    button.style.top = `${Math.max(8, range.top - 40)}px`;
    button.onclick = () => { button.remove(); showCard({ text: selection, x: range.left, y: range.bottom + 8 }); };
    document.body.append(button);
    setTimeout(() => button.remove(), 4000);
  });

  document.addEventListener('focusin', (event) => {
    const element = event.target;
    if (!(element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement || element.isContentEditable)) return;
    if (element.dataset.ltBound) return;
    element.dataset.ltBound = '1';
    const button = document.createElement('button');
    button.className = 'lt-floating-button';
    button.textContent = '翻译回复';
    button.style.position = 'absolute';
    const rect = element.getBoundingClientRect();
    button.style.left = `${scrollX + rect.right - 88}px`;
    button.style.top = `${scrollY + rect.top - 36}px`;
    button.onclick = () => showCard({ text: getInputText(element), x: rect.left, y: rect.bottom + 8, input: element });
    document.body.append(button);
    element.addEventListener('blur', () => setTimeout(() => button.remove(), 300), { once: true });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'SHOW_TRANSLATOR') showCard(message);
  });
})();
