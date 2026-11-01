/**
 * 全局「记忆记录」开关的存储。
 *
 * v2 是单值语义：整台机器只有一个「记 / 不记」。v1 曾按会话存，
 * 读到时只认版本号、忽略 sessions（旧数据不再影响任何判定），下一次写入就升级成 v2。
 * 落盘用临时文件 + rename；文件读坏了按「没有设置」处理，判定交给调用方的默认值。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const CAPTURE_FILE = "capture.json";
export const CAPTURE_VERSION = 2;
export const CAPTURE_MAX_BYTES = 200 * 1024;

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * 建一个开关存储。
 * @param {{file?: string, now?: Function}} options 落盘路径与时钟。
 * @returns {object} { isEnabled, set, all, stats }
 */
export function createCaptureStore(options = {}) {
  const file = typeof options.file === "string" && options.file.trim() ? options.file.trim() : "";
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  // version 0 表示「没有可用的 v2 记录」；1 表示读到的是旧格式
  const state = { version: 0, enabled: null, at: 0, lastError: "" };
  let seq = 0;

  function load() {
    if (!file || !existsSync(file)) return;
    try {
      if (statSync(file).size > CAPTURE_MAX_BYTES) {
        state.lastError = "capture 文件超过 " + CAPTURE_MAX_BYTES + " 字节，已忽略";
        return;
      }
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") return;
      if (parsed.version === CAPTURE_VERSION && typeof parsed.enabled === "boolean") {
        state.version = CAPTURE_VERSION;
        state.enabled = parsed.enabled;
        state.at = Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0;
        return;
      }
      // v1（按会话存）或任何别的形状：只记下「见过旧格式」，不做任何继承
      state.version = Number.isFinite(Number(parsed.version)) ? Number(parsed.version) : 1;
      state.enabled = null;
      state.at = Number.isFinite(Number(parsed.at)) ? Number(parsed.at) : 0;
    } catch (error) {
      state.version = 0;
      state.enabled = null;
      state.lastError = "capture 文件读不出来，按未设置处理：" + messageOf(error);
    }
  }

  function persist() {
    if (!file) return false;
    let tmp = "";
    try {
      const dir = dirname(file);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = JSON.stringify({ version: CAPTURE_VERSION, enabled: state.enabled === true, at: state.at });
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
   * 现在要不要记。
   * @param {boolean} fallback 没有设置过时用的全局默认。
   * @returns {boolean} 是否记录。
   */
  function isEnabled(fallback) {
    if (state.version === CAPTURE_VERSION && typeof state.enabled === "boolean") return state.enabled;
    return fallback !== false;
  }

  /**
   * 改全局开关（写 v2）。
   * @param {boolean} enabled 是否记录。
   * @returns {boolean} 写入后的值。
   */
  function set(enabled) {
    const value = enabled === true;
    const stamp = Number(now());
    state.version = CAPTURE_VERSION;
    state.enabled = value;
    state.at = Number.isFinite(stamp) ? stamp : Date.now();
    persist();
    return value;
  }

  /** 当前文档（深拷贝，调用方改不动内部状态）。 */
  function all() {
    return { version: state.version, enabled: state.enabled, at: state.at };
  }

  function stats() {
    return { enabled: state.version === CAPTURE_VERSION ? state.enabled : null, version: state.version, lastError: state.lastError };
  }

  load();

  return { isEnabled, set, all, stats };
}
