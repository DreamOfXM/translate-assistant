import test from 'node:test';
import assert from 'node:assert/strict';

import {
  splitIntoSegments, needsSegmentation, planTranslation, joinSegments,
  translateInSegments, SEGMENT_LIMIT, MAX_TEXT_LENGTH
} from '../../extension/lib/text.js';

const sentence = (text, count) => Array.from({ length: count }, () => text).join('');

test('短文本不分段', () => {
  assert.deepEqual(splitIntoSegments('Hello world.'), ['Hello world.']);
  assert.equal(needsSegmentation('Hello world.'), false);
});

test('空文本返回空数组', () => {
  assert.deepEqual(splitIntoSegments(''), []);
  assert.deepEqual(splitIntoSegments('   '), []);
  assert.deepEqual(splitIntoSegments(null), []);
});

test('长文本按句子边界分段，且不丢内容', () => {
  const text = sentence('This is a complete sentence about local translation. ', 60);
  const segments = splitIntoSegments(text, 900);
  assert.ok(segments.length > 1, '应当分段');
  assert.ok(segments.every(part => part.length <= 900), '每段不得超过上限');
  // 拼接后字数应与原文相同（分段只做 trim 与切分，不删字符）
  const joined = segments.join('');
  assert.ok(joined.length >= text.trim().length - segments.length, '内容不应被静默截断');
});

test('超长单句按字符硬切，不静默丢弃', () => {
  const long = 'a'.repeat(2500);
  const segments = splitIntoSegments(long, 900);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments.map(part => part.length), [900, 900, 700]);
  assert.equal(segments.join(''), long);
});

test('硬切不会劈开代理对，半个字符不进引擎', () => {
  // emoji 和 CJK 扩展 B 汉字都在 U+10000 以上，各占两个 UTF-16 单元；
  // 开头补一个 ASCII 字符，让切点正好落在代理对中间
  const long = 'a' + '😀'.repeat(20) + '𠮷野家'.repeat(10);
  const segments = splitIntoSegments(long, 10);

  assert.ok(segments.length > 1, '应当分段');
  assert.equal(segments.join(''), long, '拼回去不应丢字符');
  assert.deepEqual([...segments.join('')], [...long], '码位序列应完整保留');

  for (const part of segments) {
    const last = part.charCodeAt(part.length - 1);
    const first = part.charCodeAt(0);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `片段以孤立高代理项结尾：${JSON.stringify(part)}`);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), `片段以孤立低代理项开头：${JSON.stringify(part)}`);
    assert.ok(part.length <= 11, '为保住代理对，最多只允许比上限多出 1 个 UTF-16 单元');
  }

  // 确认真的走到了「边界后移」这条分支，否则上面的断言可能是空过
  assert.ok(segments.some(part => part.length === 11), '应至少有一处为了保住代理对而把切点后移');
});

test('planTranslation 对超长文本给出提示而不是截断', () => {
  const plan = planTranslation('a'.repeat(MAX_TEXT_LENGTH + 1));
  assert.equal(plan.ok, false);
  assert.match(plan.message, /分批处理/);
  assert.equal(planTranslation('').ok, false);
});

test('planTranslation 返回分段计划', () => {
  const plan = planTranslation('Short text.');
  assert.equal(plan.ok, true);
  assert.equal(plan.segmented, false);

  const long = planTranslation(sentence('Another sentence goes here. ', 80), SEGMENT_LIMIT);
  assert.equal(long.ok, true);
  assert.equal(long.segmented, true);
});

test('joinSegments 用换行合并并跳过空段', () => {
  assert.equal(joinSegments(['a', '', 'b']), 'a\nb');
  assert.equal(joinSegments([]), '');
});

test('translateInSegments 单段只调用一次', async () => {
  const calls = [];
  const result = await translateInSegments('Hello.', segment => {
    calls.push(segment);
    return Promise.resolve('你好。');
  });
  assert.deepEqual(calls, ['Hello.']);
  assert.deepEqual(result, { text: '你好。', segments: 1 });
});

test('translateInSegments 分段调用并汇报进度', async () => {
  const calls = [];
  const progress = [];
  const text = sentence('One more sentence for the engine. ', 60);

  const result = await translateInSegments(
    text,
    segment => {
      calls.push(segment);
      return Promise.resolve(`译${calls.length}`);
    },
    { onProgress: item => progress.push(item) }
  );

  assert.ok(calls.length > 1, '应逐段调用');
  assert.equal(result.segments, calls.length);
  assert.equal(result.text, calls.map((_, index) => `译${index + 1}`).join('\n'));
  assert.ok(progress.length >= calls.length, '应汇报进度');
  assert.equal(progress.at(-1).percent, 100);
});

test('translateInSegments 对超长文本直接报错', async () => {
  await assert.rejects(
    () => translateInSegments('a'.repeat(MAX_TEXT_LENGTH + 1), async segment => segment),
    /分批处理/
  );
});

test('translateInSegments 把某一段的失败透传出去', async () => {
  await assert.rejects(
    () => translateInSegments(sentence('Sentence here. ', 60), () => Promise.reject(new Error('引擎故障'))),
    /引擎故障/
  );
});
