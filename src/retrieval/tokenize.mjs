// 中文检索分词：CJK 连续串切 1-gram + 2-gram，其余按拉丁/数字词切。
// 不引第三方分词器：uni+bi 对中文召回够用，且零依赖、可解释、可测。

const MAX_INPUT_CHARS = 10000;
const MAX_TOKEN_LEN = 32;

const WORD_RE = /[\p{L}\p{N}]/u;

const stats = { calls: 0, truncatedInputs: 0, truncatedTokens: 0 };

// 与共享契约 §5 的 cjkChars 口径一致：表意字 / 假名 / 韩文音节（不含 jamo）。
function isCjkCode(c) {
  return (
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0x3040 && c <= 0x309f) ||
    (c >= 0x30a0 && c <= 0x30ff) ||
    (c >= 0xac00 && c <= 0xd7af)
  );
}

function isAsciiWordCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

export function tokenize(text) {
  stats.calls++;
  if (text == null) return [];
  let s = typeof text === 'string' ? text : String(text);
  if (s.length > MAX_INPUT_CHARS) {
    s = s.slice(0, MAX_INPUT_CHARS);
    stats.truncatedInputs++;
  }
  if (!s) return [];

  const out = [];
  let cjk = '';
  let word = '';

  const flushWord = () => {
    if (!word) return;
    let t = word.toLowerCase();
    // 超长串（base64 / 无空格英文）会撑爆倒排表，截断成单一上界长度即可
    if (t.length > MAX_TOKEN_LEN) {
      t = t.slice(0, MAX_TOKEN_LEN);
      stats.truncatedTokens++;
    }
    out.push(t);
    word = '';
  };

  const flushCjk = () => {
    if (!cjk) return;
    const n = cjk.length;
    for (let i = 0; i < n; i++) out.push(cjk[i]);
    for (let i = 0; i + 1 < n; i++) out.push(cjk.slice(i, i + 2));
    cjk = '';
  };

  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isCjkCode(c)) {
      flushWord();
      cjk += s[i];
    } else if (isAsciiWordCode(c) || (c > 127 && WORD_RE.test(s[i]))) {
      flushCjk();
      word += s[i];
    } else {
      flushWord();
      flushCjk();
    }
  }
  flushWord();
  flushCjk();
  return out;
}

// 输入截断次数要能被 /mem status 与测试读到；挂成函数属性不改变 tokenize(text) -> string[]
tokenize.stats = () => ({ ...stats });
tokenize.resetStats = () => {
  stats.calls = 0;
  stats.truncatedInputs = 0;
  stats.truncatedTokens = 0;
};
tokenize.MAX_INPUT_CHARS = MAX_INPUT_CHARS;
tokenize.MAX_TOKEN_LEN = MAX_TOKEN_LEN;
