// 欢迎页：唯一动作是引导去装语言包；「开始使用」直接关掉这一页。
document.getElementById('install-pack').onclick = () => chrome.runtime.openOptionsPage();
document.getElementById('close').onclick = () => window.close();
