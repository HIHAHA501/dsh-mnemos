// 融合排序：bm25 + 元数据亲和 + 向量 + 热度 + 情绪，分量各自归一到 0..1 后加权。
// 向量缺席时把那部分权重按 bm25:meta 的原有比例并入，避免凭空放大单侧；
// 情绪缺席（调用方没给 mood）时它整份退出归一，算出的分值与接入前逐个相同。

import { tokenize } from './tokenize.mjs';
import { cosine } from './vector.mjs';

export const DEFAULT_WEIGHTS = { bm25: 0.55, meta: 0.25, vector: 0.15, heat: 0.05, mood: 0 };
export const MAX_RESULTS = 50;
// 单字 CJK 命中只参与打分、不授予候选资格：否则「计划」里的「计」会让查询
// 「量子计算机」召回讲「杭州计划」的记忆——用户问 A、她提 B，比漏召更伤信任
export const UNI_GRAM_WEIGHT = 0.35;
// 向量通道的候选下限：低于它说明"语义上也不近"，不授予候选资格
export const DEFAULT_VECTOR_FLOOR = 0.35;

const BASE_KEYS = ['bm25', 'meta', 'vector', 'heat'];
const KEYS = [...BASE_KEYS, 'mood'];
// 情绪分量内部：「当时有多强烈」占大头，「和你此刻心情像不像」只占小头。
// 强度是记录自带的稳定属性，共振依赖当轮对心情的估计，估错时不该主导排序。
export const MOOD_INTENSITY_SHARE = 0.65;
// 没有情绪线索的记录 arousal 都停在这个中性基线上，拿它当零点才不会把「中性」算成「强烈」
export const NEUTRAL_AROUSAL = 0.3;
// 两边都要有明确正负号才谈得上「共振」：0 分代表没表态，不是「和我一样」
export const VALENCE_SIGNAL = 0.1;
// 与 tokenize.mjs 的 CJK 口径保持一致：只有单字 CJK 才算 uni-gram
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
const isUniGram = (t) => t.length === 1 && CJK_CHAR.test(t);

const num = (v, d = 0) => (Number.isFinite(v) ? Number(v) : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function effectiveWeights(weights, hasVector = true, hasMood = false) {
  const src = weights || {};
  // 情绪缺席时它连归一都不参与（不是「拿 0 分参与」）：这样不开情绪的调用
  // 拿到的四个分量与接入前逐位相同，已有的排序结果不会被悄悄改写。
  const keys = hasMood ? KEYS : BASE_KEYS;
  const raw = {};
  let total = 0;
  for (const k of keys) {
    raw[k] = Math.max(0, num(src[k], DEFAULT_WEIGHTS[k]));
    total += raw[k];
  }
  if (!(total > 0)) return { ...DEFAULT_WEIGHTS };
  const base = { mood: 0 };
  for (const k of keys) base[k] = raw[k] / total;
  if (hasVector) return base;
  const share = base.vector;
  const pool = base.bm25 + base.meta;
  if (!(pool > 0)) {
    return { bm25: share / 2, meta: share / 2, vector: 0, heat: base.heat, mood: base.mood };
  }
  return {
    bm25: base.bm25 + share * (base.bm25 / pool),
    meta: base.meta + share * (base.meta / pool),
    vector: 0,
    heat: base.heat,
    mood: base.mood,
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

/**
 * 情绪分量：当时情绪越强烈，这条越容易被想起（强度主导）；
 * 当下心情与它同向时再补一点，让「你现在什么感受」也有话说，但翻不了盘。
 * @param {object} record 记忆记录（带 emotion: {valence, arousal}）。
 * @param {{valence?: number}} mood 当轮估出的心情。
 * @returns {number} 0..1 的分量分；没有情绪数据时为 0。
 */
export function moodScore(record, mood) {
  const emotion = record && record.emotion ? record.emotion : null;
  if (!emotion) return 0;
  const arousal = clamp01(num(emotion.arousal, NEUTRAL_AROUSAL));
  const intensity = clamp01((arousal - NEUTRAL_AROUSAL) / (1 - NEUTRAL_AROUSAL));
  const recordValence = num(emotion.valence, 0);
  const moodValence = mood ? num(mood.valence, 0) : 0;
  const bothPolar = Math.abs(recordValence) > VALENCE_SIGNAL && Math.abs(moodValence) > VALENCE_SIGNAL;
  const resonance = bothPolar ? clamp01(1 - Math.abs(moodValence - recordValence) / 2) : 0;
  return clamp01(MOOD_INTENSITY_SHARE * intensity + (1 - MOOD_INTENSITY_SHARE) * resonance);
}

export function rank({ query, records, metaIndex, bm25, vectors, now, weights, heatOf, mood } = {}) {
  const list = Array.isArray(records) ? records.filter((r) => r && r.id != null) : [];
  if (!list.length) return [];

  const nowMs = Number.isFinite(now) ? now : Date.now();
  const queryText = typeof query === 'string' ? query : String(query ?? '');
  const queryTokens = tokenize(queryText);
  const queryTerms = [...new Set(queryTokens)];

  const vec = readVectors(vectors);
  const hasVector = !!(vec && vec.queryVec && vec.get);
  const hasMood = !!(mood && Number.isFinite(num(mood.valence, Number.NaN)));
  const w = effectiveWeights(weights, hasVector, hasMood);

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
    const parts = { bm25: 0, meta: 0, vector: 0, heat: 0, mood: 0 };
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
    if (hasMood) parts.mood = moodScore(record, mood);
    rows.push({ record, parts, order: i, score: 0, partsNorm: null });
  }

  const max = { bm25: 0, meta: 0, vector: 0, heat: 0, mood: 0 };
  for (const row of rows) {
    for (const k of KEYS) if (row.parts[k] > max[k]) max[k] = row.parts[k];
  }

  for (const row of rows) {
    const pn = { bm25: 0, meta: 0, vector: 0, heat: 0, mood: 0 };
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
