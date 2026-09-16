import { initI18n, applyI18n, setUiLang, uiLang } from '../lib/i18n.js';

// 欢迎页：唯一动作是引导去装语言包；「开始使用」直接关掉这一页。
document.getElementById('install-pack').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('close').onclick = () => window.close();

// 语言选择：点即切换并持久化，整页文案立即重画
initI18n().then(() => {
  applyI18n(document);
  const lang = uiLang();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
    btn.onclick = () => {
      setUiLang(btn.dataset.lang);
      applyI18n(document);
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.toggle('active', b === btn));
    };
  });
});
