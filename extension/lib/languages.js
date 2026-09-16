/**
 * 语言元数据与轻量语言识别。
 * 纯函数、不依赖任何 Chrome API，以便 content script、扩展页面和 Node 单元测试共用。
 */

/** @type {Record<string, string>} 语言代码 → 中文名称（覆盖 Mozilla 模型目录中的全部语言） */
export const LANGUAGE_NAMES = {
  af: '南非荷兰语', ar: '阿拉伯语', az: '阿塞拜疆语', be: '白俄罗斯语', bg: '保加利亚语',
  bn: '孟加拉语', bs: '波斯尼亚语', ca: '加泰罗尼亚语', cs: '捷克语', da: '丹麦语',
  de: '德语', el: '希腊语', en: '英语', es: '西班牙语', et: '爱沙尼亚语', eu: '巴斯克语',
  fa: '波斯语', fi: '芬兰语', fr: '法语', gl: '加利西亚语', gu: '古吉拉特语',
  hbs: '塞尔维亚-克罗地亚语', he: '希伯来语', hi: '印地语', hr: '克罗地亚语', hu: '匈牙利语',
  id: '印尼语', is: '冰岛语', it: '意大利语', ja: '日语', kn: '卡纳达语', ko: '韩语',
  lt: '立陶宛语', lv: '拉脱维亚语', ml: '马拉雅拉姆语', mr: '马拉地语', ms: '马来语',
  nb: '挪威语（博克莫尔）', nl: '荷兰语', nn: '挪威语（尼诺斯克）', no: '挪威语', pl: '波兰语',
  pt: '葡萄牙语', ro: '罗马尼亚语', ru: '俄语', sk: '斯洛伐克语', sl: '斯洛文尼亚语',
  sq: '阿尔巴尼亚语', sr: '塞尔维亚语', sv: '瑞典语', ta: '泰米尔语', te: '泰卢固语',
  th: '泰语', tr: '土耳其语', ug: '维吾尔语', uk: '乌克兰语', ur: '乌尔都语',
  vi: '越南语', zh: '中文（简体）', zh_hant: '中文（繁体）'
};

/** @type {Record<string, string>} 语言代码 → 英文名称（与 LANGUAGE_NAMES 一一对应） */
export const LANGUAGE_NAMES_EN = {
  af: 'Afrikaans', ar: 'Arabic', az: 'Azerbaijani', be: 'Belarusian', bg: 'Bulgarian',
  bn: 'Bengali', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', da: 'Danish',
  de: 'German', el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', eu: 'Basque',
  fa: 'Persian', fi: 'Finnish', fr: 'French', gl: 'Galician', gu: 'Gujarati',
  hbs: 'Serbo-Croatian', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', kn: 'Kannada', ko: 'Korean',
  lt: 'Lithuanian', lv: 'Latvian', ml: 'Malayalam', mr: 'Marathi', ms: 'Malay',
  nb: 'Norwegian Bokmål', nl: 'Dutch', nn: 'Norwegian Nynorsk', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian',
  sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', ta: 'Tamil', te: 'Telugu',
  th: 'Thai', tr: 'Turkish', ug: 'Uyghur', uk: 'Ukrainian', ur: 'Urdu',
  vi: 'Vietnamese', zh: 'Chinese (Simplified)', zh_hant: 'Chinese (Traditional)'
};

/** 默认在语言包管理页面置顶展示的常用方向 */
export const RECOMMENDED_PAIRS = [
  ['en', 'zh'], ['zh', 'en'], ['ja', 'zh'], ['zh', 'ja'], ['ko', 'zh'], ['zh', 'ko'],
  ['fr', 'zh'], ['zh', 'fr'], ['de', 'zh'], ['zh', 'de'], ['es', 'zh'], ['zh', 'es'],
  ['ru', 'zh'], ['zh', 'ru'], ['en', 'ja'], ['ja', 'en'], ['en', 'ko'], ['ko', 'en'],
  ['en', 'fr'], ['fr', 'en'], ['en', 'de'], ['de', 'en'], ['en', 'es'], ['es', 'en'],
  ['en', 'ru'], ['ru', 'en']
];

/** 界面里置顶的常用语言，其余语言排在后面 */
export const COMMON_LANGUAGE_CODES = [
  'zh', 'zh_hant', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt',
  'it', 'nl', 'ar', 'hi', 'id', 'vi', 'th', 'tr', 'uk', 'pl', 'sv', 'ms', 'he', 'fa'
];

/** 识别不到源语言时的兜底值 */
export const FALLBACK_LANGUAGE = 'en';

/** 界面默认目标语言 */
export const DEFAULT_TARGET_LANGUAGE = 'zh';

/** 源语言「自动检测」的取值 */
export const AUTO_DETECT = 'auto';

/**
 * 语言选择框的顺序：常用语言在前，其余按名称排序。
 */
export function orderedLanguageCodes() {
  const rest = Object.keys(LANGUAGE_NAMES)
    .filter(code => !COMMON_LANGUAGE_CODES.includes(code))
    .sort((a, b) => languageName(a).localeCompare(languageName(b), 'zh-Hans-CN'));
  return [...COMMON_LANGUAGE_CODES.filter(isKnownLanguage), ...rest];
}

/** 语言显示名：lang='en' 返回英文名，默认中文名（英文表缺失时回落代码） */
export function languageName(code, lang = 'zh') {
  if (lang === 'en') return LANGUAGE_NAMES_EN[code] ?? code;
  return LANGUAGE_NAMES[code] ?? code;
}

export function isKnownLanguage(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, code);
}

/**
 * 脚本区间表：语言代码 → 该脚本占用的 Unicode 区间。区间互不重叠，且全部落在 BMP 内。
 * 数组顺序就是判定优先级：假名必须先于汉字，否则日语会被误判成中文；
 * 汉字先于其余脚本，其余脚本按原来的先后顺序排列。
 */
const SCRIPT_RANGES = [
  ['ja', [[0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff]]],
  ['ko', [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]]],
  ['zh', [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]],
  ['ru', [[0x0400, 0x04ff]]],
  ['th', [[0x0e00, 0x0e7f]]],
  ['ar', [[0x0600, 0x06ff], [0x0750, 0x077f]]],
  ['he', [[0x0590, 0x05ff]]],
  ['hi', [[0x0900, 0x097f]]],
  ['el', [[0x0370, 0x03ff]]]
];

const scriptIndexOf = code => SCRIPT_RANGES.findIndex(([item]) => item === code);
const KANA_INDEX = scriptIndexOf('ja');
const HANGUL_INDEX = scriptIndexOf('ko');
const KANJI_INDEX = scriptIndexOf('zh');

/**
 * 码位 → 脚本序号（1 起，0 表示不属于任何已登记脚本）的直查表。
 *
 * 用 64KB 常驻内存换掉「每个脚本各扫一遍样本」：识别函数在整页扫描时每段都要调一次，
 * 悬停时还会反复调，逐区间比对会把成本放大成 字符数 × 区间数（2000 字符样本约 2.4 万次
 * 迭代，且每次迭代都要新建一个单字符字符串）。查表后每个字符只做一次下标读取。
 *
 * 表只覆盖 BMP。增补平面字符（emoji、CJK 扩展 B 等）由高低代理项组成，两个代理项都落在
 * 0xD800–0xDFFF，不在任何登记区间内，因此按 UTF-16 单元遍历与原来按码位遍历的计数结果一致。
 */
const SCRIPT_BUCKET = new Uint8Array(0x10000);
SCRIPT_RANGES.forEach(([, ranges], index) => {
  for (const [start, end] of ranges) SCRIPT_BUCKET.fill(index + 1, start, end + 1);
});

/** 拉丁字母计数在 countScripts 返回值里占用的槽位（紧跟在各脚本之后） */
const LATIN_INDEX = SCRIPT_RANGES.length;

/** 假名在直查表里的桶号（桶号从 1 起，0 表示不属于任何已登记脚本） */
const KANA_BUCKET = KANA_INDEX + 1;

/**
 * 单趟遍历样本，同时累加各脚本的命中字符数和拉丁字母数。
 *
 * 命中假名时立即返回 null：假名的优先级高于其它所有脚本，出现一个就足以定论为日语，
 * 剩下的样本不必再数。返回 null 而不是填了一半的计数数组，是为了让调用方无法误用
 * 那些不完整的计数——拿到 null 就只能返回 'ja'。
 *
 * @param {string} sample
 * @returns {Uint32Array|null} 下标 0..SCRIPT_RANGES.length-1 对应各脚本，
 *   LATIN_INDEX 对应拉丁字母；样本里出现假名时返回 null
 */
function countScripts(sample) {
  const counts = new Uint32Array(LATIN_INDEX + 1);
  for (let index = 0; index < sample.length; index++) {
    const code = sample.charCodeAt(index);
    const bucket = SCRIPT_BUCKET[code];
    if (bucket) {
      if (bucket === KANA_BUCKET) return null;
      counts[bucket - 1]++;
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      counts[LATIN_INDEX]++;
    }
  }
  return counts;
}

/**
 * 基于字符区间的轻量语言识别。只用于给出建议，用户可以手动覆盖。
 * 不调用任何模型或网络，也没有额外体积。
 * @param {string} text
 * @returns {string} 语言代码
 */
export function detectLanguage(text) {
  const sample = (text ?? '').slice(0, 2000);
  if (!sample.trim()) return FALLBACK_LANGUAGE;

  // 一趟扫描拿到全部脚本计数，再按 SCRIPT_RANGES 的优先级顺序决策
  const counts = countScripts(sample);
  if (!counts) return 'ja'; // 扫描途中命中假名，已提前定论
  for (let index = 0; index < SCRIPT_RANGES.length; index++) {
    if (counts[index] > 0) return SCRIPT_RANGES[index][0];
  }

  // 拉丁字母：按命中次数打分，避免 "is"、"a" 这类通用词把英文误判成别的语言。
  // 这只是给用户的建议，识别不准时可以在界面上手动改。
  const lower = sample.toLowerCase();
  const latinHints = [
    ['de', /\b(der|die|das|und|ist|nicht|ich|sie|für|mit|ein|eine|den|dem)\b/g],
    ['fr', /\b(le|la|les|des|est|vous|nous|je|une|pour|avec|sur|du|au)\b/g],
    ['es', /\b(el|los|las|una|que|para|con|es|por|como|del|señor)\b/g],
    ['it', /\b(di|della|che|sono|questo|perché|come|gli|una|nel|delle)\b/g],
    ['nl', /\b(de|het|een|van|niet|jij|met|zijn|voor|op|aan|er)\b/g],
    ['pt', /\b(uma|para|com|não|você|nós|isso|está|dos|das|pela)\b/g]
  ];

  let best = FALLBACK_LANGUAGE;
  let bestScore = 0;
  for (const [code, pattern] of latinHints) {
    const score = (lower.match(pattern) ?? []).length;
    if (score > bestScore) {
      bestScore = score;
      best = code;
    }
  }
  return bestScore >= 2 ? best : FALLBACK_LANGUAGE;
}

/**
 * 按中英文字数占比判断语言。
 *
 * detectLanguage 见到一个汉字就判中文，而真实网页里「英文为主、夹几个汉字」的段落
 * 非常常见（导航、品牌名、混排引用），那样整段都会被误判成中文，
 * 在「译成中文」的方向下直接报「源语言和目标语言相同」。
 * 这里改成：汉字占多数才算中文；否则把汉字剔掉再按普通规则判断。
 */
export function detectLanguageByRatio(text) {
  const sample = (text ?? '').slice(0, 2000);
  // 复用同一趟扫描：原来要跑四次正则（假名、韩文、汉字、拉丁）才能拿到这几个计数
  const counts = countScripts(sample);
  // 假名和韩文必须先于汉字判断：日语里汉字很多，直接比汉字/英文字数会把日语判成中文
  if (!counts) return 'ja'; // 扫描途中命中假名，已提前定论
  if (counts[HANGUL_INDEX] > 0) return 'ko';

  const kanji = counts[KANJI_INDEX];
  const latin = counts[LATIN_INDEX];
  if (!latin && !kanji) return detectLanguage(sample);
  if (kanji > latin) return 'zh';
  // 剔掉零星汉字再交给按脚本判断的规则，避免被它们带偏
  return detectLanguage(sample.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' '));
}

/**
 * 根据源语言推荐目标语言：用户看中文为主，源语言是中文时反向译成英文。
 */
export function suggestTarget(source, preferred = DEFAULT_TARGET_LANGUAGE) {
  if (!source) return preferred;
  const base = source === 'zh_hant' ? 'zh' : source;
  return base === preferred ? 'en' : preferred;
}

/**
 * 决定一次翻译实际使用的语言方向。
 * 源语言为「自动检测」时按文本识别；识别结果与目标语言撞车时把目标换成推荐语言，
 * 避免出现「自己译自己」。源语言由用户显式指定时不做猜测，撞车交给调用方报错。
 * @param {string} text
 * @param {string} from 源语言取值，或 AUTO_DETECT
 * @param {string} to 目标语言
 */
export function resolveDirection(text, from, to) {
  if (from !== AUTO_DETECT) return { source: from, target: to, flipped: false };
  const source = detectLanguage(text);
  const same = source === to;
  return {
    source,
    target: same ? suggestTarget(source, DEFAULT_TARGET_LANGUAGE) : to,
    flipped: same
  };
}

/**
 * 生成语言方向键，例如 en-zh。
 */
export function directionKey(from, to) {
  return `${from}-${to}`;
}

/**
 * 解析语言方向键。格式非 xx-yy 时返回 null。
 */
export function parseDirectionKey(key) {
  if (typeof key !== 'string') return null;
  if (!/^[a-z]{2,3}(_[a-z]+)?-[a-z]{2,3}(_[a-z]+)?$/.test(key)) return null;
  const index = key.indexOf('-');
  return { from: key.slice(0, index), to: key.slice(index + 1) };
}

/**
 * 按语言名称或代码过滤方向列表。
 * @param {Array<{from:string,to:string}>} directions
 * @param {string} query
 */
export function filterDirections(directions, query) {
  const keyword = (query ?? '').trim().toLowerCase();
  if (!keyword) return directions;
  return directions.filter(({ from, to }) =>
    from.includes(keyword) || to.includes(keyword) ||
    languageName(from).includes(keyword) || languageName(to).includes(keyword));
}
