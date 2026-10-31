/**
 * 合并规划（替代「记忆半衰」的另一半）：相似的低权重碎片收成一条，
 * 而不是让它们在库里各活一遍、每轮检索都挤占上下文。
 * 只出方案不动数据——落库由 store.merge 负责，这样规则可以单独测。
 */

import { unionMeta } from "./record.mjs";

const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_MAX_WEIGHT = 0.75;
const DEFAULT_MAX_GROUP_SIZE = 3;
const STRIP_PATTERN = /[^\p{L}\p{N}]/gu;

function normalizeText(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(STRIP_PATTERN, "");
}

/** 字符 bigram Jaccard：中文没有空格可切，bigram 是这里最便宜且够稳的相似度。 */
export function bigramSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const leftSet = new Set();
  const rightSet = new Set();
  for (let i = 0; i < left.length - 1; i += 1) leftSet.add(left.slice(i, i + 2));
  for (let i = 0; i < right.length - 1; i += 1) rightSet.add(right.slice(i, i + 2));
  let shared = 0;
  for (const gram of leftSet) if (rightSet.has(gram)) shared += 1;
  const union = leftSet.size + rightSet.size - shared;
  return union === 0 ? 0 : shared / union;
}

function pickKeep(group) {
  return group.reduce((best, current) => {
    const bestWeight = Number(best.weight) || 0;
    const currentWeight = Number(current.weight) || 0;
    if (currentWeight !== bestWeight) return currentWeight > bestWeight ? current : best;
    const bestLength = String(best.text || "").length;
    const currentLength = String(current.text || "").length;
    if (currentLength !== bestLength) return currentLength > bestLength ? current : best;
    return (current.createdAt || 0) < (best.createdAt || 0) ? current : best;
  });
}

function buildPatch(group, keep) {
  // 正文取最长的那条：短的那条里的信息基本已包含在长的里面，反过来会丢细节
  let text = String(keep.text || "");
  for (const record of group) {
    const candidate = String(record.text || "");
    if (candidate.length > text.length) text = candidate;
  }
  return { text, meta: unionMeta(group) };
}

export function planMerge(records, opts = {}) {
  const threshold = Number.isFinite(opts && opts.threshold) ? opts.threshold : DEFAULT_THRESHOLD;
  const maxWeight = Number.isFinite(opts && opts.maxWeight) ? opts.maxWeight : DEFAULT_MAX_WEIGHT;
  const maxGroupSize = Number.isFinite(opts && opts.maxGroupSize)
    ? Math.max(2, Math.floor(opts.maxGroupSize))
    : DEFAULT_MAX_GROUP_SIZE;

  const list = (Array.isArray(records) ? records : []).filter((record) => {
    if (!record || typeof record !== "object") return false;
    if (record.mergedInto) return false;
    if (record.pinned === true) return false;
    return (Number(record.weight) || 0) < maxWeight;
  });

  // 输入顺序不该影响结果：同一批记录必须产出同一份方案，否则每次重启合并结果都在抖
  list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const grouped = new Set();
  const keep = [];
  const drop = [];
  const groups = [];
  const patchById = {};

  for (const seed of list) {
    if (grouped.has(seed.id)) continue;
    const group = [seed];
    for (const other of list) {
      if (group.length >= maxGroupSize) break;
      if (other.id === seed.id || grouped.has(other.id)) continue;
      if (other.kind !== seed.kind) continue;
      if (bigramSimilarity(seed.text, other.text) < threshold) continue;
      group.push(other);
    }
    if (group.length < 2) continue;
    for (const record of group) grouped.add(record.id);
    const keeper = pickKeep(group);
    groups.push(group.map((record) => record.id));
    keep.push(keeper.id);
    for (const record of group) if (record.id !== keeper.id) drop.push(record.id);
    patchById[keeper.id] = buildPatch(group, keeper);
  }

  return { keep, drop, groups, patchById };
}
