// 融合排序：bm25 + 元数据亲和 + 向量 + 热度的加权和，分量各自归一到 0..1 后加权。
// 向量缺席时把那部分权重按 bm25:meta 的原有比例并入，避免凭空放大单侧。

import { tokenize } from './tokenize.mjs';
import { cosine } from './vector.mjs';

export const DEFAULT_WEIGHTS = { bm25: 0.55, meta: 0.25, vector: 0.15, heat: 0.05 };
export const MAX_RESULTS = 50;
// 单字 CJK 命中只参与打分、不授予候选资格：否则「计划」里的「计」会让查询
// 「量子计算机」召回讲「杭州计划」的记忆——用户问 A、她提 B，比漏召更伤信任
export const UNI_GRAM_WEIGHT = 0.35;
// 向量通道的候选下限：低于它说明"语义上也不近"，不授予候选资格
export const DEFAULT_VECTOR_FLOOR = 0.35;

const KEYS = ['bm25', 'meta', 'vector', 'heat'];
// 与 tokenize.mjs 的 CJK 口径保持一致：只有单字 CJK 才算 uni-gram
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
const isUniGram = (t) => t.length === 1 && CJK_CHAR.test(t);

const num = (v, d = 0) => (Number.isFinite(v) ? Number(v) : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function effectiveWeights(weights, hasVector = true) {
  const src = weights || {};
  const raw = {};
  let total = 0;
  for (const k of KEYS) {
    raw[k] = Math.max(0, num(src[k], DEFAULT_WEIGHTS[k]));
    total += raw[k];
  }
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };
  const base = {};
  for (const k of KEYS) base[k] = raw[k] / total;
  if (hasVector) return base;
  const share = base.vector;
  const pool = base.bm25 + base.meta;
  if (!(pool > 0)) {
    return { bm25: share / 2, meta: share / 2, vector: 0, heat: base.heat };
  }
  return {
    bm25: base.bm25 + share * (base.bm25 / pool),
    meta: base.meta + share * (base.meta / pool),
    vector: 0,
    heat: base.heat,
  };
}

function lookupFrom(container) {
  if (!container) return null;
  if (typeof container.get === 'function') return (id) => container.get(id) ?? null;
  if (Array.isArray(container)) {
    const m = new Map();
    for (const item of container) {
      if (item && item.id != null) m.set(String(item.id), item.vector ?? item.embedding ?? null);
      else if (Array.isArray(item)) m.set(String(m.size), item);
    }
    return (id) => m.get(String(id)) ?? null;
  }
  if (typeof container === 'object') return (id) => container[id] ?? container[String(id)] ?? null;
  return null;
}

// vectors 的可接受形状：{query,get} / {query,map|vectors} / Map(+.query) / 普通对象(+.query)
function readVectors(vectors) {
  if (!vectors) return null;
  const q = vectors.query ?? vectors.queryVector ?? vectors.q ?? null;
  const queryVec = Array.isArray(q) ? q : null;
  let get = null;
  if (typeof vectors.get === 'function') get = (id) => vectors.get(id) ?? null;
  else if (vectors.vectors) get = lookupFrom(vectors.vectors);
  else if (vectors.map) get = lookupFrom(vectors.map);
  else if (Array.isArray(vectors)) get = lookupFrom(vectors);
  else if (typeof vectors === 'object') get = lookupFrom(vectors);
  return { queryVec, get };
}

function metaBlob(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const parts = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
      return;
    }
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s) parts.push(s);
    } else if (typeof v === 'number') parts.push(String(v));
  };
  push(meta.place);
  push(meta.person);
  push(meta.object);
  push(meta.topic);
  return parts.join('\u0001');
}

function metaScore(record, queryTerms) {
  if (!queryTerms.length) return 0;
  const blob = metaBlob(record?.meta);
  if (!blob) return 0;
  let hit = 0;
  let total = 0;
  for (const t of queryTerms) {
    const w = t.length >= 2 ? 1 : 0.4; // 单字命中噪声大，权重压低
    total += w;
    if (blob.includes(t)) hit += w;
  }
  return total > 0 ? hit / total : 0;
}

// src/heat.mjs 由 S1-core 拥有；这里给同量纲的本地近似，避免跨模块耦合与加载顺序问题
function heatScore(record, now) {
  const t = Number(record?.updatedAt ?? record?.createdAt ?? 0) || 0;
  const days = t > 0 ? Math.max(0, (now - t) / 86400000) : 365;
  const recency = 1 / (1 + days / 7);
  const mentions = Math.min(1, Math.log1p(Math.max(0, Number(record?.mentions) || 0)) / Math.log1p(10));
  const weight = clamp01(Number(record?.weight ?? 0.5));
  const pinned = record?.pinned ? 1 : 0;
  return clamp01(0.35 * recency + 0.2 * mentions + 0.25 * weight + 0.2 * pinned);
}

export function rank({ query, records, metaIndex, bm25, vectors, now, weights, heatOf } = {}) {
  const list = Array.isArray(records) ? records.filter((r) => r && r.id != null) : [];
  if (!list.length) return [];

  const nowMs = Number.isFinite(now) ? now : Date.now();
  const queryText = typeof query === 'string' ? query : String(query ?? '');
  const queryTokens = tokenize(queryText);
  const queryTerms = [...new Set(queryTokens)];

  const vec = readVectors(vectors);
  const hasVector = !!(vec && vec.queryVec && vec.get);
  const w = effectiveWeights(weights, hasVector);

  // BM25 对查询词可加，所以「强词全额 + 单字 0.35×」与逐词调权等价，
  // 不必改动 bm25 模块的签名，也就不必改动它的单测
  const strongTerms = queryTerms.filter((t) => !isUniGram(t));
  const weakTerms = queryTerms.filter(isUniGram);
  const gating = strongTerms.length > 0 && !!bm25 && typeof bm25.score === 'function';
  const uniW = Number.isFinite(weights?.uni) ? clamp01(weights.uni) : UNI_GRAM_WEIGHT;
  const vectorFloor = Number.isFinite(weights?.vectorFloor) ? clamp01(weights.vectorFloor) : DEFAULT_VECTOR_FLOOR;
  // ② 元数据强信号：把查询整体当作线索值问一次索引（narrow 是双向包含匹配）。
  // narrow 返回 null（无线索 / 线索全落空）时本条不生效——不能退化成「有 meta 就算」，
  // 否则「杭州计划」会靠 meta 复活。
  const metaHitIds =
    gating && metaIndex && typeof metaIndex.narrow === 'function'
      ? metaIndex.narrow({ place: queryText, person: queryText, object: queryText, topic: queryText })
      : null;

  let strongHits = new Map();
  let weakHits = new Map();
  if (bm25 && typeof bm25.score === 'function' && queryTerms.length) {
    try {
      if (strongTerms.length) strongHits = bm25.score(strongTerms) || new Map();
      if (weakTerms.length) weakHits = bm25.score(weakTerms) || new Map();
    } catch {
      strongHits = new Map();
      weakHits = new Map();
    }
  }

  const rows = [];
  for (let i = 0; i < list.length; i++) {
    const record = list[i];
    const id = String(record.id);
    const parts = { bm25: 0, meta: 0, vector: 0, heat: 0 };
    const strongHit = strongHits.get(record.id) ?? strongHits.get(id) ?? 0;
    const weakHit = weakHits.get(record.id) ?? weakHits.get(id) ?? 0;
    let sim = 0;
    if (hasVector) {
      const v = vec.get(record.id) ?? vec.get(id);
      if (v) sim = cosine(vec.queryVec, v);
    }
    if (gating) {
      // 候选资格 = 三个通道任一给出强信号。只治「仅单字命中」这一种病：
      // ① 词面强命中 ② 元数据 narrow 命中 ③ 向量 ≥ vectorFloor。
      // 三项都是廉价判定（查表 / 一次点积），重活（matchScore、热度）留给存活者。
      // 未进索引的记录无从判定词面，放行而不是误杀（例如只做了存储投影的记录）
      const judgeable = typeof bm25.has === 'function' ? bm25.has(record.id) : true;
      const metaOk = !!metaHitIds && (metaHitIds.has(record.id) || metaHitIds.has(id));
      const vecOk = sim >= vectorFloor;
      if (judgeable && !strongHit && !metaOk && !vecOk) continue;
    }
    if (strongHit || weakHit) parts.bm25 = strongHit + uniW * weakHit;
    // 优先用元数据索引（记录可能只是存储投影、没有 meta 字段）；索引缺席或未收录时回落
    const fromIndex = metaIndex && typeof metaIndex.matchScore === 'function' ? metaIndex.matchScore(record.id, queryTerms) : null;
    parts.meta = fromIndex == null ? metaScore(record, queryTerms) : fromIndex;
    if (sim > 0) parts.vector = sim;
    parts.heat = typeof heatOf === 'function' ? heatOf(record, nowMs) : heatScore(record, nowMs);
    rows.push({ record, parts, order: i, score: 0, partsNorm: null });
  }

  const max = { bm25: 0, meta: 0, vector: 0, heat: 0 };
  for (const row of rows) {
    for (const k of KEYS) if (row.parts[k] > max[k]) max[k] = row.parts[k];
  }

  for (const row of rows) {
    const pn = { bm25: 0, meta: 0, vector: 0, heat: 0 };
    let s = 0;
    for (const k of KEYS) {
      pn[k] = max[k] > 0 ? row.parts[k] / max[k] : 0;
      s += w[k] * pn[k];
    }
    row.partsNorm = pn;
    row.score = clamp01(s);
  }

  rows.sort((x, y) => y.score - x.score || x.order - y.order);
  return rows
    .slice(0, MAX_RESULTS)
    .map(({ record, score, parts, partsNorm }) => ({ record, score, parts, partsNorm }));
}
