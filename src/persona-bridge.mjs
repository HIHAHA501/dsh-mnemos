/**
 * 人格桥接：读别人的当前人格，算出要不要落库。
 *
 * 只做两件事——取文本、出计划；落库与注入让位由宿主层执行。
 * 所有失败都是结构化对象，不抛；网络与磁盘都能注入，测试不联网、不碰真盘。
 */

import { createHash } from "node:crypto";
import { readFile as nodeReadFile } from "node:fs";

export const PERSONA_DEFAULTS = Object.freeze({
  mode: "self",
  kind: "none",
  path: "",
  url: "",
  timeoutMs: 2000,
  maxChars: 4000,
  refresh: "startup",
});

/** 记录里的来源标记：用它幂等定位「这条 persona 是不是桥接写进来的」。 */
export const PERSONA_SOURCE_KEY = "primary";

const HASH_LENGTH = 16;

function personaOf(config) {
  if (!config || typeof config !== "object") return {};
  const nested = config.persona;
  return nested && typeof nested === "object" ? nested : config;
}

function num(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function limitOf(value) {
  return Math.max(0, Math.floor(num(value, PERSONA_DEFAULTS.maxChars)));
}

/**
 * 只接受本机 http 源：127.0.0.1 / localhost / [::1]。
 * 0.0.0.0 与 127.0.0.2 这类都不算——前者是绑定地址、不是访问地址，后者不在白名单内。
 * @param {string} raw 目标地址。
 * @returns {boolean} 是否允许发请求。
 */
export function isLoopbackUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return false;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = String(parsed.hostname || "").toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** 截断后算哈希：hash 必须对应真正落库的那段文本。 */
export function hashOf(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex").slice(0, HASH_LENGTH);
}

async function defaultReadFile(path) {
  return new Promise(function (resolve, reject) {
    nodeReadFile(path, function (error, data) {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function failure(code, error) {
  return { ok: false, code, error: error || code };
}

/**
 * 读出人格快照文本。
 * @param {object} config 插件配置（取其 persona 块）。
 * @param {{fetchImpl?: Function, readFile?: Function, now?: Function}} deps 注入点。
 * @returns {Promise<object>} { ok:true, text, hash } 或 { ok:false, code, error }。
 */
export async function readPersonaSource(config, deps = {}) {
  const options = deps && typeof deps === "object" ? deps : {};
  const persona = personaOf(config);
  const kind = String(persona.kind == null ? PERSONA_DEFAULTS.kind : persona.kind);

  if (kind === "none") return failure("disabled", "persona.kind=none");
  if (kind !== "file" && kind !== "http") return failure("disabled", "persona.kind=" + kind);

  const maxChars = limitOf(persona.maxChars);
  let raw = "";

  try {
    if (kind === "file") {
      const path = typeof persona.path === "string" ? persona.path.trim() : "";
      if (!path) return failure("no-source", "persona.path 为空");
      const reader = typeof options.readFile === "function" ? options.readFile : defaultReadFile;
      raw = String(await reader(path));
    } else {
      const url = typeof persona.url === "string" ? persona.url.trim() : "";
      if (!url) return failure("no-source", "persona.url 为空");
      // 硬要求：非 loopback 连请求都不发
      if (!isLoopbackUrl(url)) return failure("not-loopback", "只允许 http://127.0.0.1 / http://localhost / http://[::1]：" + url);

      const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
      if (typeof fetchImpl !== "function") return failure("read-failed", "当前运行时没有 fetch");
      const timeoutMs = Math.min(10000, Math.max(200, Math.floor(num(persona.timeoutMs, PERSONA_DEFAULTS.timeoutMs))));
      // 用运行时的 AbortSignal.timeout，不引入任何常驻定时器
      const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
      let response;
      try {
        response = await fetchImpl(url, signal === undefined ? { method: "GET" } : { method: "GET", signal });
      } catch (error) {
        const name = error && error.name ? String(error.name) : "";
        if (name === "TimeoutError" || name === "AbortError") return failure("timeout", "读取人格超时（" + timeoutMs + "ms）");
        return failure("read-failed", error && error.message ? error.message : String(error));
      }
      if (response && response.ok === false) {
        return failure("read-failed", "HTTP " + String(response.status));
      }
      raw = String(await response.text());
    }
  } catch (error) {
    return failure("read-failed", error && error.message ? error.message : String(error));
  }

  const text = String(raw == null ? "" : raw).trim().slice(0, maxChars);
  if (!text) return failure("empty", "人格快照是空文本");
  return { ok: true, text, hash: hashOf(text) };
}

/**
 * 决定这条快照该新建、覆盖还是跳过。
 * 纯函数：不改入参、不读时钟（now 收在参数里，留给将来的时间型策略）。
 * @param {{records?: Array, text?: string, hash?: string, now?: number}} input 输入。
 * @returns {{action: string, targetId?: string, hash: string}} 计划。
 */
export function planPersonaRecord(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const hash = String(input.hash == null ? "" : input.hash);
  let target = null;
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    if (record.tier !== "persona") continue;
    const meta = record.meta && typeof record.meta === "object" ? record.meta : null;
    if (!meta || meta.personaSourceKey !== PERSONA_SOURCE_KEY) continue;
    target = record;
    break;
  }
  if (!target) return { action: "create", hash };
  const existing = target.meta && typeof target.meta === "object" ? target.meta.personaHash : undefined;
  if (existing === hash) return { action: "skip", targetId: String(target.id), hash };
  return { action: "update", targetId: String(target.id), hash };
}
