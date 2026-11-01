/**
 * 插件配置的唯一解析入口：宿主传进来的 config 是不可信的，
 * 这里把每个字段收成固定形状，上层就不用到处写 ?? 默认值。
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { TIER_DEFAULTS } from "./tiering.mjs";

export const MODES = Object.freeze(["general", "companion"]);
export const VECTOR_ENABLED = Object.freeze(["auto", "off", "on"]);
export const VECTOR_PROVIDERS = Object.freeze(["none", "local", "api"]);
export const INGEST_LLM = Object.freeze(["auto", "off"]);
export const PERSONA_MODES = Object.freeze(["self", "external"]);
export const PERSONA_KINDS = Object.freeze(["none", "file", "http"]);
export const PERSONA_REFRESH = Object.freeze(["startup", "turn"]);
export const PERSONA_ADAPTERS = Object.freeze(["text", "dafeiyu"]);

/** dataDir 不在这里：它默认依赖 profile 目录，必须运行时解析。 */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  mode: "general",
  hotTokenBudget: 1200,
  injectTokenBudget: 600,
  topN: 6,
  vector: Object.freeze({
    enabled: "auto",
    provider: "none",
    model: null,
    endpoint: null,
    apiKeyEnv: null,
  }),
  proactive: Object.freeze({
    enabled: true,
    quoteThreshold: 0.62,
    askThreshold: 0.45,
    noiseFloor: 0.18,
    maxPerTurn: 1,
  }),
  ingest: Object.freeze({
    llm: "auto",
    everyTurns: 20,
    capture: true,
    filter: true,
    skipSubagentSessions: true,
  }),
  projection: Object.freeze({
    enabled: true,
    triggerTokens: 6000,
    keepRecentTurns: 8,
    maxFoldedTokens: 400,
  }),
  tiering: Object.freeze({
    enabled: TIER_DEFAULTS.enabled,
    demoteAfterDays: TIER_DEFAULTS.demoteAfterDays,
    demoteBelowHeat: TIER_DEFAULTS.demoteBelowHeat,
    coldWeight: TIER_DEFAULTS.coldWeight,
    reviveOnMention: TIER_DEFAULTS.reviveOnMention,
  }),
  persona: Object.freeze({
    mode: "self",
    kind: "none",
    adapter: "text",
    path: "",
    url: "",
    timeoutMs: 2000,
    maxChars: 4000,
    refresh: "startup",
  }),
  debug: false,
});

function dshHome(env) {
  const custom = env && typeof env.DSH_HOME === "string" && env.DSH_HOME.trim();
  return custom ? custom.trim() : join(homedir(), ".dsh");
}

/** 单 profile 安装时直接认出来，多 profile 时退回 default——猜错只是多一个空目录，不丢数据。 */
function profileName(env) {
  if (env && typeof env.DSH_PROFILE === "string" && env.DSH_PROFILE.trim()) return env.DSH_PROFILE.trim();
  try {
    const base = join(dshHome(env), "profiles");
    if (existsSync(base)) {
      const names = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
      if (names.length === 1) return names[0];
    }
  } catch {
    // 读不到目录就当没 profile，回退默认名
  }
  return "default";
}

export function defaultDataDir(env = process.env) {
  const override = env && typeof env.DSH_MNEMOS_DATA_DIR === "string" && env.DSH_MNEMOS_DATA_DIR.trim();
  if (override) return override.trim();
  return join(dshHome(env), "profiles", profileName(env), "dsh-mnemos");
}

function warn(warnings, message) {
  if (Array.isArray(warnings)) warnings.push(message);
}

function pickBool(raw, fallback, name, warnings) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "boolean") return raw;
  warn(warnings, name + " 需要布尔值，已回退默认 " + String(fallback));
  return fallback;
}

function pickEnum(raw, allowed, fallback, name, warnings) {
  if (raw === undefined || raw === null) return fallback;
  if (allowed.includes(raw)) return raw;
  warn(warnings, name + " 只能是 " + allowed.join("/") + "，已回退默认 " + fallback);
  return fallback;
}

function pickInt(raw, fallback, range, name, warnings) {
  if (raw === undefined || raw === null) return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    warn(warnings, name + " 需要数字，已回退默认 " + fallback);
    return fallback;
  }
  return Math.min(range.max, Math.max(range.min, Math.floor(parsed)));
}

function pickNumber(raw, fallback, range, name, warnings) {
  if (raw === undefined || raw === null) return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    warn(warnings, name + " 需要数字，已回退默认 " + fallback);
    return fallback;
  }
  return Math.min(range.max, Math.max(range.min, parsed));
}

function pickString(raw, fallback, name, warnings) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === "string") return raw.trim() ? raw.trim() : fallback;
  warn(warnings, name + " 需要字符串，已回退默认 " + String(fallback));
  return fallback;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function section(source, key) {
  const value = source[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** options.warnings 是出口而不是返回值上的额外字段：配置形状必须和契约逐字一致。 */
export function resolveConfig(input, options = {}) {
  const source = input && typeof input === "object" ? input : {};
  const env = options.env || process.env;
  const warnings = Array.isArray(options.warnings) ? options.warnings : [];
  const vector = section(source, "vector");
  const proactive = section(source, "proactive");
  const ingest = section(source, "ingest");
  const projection = section(source, "projection");
  const tiering = section(source, "tiering");
  const persona = section(source, "persona");

  return deepFreeze({
    enabled: pickBool(source.enabled, CONFIG_DEFAULTS.enabled, "enabled", warnings),
    dataDir: pickString(source.dataDir, defaultDataDir(env), "dataDir", warnings),
    mode: pickEnum(source.mode, MODES, CONFIG_DEFAULTS.mode, "mode", warnings),
    hotTokenBudget: pickInt(source.hotTokenBudget, CONFIG_DEFAULTS.hotTokenBudget, { min: 0, max: 200000 }, "hotTokenBudget", warnings),
    injectTokenBudget: pickInt(source.injectTokenBudget, CONFIG_DEFAULTS.injectTokenBudget, { min: 0, max: 200000 }, "injectTokenBudget", warnings),
    topN: pickInt(source.topN, CONFIG_DEFAULTS.topN, { min: 0, max: 100 }, "topN", warnings),
    vector: {
      enabled: pickEnum(vector.enabled, VECTOR_ENABLED, CONFIG_DEFAULTS.vector.enabled, "vector.enabled", warnings),
      provider: pickEnum(vector.provider, VECTOR_PROVIDERS, CONFIG_DEFAULTS.vector.provider, "vector.provider", warnings),
      model: pickString(vector.model, CONFIG_DEFAULTS.vector.model, "vector.model", warnings),
      endpoint: pickString(vector.endpoint, CONFIG_DEFAULTS.vector.endpoint, "vector.endpoint", warnings),
      apiKeyEnv: pickString(vector.apiKeyEnv, CONFIG_DEFAULTS.vector.apiKeyEnv, "vector.apiKeyEnv", warnings),
    },
    proactive: {
      enabled: pickBool(proactive.enabled, CONFIG_DEFAULTS.proactive.enabled, "proactive.enabled", warnings),
      quoteThreshold: pickNumber(proactive.quoteThreshold, CONFIG_DEFAULTS.proactive.quoteThreshold, { min: 0, max: 1 }, "proactive.quoteThreshold", warnings),
      askThreshold: pickNumber(proactive.askThreshold, CONFIG_DEFAULTS.proactive.askThreshold, { min: 0, max: 1 }, "proactive.askThreshold", warnings),
      noiseFloor: pickNumber(proactive.noiseFloor, CONFIG_DEFAULTS.proactive.noiseFloor, { min: 0, max: 1 }, "proactive.noiseFloor", warnings),
      maxPerTurn: pickInt(proactive.maxPerTurn, CONFIG_DEFAULTS.proactive.maxPerTurn, { min: 0, max: 20 }, "proactive.maxPerTurn", warnings),
    },
    ingest: {
      llm: pickEnum(ingest.llm, INGEST_LLM, CONFIG_DEFAULTS.ingest.llm, "ingest.llm", warnings),
      everyTurns: pickInt(ingest.everyTurns, CONFIG_DEFAULTS.ingest.everyTurns, { min: 1, max: 10000 }, "ingest.everyTurns", warnings),
      capture: pickBool(ingest.capture, CONFIG_DEFAULTS.ingest.capture, "ingest.capture", warnings),
      filter: pickBool(ingest.filter, CONFIG_DEFAULTS.ingest.filter, "ingest.filter", warnings),
      skipSubagentSessions: pickBool(ingest.skipSubagentSessions, CONFIG_DEFAULTS.ingest.skipSubagentSessions, "ingest.skipSubagentSessions", warnings),
    },
    persona: {
      mode: pickEnum(persona.mode, PERSONA_MODES, CONFIG_DEFAULTS.persona.mode, "persona.mode", warnings),
      kind: pickEnum(persona.kind, PERSONA_KINDS, CONFIG_DEFAULTS.persona.kind, "persona.kind", warnings),
      adapter: pickEnum(persona.adapter, PERSONA_ADAPTERS, CONFIG_DEFAULTS.persona.adapter, "persona.adapter", warnings),
      path: pickString(persona.path, CONFIG_DEFAULTS.persona.path, "persona.path", warnings),
      url: pickString(persona.url, CONFIG_DEFAULTS.persona.url, "persona.url", warnings),
      timeoutMs: pickInt(persona.timeoutMs, CONFIG_DEFAULTS.persona.timeoutMs, { min: 200, max: 10000 }, "persona.timeoutMs", warnings),
      maxChars: pickInt(persona.maxChars, CONFIG_DEFAULTS.persona.maxChars, { min: 200, max: 20000 }, "persona.maxChars", warnings),
      refresh: pickEnum(persona.refresh, PERSONA_REFRESH, CONFIG_DEFAULTS.persona.refresh, "persona.refresh", warnings),
    },
    tiering: {
      enabled: pickBool(tiering.enabled, CONFIG_DEFAULTS.tiering.enabled, "tiering.enabled", warnings),
      demoteAfterDays: pickInt(tiering.demoteAfterDays, CONFIG_DEFAULTS.tiering.demoteAfterDays, { min: 0, max: 3650 }, "tiering.demoteAfterDays", warnings),
      demoteBelowHeat: pickNumber(tiering.demoteBelowHeat, CONFIG_DEFAULTS.tiering.demoteBelowHeat, { min: 0, max: 1 }, "tiering.demoteBelowHeat", warnings),
      coldWeight: pickNumber(tiering.coldWeight, CONFIG_DEFAULTS.tiering.coldWeight, { min: 0, max: 1 }, "tiering.coldWeight", warnings),
      reviveOnMention: pickBool(tiering.reviveOnMention, CONFIG_DEFAULTS.tiering.reviveOnMention, "tiering.reviveOnMention", warnings),
    },
    projection: {
      enabled: pickBool(projection.enabled, CONFIG_DEFAULTS.projection.enabled, "projection.enabled", warnings),
      triggerTokens: pickInt(projection.triggerTokens, CONFIG_DEFAULTS.projection.triggerTokens, { min: 0, max: 1000000 }, "projection.triggerTokens", warnings),
      keepRecentTurns: pickInt(projection.keepRecentTurns, CONFIG_DEFAULTS.projection.keepRecentTurns, { min: 0, max: 10000 }, "projection.keepRecentTurns", warnings),
      maxFoldedTokens: pickInt(projection.maxFoldedTokens, CONFIG_DEFAULTS.projection.maxFoldedTokens, { min: 0, max: 100000 }, "projection.maxFoldedTokens", warnings),
    },
    debug: pickBool(source.debug, CONFIG_DEFAULTS.debug, "debug", warnings),
  });
}
