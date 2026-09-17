import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLanguage, detectLanguageByRatio, suggestTarget, resolveDirection, parseDirectionKey, directionKey,
  filterDirections, orderedLanguageCodes, languageName, isKnownLanguage,
  AUTO_DETECT, DEFAULT_TARGET_LANGUAGE
} from '../../extension/lib/languages.js';

test('detectLanguage 能区分中文、日语、韩语', () => {
  assert.equal(detectLanguage('这是一段中文'), 'zh');
  assert.equal(detectLanguage('これは日本語です'), 'ja');
  assert.equal(detectLanguage('안녕하세요'), 'ko');
});

test('detectLanguage 能识别西里尔、泰文、阿拉伯、希伯来、希腊字母', () => {
  assert.equal(detectLanguage('Привет мир'), 'ru');
  assert.equal(detectLanguage('สวัสดีชาวโลก'), 'th');
  assert.equal(detectLanguage('مرحبا بالعالم'), 'ar');
  assert.equal(detectLanguage('שלום עולם'), 'he');
  assert.equal(detectLanguage('Καλημέρα κόσμε'), 'el');
});

test('detectLanguage 对拉丁字母给出合理建议', () => {
  assert.equal(detectLanguage('This is a test of the translation engine.'), 'en');
  assert.equal(detectLanguage('Das ist ein Test und ich bin nicht sicher.'), 'de');
  assert.equal(detectLanguage('Ceci est un test et nous sommes ici.'), 'fr');
  assert.equal(detectLanguage('Esto es una prueba para todos.'), 'es');
});

test('detectLanguage 不因个别通用词误判', () => {
  // "is" 同时出现在荷兰语词表里、 "a" 同时出现在葡萄牙语词表里，
  // 只命中一个虚词时不应改变判定结果
  assert.equal(detectLanguage('This is a local model.'), 'en');
  assert.equal(detectLanguage('The model runs in your browser and it is fast.'), 'en');
});

test('detectLanguage 对空文本返回兜底语言而不是抛错', () => {
  assert.equal(detectLanguage(''), 'en');
  assert.equal(detectLanguage('   '), 'en');
  assert.equal(detectLanguage(null), 'en');
});

test('suggestTarget 不会把中文翻成中文', () => {
  assert.equal(suggestTarget('en', 'zh'), 'zh');
  assert.equal(suggestTarget('ja', 'zh'), 'zh');
  assert.equal(suggestTarget('zh', 'zh'), 'en');
  assert.equal(suggestTarget('', 'zh'), 'zh');
  // 繁体中文同样按中文处理，否则会被当成「不是中文」而译回中文
  assert.equal(suggestTarget('zh_hant', 'zh'), 'en');
});

test('resolveDirection：自动检测时按文本定源语言', () => {
  assert.deepEqual(
    resolveDirection('Hello there, how are you doing?', AUTO_DETECT, 'zh'),
    { source: 'en', target: 'zh', flipped: false }
  );
  assert.deepEqual(
    resolveDirection('これは日本語です', AUTO_DETECT, 'zh'),
    { source: 'ja', target: 'zh', flipped: false }
  );
});

test('resolveDirection：识别结果撞上目标语言时自动换向，不自己译自己', () => {
  const direction = resolveDirection('这是一段中文', AUTO_DETECT, 'zh');
  assert.equal(direction.source, 'zh');
  assert.equal(direction.target, 'en');
  assert.equal(direction.flipped, true);
});

test('resolveDirection：用户显式指定源语言时不做猜测', () => {
  const direction = resolveDirection('whatever', 'ja', 'ja');
  assert.equal(direction.source, 'ja');
  assert.equal(direction.target, 'ja', '撞车交给调用方报错，不擅自改用户的选择');
  assert.equal(direction.flipped, false);
  assert.equal(resolveDirection('', 'en', DEFAULT_TARGET_LANGUAGE).source, 'en');
});

test('parseDirectionKey 解析正常方向并拒绝非法输入', () => {
  assert.deepEqual(parseDirectionKey('en-zh'), { from: 'en', to: 'zh' });
  assert.deepEqual(parseDirectionKey('zh_hant-en'), { from: 'zh_hant', to: 'en' });
  assert.equal(parseDirectionKey('english-chinese'), null);
  assert.equal(parseDirectionKey('enzh'), null);
  assert.equal(parseDirectionKey(null), null);
});

test('directionKey 与 parseDirectionKey 互逆', () => {
  assert.equal(directionKey('ja', 'ko'), 'ja-ko');
  assert.deepEqual(parseDirectionKey(directionKey('ja', 'ko')), { from: 'ja', to: 'ko' });
});

test('filterDirections 支持按名称和代码搜索', () => {
  const directions = [
    { from: 'en', to: 'zh' },
    { from: 'ja', to: 'en' },
    { from: 'ko', to: 'en' }
  ];
  assert.equal(filterDirections(directions, '').length, 3);
  assert.equal(filterDirections(directions, 'ja').length, 1);
  assert.equal(filterDirections(directions, '韩').length, 1);
  assert.equal(filterDirections(directions, '不存在的语言').length, 0);
});

test('orderedLanguageCodes 覆盖全部语言且常用语言在前', () => {
  const codes = orderedLanguageCodes();
  assert.ok(codes.length >= 60, `语言数量偏少：${codes.length}`);
  assert.equal(codes[0], 'zh');
  assert.equal(new Set(codes).size, codes.length, '存在重复语言代码');
  for (const code of codes) assert.ok(isKnownLanguage(code), `未知语言 ${code}`);
  assert.notEqual(languageName('zh'), 'zh');
});

test('detectLanguageByRatio：英文为主、夹汉字的段落按英文处理', () => {
  assert.equal(detectLanguageByRatio('Plan your visit 家庭 and see the collection 展览.'), 'en');
  assert.equal(detectLanguageByRatio('HOME'), 'en');
  assert.equal(detectLanguageByRatio('The CTO said: "if you\'re not at your desk, it\'s not work."'), 'en');
});

test('detectLanguageByRatio：汉字占多数才算中文', () => {
  assert.equal(detectLanguageByRatio('看 & 做'), 'zh');
  assert.equal(detectLanguageByRatio('这一段是完整的中文，翻译成中文没有意义。'), 'zh');
  assert.equal(detectLanguageByRatio(''), 'en');
});

test('detectLanguageByRatio：日语汉字多，必须判成日语而不是中文', () => {
  assert.equal(detectLanguageByRatio('この拡張機能はブラウザの中で翻訳を実行します。'), 'ja');
  assert.equal(detectLanguageByRatio('テキストが外部に送信されることはありません。'), 'ja');
});

test('detectLanguage：网址和邮箱不该左右语言判定', () => {
  // 葡萄牙语词表里有 com（= with），一个邮箱地址就能喂它 1 分；
  // 只要再凑一个虚词，整段就会被判成葡语，然后拿去「葡→中」翻出乱码
  assert.equal(detectLanguage('It sounds really good.\n\n1179102890@qq.com\n\nLet me know.'), 'en');
  assert.equal(detectLanguage('见 https://example.com/docs 里的说明。'), 'zh');
});

test('detectLanguage：英语里的常用词不该命中别的语言的词表', () => {
  // die / den / mit / come / de / op / er / met / van 这些词在英语正文里很常见，
  // 收进德语、意语、荷兰语词表后，两句英文就能把整段判成荷兰语
  assert.equal(detectLanguage('I come from a place where the die is cast and the data is met.'), 'en');
  assert.equal(detectLanguage('The van left and she met them at the op er.'), 'en');
});

test('detectLanguageByRatio：中文回复 + 英文引用历史要判成中文', () => {
  // 用户真实场景：回复英文邮件，自己的话是中文，下面挂着整段英文引用历史。
  // 拉丁字母当然远多于汉字，但用户要翻的是自己写的那句。
  const draft = [
    '听起来确实不错',
    '',
    '1179102890',
    '1179102890@qq.com',
    '',
    '---- Replied Message ----',
    'From Francis',
    '',
    'share the plan. No meetings, no pressure, we can sort it all right here.',
    '',
    'Best of,',
    'Francis'
  ].join('\n');

  assert.equal(detectLanguageByRatio(draft), 'zh');
  // 目标是中文时应当自动换向成「中文 → 英文」，而不是自己译自己
  assert.deepEqual(resolveDirection(draft, AUTO_DETECT, 'zh'), { source: 'zh', target: 'en', flipped: true });
});

test('detectLanguage：整段都是引用时退回原文，不会判不出来', () => {
  // 引用块被清空后样本就空了，此时必须退回原文，否则会直接掉到兜底语言
  assert.equal(detectLanguageByRatio('> 这是一段被引用的话，仍然应该按中文处理。'), 'zh');
  assert.equal(detectLanguageByRatio('On Mon, Jan 1 2026 at 10:00, Alice wrote:'), 'en');
});
