/**
 * 正文主体识别的单元测试。
 *
 * 重点验证两件事：一是能从导航/侧栏/广告/页脚/评论里把正文挑出来，
 * 二是识别不出来时必须保守降级——裸挂在 body 下的段落绝不能被判成「非正文」，
 * 否则整页双语对照会一个字都不翻。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findMainContentRoot, shouldSkipBlock, looksLikeAppPage } from '../../extension/lib/content-extract.js';

/** 造一段足够长的英文正文，让容器能越过「文字量太少不算正文根」的门槛 */
const prose = (seed, sentences = 3) => Array.from(
  { length: sentences },
  (_, index) => `${seed} sentence number ${index + 1}, which is long enough to look like real prose.`
).join(' ');

const doc = html => new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
  url: 'https://example.test/'
}).window.document;

/** 典型的文章页：语义正文 + 站点页眉 + 面包屑 + 侧栏 + 广告 + 页脚 + 评论区 */
const articlePage = () => doc(`
  <header id="site-header">
    <nav class="main-nav">
      <ul><li><a href="/">Home page</a></li><li><a href="/about">About us</a></li></ul>
    </nav>
  </header>
  <div id="page">
    <nav class="breadcrumb"><a href="/">Home</a> &gt; <a href="/blog">Blog</a></nav>
    <article class="post">
      <header class="article-header"><h1>Understanding local translation</h1></header>
      <p>${prose('Opening paragraph of the real article body')}</p>
      <p>${prose('Second paragraph of the real article body')}</p>
      <p>${prose('Third paragraph of the real article body')}</p>
      <footer class="article-footer"><p>Written by the author, who says hello.</p></footer>
    </article>
    <aside class="sidebar">
      <p>${prose('Sidebar teaser that tries hard to look like content')}</p>
    </aside>
    <div class="ad-banner"><p>${prose('Sponsored placement disguised as a paragraph')}</p></div>
    <section id="comments">
      <ol class="comment-list">
        <li class="comment"><div class="comment-body"><p>${prose('Some random visitor wrote this')}</p></div></li>
      </ol>
    </section>
  </div>
  <footer id="site-footer"><p>Copyright 2026, all rights reserved everywhere.</p></footer>
`);

test('语义容器优先：findMainContentRoot 选中 article 正文', () => {
  const document = articlePage();
  const root = findMainContentRoot(document);
  assert.equal(root, document.querySelector('article.post'), '应把 article 认成正文根');
});

test('shouldSkipBlock 跳过导航、侧栏、广告、页脚、评论', () => {  const document = articlePage();
  const root = findMainContentRoot(document);

  const cases = [
    ['nav 里的列表项', '.main-nav li'],
    ['面包屑里的链接项', '.breadcrumb a'],
    ['侧栏段落', '.sidebar p'],
    ['广告位段落', '.ad-banner p'],
    ['站点页脚段落', '#site-footer p'],
    ['站点页眉里的 nav', '#site-header nav'],
    ['评论区段落', '#comments .comment-body p']
  ];
  for (const [label, selector] of cases) {
    assert.equal(shouldSkipBlock(document.querySelector(selector), root), true, `${label} 应被跳过`);
  }
});

test('shouldSkipBlock 放过正文段落和标题', () => {
  const document = articlePage();
  const root = findMainContentRoot(document);

  for (const paragraph of document.querySelectorAll('article.post > p')) {
    assert.equal(shouldSkipBlock(paragraph, root), false, '正文段落不该被跳过');
  }
  assert.equal(shouldSkipBlock(document.querySelector('article.post h1'), root), false, '文章标题不该被跳过');
});

test('正文根是 article 时，它内部的 header 算标题区，footer 仍算杂讯', () => {
  const document = articlePage();
  const root = findMainContentRoot(document);
  const title = document.querySelector('.article-header h1');
  const share = document.querySelector('.article-footer p');

  assert.equal(shouldSkipBlock(title, root), false, '文章标题在正文根内，应该翻');
  assert.equal(shouldSkipBlock(share, root), true, '文章页脚是分享/版权，正是用户嫌乱的东西');
  // 不传正文根时无从判断这是文章内部的 header，按站点框架区域跳过
  assert.equal(shouldSkipBlock(title), true, '没有正文根时 header 内的块按框架区域处理');
});

test('main 里嵌着更精确的 article 时选 article，不把整个 main 当正文根', () => {
  const document = doc(`
    <main>
      <div class="toolbar"><button>Watch</button><button>Star</button></div>
      <table><tr><td>Name</td><td>Sep 14, 2026</td></tr></table>
      <article class="markdown-body">
        <h1>Real article</h1>
        <p>${prose('First paragraph of the embedded readme article')}</p>
        <p>${prose('Second paragraph of the embedded readme article')}</p>
      </article>
    </main>
  `);
  const root = findMainContentRoot(document);
  assert.ok(root?.matches('article'), '正文根应是 article 而不是包住界面零件的 main');
});

test('常见 CMS 类名也能当正文根', () => {
  const document = doc(`
    <div id="wrapper">
      <div class="entry-content">
        <p>${prose('First paragraph inside the CMS content wrapper')}</p>
        <p>${prose('Second paragraph inside the CMS content wrapper')}</p>
      </div>
      <div id="sidebar"><p>${prose('Sidebar noise')}</p></div>
    </div>
  `);
  assert.equal(findMainContentRoot(document), document.querySelector('.entry-content'));
});

test('没有语义标签时用打分兜底，选中段落最密集的容器', () => {
  const document = doc(`
    <div id="topnav"><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></div>
    <div id="wrapper">
      <div id="main-column">
        <h1>Understanding local translation</h1>
        <p>${prose('First real paragraph, with a few commas, so it scores like prose')}</p>
        <p>${prose('Second real paragraph, with a few commas, so it scores like prose')}</p>
        <p>${prose('Third real paragraph, with a few commas, so it scores like prose')}</p>
        <p>${prose('Fourth real paragraph, with a few commas, so it scores like prose')}</p>
      </div>
      <div id="sidebar"><p>Buy things now.</p></div>
    </div>
    <div id="footer-area"><p>Copyright 2026</p></div>
  `);
  assert.equal(findMainContentRoot(document), document.getElementById('main-column'));
});

test('链接密度过高的块按导航处理，即使文字很长', () => {
  const document = doc('<div id="link-farm"></div>');
  const farm = document.getElementById('link-farm');
  for (let index = 0; index < 12; index++) {
    const link = document.createElement('a');
    link.href = `/page-${index}`;
    link.textContent = `Recommended article number ${index} you should really read`;
    farm.append(link);
  }
  assert.equal(shouldSkipBlock(farm), true, '整块都是链接，不是正文');
});

test('极短块跳过，但短标题放过', () => {
  const document = doc(`
    <div id="body-copy">
      <p>Yes.</p>
      <h2>Setup</h2>
      <p>${prose('A perfectly normal paragraph that should never be skipped')}</p>
    </div>
  `);
  const [short, heading] = document.querySelectorAll('#body-copy p, #body-copy h2');
  assert.equal(shouldSkipBlock(short), true, '两三个字的块没有翻译价值');
  assert.equal(shouldSkipBlock(heading), false, '标题本来就短，不能跳过');
});

test('保守降级：body 下的裸段落没有容器时不认正文根，也不跳过段落', () => {
  const document = doc(`
    <p id="para">Local translation runs entirely on your device.</p>
    <p id="para2">Another local paragraph for batch tests.</p>
    <p id="zhpara">这一段本来就是中文。</p>
    <textarea id="comment"></textarea>
  `);
  assert.equal(findMainContentRoot(document), null, '识别不出正文根时应返回 null，让调用方翻所有合格块');
  for (const id of ['para', 'para2', 'zhpara']) {
    assert.equal(shouldSkipBlock(document.getElementById(id)), false, `${id} 是裸段落，必须当正文`);
  }
});

test('保守降级：正文太短时不硬认一个容器当正文根', () => {
  const document = doc(`
    <div id="shell">
      <div class="tiny"><p>Short note.</p></div>
    </div>
  `);
  assert.equal(findMainContentRoot(document), null, '文字量不够时应降级，交给调用方翻所有合格块');
});

test('保守降级：正文散落在多个体量相当的容器里时不挑最大那个', () => {
  // 每个长段各包一个卡片容器（e2e 测试页就是这种结构）：认最大单个容器会漏掉其余正文块
  const document = doc(`
    <h1>Sample page</h1>
    <div class="case"><p>${prose('First standalone paragraph living in its own card')}</p></div>
    <div class="case"><p>${prose('Second standalone paragraph living in its own card')}</p></div>
    <div class="case"><p>${prose('Third standalone paragraph living in its own card, a bit longer, with more clauses, to become the strongest single candidate')}</p></div>
  `);
  assert.equal(findMainContentRoot(document), null, '单一容器覆盖不了页面段落分的大头时应降级为翻所有合格块');
  for (const p of document.querySelectorAll('.case p')) {
    assert.equal(shouldSkipBlock(p), false, '散落在卡片里的段落必须当正文翻');
  }
});

test('looksLikeAppPage：满页短标签的工具页（GitHub 仓库页）应命中', () => {
  const document = doc(`
    <main>
      <h1>BrokenPipe</h1>
      <p>Steam Client Service Local Privilege Escalation Vulnerability.</p>
      <table>
        <tr><td>Name</td><td>Last commit message</td><td>Commit date</td></tr>
        <tr><td>src</td><td>initial upload</td><td>Sep 14, 2026</td></tr>
        <tr><td>docs</td><td>add readme</td><td>Sep 14, 2026</td></tr>
        <tr><td>assets</td><td>initial upload</td><td>Sep 14, 2026</td></tr>
      </table>
      <ul><li><a href="#">Terms</a></li><li><a href="#">Privacy</a></li>
      <li><a href="#">Security</a></li><li><a href="#">Status</a></li>
      <li><a href="#">Docs</a></li><li><a href="#">Contact</a></li>
      <li><a href="#">Pricing</a></li><li><a href="#">API</a></li>
      <li><a href="#">Training</a></li><li><a href="#">Blog</a></li></ul>
    </main>
  `);
  assert.equal(looksLikeAppPage(document), true, '成段文字占比过低的页面是工具页，不该自动整页翻译');
});

test('looksLikeAppPage：正常文章页不应命中', () => {
  const document = doc(`
    <article>
      <h1>Understanding local translation</h1>
      <p>${prose('Opening paragraph of the article')}</p>
      <p>${prose('Second paragraph of the article')}</p>
      <p>${prose('Third paragraph of the article')}</p>
      <p>${prose('Fourth paragraph of the article')}</p>
      <button>Share</button>
    </article>
  `);
  assert.equal(looksLikeAppPage(document), false, '文章页有成段文字，应当照常自动双语');
});

test('looksLikeAppPage：块太少的小页面不参与判定', () => {
  const document = doc(`
    <p>A short note.</p>
    <p>Another short line.</p>
    <p>Contact us at example@example.com.</p>
  `);
  assert.equal(looksLikeAppPage(document), false, '块太少时不判工具页，照常走正文识别');
});

test('shouldSkipBlock：表格单元的短数据（日期、文件名）不算正文', () => {
  const document = doc(`
    <table>
      <tr><th id="h">Last commit message</th><th id="d">Commit date</th></tr>
      <tr><td id="msg">initial upload</td><td id="date">Sep 14, 2026</td></tr>
      <tr><td id="long">A genuinely long table cell that carries real sentence content and is worth translating for readers.</td></tr>
    </table>
  `);
  assert.equal(shouldSkipBlock(document.getElementById('h')), true, '短表头是数据不是正文');
  assert.equal(shouldSkipBlock(document.getElementById('msg')), true, '短 commit 信息是数据');
  assert.equal(shouldSkipBlock(document.getElementById('date')), true, '日期是数据');
  assert.equal(shouldSkipBlock(document.getElementById('long')), false, '够长的表格单元仍当正文翻');
});

test('shouldSkipBlock：sr-only 屏幕阅读器元素按杂讯跳过', () => {
  const document = doc(`
    <div id="wrap"><h2 class="sr-only" id="srh">Folders and files</h2><p id="body">${prose('A real paragraph of body text')}</p></div>
    <nav class="visually-hidden-nav" id="vh"><p id="vhp">Hidden nav paragraph text.</p></nav>
  `);
  assert.equal(shouldSkipBlock(document.getElementById('srh')), true, 'class 命中 sr-only 的元素是屏幕阅读器文本');
  assert.equal(shouldSkipBlock(document.getElementById('vhp')), true, '祖先类名命中 visually-hidden 的按杂讯处理');
  assert.equal(shouldSkipBlock(document.getElementById('body')), false);
});

test('保守降级：整页被一个 form 包住时不把 form 当表单控件', () => {
  const document = doc(`
    <form id="aspnetForm">
      <div id="nav-bar"><ul><li><a href="/">Home</a></li></ul></div>
      <div class="article-body">
        <p>${prose('First paragraph of an article living inside a page wrapping form')}</p>
        <p>${prose('Second paragraph of an article living inside a page wrapping form')}</p>
        <p>${prose('Third paragraph of an article living inside a page wrapping form')}</p>
      </div>
      <div id="footer-bar"><p>Copyright 2026, all rights reserved.</p></div>
    </form>
  `);
  const root = findMainContentRoot(document);
  assert.equal(root, document.querySelector('.article-body'), '包页 form 不该挡住正文识别');
  for (const paragraph of document.querySelectorAll('.article-body p')) {
    assert.equal(shouldSkipBlock(paragraph, root), false, '包页 form 里的正文段落必须能翻');
  }
  assert.equal(shouldSkipBlock(document.querySelector('#nav-bar li'), root), true, '同一个 form 里的导航仍然要跳过');
});

test('小表单控件里的块仍然跳过', () => {
  const document = doc(`
    <form class="search-form">
      <p>Type a keyword and press enter to search the site.</p>
      <input type="text" name="q" />
    </form>
  `);
  assert.equal(shouldSkipBlock(document.querySelector('.search-form p')), true, '搜索框的提示文字不是正文');
});

test('博客首页的多篇文章卡片：取公共祖先，不只翻最大那一篇', () => {
  const document = doc(`
    <div class="post-list">
      <article class="card"><p>${prose('Summary of the first post on the index page')}</p></article>
      <article class="card"><p>${prose('Summary of the second post on the index page')}</p></article>
    </div>
  `);
  assert.equal(findMainContentRoot(document), document.querySelector('.post-list'));
});

test('侧栏里的 article（相关推荐）不会被当成正文根', () => {
  const document = doc(`
    <div id="layout">
      <div class="main-text">
        <p>${prose('The genuine article text, long enough to be recognised as the main body')}</p>
        <p>${prose('More genuine article text, still long enough to be recognised as main body')}</p>
      </div>
      <aside class="related">
        <article class="teaser"><p>${prose('Related recommendation card sitting in the sidebar')}</p></article>
      </aside>
    </div>
  `);
  const root = findMainContentRoot(document);
  assert.equal(root, document.querySelector('.main-text'), '侧栏里的 article 是推荐位，不是正文');
});

test('扩展自己插入的译文节点不会被当成正文', () => {
  const document = doc(`
    <div class="entry-content">
      <p id="source">${prose('A paragraph that already has a translation inserted below it')}</p>
      <div class="lt-para-host" id="inserted"></div>
    </div>
  `);
  const host = document.getElementById('inserted');
  assert.equal(shouldSkipBlock(host), true, '译文宿主是极短的空 div，必须跳过，避免翻自己');
});
