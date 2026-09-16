/**
 * 正文主体识别（content extraction）。
 *
 * 整页双语对照如果翻遍每一个段落，导航、侧栏、广告、页脚、评论都会插上译文，
 * 页面反而比原文更难读。这里用纯 DOM 启发式找出「正文主体」区域，让翻译只落在正文里。
 *
 * 底线是**保守降级**：识别不出正文根时返回 null，调用方退回「翻译所有合格块」的旧行为。
 * 裸段落直接挂在 body 下、没有 article/main 包裹的页面就属于这种情况——
 * 宁可多翻，也不能把真正的正文漏掉。
 *
 * 零依赖、不碰任何 Chrome API，可以直接在 jsdom 里单测。
 */

/** 语义容器：命中即优先当作正文根，比打分可靠 */
const SEMANTIC_SELECTOR = [
  'article', 'main', '[role="main"]', '[itemprop="articleBody"]',
  '.post-content', '.entry-content', '.article-body', '.article-content',
  '.post-body', '.entry-body', '.story-body', '.page-content', '.main-content',
  '#content', '.content', '#main', '.main', '#main-content'
].join(',');

/** 语义文章容器：只有它内部的 header 才属于文章自身（标题区），不是站点页眉 */
const ARTICLE_LIKE_SELECTOR = 'article, main, [role="main"], [itemprop="articleBody"]';

/** 站点框架区域：这些标签/角色里的内容不是正文 */
const CHROME_SELECTOR =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], ' +
  '[role="contentinfo"], [role="complementary"], [role="search"]';

/**
 * 同上，但放过 header：正文根是 article/main 时，它内部的 header 装的是文章标题，
 * 属于正文。footer 不放过——文章页脚通常是分享按钮、相关推荐、版权，正是用户嫌乱的东西。
 */
const INNER_CHROME_SELECTOR =
  'nav, footer, aside, [role="navigation"], [role="contentinfo"], ' +
  '[role="complementary"], [role="search"]';

/**
 * class/id 命中这些词的块多半是导航、广告、评论、分享等非正文区域。
 * 广告用 `\bads?\b|\bad[-_]|\badvert` 而不是裸 `ad`：裸写会把 lead、head、thread、
 * download 这类正文常用词全部误杀。
 */
const CHROME_PATTERN =
  /comment|sidebar|footer|nav|menu|promo|related|share|social|breadcrumb|pagination|widget|sponsor|\bads?\b|\bad[-_]|\badvert|sr-only|visually-hidden|screen-?reader|offscreen/i;

/** class/id 命中这些词的容器多半是正文，打分时加分 */
const CONTENT_PATTERN = /article|body|content|entry|hentry|main|page|post|story|text|document/i;

/** 参与 Readability-lite 打分的段落类元素（不含 li：导航列表用它，会把菜单区分抬上去） */
const SCORING_SELECTOR = 'p, pre, blockquote, td';

/** 统计容器文字量时算进去的元素 */
const TEXT_BLOCK_SELECTOR = 'p, pre, blockquote, td, li, dd';

/** 正文根至少要有的文字量：太小的容器多半是摘要卡片，认它当正文会漏掉真正的正文 */
const MIN_ROOT_TEXT = 140;

/** 候选容器至少要拿到的段落分，滤掉只包着一两个短段落的包装层 */
const MIN_PARAGRAPH_SCORE = 6;

/**
 * 最佳容器的段落分占页面段落总分的最低比例。正文散落在多个体量相当的容器里时
 * （每段各包一个卡片的首页、每条例子各包一个容器的测试页），挑最大单个容器必然
 * 漏掉其余正文块——低于这个比例说明「认不出单一正文根」，降级为翻所有合格块。
 */
const MIN_SCORE_COVERAGE = 0.6;

/** 链接密度超过这个值的块是导航或链接农场，不是正文 */
const MAX_LINK_DENSITY = 0.5;

/** 短于这个字数的块没有翻译价值（标题除外，标题本来就短） */
const MIN_BLOCK_TEXT = 8;

/** 表格单元要更长才值得翻：它们多是日期、文件名这类数据而非正文 */
const MIN_TABLE_CELL_TEXT = 24;

/** 打分时最多细看几个候选：算链接密度要遍历子树，不能对每个容器都来一遍 */
const TOP_CANDIDATES = 6;

/** 多个语义容器体量相当（博客首页的文章卡片列表）时，认定它们「同类」的比例阈值 */
const PEER_RATIO = 0.5;

/** class/id 命名检查最多往上走几层，避免被远处的布局类名误伤 */
const NAMING_WALK_LIMIT = 5;

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** 整页被一个 form 包住的老式页面（ASP.NET WebForms 等）判定结果缓存 */
const wrappingForms = new WeakMap();

function isDocumentLevel(el) {
  if (!el) return true;
  return el.tagName === 'HTML' || el.tagName === 'BODY';
}

function elementName(el) {
  // SVG 元素的 className 是对象不是字符串，直接拼会拿到 "[object SVGAnimatedString]"
  const className = typeof el.className === 'string' ? el.className : '';
  return `${el.id ?? ''} ${className}`;
}

function textOf(el) {
  return (el?.textContent ?? '').trim();
}

/** 容器里「像正文」的文字量；没有任何段落标记时（纯 div 排版）退回整体文字量 */
function paragraphTextLength(el) {
  let total = 0;
  for (const block of el.querySelectorAll(TEXT_BLOCK_SELECTOR)) total += textOf(block).length;
  return total || textOf(el).length;
}

/** 链接内文字占比：导航、相关推荐、链接农场都接近 1，正文段落接近 0 */
function linkDensity(el) {
  const total = textOf(el).length;
  if (!total) return 1;
  let linked = 0;
  for (const anchor of el.querySelectorAll('a')) linked += textOf(anchor).length;
  return Math.min(1, linked / total);
}

/**
 * 整页被一个 `<form>` 包住的老式页面不能把 form 当表单控件跳过，
 * 否则整页正文一个块都翻不了。判据是它装下了成规模的正文。
 */
function isWrappingForm(form) {
  let cached = wrappingForms.get(form);
  if (cached === undefined) {
    cached = paragraphTextLength(form) >= MIN_ROOT_TEXT &&
      form.querySelectorAll(SCORING_SELECTOR).length >= 2;
    wrappingForms.set(form, cached);
  }
  return cached;
}

/** 是否落在站点框架区域（导航/页眉/页脚/侧栏/表单）里 */
function isInChromeRegion(el, innerArticle = false) {
  if (el.closest?.(innerArticle ? INNER_CHROME_SELECTOR : CHROME_SELECTOR)) return true;
  const form = el.closest?.('form');
  return Boolean(form) && !isWrappingForm(form);
}

/**
 * class/id 命名检查。从块本身往上走，走到正文根为止：正文根以上的包装层描述的是页面
 * 布局（WordPress 常见的 `content-sidebar` 就是这种），拿它判定会把整页正文全跳过。
 * 没有正文根时只往上看有限几层，同样是为了不被远处的布局类名误伤。
 */
function hasChromeNaming(el, contentRoot) {
  let steps = 0;
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (isDocumentLevel(node)) break;
    if (CHROME_PATTERN.test(elementName(node))) return true;
    if (contentRoot && node === contentRoot) break;
    if (++steps >= NAMING_WALK_LIMIT) break;
  }
  return false;
}

/** 句读标点：出现任意一个说明这是在「说话」，哪怕很短也值得翻 */
const SENTENCE_PUNCT = /[.!?。！？，,;；:：(']/;

/** 超短的「标题行」块：专名、数字、标签串（Chuluu/mural ★23 · GitHub、
 *  PeekPaste），没有可读句子；机器翻译只会产出「丘卢/壁画」「固定装载」
 *  级别的噪音。非标题元素按此跳过。 */
function isTrivialTitle(el) {
  if (HEADING_TAGS.has(el.tagName)) return false;
  const text = textOf(el);
  return text.length <= 40 && !SENTENCE_PUNCT.test(text);
}

/** 极短块没有翻译价值；标题本来就短，放过 */
function isTooShort(el) {
  if (HEADING_TAGS.has(el.tagName)) return false;
  // 表格单元在网页里多是数据（日期、文件名、状态词、数字），不是可读正文；
  // 门槛抬高到一整行文字，消掉「Sep 14, 2026」「initial upload」这类噪音
  const min = el.tagName === 'TD' || el.tagName === 'TH' ? MIN_TABLE_CELL_TEXT : MIN_BLOCK_TEXT;
  return textOf(el).length < min;
}

/** 多个元素的最近公共祖先 */
function commonAncestor(elements) {
  let node = elements[0]?.parentElement ?? null;
  while (node) {
    if (elements.every(el => node.contains(el))) return node;
    node = node.parentElement;
  }
  return null;
}

/** 语义容器优先：article/main/[role=main] 以及常见 CMS 类名 */
function pickSemanticRoot(doc) {
  const matches = [];
  for (const el of doc.querySelectorAll(SEMANTIC_SELECTOR)) {
    // 侧栏里的「相关文章」也用 article 标签，先按框架区域滤掉
    if (isInChromeRegion(el)) continue;
    const text = paragraphTextLength(el);
    if (text >= MIN_ROOT_TEXT) matches.push({ el, text });
  }
  if (!matches.length) return null;

  // 嵌套时保留更精确的内层：GitHub 的 main 里嵌着 README 的 article，
  // 认外层的 main 当正文根，表格、时间戳、界面词就全混进「正文」了
  const refined = matches.filter(match =>
    !matches.some(other => other.el !== match.el && match.el.contains(other.el)));
  matches.sort((a, b) => b.text - a.text);
  // 博客首页那种一排体量相当的文章卡片：只认最大那个会漏掉其余卡片，
  // 改取它们的公共祖先；公共祖先就是 body 时交给调用方降级
  const peers = refined
    .filter(match => match.text >= refined[0].text * PEER_RATIO)
    .map(match => match.el);
  if (peers.length === 1) return peers[0];
  const common = commonAncestor(peers);
  return common && !isDocumentLevel(common) ? common : null;
}

/**
 * Readability-lite 打分：把每个段落类元素的分数按 1、1/2、1/3 累加到父、祖父、曾祖父上，
 * 再按链接密度打折、按 class/id 加减分。body/html 不参与——它们当正文根等于没识别。
 * total 是所有段落贡献的原始总分（父子间不重叠），供覆盖度检查用。
 */
function accumulateScores(doc) {
  const scores = new Map();
  let total = 0;
  const add = (el, delta) => {
    if (!el || el.nodeType !== 1 || isDocumentLevel(el)) return;
    scores.set(el, (scores.get(el) ?? 0) + delta);
  };
  for (const block of doc.querySelectorAll(SCORING_SELECTOR)) {
    const text = textOf(block);
    if (text.length < 25) continue;   // 太短的段落不是正文信号
    // 逗号越多越像自然语句，长段落权重更高，但都设上限避免单块刷分
    const commas = (text.match(/[,，;；、]/g) ?? []).length;
    const weight = 1 + Math.min(Math.floor(text.length / 100), 3) + Math.min(commas, 8);
    add(block.parentElement, weight);
    add(block.parentElement?.parentElement, weight / 2);
    add(block.parentElement?.parentElement?.parentElement, weight / 3);
    total += weight;
  }
  return { scores, total };
}

function namingBonus(el) {
  const name = elementName(el);
  let bonus = 0;
  if (CONTENT_PATTERN.test(name)) bonus += 25;
  if (CHROME_PATTERN.test(name)) bonus -= 25;
  return bonus;
}

/** 没有语义容器时的兜底：挑打分最高、且确实装了足够正文的容器 */
function pickScoredRoot(doc) {
  const { scores, total } = accumulateScores(doc);
  const ranked = [...scores.entries()]
    .filter(([, score]) => score >= MIN_PARAGRAPH_SCORE)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CANDIDATES);

  let best = null;
  for (const [el, score] of ranked) {
    if (isInChromeRegion(el)) continue;
    const density = linkDensity(el);
    if (density > MAX_LINK_DENSITY) continue;
    const adjusted = score * (1 - density) + namingBonus(el);
    if (!best || adjusted > best.score) best = { el, score: adjusted, raw: score };
  }
  if (!best) return null;
  // 文字量太少的容器多半是摘要卡片或包装层，认它当正文根会漏掉真正的正文
  if (paragraphTextLength(best.el) < MIN_ROOT_TEXT) return null;
  // 最佳容器只盖住页面段落分的少数：正文散落在多个容器里，认单个容器会漏掉其余正文块
  if (total > 0 && best.raw / total < MIN_SCORE_COVERAGE) return null;
  return best.el;
}

/**
 * 一段长文本的最小字符数：工具页的块几乎都是短标签（Watch、Sep 14, 2026、
 * 表头单词），文章页则必然有成段的自然语言。
 */
const LONG_BLOCK_TEXT = 60;

/** 块总数达到这个量级才参与工具页判定，几个块的小页面不判 */
const MIN_BLOCKS_FOR_APP_CHECK = 8;

/** 长块占比低于这个值：满页都是短标签，是工具型页面 */
const MAX_LONG_BLOCK_RATIO = 0.15;

/**
 * 页面里已有可观汉字就保守判中文的下限：真外文页面不会带这么多汉字。
 */
export const MIN_CJK_FOR_ZH_PAGE = 800;

/**
 * 默认不自动整页翻译的站点（hostname 以此结尾即命中）。
 *
 * GitHub 这类「应用型站点」的每一页都是界面零件：搜索结果页翻出「先进」
 * （Advanced 的烂译）、仓库页翻出表格与时间戳，怎么调启发式都有漏网之鱼。
 * 主流做法（Chrome 的「永不翻译这些网站」、沉浸式翻译的「永不翻译此网站」）
 * 都是站点级黑名单；这里预置口碑最差的几个，用户手动点「双语对照」仍可翻。
 */
export const DEFAULT_NEVER_AUTO_SITES = ['github.com'];

/**
 * hostname 是否命中「不自动翻译」站点列表（点分后缀匹配，仓库页/搜索页一并覆盖）。
 * @param {string} hostname 页面 hostname
 * @param {string[]} [sites] 站点列表，默认内置列表
 * @returns {boolean}
 */
export function isNeverAutoSite(hostname, sites = DEFAULT_NEVER_AUTO_SITES) {
  if (!hostname) return false;
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  // 只认完全相等或「.站点」后缀：evil-github.com 不能命中 github.com
  return sites.some(site => host === site || host.endsWith(`.${site}`));
}

/**
 * 判断这是不是「应用/工具型页面」：满页短标签、时间戳、表格单元，几乎没有
 * 成段的自然语言（GitHub 仓库页、管理后台、搜索结果页）。这类页面整页双语
 * 只会把 Watch→观看、Sep 14, 2026→2026年9月14日 这种界面词逐个插成噪音节点，
 * 默认不该自动开启；用户手动点悬浮按钮仍可翻。
 *
 * 判据是「长块占比」：控件计数在 GitHub 上会失效（footer 链接、td、README 列表
 * 把块总数撑得比按钮大一个量级），而「有没有成段文字」是文章页和工具页的
 * 本质区别，按整页 body 统计、不跟正文根收窄。
 *
 * @param {Document|Element} doc 要分析的文档
 * @returns {boolean} true 表示这是工具型页面，自动整页翻译应当跳过
 */
export function looksLikeAppPage(doc) {
  if (!doc?.querySelectorAll) return false;
  const scope = doc.body ?? doc;
  const blocks = [...scope.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td')];
  if (blocks.length < MIN_BLOCKS_FOR_APP_CHECK) return false;
  const longBlocks = blocks.filter(el => paragraphTextLength(el) >= LONG_BLOCK_TEXT).length;
  return longBlocks / blocks.length < MAX_LONG_BLOCK_RATIO;
}

/**
 * 找出页面的正文主体容器。
 *
 * 分两层：先认语义容器（article/main/[role=main]/[itemprop=articleBody] 与常见 CMS 类名），
 * 没有语义容器时再用 Readability-lite 打分兜底。两层都不自信时返回 null，
 * 调用方必须退回「翻译所有合格块」，否则会漏掉裸挂在 body 下的正文段落。
 *
 * @param {Document|Element} [doc] 要分析的文档（默认当前 document）
 * @returns {Element|null} 正文根；无法自信识别时为 null
 */
export function findMainContentRoot(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return null;
  try {
    return pickSemanticRoot(doc) ?? pickScoredRoot(doc);
  } catch {
    // 识别失败不该让翻译整个瘫掉，退回旧行为
    return null;
  }
}

/**
 * 判断块是否该跳过（不是正文）。
 *
 * 跳过规则：位于 nav/header/footer/aside/form 或对应 ARIA 角色内；自身或近处祖先的
 * class/id 命中广告、侧栏、评论、分享等命名；链接密度过高（导航、链接农场）；文字极短。
 * 另外尊重 Web 标准：带 translate="no" 或 notranslate 标记的区域是站长明确
 * 说不翻的（Chrome/沉浸式翻译都遵守），一律跳过。
 *
 * @param {Element} el 候选块
 * @param {Element|null} [contentRoot] 已识别的正文根。传了之后有两处放宽：
 *   正文根是 article/main 时，它内部的 header 算文章自己的标题区而不是站点页眉；
 *   class/id 命名检查走到正文根就停，不被更外层的布局类名误伤。
 * @returns {boolean} true 表示应该跳过
 */
export function shouldSkipBlock(el, contentRoot = null) {
  if (!el || el.nodeType !== 1) return true;
  if (el.closest?.('[translate="no"], .notranslate')) return true;
  const innerArticle = Boolean(contentRoot) && contentRoot !== el &&
    Boolean(contentRoot.matches?.(ARTICLE_LIKE_SELECTOR)) && contentRoot.contains(el);
  if (isInChromeRegion(el, innerArticle)) return true;
  if (isTrivialTitle(el)) return true;
  if (hasChromeNaming(el, contentRoot)) return true;
  if (linkDensity(el) > MAX_LINK_DENSITY) return true;
  return isTooShort(el);
}
