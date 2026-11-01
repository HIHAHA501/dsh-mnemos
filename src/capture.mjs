/**
 * 记忆记录开关的存储：全局默认 + 会话覆盖（v3）。
 *
 * 语义和界面一一对应：设置页那个大开关 = default，输入区胶囊 = 某个会话的覆盖。
 * 会话表同时承担「见过的会话」清单（enabled 为 null 表示见过但没覆盖），
 * 落盘用临时文件 + rename；读坏了按「没有设置」处理，判定交给调用方的默认值。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CAPTURE_FILE = "capture.json";
export const CAPTURE_VERSION = 3;
export const CAPTURE_MAX_SESSIONS = 500;
export const CAPTURE_MAX_BYTES = 200 * 1024;

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * 建一个开关存储。
 * @param {{file?: string, now?: Function}} options 落盘路径与时钟。
 * @returns {object} { isEnabled, setDefault, setSession, touch, all, stats }
 */
export function createCaptureStore(options = {}) {
  const file = typeof options.file === "string" && options.file.trim() ? options.file.trim() : "";
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  // version 0 = 没有可用记录；1 = 旧 per-session 格式（已作废）；2 = 纯全局；3 = 当前
  const state = { version: 0, default: null, lastError: "" };
  const sessions = new Map();
  let seq = 0;

  function readEntry(value) {
    if (!value || typeof value !== "object") return null;
    const enabled = typeof value.enabled === "boolean" ? value.enabled : null;
    const at = Number.isFinite(Number(value.at)) ? Number(value.at) : 0;
    return { enabled: enabled, at: at };
  }

  /** 超出上限就淘汰最旧的；at 相同再按 id 排，保证同一份输入淘汰结果一致。 */
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
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > CAPTURE_MAX_BYTES) {
        state.lastError = "capture 文件超过 " + CAPTURE_MAX_BYTES + " 字节，已忽略";
        return;
      }
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.version === CAPTURE_VERSION) {
        state.version = CAPTURE_VERSION;
        state.default = typeof parsed.default === "boolean" ? parsed.default : null;
        const source = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};
        for (const key of Object.keys(source)) {
          const entry = readEntry(source[key]);
          if (!key || !entry) continue;
          sessions.set(key, entry);
        }
        evict();
        return;
      }
      if (parsed.version === 2 && typeof parsed.enabled === "boolean") {
        // v2 只有一个全局值：原样当默认，会话表清空
        state.version = CAPTURE_VERSION;
        state.default = parsed.enabled;
        return;
      }
      // v1（按会话存）或任何别的形状：不继承任何东西，下一次写入升级成 v3
      state.version = Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1;
      state.default = null;
    } catch (error) {
      state.version = 0;
      state.default = null;
      sessions.clear();
      state.lastError = "capture 文件读不出来，按未设置处理：" + messageOf(error);
    }
  }

  function persist() {
    if (!file) return false;
    let tmp = "";
    try {
      const dir = dirname(file);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const map = {};
      for (const [key, entry] of sessions) map[key] = { enabled: entry.enabled, at: entry.at };
      const payload = JSON.stringify({ version: CAPTURE_VERSION, default: state.default === true, sessions: map });
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

  function keyOf(sessionId) {
    return typeof sessionId === "string" ? sessionId.trim() : "";
  }

  function effectiveDefault(fallback) {
    if (state.version === CAPTURE_VERSION && typeof state.default === "boolean") return state.default;
    return fallback !== false;
  }

  /** 全局默认（没有记录时用 fallback）。 */
  function defaultOf(fallback) {
    return effectiveDefault(fallback);
  }

  /**
   * 现在这个会话要不要记：会话覆盖优先，没覆盖就跟随默认。
   * @param {string} sessionId 会话 id。
   * @param {boolean} fallback 没有全局默认时用的值。
   * @returns {boolean} 是否记录。
   */
  function isEnabled(sessionId, fallback) {
    const key = keyOf(sessionId);
    if (key) {
      const entry = sessions.get(key);
      if (entry && typeof entry.enabled === "boolean") return entry.enabled;
    }
    return effectiveDefault(fallback);
  }

  /**
   * 改全局默认。
   * @param {boolean} enabled 新默认值。
   * @returns {boolean} 写入后的值。
   */
  function setDefault(enabled) {
    const value = enabled === true;
    state.version = CAPTURE_VERSION;
    state.default = value;
    persist();
    return value;
  }

  /**
   * 写/清除会话覆盖。
   * @param {string} sessionId 会话 id。
   * @param {boolean|null} enabled true/false 设置覆盖，null 清除回跟随默认。
   * @returns {null|{sessionId: string, enabled: boolean|null, at: number}} 写入结果。
   */
  function setSession(sessionId, enabled) {
    const key = keyOf(sessionId);
    if (!key) return null;
    state.version = CAPTURE_VERSION;
    const stamp = Number(now());
    const at = Number.isFinite(stamp) ? stamp : Date.now();
    if (enabled === null || enabled === undefined) {
      // 清除覆盖但保留「见过这个会话」，否则它会从列表里消失
      const existing = sessions.get(key);
      if (existing) sessions.set(key, { enabled: null, at: at });
      persist();
      return { sessionId: key, enabled: null, at: at };
    }
    sessions.set(key, { enabled: enabled === true, at: at });
    evict();
    persist();
    const saved = sessions.get(key);
    return { sessionId: key, enabled: saved ? saved.enabled : enabled === true, at: at };
  }

  /** 记下「见过这个会话」：只看时间，不动覆盖值。 */
  function touch(sessionId) {
    const key = keyOf(sessionId);
    if (!key) return false;
    state.version = CAPTURE_VERSION;
    const stamp = Number(now());
    const at = Number.isFinite(stamp) ? stamp : Date.now();
    const existing = sessions.get(key);
    sessions.set(key, { enabled: existing ? existing.enabled : null, at: at });
    evict();
    persist();
    return true;
  }

  /** 整份文档（深拷贝，调用方改不动内部状态）。 */
  function all() {
    const map = {};
    for (const [key, entry] of sessions) map[key] = { enabled: entry.enabled, at: entry.at };
    return { version: state.version, default: state.version === CAPTURE_VERSION ? state.default : null, sessions: map };
  }

  function stats() {
    return {
      version: state.version,
      default: state.version === CAPTURE_VERSION ? state.default : null,
      sessions: sessions.size,
      lastError: state.lastError,
    };
  }

  load();

  return { isEnabled, defaultOf, setDefault, setSession, touch, all, stats };
}
