/**
 * 记忆热度：越新 + 被提起越多 + 权重越高 = 越容易被想起。
 * 这是「记忆半衰」的替代物：不是让记忆到点消失，而是让它慢慢沉底、被提起时重新浮起。
 */

const DEFAULT_WEIGHTS = { recency: 0.45, mentions: 0.25, weight: 0.3 };
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_MENTION_HALF = 3;
const DEFAULT_COLD_WEIGHT = 0.75;
const MS_PER_DAY = 86400000;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function resolveNow(now) {
  if (typeof now === "number" && Number.isFinite(now)) return now;
  if (typeof now === "function") return now();
  return Date.now();
}

/**
 * mentions 是累计次数、本身无上界，直接乘 0.25 会让「被提过 4 次」和「被提过 40 次」一样热；
 * 这里用半衰式饱和压到 0..1：多提一次永远再多一点，但收益递减。
 */
function mentionScore(mentions, half) {
  if (!(mentions > 0)) return 0;
  const safeHalf = half > 0 ? half : DEFAULT_MENTION_HALF;
  return clamp01(1 - Math.pow(0.5, mentions / safeHalf));
}

export function heatOf(record, now = Date.now(), opts = {}) {
  const source = record && typeof record === "object" ? record : {};
  const weights = { ...DEFAULT_WEIGHTS, ...(opts && opts.weights ? opts.weights : {}) };
  const halfLifeDays = Number.isFinite(opts && opts.halfLifeDays) ? opts.halfLifeDays : DEFAULT_HALF_LIFE_DAYS;
  const mentionHalf = Number.isFinite(opts && opts.mentionHalf) ? opts.mentionHalf : DEFAULT_MENTION_HALF;
  const at = resolveNow(now);

  const stamp = Number(source.updatedAt != null ? source.updatedAt : source.createdAt);
  const reference = Number.isFinite(stamp) ? stamp : at;
  const ageDays = Math.max(0, (at - reference) / MS_PER_DAY);

  // persona/state 是「一直成立的前提」，让它随时间变冷等于让模型逐渐忘掉自己是谁；
  // cold 已经沉底了，再按年代衰减等于把「冷」算两遍
  const timeless = source.tier === "persona" || source.tier === "state" || source.tier === "cold";
  const recency = timeless ? 1 : halfLifeDays > 0 ? Math.pow(0.5, ageDays / halfLifeDays) : ageDays === 0 ? 1 : 0;

  const value =
    weights.recency * recency +
    weights.mentions * mentionScore(Number(source.mentions) || 0, mentionHalf) +
    weights.weight * clamp01(Number(source.weight) || 0);

  // 冷层整体打折：它还在，只是不再抢注意力
  if (source.tier === "cold") {
    const raw = Number(opts && opts.coldWeight);
    const coldWeight = Number.isFinite(raw) ? clamp01(raw) : DEFAULT_COLD_WEIGHT;
    return clamp01(value * coldWeight);
  }
  return clamp01(value);
}
