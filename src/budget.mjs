/**
 * token 预算与上下文投影。
 * 估算口径必须和检索层、宿主注入层逐字一致，否则预算算的是另一门语言的字数；
 * 所以这里不用 tiktoken 之类的外部包，只用一条可复现的公式。
 */

const WORD_PATTERN = /[A-Za-z0-9]+/g;
const PUNCT_PATTERN = /[\p{P}\p{S}]/u;

function isCjk(codePoint) {
  return (
    (codePoint >= 0x3005 && codePoint <= 0x3007) ||
    (codePoint >= 0x3040 && codePoint <= 0x30ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0x3130 && codePoint <= 0x318f) ||
    (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
  );
}

/** 拆开算而不是只给一个数：口径有争议时能直接指到是哪一项不对。 */
export function tokenParts(text) {
  const source = typeof text === "string" ? text : String(text == null ? "" : text);
  let cjk = 0;
  let punct = 0;
  for (const char of source) {
    const codePoint = char.codePointAt(0);
    if (isCjk(codePoint)) cjk += 1;
    else if (PUNCT_PATTERN.test(char)) punct += 1;
  }
  const words = source.match(WORD_PATTERN);
  return { cjk, words: words ? words.length : 0, punct };
}

export function estimateTokens(text) {
  const parts = tokenParts(text);
  return Math.ceil(parts.cjk * 1.0 + parts.words + parts.punct * 0.3);
}

function isPersistent(record) {
  return record.tier === "persona" || record.tier === "state";
}

/**
 * records 必须已按 score 排好序（排序是检索层的职责），这里只做贪心裁剪。
 * persona/state 是「一直成立的前提」：预算再紧也不裁，否则模型会忘掉自己是谁。
 */
export function project(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const budget = Number.isFinite(options.budget) ? options.budget : Infinity;
  const topN = Number.isFinite(options.topN) ? Math.max(0, Math.floor(options.topN)) : Infinity;
  // options.now 只为与调用方口径一致而存在：排序在上游就做完了，这里不再按时间重排
  const picks = [];
  const dropped = [];
  const seenIds = new Set();
  const reported = new Set();
  let tokens = 0;

  // 同一条记录只报一次：重复的 dropped 会让上层把「裁掉的条数」算重
  function drop(record, reason) {
    if (reported.has(record.id)) return;
    reported.add(record.id);
    dropped.push({ id: record.id, reason });
  }

  for (const record of list) {
    if (!record || typeof record !== "object") continue;
    // 这里只挑人，不报 dropped：dropped 要按输入顺序出，才配得回调用方的列表
    if (record.mergedInto || seenIds.has(record.id)) continue;
    if (!isPersistent(record)) continue;
    seenIds.add(record.id);
    picks.push(record);
    tokens += estimateTokens(record.text);
  }

  // 槽位按 topN 算，但 persona/state 已经占掉的位置不能被要回来
  const slots = Math.max(topN, picks.length);

  for (const record of list) {
    if (!record || typeof record !== "object") continue;
    if (seenIds.has(record.id)) continue;
    // mergedInto 的记录已由 keep 代表，同一条记忆不该在上下文里出现两次
    if (record.mergedInto || seenIds.has(record.mergedInto)) {
      drop(record, "dup");
      continue;
    }
    if (isPersistent(record)) continue;
    if (picks.length >= slots) {
      drop(record, "topN");
      continue;
    }
    const cost = estimateTokens(record.text);
    if (tokens + cost > budget) {
      drop(record, "budget");
      continue;
    }
    seenIds.add(record.id);
    picks.push(record);
    tokens += cost;
  }

  return { picks, tokens, dropped };
}
