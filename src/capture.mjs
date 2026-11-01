/**
 * 会话级「要不要记」开关的存储。
 *
 * 纯逻辑 + 一个原子落盘助手：内存里就是一张 sessionId -> {enabled, at} 的表，
 * 落盘用临时文件 + rename，读坏了就当空表——一个开关文件不该拖垮整个插件。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CAPTURE_FILE = "capture.json";
export const CAPTURE_VERSION = 1;
export const CAPTURE_MAX_SESSIONS = 500;
export const CAPTURE_MAX_BYTES = 200 * 1024;

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * 建一个开关存储。
 * @param {{file?: string, now?: Function}} options 落盘路径与时钟。
 * @returns {object} { get, set, all, remove, stats }
 */
export function createCaptureStore(options = {}) {
  const file = typeof options.file === "string" && options.file.trim() ? options.file.trim() : "";
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const sessions = new Map();
  const state = { lastError: "", loaded: false };
  let seq = 0;

  function toDocument() {
    const map = {};
    for (const [key, entry] of sessions) map[key] = { enabled: entry.enabled === true, at: entry.at };
    return { version: CAPTURE_VERSION, sessions: map };
  }

  /** 超出上限就淘汰最旧的；at 相同再按 key 排，保证同一份输入淘汰结果一致。 */
  function evict() {
    if (sessions.size <= CAPTURE_MAX_SESSIONS) return;
    const ordered = [...sessions.entries()].sort(function (left, right) {
      const diff = (left[1].at || 0) - (right[1].at || 0);
      if (diff !== 0) return diff;
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    });
    const excess = sessions.size - CAPTURE_MAX_SESSIONS;
    for (let i = 0; i < excess; i += 1) sessions.delete(ordered[i][0]);
  }

  function load() {
    state.loaded = true;
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > CAPTURE_MAX_BYTES) {
        state.lastError = "capture 文件超过 " + CAPTURE_MAX_BYTES + " 字节，已忽略";
        return;
      }
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      const source = parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (!key || !value || typeof value !== "object") continue;
        sessions.set(key, { enabled: value.enabled === true, at: Number.isFinite(Number(value.at)) ? Number(value.at) : 0 });
      }
      evict();
    } catch (error) {
      sessions.clear();
      state.lastError = "capture 文件读不出来，按空表继续：" + messageOf(error);
    }
  }

  function persist() {
    if (!file) return false;
    let tmp = "";
    try {
      const dir = dirname(file);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify(toDocument());
      if (payload.length > CAPTURE_MAX_BYTES) {
        state.lastError = "capture 文件将超过 " + CAPTURE_MAX_BYTES + " 字节，已放弃这次写入";
        return false;
      }
      seq += 1;
      tmp = file + ".tmp-" + process.pid + "-" + seq;
      writeFileSync(tmp, payload);
      // rename 是原子的：要么旧文件、要么新文件，不会读到写了一半的表
      renameSync(tmp, file);
      state.lastError = "";
      return true;
    } catch (error) {
      state.lastError = "capture 落盘失败：" + messageOf(error);
      if (tmp) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // 临时文件删不掉也不影响内存状态
        }
      }
      return false;
    }
  }

  /**
   * 读某个会话的开关；没覆盖过就返回 fallback（默认开）。
   * @param {string} sessionId 会话 id。
   * @param {boolean} fallback 全局默认。
   * @returns {boolean} 是否记录。
   */
  function get(sessionId, fallback) {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    if (key) {
      const entry = sessions.get(key);
      if (entry) return entry.enabled === true;
    }
    return fallback !== false;
  }

  /**
   * 写某个会话的开关。
   * @param {string} sessionId 会话 id（空则拒绝）。
   * @param {boolean} enabled 是否记录。
   * @returns {null|{sessionId: string, enabled: boolean, at: number}} 写入结果。
   */
  function set(sessionId, enabled) {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!key) return null;
    const stamp = Number(now());
    const at = Number.isFinite(stamp) ? stamp : Date.now();
    const value = enabled === true;
    sessions.set(key, { enabled: value, at });
    evict();
    persist();
    return { sessionId: key, enabled: value, at };
  }

  /** 整表快照（深拷贝，调用方改不动内部状态）。 */
  function all() {
    const map = {};
    for (const [key, entry] of sessions) map[key] = { enabled: entry.enabled === true, at: entry.at };
    return map;
  }

  function remove(sessionId) {
    const key = typeof sessionId === "string" ? sessionId.trim() : "";
    if (!key || !sessions.has(key)) return false;
    sessions.delete(key);
    persist();
    return true;
  }

  function stats() {
    return { file, count: sessions.size, loaded: state.loaded, lastError: state.lastError, maxSessions: CAPTURE_MAX_SESSIONS, maxBytes: CAPTURE_MAX_BYTES };
  }

  load();

  return { get, set, all, remove, stats };
}
