/**
 * MemoryRecord 的唯一构造/校验入口。
 * 默认值与取值范围都收在这里：同一条记录在不同模块里必须是同一个形状，
 * 否则 store 读回来的和检索层理解的会是两份数据。
 */

import { randomBytes } from "node:crypto";

export const KINDS = Object.freeze(["turn", "fact", "event", "profile", "milestone", "musing"]);
export const TIERS = Object.freeze(["hot", "cold", "persona", "state"]);

/** 层是谁定的：auto 是规则判的，user 是用户显式设的（自动降级不许覆盖它）。 */
export const TIER_SOURCES = Object.freeze(["auto", "user"]);
export const SUBJECTS = Object.freeze(["self", "user", "world"]);

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const META_LIST_FIELDS = ["person", "object", "topic"];
/** 人格桥接要写进 meta 的三个键：只放行这三个短字符串，其它未知键照旧丢弃（meta 不是垃圾桶）。 */
const META_TEXT_FIELDS = Object.freeze({ personaSourceKey: 64, personaHash: 64, personaSource: 64 });

export function recordError(code, message) {
  const error = new Error(message);
  error.name = "RecordError";
  error.code = code;
  return error;
}

export function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function num(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestamp(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toList(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out;
}

/** id 里带 kind 和时间戳是故意的：看不带索引的日志文件也能一眼认出这条是什么、什么时候的。 */
export function createId(kind, ts) {
  const resolvedKind = KINDS.includes(kind) ? kind : "turn";
  const stamp = Math.floor(timestamp(ts, Date.now())).toString(36);
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i += 1) suffix += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return resolvedKind + "-" + stamp + "-" + suffix;
}

export function normalizeMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== "object") return out;
  if (meta.time != null && String(meta.time).trim()) out.time = String(meta.time).trim();
  if (meta.place != null && String(meta.place).trim()) out.place = String(meta.place).trim();
  for (const field of META_LIST_FIELDS) {
    const list = toList(meta[field]);
    if (list.length) out[field] = list;
  }
  // 人格桥接的三个键：字符串才收，trim 后非空，超长截断到 64（截断而不是丢弃）
  for (const field of Object.keys(META_TEXT_FIELDS)) {
    const raw = meta[field];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const limit = META_TEXT_FIELDS[field];
    out[field] = trimmed.length > limit ? trimmed.slice(0, limit) : trimmed;
  }
  return out;
}

/** 无情绪线索时 arousal 留 0.3 的中性基线：0 会被上层读成「死气沉沉」，而中性不是死。 */
export function normalizeEmotion(emotion) {
  const source = emotion && typeof emotion === "object" ? emotion : {};
  return {
    valence: clamp(num(source.valence, 0), -1, 1),
    arousal: clamp(num(source.arousal, 0.3), 0, 1),
  };
}

export function normalizeRecord(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const rawNow = options.now == null ? Date.now() : options.now;
  const now = typeof rawNow === "function" ? rawNow() : rawNow;
  const kind = KINDS.includes(source.kind) ? source.kind : "turn";
  const text = typeof source.text === "string" ? source.text.trim() : "";
  if (!text) throw recordError("invalid-record", "record.text 不能为空");

  const createdAt = Math.floor(timestamp(source.createdAt, now));
  const updatedAt = Math.max(createdAt, Math.floor(timestamp(source.updatedAt, createdAt)));
  const id = typeof source.id === "string" && source.id.trim() ? source.id.trim() : createId(kind, createdAt);

  const record = {
    id,
    kind,
    tier: TIERS.includes(source.tier) ? source.tier : "hot",
    text,
    createdAt,
    updatedAt,
    subject: SUBJECTS.includes(source.subject) ? source.subject : "world",
    meta: normalizeMeta(source.meta),
    emotion: normalizeEmotion(source.emotion),
    weight: clamp(num(source.weight, 0.5), 0, 1),
    mentions: Math.max(0, Math.floor(num(source.mentions, 1))),
    sourceRefs: toList(source.sourceRefs),
    pinned: source.pinned === true,
    tierSource: source.tierSource === "user" ? "user" : "auto",
  };

  if (typeof source.summary === "string" && source.summary.trim()) record.summary = source.summary.trim();
  if (typeof source.sessionId === "string" && source.sessionId.trim()) record.sessionId = source.sessionId.trim();
  if (typeof source.mergedInto === "string" && source.mergedInto.trim()) record.mergedInto = source.mergedInto.trim();
  return record;
}

/** createRecord 永远发新 id：调用方不该能靠传 id 假装自己是一条老记录。 */
export function createRecord(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const { id: _ignored, ...rest } = source;
  return normalizeRecord(rest, options);
}

export function cloneRecord(record) {
  const meta = {};
  for (const key of Object.keys(record.meta || {})) {
    const value = record.meta[key];
    meta[key] = Array.isArray(value) ? value.slice() : value;
  }
  return {
    ...record,
    meta,
    emotion: { ...record.emotion },
    sourceRefs: (record.sourceRefs || []).slice(),
  };
}

export function isMerged(record) {
  return Boolean(record && record.mergedInto);
}

/** 合并同类记忆时元信息取并集：丢掉一条记录的「谁/在哪」，比丢掉措辞更亏。 */
export function unionMeta(records) {
  const out = {};
  for (const record of records) {
    const meta = (record && record.meta) || {};
    if (!out.time && meta.time) out.time = meta.time;
    if (!out.place && meta.place) out.place = meta.place;
    for (const field of META_LIST_FIELDS) {
      const merged = toList([...(out[field] || []), ...(meta[field] || [])]);
      if (merged.length) out[field] = merged;
    }
  }
  return out;
}
