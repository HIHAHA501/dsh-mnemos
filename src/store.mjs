/**
 * 本地记忆库：JSONL 追加日志 + 周期快照。
 * 不用 node:sqlite 是有意的——宿主跑在 Electron 里，那个内置模块在这个运行时上没人验证过，
 * 而记忆是用户级资产，存储格式必须在任何 node 版本上都能用读文件的方式捞回来。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { replaceFile } from "./atomic.mjs";
import { join } from "node:path";

import { cloneRecord, normalizeRecord } from "./record.mjs";

const SNAPSHOT_VERSION = 1;
const LOG_FILE = "records.jsonl";
const SNAPSHOT_FILE = "memory.snapshot.json";
const LOCK_FILE = "store.lock";
const DEFAULT_LOCK_STALE_MS = 30000;
const DEFAULT_SNAPSHOT_EVERY = 512;
const LOCK_REFRESH_MS = 1000;

/** merge 的派生字段由 store 自己算，patch 只能改描述性字段。 */
const MERGE_PROTECTED_KEYS = ["id", "mergedInto", "mentions", "weight", "sourceRefs", "createdAt", "updatedAt"];

export class StoreError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  toJSON() {
    if (this.detail === undefined) return { code: this.code, message: this.message };
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

function byUpdatedDesc(a, b) {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function createStore(options = {}) {
  const dataDir = typeof options.dataDir === "string" ? options.dataDir.trim() : "";
  if (!dataDir) throw new StoreError("invalid-datadir", "createStore 需要 dataDir");

  const clock =
    typeof options.now === "function"
      ? options.now
      : typeof options.now === "number"
        ? () => options.now
        : () => Date.now();
  const lockStaleMs = Number.isFinite(options.lockStaleMs) ? options.lockStaleMs : DEFAULT_LOCK_STALE_MS;
  const snapshotEvery =
    Number.isFinite(options.snapshotEvery) && options.snapshotEvery > 0
      ? Math.floor(options.snapshotEvery)
      : DEFAULT_SNAPSHOT_EVERY;

  const logPath = join(dataDir, LOG_FILE);
  const snapshotPath = join(dataDir, SNAPSHOT_FILE);
  const lockPath = join(dataDir, LOCK_FILE);

  const warnings = [];
  const records = new Map();
  // 锁文件里的 owner 只是「谁开的」标记，用来避免删掉别人的锁
  const owner = String(process.pid) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  let closed = false;
  let logLines = 0;
  let lastSnapshotAt = null;
  let opsSinceSnapshot = 0;
  let lastLockRefreshAt = 0;
  let tmpSeq = 0;
  let logFd = null;

  function tempPath(target) {
    tmpSeq += 1;
    return target + ".tmp-" + process.pid + "-" + tmpSeq;
  }

  function readLock() {
    try {
      const raw = readFileSync(lockPath, "utf8");
      if (!raw.trim()) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeLock() {
    const at = clock();
    const payload = JSON.stringify({ owner, pid: process.pid, at, version: SNAPSHOT_VERSION });
    const tmp = tempPath(lockPath);
    writeFileSync(tmp, payload);
    replaceFile(tmp, lockPath);
    lastLockRefreshAt = at;
  }

  function acquireLock() {
    const existing = readLock();
    if (existing && existing.owner !== owner) {
      const heldAt = Number(existing.at) || 0;
      const ageMs = clock() - heldAt;
      if (ageMs < lockStaleMs) {
        throw new StoreError("store-locked", "数据目录已被另一个 store 占用：" + dataDir, {
          dataDir,
          holder: { pid: existing.pid, owner: existing.owner, at: heldAt, ageMs },
          staleMs: lockStaleMs,
        });
      }
    }
    writeLock();
  }

  function ensureLock() {
    if (clock() - lastLockRefreshAt >= LOCK_REFRESH_MS) writeLock();
  }

  function releaseLock() {
    const existing = readLock();
    if (existing && existing.owner !== owner) return;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // 锁文件已经不在 = 目的已达成
    }
  }

  const onExit = () => {
    try {
      releaseLock();
    } catch {
      // 退出路径上再抛也没人接
    }
  };

  function putInternal(record) {
    records.set(record.id, record);
  }

  function removeInternal(id) {
    records.delete(id);
  }

  // 常开一个追加句柄：每次写都 open/close 一遍，光系统调用就吃掉批量入库的大半预算
  function closeLogFd() {
    if (logFd === null) return;
    try {
      closeSync(logFd);
    } catch {
      // 句柄已经关了
    }
    logFd = null;
  }

  function rewriteLog() {
    closeLogFd();
    let body = "";
    for (const record of records.values()) body += JSON.stringify({ op: "put", r: record }) + "\n";
    const tmp = tempPath(logPath);
    writeFileSync(tmp, body);
    replaceFile(tmp, logPath);
    logLines = records.size;
  }

  function applyEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.op === "put" && entry.r) {
      putInternal(normalizeRecord(entry.r));
      return;
    }
    if (entry.op === "del" && typeof entry.id === "string") removeInternal(entry.id);
  }

  function loadSnapshot() {
    if (!existsSync(snapshotPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
      const list = Array.isArray(parsed && parsed.records) ? parsed.records : [];
      for (const raw of list) {
        try {
          putInternal(normalizeRecord(raw));
        } catch {
          warnings.push("快照中有无法解析的记录，已跳过");
        }
      }
      lastSnapshotAt = Number.isFinite(Number(parsed && parsed.savedAt)) ? Number(parsed.savedAt) : null;
    } catch (error) {
      warnings.push("快照损坏，已回退到 JSONL：" + (error && error.message ? error.message : String(error)));
    }
  }

  function loadLog() {
    if (!existsSync(logPath)) return;
    const text = readFileSync(logPath, "utf8");
    if (!text) return;
    const lines = text.split("\n");
    let needsRewrite = text.charAt(text.length - 1) !== "\n";
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trim()) continue;
      try {
        applyEntry(JSON.parse(line));
        logLines += 1;
      } catch {
        // 崩溃多半死在「写了一半这一行」，跳过它继续，别让整个库打不开
        warnings.push("JSONL 第 " + (index + 1) + " 行不完整，已跳过");
        needsRewrite = true;
      }
    }
    // 留着半行会让下一次 append 粘在那行后面，把坏行养成坏库
    if (needsRewrite) rewriteLog();
  }

  function writeSnapshot() {
    const savedAt = clock();
    const payload = { version: SNAPSHOT_VERSION, savedAt, count: records.size, records: Array.from(records.values()) };
    const tmp = tempPath(snapshotPath);
    writeFileSync(tmp, JSON.stringify(payload));
    replaceFile(tmp, snapshotPath);
    // 先落快照再清日志：反过来的话，两步之间崩溃就真的少一段数据；这个顺序最坏只是重放一遍幂等的 put
    closeLogFd();
    writeFileSync(logPath, "");
    logLines = 0;
    opsSinceSnapshot = 0;
    lastSnapshotAt = savedAt;
  }

  function append(entry) {
    if (closed) throw new StoreError("store-closed", "store 已关闭");
    ensureLock();
    if (logFd === null) logFd = openSync(logPath, "a");
    writeSync(logFd, JSON.stringify(entry) + "\n");
    logLines += 1;
    opsSinceSnapshot += 1;
    if (opsSinceSnapshot >= snapshotEvery) writeSnapshot();
  }

  function commit(record) {
    const previous = records.get(record.id);
    putInternal(record);
    try {
      append({ op: "put", r: record });
    } catch (error) {
      // 落盘失败就把内存退回上一版，否则内存与磁盘会分叉
      if (previous) putInternal(previous);
      else removeInternal(record.id);
      throw error;
    }
    return cloneRecord(record);
  }

  function insert(input) {
    const record = normalizeRecord(input, { now: clock() });
    if (records.has(record.id)) {
      throw new StoreError("duplicate-id", "记录已存在：" + record.id, { id: record.id });
    }
    return commit(record);
  }

  function upsert(input) {
    const provided = input && typeof input === "object" ? input : {};
    const existing = typeof provided.id === "string" ? records.get(provided.id.trim()) : undefined;
    const record = normalizeRecord(provided, { now: clock() });
    if (existing) {
      if (provided.createdAt == null) record.createdAt = existing.createdAt;
      if (provided.pinned == null) record.pinned = existing.pinned;
      record.updatedAt = Math.max(record.updatedAt, record.createdAt);
    }
    return commit(record);
  }

  function get(id) {
    const record = records.get(id);
    return record ? cloneRecord(record) : null;
  }

  function all() {
    return Array.from(records.values()).map(cloneRecord);
  }

  function candidates(filter = {}) {
    const since = filter && Number.isFinite(filter.since) ? filter.since : null;
    const limit = filter && Number.isFinite(filter.limit) ? Math.floor(filter.limit) : null;
    const out = [];
    for (const record of records.values()) {
      if (record.mergedInto) continue;
      if (since !== null && record.updatedAt < since) continue;
      out.push(cloneRecord(record));
    }
    out.sort(byUpdatedDesc);
    return limit === null ? out : out.slice(0, limit);
  }

  function recent(limit = 20) {
    return candidates({ limit: Number.isFinite(limit) ? Math.floor(limit) : 20 });
  }

  function setPinned(id, value) {
    const record = records.get(id);
    if (!record) return null;
    const next = { ...cloneRecord(record), pinned: value === true };
    return commit(normalizeRecord(next, { now: clock() }));
  }

  function forget(id) {
    if (!records.has(id)) return false;
    const previous = records.get(id);
    removeInternal(id);
    try {
      append({ op: "del", id });
    } catch (error) {
      putInternal(previous);
      throw error;
    }
    return true;
  }

  function applyPatch(record, patch) {
    if (!patch || typeof patch !== "object") return record;
    const next = { ...record };
    for (const key of Object.keys(patch)) {
      if (MERGE_PROTECTED_KEYS.includes(key)) continue;
      next[key] = patch[key];
    }
    return normalizeRecord(next, { now: record.updatedAt });
  }

  function merge(keepId, dropIds, patch) {
    const keep = records.get(keepId);
    if (!keep) throw new StoreError("not-found", "保留记录不存在：" + keepId, { id: keepId });
    const dropList = Array.isArray(dropIds) ? dropIds : [];
    const drops = [];
    for (const id of dropList) {
      if (id === keepId) continue;
      const record = records.get(id);
      if (!record) throw new StoreError("not-found", "被合并记录不存在：" + id, { id });
      if (!drops.includes(record)) drops.push(record);
    }

    const group = [keep, ...drops];
    const ts = clock();
    let mentions = 0;
    let maxWeight = 0;
    const refs = [];
    for (const record of group) {
      mentions += record.mentions || 0;
      maxWeight = Math.max(maxWeight, record.weight || 0);
      for (const ref of record.sourceRefs || []) if (!refs.includes(ref)) refs.push(ref);
    }

    const nextKeep = {
      ...cloneRecord(keep),
      mentions,
      weight: Math.min(1, maxWeight + 0.05),
      sourceRefs: refs,
      updatedAt: Math.max(ts, keep.createdAt),
    };
    delete nextKeep.mergedInto;
    const patched = applyPatch(nextKeep, patch);
    const savedKeep = commit(patched);

    for (const record of drops) {
      const next = { ...cloneRecord(record), mergedInto: keepId, updatedAt: Math.max(ts, record.createdAt) };
      commit(normalizeRecord(next, { now: ts }));
    }
    return savedKeep;
  }

  function stats() {
    const byKind = {};
    const byTier = {};
    const bySubject = {};
    let live = 0;
    let merged = 0;
    for (const record of records.values()) {
      byKind[record.kind] = (byKind[record.kind] || 0) + 1;
      byTier[record.tier] = (byTier[record.tier] || 0) + 1;
      bySubject[record.subject] = (bySubject[record.subject] || 0) + 1;
      if (record.mergedInto) merged += 1;
      else live += 1;
    }
    return {
      dataDir,
      count: records.size,
      live,
      merged,
      byKind,
      byTier,
      bySubject,
      logLines,
      lastSnapshotAt,
      snapshotEvery,
      closed,
      warnings: warnings.slice(),
    };
  }

  function close() {
    if (closed) return;
    try {
      writeSnapshot();
    } catch (error) {
      warnings.push("关闭时写快照失败：" + (error && error.message ? error.message : String(error)));
    }
    closeLogFd();
    releaseLock();
    process.removeListener("exit", onExit);
    closed = true;
  }

  mkdirSync(dataDir, { recursive: true });
  process.on("exit", onExit);
  try {
    acquireLock();
    loadSnapshot();
    loadLog();
  } catch (error) {
    releaseLock();
    process.removeListener("exit", onExit);
    throw error;
  }

  return { insert, upsert, get, all, recent, candidates, setPinned, forget, merge, stats, close };
}
