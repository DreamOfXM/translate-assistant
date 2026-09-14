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

export function languageName(code) {
  return LANGUAGE_NAMES[code] ?? code;
}

export function isKnownLanguage(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, code);
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

  const count = ranges => {
    let total = 0;
    for (const [start, end] of ranges) {
      for (const character of sample) {
        const point = character.codePointAt(0);
        if (point >= start && point <= end) total++;
      }
    }
    return total;
  };

  // 假名先于汉字判断，否则日语会被误判为中文
  const kana = count([[0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff]]);
  if (kana > 0) return 'ja';

  const hangul = count([[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]]);
  if (hangul > 0) return 'ko';

  const cjk = count([[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]]);
  if (cjk > 0) return 'zh';

  const scripts = [
    ['ru', [[0x0400, 0x04ff]]],
    ['th', [[0x0e00, 0x0e7f]]],
    ['ar', [[0x0600, 0x06ff], [0x0750, 0x077f]]],
    ['he', [[0x0590, 0x05ff]]],
    ['hi', [[0x0900, 0x097f]]],
    ['el', [[0x0370, 0x03ff]]]
  ];
  for (const [code, ranges] of scripts) {
    if (count(ranges) > 0) return code;
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
  // 假名和韩文必须先于汉字判断：日语里汉字很多，直接比汉字/英文字数会把日语判成中文
  if (/[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/.test(sample)) return 'ja';
  if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/.test(sample)) return 'ko';

  const kanji = (sample.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (sample.match(/[A-Za-z]/g) ?? []).length;
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
