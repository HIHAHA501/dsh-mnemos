/**
 * 检索 → 排序 → 预算裁剪 → 渲染成给模型看的注入块，外加每轮 token 计账。
 *
 * 两条口径在这里定死，别处不许再算一遍：
 * - 相关性：core 的 heatOf 统一热度，检索层只负责加权融合；
 * - 预算：一律用 core 的 estimateTokens，渲染完还要复核一次总花费。
 */

import { estimateTokens, project } from "../budget.mjs";
import { heatOf } from "../heat.mjs";
import { createBm25 } from "../retrieval/bm25.mjs";
import { rank } from "../retrieval/hybrid.mjs";
import { createMetaIndex } from "../retrieval/metadata.mjs";
import { createVector } from "../retrieval/vector.mjs";
import { messageText } from "./ingest.mjs";
import { decide, renderHint, renderReference } from "./proactive.mjs";

/** 单个注入块的字数上限：块是给模型读的提示，不是把记忆库倒进上下文。 */
export const INJECT_CHAR_CAP = 600;

/** 注入块的第一句：这是指令，不是数据。 */
export const INSTRUCTION = "[记忆] 下面是你在这段关系里记得的事。对得上就用，用不上就别硬提；不确定就说不确定，别编。";

const PERSISTENT_TIERS = Object.freeze(["persona", "state"]);
const ITEM_CHAR_CAP = 160;
const MAX_MEMORY_ITEMS = 8;
const MAX_PERSISTENT_ITEMS = 6;
const RECALL_LIMIT = 5;
const RECALL_CHAR_CAP = 80;
const DROPPED_LIMIT = 20;
const RANK_POOL = 48;

function clip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

function dayOf(stamp) {
  const value = Number(stamp);
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

function isPersistent(record) {
  return Boolean(record) && PERSISTENT_TIERS.includes(record.tier);
}

/* ------------------------------------------------------------------ 索引 */

/**
 * 建检索索引（bm25 + 元数据 + 可选向量）。
 * 向量只探状态、不建库：宿主面是同步的，逐条 embed 会把每轮对话拖成网络请求。
 * @param {object} options 依赖。
 * @returns {object} 索引句柄。
 */
export function createRetrievalIndex(options = {}) {
  const config = options.config || {};
  const note = typeof options.note === "function" ? options.note : () => {};
  const bm25 = createBm25();
  const metaIndex = createMetaIndex();
  const known = new Set();

  let vector = null;
  try {
    vector = createVector({ config, log: (message) => note(String(message)) });
  } catch (error) {
    note("向量层初始化失败，已按纯关键词检索继续：" + (error && error.message ? error.message : String(error)));
    vector = null;
  }

  function add(record) {
    if (!record || record.id == null) return;
    if (record.mergedInto) {
      remove(record.id);
      return;
    }
    try {
      bm25.add(record);
      metaIndex.add(record);
      known.add(record.id);
    } catch (error) {
      note("索引写入失败，这条记录只能靠热度召回：" + (error && error.message ? error.message : String(error)));
    }
  }

  function remove(id) {
    if (id == null || !known.has(id)) return;
    try {
      bm25.remove(id);
      metaIndex.remove(id);
    } catch {
      // 索引删不掉只是浪费一次倒排命中，不值得中断写入
    }
    known.delete(id);
  }

  /** 全量重建：合并改了正文与 mergedInto，留着旧倒排会指向已经被并掉的记录。 */
  function reload(records) {
    for (const id of [...known]) remove(id);
    load(records);
  }

  function load(records) {
    if (!Array.isArray(records)) return 0;
    let count = 0;
    for (const record of records) {
      if (!record || record.mergedInto) continue;
      add(record);
      count += 1;
    }
    return count;
  }

  function vectorStatus() {
    try {
      if (vector && typeof vector.status === "function") return vector.status();
    } catch {
      // 探测失败按关闭处理
    }
    return { state: "off", reason: vector ? "status-failed" : "unavailable" };
  }

  function stats() {
    const bm = typeof bm25.stats === "function" ? bm25.stats() : { docs: 0, terms: 0 };
    let meta = 0;
    try {
      meta = typeof metaIndex.size === "function" ? metaIndex.size() : 0;
    } catch {
      meta = 0;
    }
    return { docs: bm.docs, terms: bm.terms, meta, vector: vectorStatus() };
  }

  return { bm25, metaIndex, vector, add, remove, reload, load, stats, vectorStatus };
}

/* ------------------------------------------------------------------ 排序 */

/** 热度口径统一到 core：检索层内部那份本地近似只是兜底。 */
function safeHeat(record, at) {
  try {
    return heatOf(record, at);
  } catch {
    return 0;
  }
}

/**
 * 排序一批候选记录。
 * @param {object} input 查询、候选、索引。
 * @returns {Array} 排序结果行。
 */
export function rankRecords(input = {}) {
  // persona/state 是「设定」不是「往事」：它们由 [人设与状态] 段或外部人格插件负责，
  // 混进检索会让同一段文字注入两遍，也会让主动召回用「我想起…」复述人格
  const records = Array.isArray(input.records)
    ? input.records.filter((record) => record && !record.mergedInto && !isPersistent(record))
    : [];
  if (!records.length) return [];
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const rows = rank({
    query: typeof input.query === "string" ? input.query : "",
    records,
    metaIndex: input.index ? input.index.metaIndex : undefined,
    bm25: input.index ? input.index.bm25 : undefined,
    // 向量不可用时传 null：rank 已经把这份权重按 bm25:meta 的原有比例并回去
    vectors: null,
    now,
    heatOf: safeHeat,
    // 情绪与权重都由调用方给：没人传 mood 时 rank 把它整份排除在归一之外
    mood: input.mood,
    weights: input.weights,
  });
  const limit = Number.isFinite(input.limit) ? Math.max(0, Math.floor(input.limit)) : rows.length;
  return rows.slice(0, limit);
}

/* ------------------------------------------------------------------ 渲染 */

/** 按「标题 + 若干行」拼块，逐行收字/收 token 双上限；放不下的行整行丢，不切半句。 */
function fitBlock(title, lines, limits) {
  const kept = [];
  for (const line of lines) {
    if (kept.length >= limits.maxLines) break;
    if (title.length + 1 + kept.join("\n").length + 1 + line.length > INJECT_CHAR_CAP) break;
    kept.push(line);
  }
  // token 上限按「拼好的整块」实测：逐行估算会漏掉标题和每行多出来的换行
  const build = () => (kept.length ? title + "\n" + kept.join("\n") : "");
  while (kept.length > 0 && limits.tokens !== undefined && estimateTokens(build()) > limits.tokens) kept.pop();
  const text = build();
  return { text, lines: kept.slice(), tokens: text ? estimateTokens(text) : 0 };
}

/** dropped 是给面板看的账：上限 20 条、同 id 同原因只记一次。 */
function pushDrop(dropped, id, reason) {
  if (!Array.isArray(dropped) || dropped.length >= DROPPED_LIMIT) return;
  const key = String(id);
  if (dropped.some((item) => item.id === key && item.reason === reason)) return;
  dropped.push({ id: key, reason });
}

function renderPersistent(records, options = {}) {
  const budget = Math.max(0, Math.floor(Number(options.budget) || 0));
  const dropped = Array.isArray(options.dropped) ? options.dropped : [];
  const entries = [];
  for (const record of records) {
    if (!isPersistent(record) || record.mergedInto) continue;
    entries.push({ id: record.id, line: "· " + clip(record.text, ITEM_CHAR_CAP) });
  }
  const fitted = fitBlock("[人设与状态] 这些是长期成立的前提，回答时保持一致。", entries.map((entry) => entry.line), {
    tokens: budget,
    maxLines: MAX_PERSISTENT_ITEMS,
  });
  // 顺序即优先级：超出 hotTokenBudget 的从尾部裁，并记下是谁被裁的
  for (let i = fitted.lines.length; i < entries.length; i += 1) pushDrop(dropped, entries[i].id, "hot-budget");
  return { text: fitted.text, tokens: fitted.tokens };
}

function renderMemories(rows, options) {
  const budget = Math.max(0, Math.floor(Number(options.budget) || 0));
  const topN = Number.isFinite(options.topN) ? options.topN : MAX_MEMORY_ITEMS;
  const floor = Number.isFinite(options.noiseFloor) ? options.noiseFloor : 0;
  const dropped = Array.isArray(options.dropped) ? options.dropped : [];
  const eligible = [];
  for (const row of rows) {
    if (!row || !row.record || row.record.mergedInto) continue;
    if (isPersistent(row.record)) continue;
    // 噪声档不进上下文：留着它只会让模型把「碰巧有点热」当成相关
    if (Number(row.score) <= floor) {
      pushDrop(dropped, row.record.id, "noise");
      continue;
    }
    eligible.push(row);
  }
  if (!eligible.length || budget <= 0) return { text: "", picks: [], tokens: 0 };

  const slots = Math.max(1, Math.min(MAX_MEMORY_ITEMS, topN));
  const projected = project(
    eligible.map((row) => row.record),
    { budget, topN: slots, now: options.now }
  );

  for (const item of projected.dropped) pushDrop(dropped, item.id, item.reason || "budget");

  const title = "[相关记忆] 这些是你记得的往事，用来对照，不要照抄。";
  let picks = projected.picks.slice();
  const lines = picks.map((record) => {
    const day = dayOf(record.createdAt);
    return "· " + (day ? day + " " : "") + clip(record.text, ITEM_CHAR_CAP);
  });
  const fitted = fitBlock(title, lines, { tokens: budget, maxLines: slots });
  // 投影按 record.text 估花费，渲染还多了日期与符号：按整块实测结果再收一次
  while (picks.length > fitted.lines.length) {
    const removed = picks[picks.length - 1];
    pushDrop(dropped, removed.id, "budget");
    picks = picks.slice(0, -1);
  }
  return { text: fitted.text, picks, tokens: fitted.tokens };
}

/**
 * 渲染这一轮该注入的全部内容。
 * 三段顺序固定：人设/状态（仅 companion）→ 相关记忆 → 主动召回提示。
 * @param {object} options 输入。
 * @returns {{text: string, tokens: number, blocks: string[], picks: Array, decision: object, rows: Array}} 渲染结果。
 */
export function renderInjection(options = {}) {
  const config = options.config || {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  // 两笔预算各管各的：人设/状态吃 hotTokenBudget，召回+提示吃 injectTokenBudget。
  // 合计是硬上限，所以「人设一直成立」不会被这一轮的召回挤掉，召回也不会被它吞掉。
  const injectBudget = Math.max(0, Math.floor(Number(config.injectTokenBudget) || 0));
  const hotBudget = Math.max(0, Math.floor(Number(config.hotTokenBudget) || 0));
  const totalBudget = injectBudget + hotBudget;
  const records = Array.isArray(options.records) ? options.records : [];
  const proactive = config.proactive || {};

  const ranked = options.ranked
    ? options.ranked
    : rankRecords({ query: options.query, records, index: options.index, now, limit: RANK_POOL, mood: options.mood, weights: options.weights });
  // 调用方直接塞 ranked 时也要挡住常驻层：top 决定主动召回档位，不能是设定
  const rows = Array.isArray(ranked) ? ranked.filter((row) => row && row.record && !isPersistent(row.record)) : [];
  const top = rows[0] || null;

  let decision;
  if (proactive.enabled === false) decision = { state: "silence", score: top ? top.score : 0, reason: "disabled" };
  else if (!top) decision = { state: "silence", score: 0, reason: "no-candidate" };
  else decision = decide({ score: top.score, config, text: top.record.text });

  const dropped = [];
  // 面板要「最近 5 条召回」，所以排序结果留个短投影；正文裁到 80 字，不把整库带出进程
  const recalls = rows.slice(0, RECALL_LIMIT).map((row) => ({
    id: String(row.record.id),
    text: clip(row.record.text, RECALL_CHAR_CAP),
    score: Number(Number(row.score).toFixed(3)),
  }));
  const empty = { text: "", tokens: 0, hotTokens: 0, injectTokens: 0, blocks: [], picks: [], decision, rows, dropped, recalls };

  /** 主动召回块：记忆块里已经有这条时只提醒「该不该提」，不重复正文。 */
  const pickHint = (memories) => {
    if (decision.state === "silence" || !top) return null;
    const referenced = Array.isArray(memories.picks) && memories.picks.some((record) => record.id === top.record.id);
    return referenced ? renderReference(decision) : renderHint(decision, top.record);
  };

  // 召回预算连指令行都装不下时，只砍召回这一段；人设段有它自己的预算，照旧渲染
  let left = injectBudget;
  const instructionCost = estimateTokens(INSTRUCTION);
  const withInstruction = instructionCost <= left;
  if (withInstruction) left -= instructionCost;
  const instruction = withInstruction ? INSTRUCTION : "";

  // 人设/状态段只花 hotTokenBudget，且不占用 left（那是召回的钱）
  // 人格桥接处于 external 时：人格注入归别的插件，这段不渲染、hotTokenBudget 也不消费。
  const personaExternal = Boolean(config.persona) && config.persona.mode === "external";
  let persistent = "";
  let hotTokens = 0;
  if (config.mode === "companion" && !personaExternal) {
    const fittedHot = renderPersistent(records, { budget: hotBudget, dropped });
    persistent = fittedHot.text;
    hotTokens = fittedHot.tokens;
  }

  const memoryOptions = {
    budget: withInstruction ? left : 0,
    topN: config.topN,
    noiseFloor: proactive.noiseFloor,
    now,
    dropped,
  };
  let memories = renderMemories(rows, memoryOptions);

  // 提示是搭头，事实是内容：两样只能要一样时先丢提示，不要为了一句提醒把记忆挤出上下文
  let hint = pickHint(memories);
  if (hint && memories.tokens + estimateTokens(hint) > left) hint = memories.picks.length > 0 ? null : hint;
  if (hint && memories.tokens + estimateTokens(hint) > left) hint = null;

  const compose = (memoryText, hintText) =>
    [instruction, persistent, memoryText, hintText].filter((part) => part && part.length > 0).join("\n\n");

  let memoryText = memories.text;
  let picks = memories.picks.slice();
  let text = compose(memoryText, hint);
  let tokens = estimateTokens(text);

  // 预算不许靠「估算大概能过」：超了就一条条回退到真的过为止（合计上限 = hot + inject）
  const lines = memoryText ? memoryText.split("\n") : [];
  while (tokens > totalBudget && picks.length > 0) {
    const removed = picks[picks.length - 1];
    pushDrop(dropped, removed.id, "budget");
    picks = picks.slice(0, -1);
    lines.pop();
    memoryText = picks.length > 0 ? lines.join("\n") : "";
    // 第一条被裁掉时「上面第一条」就没有指代对象了：宁可不提，也不说一句指空的话
    if (hint && top && !picks.some((record) => record.id === top.record.id)) hint = null;
    text = compose(memoryText, hint);
    tokens = estimateTokens(text);
  }
  if (tokens > totalBudget) {
    // 兜底：三段的钱都是各算各的，走到这里说明口径又被谁改了——宁可少注入
    hint = null;
    text = compose(memoryText, null);
    tokens = estimateTokens(text);
  }
  if (tokens > totalBudget) {
    // 连固定部分都放不下（预算被调到极小）：宁可不注入，也不超预算
    return { ...empty, decision, rows };
  }

  const blocks = [persistent, memoryText, hint].filter((part) => part && part.length > 0);
  const injectTokens = Math.max(0, tokens - hotTokens);
  return { text, tokens, hotTokens, injectTokens, blocks, picks, decision, rows, dropped, recalls };
}

/* ------------------------------------------------------------- 计账/会话 */

/**
 * 每轮注入的 token 计账：/mem budget 与 /mem status 都从这一份读，
 * 不在别处另开计数器，否则两个数会各说各话。
 * @param {object} options 依赖。
 * @returns {object} 计账句柄。
 */
export function createLedger(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const totals = { turns: 0, tokens: 0, skipped: 0 };
  const sessions = new Map();
  let last = null;

  /** 投影账：只留面板与 /mem status 要的三个数，外加折叠前后的规模。 */
  function projectionOf(value) {
    if (!value || typeof value !== "object") return null;
    const folded = Number.isFinite(value.folded) ? Math.max(0, Math.floor(value.folded)) : 0;
    if (folded <= 0) return null;
    return {
      folded,
      foldedTokens: Number.isFinite(value.foldedTokens) ? Math.max(0, Math.floor(value.foldedTokens)) : 0,
      kept: Number.isFinite(value.kept) ? Math.max(0, Math.floor(value.kept)) : 0,
      before: Number.isFinite(value.before) ? Math.max(0, Math.floor(value.before)) : 0,
      after: Number.isFinite(value.after) ? Math.max(0, Math.floor(value.after)) : 0,
    };
  }

  // /mem status 直接打印 state，所以把投影的三个数压进这一格：命令层的渲染不归这里改
  function stateLabel(entry) {
    const base = entry.decision ? entry.decision.state : "silence";
    const folded = projectionOf(entry.projection);
    if (!folded) return base;
    return base + " · 投影 folded=" + folded.folded + " foldedTokens=" + folded.foldedTokens + " kept=" + folded.kept;
  }

  function record(sessionId, entry = {}) {
    const tokens = Number.isFinite(entry.tokens) ? Math.max(0, Math.floor(entry.tokens)) : 0;
    totals.turns += 1;
    totals.tokens += tokens;
    // last 是面板唯一的数据来源：预算、被裁的原因、召回投影都记在这一份里
    last = {
      sessionId: typeof sessionId === "string" ? sessionId : "",
      tokens,
      hotTokens: Number.isFinite(entry.hotTokens) ? Math.max(0, Math.floor(entry.hotTokens)) : 0,
      injectTokens: Number.isFinite(entry.injectTokens) ? Math.max(0, Math.floor(entry.injectTokens)) : tokens,
      budget: Number.isFinite(entry.budget) ? Math.max(0, Math.floor(entry.budget)) : 0,
      picks: Array.isArray(entry.picks) ? entry.picks.length : 0,
      dropped: Array.isArray(entry.dropped) ? entry.dropped.slice(0, DROPPED_LIMIT) : [],
      recalls: Array.isArray(entry.recalls) ? entry.recalls.slice(0, RECALL_LIMIT) : [],
      projection: projectionOf(entry.projection),
      state: stateLabel(entry),
      at: now(),
    };
    if (typeof sessionId === "string" && sessionId) {
      const current = sessions.get(sessionId) || { turns: 0, tokens: 0 };
      current.turns += 1;
      current.tokens += tokens;
      sessions.set(sessionId, current);
    }
    return last;
  }

  function skip() {
    totals.skipped += 1;
  }

  function snapshot() {
    return {
      ...totals,
      last,
      sessions: [...sessions.entries()].map(([id, value]) => ({ sessionId: id, ...value })),
    };
  }

  return { record, skip, snapshot };
}

/** 会话事件，容忍 events 数组与 snapshotEvents() 两种形态。 */
function sessionEvents(session) {
  try {
    if (Array.isArray(session && session.events)) return session.events;
    if (session && typeof session.snapshotEvents === "function") return session.snapshotEvents() || [];
  } catch {
    // 读不到历史就当没有
  }
  return [];
}

/**
 * 本轮查询文本：最后一条用户消息。
 * 从后往前找并立刻返回，不做整段历史扫描。
 * @param {object} session 会话。
 * @returns {string} 查询文本。
 */
export function latestUserText(session) {
  const events = sessionEvents(session);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || event.type !== "user/message") continue;
    const text = messageText(event.data);
    if (text) return text;
  }
  return "";
}

export { sessionEvents };
