/**
 * 上下文投影：把不再需要的旧正文折成一条合成消息。
 *
 * 只追加不删除的「记忆注入」救不了长会话——旧正文永远在上下文里，插件只是又叠了一层。
 * 这里做的是投影的另一半：删。但删是有前提的：
 * 1. 只折「最近 keepRecentTurns 条之前」的部分，最后一条 user 消息永不丢；
 * 2. tool-call 与它的 tool-result 必须成对留或成对折，判不出配对就整对保留；
 * 3. 整个函数是纯函数：同样的输入永远同样的输出（幂等由此而来）。
 * 折掉的正文不是被遗忘：store 里的记录还在，折叠消息里会写清楚怎么找回。
 */

import { estimateTokens } from "../budget.mjs";

/** 投影默认值；与 config.mjs 的 CONFIG_DEFAULTS.projection 保持一致。 */
export const PROJECTION_DEFAULTS = Object.freeze({
  enabled: true,
  triggerTokens: 6000,
  keepRecentTurns: 8,
  maxFoldedTokens: 400,
});

/** 折叠消息的来源标记：同一条链上只允许存在一条。 */
export const FOLD_SOURCE = "dsh-mnemos-fold";

const POINT_CHAR_CAP = 60;
const MAX_POINTS = 8;

function num(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

function safeJson(value) {
  try {
    return JSON.stringify(value) || "";
  } catch {
    return "";
  }
}

/** 一条消息对模型可见的文本（工具调用把名字与参数算进去，否则折叠前后 token 不可比）。 */
export function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (typeof block.text === "string") parts.push(block.text);
    else if (block.type === "tool-call") parts.push(String(block.name || "") + " " + safeJson(block.arguments));
  }
  return parts.join("\n");
}

/** 一批消息的 token 合计（口径与注入预算完全一致）。 */
export function messagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) total += estimateTokens(messageText(message));
  return total;
}

/** 是否是本模块产出的折叠消息。 */
export function isFoldMessage(message) {
  return Boolean(message && message.source && message.source.kind === FOLD_SOURCE);
}

function callIds(message) {
  const content = message && message.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (block && block.type === "tool-call" && block.id != null) out.push(String(block.id));
  }
  return out;
}

function resultCallId(message) {
  if (!message || typeof message !== "object") return "";
  if (message.toolCallId != null) return String(message.toolCallId);
  const source = message.source;
  if (source && source.callId != null) return String(source.callId);
  return "";
}

/**
 * 收集 tool-call / tool-result 的配对跨度。
 * 只有调用没有结果时按「单点跨度」返回，交给边界修复去保留它。
 */
export function toolPairs(messages) {
  const calls = new Map();
  const idless = [];
  const results = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    const content = messages[i] && messages[i].content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || block.type !== "tool-call") continue;
        if (block.id == null) {
          idless.push(i);
          continue;
        }
        const id = String(block.id);
        if (!calls.has(id)) calls.set(id, i);
      }
    }
    const resultId = resultCallId(messages[i]);
    if (resultId && !results.has(resultId)) results.set(resultId, i);
  }
  const spans = [];
  for (const [id, callIndex] of calls) {
    const resultIndex = results.get(id);
    if (resultIndex === undefined) {
      // 只有调用没有结果（中断/在飞）：没有配对可言，折叠它不破坏协议
      spans.push({ id, start: callIndex, end: callIndex });
      continue;
    }
    spans.push({ id, start: Math.min(callIndex, resultIndex), end: Math.max(callIndex, resultIndex) });
  }
  // 判不出配对的两种：有结果没调用、调用没有 id —— 一律整条保留
  const undecidable = [];
  for (const [id, resultIndex] of results) if (!calls.has(id)) undecidable.push(resultIndex);
  for (const index of idless) undecidable.push(index);
  return { spans, undecidable };
}

/**
 * 边界修复：把 b 挪到「不切开任何一对工具调用」的位置。
 * 跨度跨界时优先整对保留（b = end + 1）；若那样会把最后一条 user 消息卷进折叠区，
 * 就退而整对折叠（b = start）——宁可少省，不许破坏协议。
 * 判不出配对的条目（有结果没调用、调用没有 id）一律留在保留区。
 */
export function repairBoundary(messages, boundary, lastUser) {
  let b = Math.max(0, Math.min(boundary, messages.length));
  const pairs = toolPairs(messages);
  for (let pass = 0; pass < 4; pass += 1) {
    let moved = false;
    for (const span of pairs.spans) {
      if (span.start >= b) continue; // 整对都在保留区
      if (span.end < b) continue; // 整对都在折叠区
      if (span.end < lastUser) b = span.end + 1;
      else b = span.start;
      moved = true;
    }
    for (const index of pairs.undecidable) {
      if (index >= b) continue;
      b = index;
      moved = true;
    }
    if (!moved) break;
  }
  return Math.max(0, Math.min(b, messages.length));
}

/** 折叠消息正文：条数 + 可安全提取的要点；总长受 maxFoldedTokens 约束。 */
export function buildFoldText(foldedCount, records, maxFoldedTokens) {
  const header =
    "[上下文投影] 更早的 " + foldedCount + " 条消息已折叠以节省上下文。" +
    "这不是遗忘：原文与要点仍在本地记忆库里（可用 mem_search 找回），需要细节时先检索再回答，别凭印象补全。";
  const limit = Math.max(0, Math.floor(num(maxFoldedTokens, PROJECTION_DEFAULTS.maxFoldedTokens)));
  let text = header;
  if (estimateTokens(text) >= limit) return text;
  const lines = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (lines.length >= MAX_POINTS) break;
    const body = clip(record && record.text, POINT_CHAR_CAP);
    if (!body) continue;
    const next = text + "\n· " + body;
    if (estimateTokens(next) > limit) break;
    text = next;
    lines.push(body);
  }
  return text;
}

/**
 * 算一次投影。
 * @param {{messages: Array, records?: Array, config?: object, now?: number}} input 输入。
 * @returns {{changed: boolean, messages: Array, stats: object}} 结果（changed=false 时 messages 原样返回）。
 */
export function projectMessages(input = {}) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const config = (input.config && input.config.projection) || {};
  const unchanged = {
    changed: false,
    messages: input.messages,
    stats: { folded: 0, foldedTokens: 0, kept: messages.length, before: messagesTokens(messages), after: messagesTokens(messages), enabled: config.enabled !== false },
  };
  if (config.enabled === false) return unchanged;
  if (messages.length === 0) return unchanged;
  // 已经折过一次就不再折：重复执行 pre-step 不会叠出第二条折叠消息
  if (messages.some(isFoldMessage)) return unchanged;

  const trigger = Math.max(0, Math.floor(num(config.triggerTokens, PROJECTION_DEFAULTS.triggerTokens)));
  const before = messagesTokens(messages);
  if (before <= trigger) return unchanged;

  const keepRecent = Math.max(0, Math.min(messages.length, Math.floor(num(config.keepRecentTurns, PROJECTION_DEFAULTS.keepRecentTurns))));
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }

  let boundary = Math.max(0, messages.length - keepRecent);
  if (lastUser >= 0) boundary = Math.min(boundary, lastUser);
  boundary = repairBoundary(messages, boundary, lastUser);
  if (boundary <= 0) return unchanged;
  // 边界之后只剩折叠消息本身，没有可折的东西
  if (boundary >= messages.length) return unchanged;

  const foldedMessages = messages.slice(0, boundary);
  const keptMessages = messages.slice(boundary);
  const foldText = buildFoldText(foldedMessages.length, input.records, config.maxFoldedTokens);
  const fold = {
    id: "mnemos-fold-" + foldedMessages.length + "-" + estimateTokens(foldText).toString(36),
    role: "user",
    content: [{ type: "text", text: foldText }],
    source: { kind: FOLD_SOURCE, folded: foldedMessages.length },
  };
  const next = [fold, ...keptMessages];
  const after = messagesTokens(next);
  return {
    changed: true,
    messages: next,
    stats: {
      folded: foldedMessages.length,
      foldedTokens: estimateTokens(foldText),
      kept: keptMessages.length,
      before,
      after,
      enabled: true,
    },
  };
}
