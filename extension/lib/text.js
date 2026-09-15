/**
 * 文本长度处理。
 * 翻译引擎对单次输入长度敏感，过长文本必须显式分段，不能静默截断。
 * 纯函数，供 content script、popup 和单元测试共用。
 */

/** 单次送入引擎的字符上限 */
export const SEGMENT_LIMIT = 900;

/** 单次请求允许的最大总字符数，超过则要求用户自行缩减 */
export const MAX_TEXT_LENGTH = 20000;

/** 高代理项 U+D800–U+DBFF，与紧随其后的低代理项一起组成一个 U+10000 以上的字符 */
const isHighSurrogate = code => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = code => code >= 0xdc00 && code <= 0xdfff;

/**
 * 切点 index 是否正好把一个代理对劈成两半。
 * emoji、CJK 扩展 B 汉字等 U+10000 以上的字符占两个 UTF-16 单元，
 * 半个字符送进翻译引擎会变成乱码，硬切时必须避开。
 */
function splitsSurrogatePair(text, index) {
  return index > 0 && index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index));
}

/**
 * 把长文本切成不超过 limit 的片段。
 * 优先在句子边界断开；单个句子本身超长时再按字符硬切。
 * @param {string} text
 * @param {number} limit
 * @returns {string[]}
 */
export function splitIntoSegments(text, limit = SEGMENT_LIMIT) {
  const source = (text ?? '').trim();
  if (!source) return [];

  const size = Math.max(1, Math.floor(limit));
  if (source.length <= size) return [source];

  const segments = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) segments.push(buffer.trim());
    buffer = '';
  };

  // 按句子切分，保留标点
  const sentences = source.match(/[^.!?。！？；;\n]+[.!?。！？；;]?|\n+/g) ?? [source];

  for (const sentence of sentences) {
    if (sentence.length > size) {
      flush();
      // 单个句子仍然过长：按字符硬切，避免在词中间断开得太离谱
      for (let offset = 0; offset < sentence.length;) {
        let end = offset + size;
        // 切点劈开代理对时把边界后移 1，宁可这一段多出 1 个 UTF-16 单元也不送半个字符进引擎
        if (splitsSurrogatePair(sentence, end)) end++;
        end = Math.min(end, sentence.length);
        segments.push(sentence.slice(offset, end));
        offset = end;
      }
      continue;
    }
    if ((buffer + sentence).length > size) flush();
    buffer += sentence;
  }
  flush();

  return segments;
}

/**
 * 文本是否需要分段。
 */
export function needsSegmentation(text, limit = SEGMENT_LIMIT) {
  return (text ?? '').trim().length > limit;
}

/**
 * 校验文本长度，返回可直接展示给用户的结论。
 * @returns {{ok: boolean, segments: string[], message?: string}}
 */
export function planTranslation(text, limit = SEGMENT_LIMIT) {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return { ok: false, segments: [], message: '请输入要翻译的内容。' };
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return {
      ok: false,
      segments: [],
      message: `内容超过 ${MAX_TEXT_LENGTH} 字，请分批处理（当前 ${trimmed.length} 字）。`
    };
  }
  const segments = splitIntoSegments(trimmed, limit);
  return { ok: true, segments, segmented: segments.length > 1 };
}

/**
 * 把分段译文合并回一段文本。硬切产生的片段之间没有空格，用换行分隔更安全。
 * @param {string[]} parts
 */
export function joinSegments(parts) {
  return (parts ?? []).filter(part => typeof part === 'string' && part.trim()).join('\n');
}

/**
 * 按段调用翻译函数并汇报进度。长文本分段处理，不做静默截断。
 * @param {string} text
 * @param {(segment: string) => Promise<string>} runSegment
 * @param {{onProgress?: (progress: {percent:number, label:string}) => void, limit?: number}} options
 * @returns {Promise<{text: string, segments: number}>}
 */
export async function translateInSegments(text, runSegment, { onProgress, limit = SEGMENT_LIMIT } = {}) {
  const plan = planTranslation(text, limit ?? SEGMENT_LIMIT);
  if (!plan.ok) throw new Error(plan.message);

  if (plan.segments.length === 1) {
    return { text: await runSegment(plan.segments[0]), segments: 1 };
  }

  onProgress?.({ percent: 0, label: `内容较长，将分 ${plan.segments.length} 段翻译…` });
  const parts = [];
  for (let index = 0; index < plan.segments.length; index++) {
    onProgress?.({
      percent: Math.round((index / plan.segments.length) * 100),
      label: `翻译第 ${index + 1}/${plan.segments.length} 段…`
    });
    parts.push(await runSegment(plan.segments[index]));
  }
  onProgress?.({ percent: 100, label: `已分 ${plan.segments.length} 段完成` });
  return { text: joinSegments(parts), segments: plan.segments.length };
}
