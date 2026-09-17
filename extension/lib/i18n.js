/**
 * 轻量 UI i18n：中 / 英两套文案，运行时可切换（Chrome 自带的 _locales 做不到）。
 *
 * - 语言存 chrome.storage.local 的 uiLang；未设置时跟随浏览器 UI 语言
 *   （zh 开头 → 中文，其余 → 英文）。
 * - 扩展页面（popup/options/welcome）在 HTML 上挂 data-i18n / data-i18n-placeholder /
 *   data-i18n-title，加载后 applyI18n(document) 一次性填充。
 * - content script 的动态文案直接调 t()；初始化是异步的，UI 创建前先 await ready()。
 */

const STORAGE_KEY = 'uiLang';

const ZH = {
  app_name: '翻译助手',
  badge: '本地 · 离线',
  // popup
  placeholder: '把要翻译的内容粘进来…',
  translate: '翻译',
  copy: '复制',
  copied: '已复制 ✓',
  output_label: '译文',
  output_label_named: '译文 · {name}',
  output_placeholder: '译文会出现在这里。',
  onboard_title: '先装语言包，才能开始翻译',
  onboard_sub: '首次下载约 40 MB，之后断网也能用',
  onboard_go: '去安装',
  toggle_auto: '整页双语对照',
  toggle_auto_sub: '打开网页自动逐段翻译，译文插在每段原文下面',
  toggle_page: '右下角悬浮按钮',
  toggle_page_sub: '手动点「双语对照」翻整页，或收起全部译文',
  toggle_hover: '悬停出「译」按钮',
  toggle_hover_sub: '鼠标停在段落上出现「译」，点一下翻那一段',
  packs_none: '尚未安装语言包',
  packs_count: '已安装 {n} 个语言包',
  packs_error: '语言包状态不可用',
  packs_manage: '语言包管理',
  status_empty: '先把要翻译的内容粘进来。',
  status_translating: '正在本地翻译…',
  status_done: '翻译完成。',
  status_done_segments: '已分 {n} 段翻译完成。',
  status_same_lang: '识别出的源语言和目标语言都是{name}，请换一个目标语言。',
  status_copied: '译文已复制。',
  status_copy_failed: '复制失败，请手动选择译文复制。',
  status_swapped: '已交换语言，可把译文改回原文再翻一次。',
  // options
  options_title: '语言包管理',
  options_lead: '翻译在你的浏览器里完成，不需要 API Key。首次使用某个方向会下载对应语言包，之后可离线使用。',
  options_source: '模型来源：',
  options_license: '许可证：',
  options_runtime: '运行时：',
  options_loading: '正在读取语言包状态…',
  options_refresh: '刷新',
  options_combos: '常用组合',
  options_combos_hint: 'Mozilla 只发布「各语言 ↔ 英语」的模型，所以中文 ↔ 日语这类方向会经英语中转，需要两个语言包。',
  options_all: '全部语言包',
  options_search_ph: '搜索语言，例如：日语 / ja / 韩',
  options_none_catalog: '暂时无法读取语言包目录。',
  options_none_match: '没有匹配的语言包。',
  options_ready_pair: '已就绪，可离线使用（{packs}）',
  options_needs: '需 {n} 个语言包：{packs} · 约 {size}',
  options_ready_pack: '已下载，可离线使用',
  options_estimate: '预计下载约 {size}',
  options_totals_none: '尚未安装语言包',
  options_totals: '已安装 {n} 个语言包',
  options_usage: '本地占用约 {size}',
  download_progress: '下载（{done}/{total}）',
  download: '下载',
  remove: '删除',
  status_downloading: '正在下载…',
  task_done: '{label}完成。',
  task_failed: '{label}失败：{msg}',
  status_removing: '正在删除语言包…',
  status_removed: '语言包已删除。',
  status_load_failed: '读取语言包状态失败：{msg}',
  ui_language: '界面语言',
  auto_detect: '自动检测',
  target_language: '目标语言',
  swap_languages: '交换语言',
  // welcome
  welcome_lead: '整个翻译在你的浏览器里完成——不需要 API Key，不上传任何文本，语言包装好后断网也能用。',
  step1_t: '安装语言包',
  step1_s: '第一次点「去安装」下载英→中语言包（约 40 MB），之后全部离线。',
  step2_t: '打开外文网页',
  step2_s: '整页双语对照默认开启：译文自动逐段插在原文下面，不用点任何按钮。',
  step3_t: '选中即译，中文写回复',
  step3_s: '选中外文点「翻译选中」出结果卡片；在评论框点「翻译回复」，用中文写草稿，确认后才填入。',
  privacy: '隐私承诺：网页文本、草稿、译文全部留在你的设备上，网络请求只有下载语言包本身。',
  cta_install: '安装语言包',
  cta_start: '开始使用',
  // content：选中文本卡片
  sel_title: '选中文本翻译',
  sel_sub: '本地运行 · 不上传 · 不修改页面',
  field_source: '原文',
  retranslate: '重新翻译',
  copy_translation: '复制译文',
  // content：回复面板与就地译文条
  float_reply: '翻译回复',
  float_select: '翻译选中',
  reply_title: '回复翻译助手',
  reply_sub: '本地处理 · 只在你确认后填入 · 不自动发布',
  reply_note: '用母语写下想表达的内容，确认译文后再手动填入。插件不会替你点击发送。',
  draft: '草稿',
  draft_ph: '例如：这个方案我觉得可行，但预算需要再确认一下。',
  generate: '生成译文',
  fill: '填入输入框',
  reply_status_has_draft: '确认草稿后点击「生成译文」。',
  reply_status_empty: '写下草稿后点击「生成译文」。',
  translating_pack: '正在本地翻译，首次使用需要下载语言包…',
  review_fill: '请检查译文，确认后再填入。',
  no_input: '当前没有绑定输入框，可复制译文使用。',
  filled: '已填入输入框。请自行检查后发布——插件不会替你发送。',
  fill_rejected: '这个编辑器不接受自动填入，请复制译文后手动粘贴。',
  input_gone: '原来的输入框已失效，请重新点击输入框上的「翻译回复」。',
  inline_retry: '重译',
  inline_more: '完整面板',
  inline_ready: '确认后点「填入输入框」。',
  inline_copy_hint: '可复制译文使用。',
  // content：整页双语对照
  bubble_idle: '双语对照',
  bubble_title: '逐段翻译正文，译文插在每段原文下面',
  bubble_progress: '翻译中 {done}/{total} · 点击停止',
  bubble_done: '已译 {n} 段 · 收起',
  bubble_nothing: '没有需要翻译的段落',
  bubble_tool: '工具页不自动翻译 · 点击翻正文',
  bubble_zh: '中文页面 · 无需翻译',
  bubble_pack: '缺语言包 · 点击翻译并下载',
  bubble_google: '首次使用需下载谷歌翻译模型 · 点击开始',
  bubble_site: '此站点不自动翻译 · 点击翻正文',
  para_translating: '翻译中…',
  para_copy: '复制',
  para_copied: '已复制',
  para_hide: '收起',
  para_failed: '翻译失败：{msg}',
  error_no_response: '翻译引擎没有响应。',
  status_result_segmented: '已分 {n} 段翻译完成。',
  status_result_done: '翻译完成。'
};

const EN = {
  app_name: 'Translate Assistant',
  badge: 'Local · Offline',
  placeholder: 'Paste text to translate…',
  translate: 'Translate',
  copy: 'Copy',
  copied: 'Copied ✓',
  output_label: 'Translation',
  output_label_named: 'Translation · {name}',
  output_placeholder: 'Translation will appear here.',
  onboard_title: 'Install a language pack to start',
  onboard_sub: 'About 40 MB once — works offline afterwards',
  onboard_go: 'Install',
  toggle_auto: 'Bilingual page',
  toggle_auto_sub: 'Translations appear under each paragraph as you browse',
  toggle_page: 'Floating button',
  toggle_page_sub: 'Translate the whole page manually, or collapse all translations',
  toggle_hover: 'Hover-to-translate pill',
  toggle_hover_sub: 'Hover over a paragraph and click the pill to translate it',
  packs_none: 'No language packs yet',
  packs_count: '{n} language packs installed',
  packs_error: 'Pack status unavailable',
  packs_manage: 'Manage packs',
  status_empty: 'Paste something to translate first.',
  status_translating: 'Translating locally…',
  status_done: 'Done.',
  status_done_segments: 'Done in {n} parts.',
  status_same_lang: 'Source and target are both {name} — pick another target.',
  status_copied: 'Translation copied.',
  status_copy_failed: 'Copy failed — select the text manually.',
  status_swapped: 'Swapped — translate back anytime.',
  options_title: 'Language Packs',
  options_lead: 'Translation runs in your browser — no API keys. The first time you use a direction its pack is downloaded, then it works offline.',
  options_source: 'Models: ',
  options_license: 'License: ',
  options_runtime: 'Runtime: ',
  options_loading: 'Loading pack status…',
  options_refresh: 'Refresh',
  options_combos: 'Common pairs',
  options_combos_hint: 'Mozilla only publishes X↔English models, so pairs like Chinese↔Japanese relay through English and need two packs.',
  options_all: 'All packs',
  options_search_ph: 'Search a language, e.g. Japanese / ja',
  options_none_catalog: "Couldn't load the pack catalog.",
  options_none_match: 'No matching packs.',
  options_ready_pair: 'Ready offline ({packs})',
  options_needs: 'Needs {n} packs: {packs} · about {size}',
  options_ready_pack: 'Downloaded — offline ready',
  options_estimate: 'About {size} to download',
  options_totals_none: 'No language packs installed',
  options_totals: '{n} packs installed',
  options_usage: 'about {size} used locally',
  download_progress: 'Download ({done}/{total})',
  download: 'Download',
  remove: 'Remove',
  status_downloading: 'Downloading…',
  task_done: '{label} done.',
  task_failed: '{label} failed: {msg}',
  status_removing: 'Removing pack…',
  status_removed: 'Pack removed.',
  status_load_failed: 'Failed to load status: {msg}',
  ui_language: 'UI language',
  auto_detect: 'Detect language',
  target_language: 'Target language',
  swap_languages: 'Swap languages',
  welcome_lead: 'Everything translates inside your browser — no API keys, no text uploaded, and it works offline once a pack is installed.',
  step1_t: 'Install a pack',
  step1_s: 'One click downloads the en→zh pack (about 40 MB); after that everything is offline.',
  step2_t: 'Open a foreign page',
  step2_s: 'Bilingual view is on by default — translations appear under each paragraph, zero clicks.',
  step3_t: 'Select to translate, reply in Chinese',
  step3_s: 'Select foreign text for a result card; in comment boxes hit "Translate reply", write in your language, and fill in after you confirm.',
  privacy: 'Privacy: page text, drafts and translations stay on your device — the only network traffic is the pack download itself.',
  cta_install: 'Install a pack',
  cta_start: 'Get started',
  sel_title: 'Translate selection',
  sel_sub: 'Local · nothing uploaded · the page is untouched',
  field_source: 'Source',
  retranslate: 'Re-translate',
  copy_translation: 'Copy',
  float_reply: 'Translate reply',
  float_select: 'Translate selection',
  reply_title: 'Reply Translator',
  reply_sub: 'Local · filled in only after you confirm · never auto-posts',
  reply_note: 'Write in your own language, confirm the translation, then fill it in yourself. The extension never clicks send.',
  draft: 'Draft',
  draft_ph: 'e.g. Sounds good, but the budget needs another look.',
  generate: 'Translate',
  fill: 'Fill in',
  reply_status_has_draft: 'Review the draft, then hit "Translate".',
  reply_status_empty: 'Write a draft, then hit "Translate".',
  translating_pack: 'Translating locally — the first use downloads a pack…',
  review_fill: 'Review it, then fill in.',
  no_input: 'No input bound — copy the translation instead.',
  filled: 'Filled in. Review before posting — the extension never clicks send.',
  fill_rejected: 'This editor rejects programmatic input — copy and paste instead.',
  input_gone: 'The input went stale — click "Translate reply" on it again.',
  inline_retry: 'Retry',
  inline_more: 'Full panel',
  inline_ready: 'Review it, then hit "Fill in".',
  inline_copy_hint: 'Copy the translation instead.',
  bubble_idle: 'Bilingual',
  bubble_title: 'Translate the page paragraph by paragraph',
  bubble_progress: 'Translating {done}/{total} · click to stop',
  bubble_done: '{n} translated · collapse',
  bubble_nothing: 'Nothing to translate',
  bubble_tool: 'Tool page — click to translate',
  bubble_zh: 'Chinese page — nothing to translate',
  bubble_pack: 'Missing pack — click to translate & download',
  bubble_google: 'First use downloads the Google model — click to start',
  bubble_site: 'Not auto-translated here — click to translate',
  para_translating: 'Translating…',
  para_copy: 'Copy',
  para_copied: 'Copied',
  para_hide: 'Collapse',
  para_failed: 'Failed: {msg}',
  error_no_response: 'The translation engine did not respond.',
  status_result_segmented: 'Done in {n} parts.',
  status_result_done: 'Done.'
};

const DICT = { zh: ZH, en: EN };

let currentLang = null;   // 初始化后才有值；t() 在此之前回落中文

/** 浏览器 UI 语言 → 支持的语言 */
function detectLang() {
  const ui = (globalThis.navigator?.language ?? (globalThis.chrome?.i18n?.getUILanguage?.() ?? 'zh')).toLowerCase();
  return ui.startsWith('zh') ? 'zh' : 'en';
}

/** 初始化：读用户设置，没有则跟随浏览器语言。重复调用无副作用。 */
export function initI18n() {
  if (currentLang) return Promise.resolve(currentLang);
  try {
    return chrome.storage.local.get(STORAGE_KEY)
      .then(stored => {
        const saved = stored?.[STORAGE_KEY];
        currentLang = saved === 'en' || saved === 'zh' ? saved : detectLang();
        return currentLang;
      })
      .catch(() => { currentLang = detectLang(); return currentLang; });
  } catch {
    currentLang = detectLang();
    return Promise.resolve(currentLang);
  }
}

/** 当前界面语言；initI18n 之前调用返回 zh 兜底 */
export function uiLang() {
  return currentLang ?? 'zh';
}

/** 切换界面语言并持久化；传 '' 表示清除设置、跟随浏览器语言（页面切换后需刷新） */
export function setUiLang(lang) {
  try {
    if (lang === 'en' || lang === 'zh') {
      currentLang = lang;
      chrome.storage.local.set({ [STORAGE_KEY]: currentLang });
    } else {
      currentLang = detectLang();
      chrome.storage.local.remove(STORAGE_KEY);
    }
  } catch { /* 测试环境静默 */ }
  return currentLang;
}

/** 取文案：t('bubble_done', { n: 3 })；缺失 key 回落中文，再缺失回退 key 本身 */
export function t(key, params) {
  const text = DICT[uiLang()][key] ?? ZH[key] ?? key;
  if (!params) return text;
  return Object.entries(params).reduce(
    (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
    text
  );
}

/** 扫描并填充页面上的 i18n 标记：data-i18n（textContent）、data-i18n-placeholder、data-i18n-title */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(node => { node.placeholder = t(node.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach(node => { node.title = t(node.dataset.i18nTitle); });
}
