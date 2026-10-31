/**
 * 分层判定：hot → cold 的惰性降级，以及被重新提起时的回升。
 *
 * 纯函数：now 由调用方传入，不读时钟、不碰文件、不改入参；同一输入永远同一输出。
 * 热度口径直接复用 src/heat.mjs 的 heatOf —— 抄一份公式就等于给同一件事定两套标准。
 */

import { heatOf } from "./heat.mjs";

export const TIER_DEFAULTS = Object.freeze({
  enabled: true,
  demoteAfterDays: 30,
  demoteBelowHeat: 0.35,
  coldWeight: 0.75,
  reviveOnMention: true,
});

const MS_PER_DAY = 86400000;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 算一次该降级谁。
 *
 * 唯一判据（不加别的条件）：tier 为 hot、未 pinned、tierSource 不是 user、
 * 距 createdAt 的天数 >= demoteAfterDays、且 heatOf 严格小于 demoteBelowHeat。
 * @param {Array} records 记录数组（不改动）。
 * @param {number|Function} now 判定基准时间（毫秒）。
 * @param {object} opts tiering 配置（可带 coldWeight 等 heatOf 选项）。
 * @returns {{patches: Array, changed: number, skipped: number}} 补丁与计数。
 */
export function applyTiering(records, now, opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const list = Array.isArray(records) ? records : [];
  const patches = [];

  if (options.enabled === false) return { patches, changed: 0, skipped: list.length };

  const resolved = typeof now === "function" ? now() : now;
  // 没有可用的基准时间就一条都不判：宁可这一次不降级，也不要偷读系统时钟
  if (!Number.isFinite(resolved)) return { patches, changed: 0, skipped: list.length };

  const demoteAfterDays = Number.isFinite(options.demoteAfterDays)
    ? Math.max(0, options.demoteAfterDays)
    : TIER_DEFAULTS.demoteAfterDays;
  const demoteBelowHeat = Number.isFinite(options.demoteBelowHeat)
    ? clamp01(options.demoteBelowHeat)
    : TIER_DEFAULTS.demoteBelowHeat;

  let skipped = 0;
  for (const record of list) {
    if (!record || typeof record !== "object" || record.id == null) {
      skipped += 1;
      continue;
    }
    if (record.tier !== "hot" || record.pinned === true || record.tierSource === "user") {
      skipped += 1;
      continue;
    }
    const createdAt = Number(record.createdAt);
    if (!Number.isFinite(createdAt)) {
      skipped += 1;
      continue;
    }
    const ageDays = Math.max(0, (resolved - createdAt) / MS_PER_DAY);
    if (!(ageDays >= demoteAfterDays)) {
      skipped += 1;
      continue;
    }
    if (!(heatOf(record, resolved, options) < demoteBelowHeat)) {
      skipped += 1;
      continue;
    }
    patches.push({ id: String(record.id), tier: "cold", tierSource: "auto" });
  }

  return { patches, changed: patches.length, skipped };
}

/**
 * 被重新提起时该不该回升。
 * 契约正文要求 tierSource 保持原值、除非原来是 auto，所以用户显式设过的层不会被自动改写。
 * @param {object} record upsert/merge 之后的记录。
 * @param {number} prevMentions 变更前的 mentions。
 * @param {object} opts tiering 配置。
 * @returns {null|{tier: string, tierSource: string}} 回升补丁或 null。
 */
export function reviveOnMentionPatch(record, prevMentions, opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  if (options.reviveOnMention === false) return null;
  if (!record || typeof record !== "object") return null;
  if (record.tier !== "cold") return null;
  const before = Number(prevMentions);
  const after = Number(record.mentions);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  if (!(after > before)) return null;
  return { tier: "hot", tierSource: record.tierSource === "user" ? "user" : "auto" };
}
