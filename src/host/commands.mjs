/**
 * /mem 命令族：记忆的运维面。
 *
 * 五个子命令只做「看一眼 / 找一找 / 删掉 / 钉住 / 预算」，
 * 输出一律是给人读的文本（命令结果会被宿主原样写进会话日志，不是 JSON 通道）。
 */

import { TIERS } from "../record.mjs";
import { rankRecords } from "./inject.mjs";

export const COMMAND_NAME = "mem";

export const USAGE = [
  "mem: 用法 — /mem [status | search <query> | forget <id> | pin <id> | tier <id> <tier> | budget]",
  "  status   记忆库与注入面状态（默认）",
  "  search   按关键词检索记忆，回 id 与相关度",
  "  forget   删掉一条记忆（按 id）",
  "  pin      把一条记忆钉住（钉住的不参与合并、热度不掉）",
  "  tier     显式把一条记忆放到某一层（hot | cold | persona | state），不再自动降级",
  "  budget   注入预算与这轮的 token 计账",
].join("\n");

function clip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function counts(record) {
  if (!record || typeof record !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(record)) {
    if (value > 0) parts.push(key + "=" + value);
  }
  return parts.join(" ") || "(none)";
}

function renderStatus(deps) {
  const config = deps.config || {};
  const store = deps.store;
  let stats = {};
  try {
    stats = typeof store.stats === "function" ? store.stats() : {};
  } catch (error) {
    stats = { error: messageOf(error) };
  }
  const index = deps.index && typeof deps.index.stats === "function" ? deps.index.stats() : { docs: 0, terms: 0, meta: 0, vector: { state: "off" } };
  const ledger = deps.ledger && typeof deps.ledger.snapshot === "function" ? deps.ledger.snapshot() : { turns: 0, tokens: 0, last: null };
  const ingest = deps.ingest && typeof deps.ingest.stats === "function" ? deps.ingest.stats() : {};
  const lines = [
    "mem: " + (config.enabled === false ? "off" : "on") + " · mode=" + String(config.mode || "general") + " · dir=" + String(config.dataDir || "-"),
    "records: " + (stats.count || 0) + " total / " + (stats.live || 0) + " live / " + (stats.merged || 0) + " merged",
    "kinds: " + (stats.error ? "(" + stats.error + ")" : counts(stats.byKind)),
    "tiers: " + counts(stats.byTier),
    "index: docs=" + index.docs + " terms=" + index.terms + " meta=" + index.meta + " vector=" + (index.vector ? index.vector.state + (index.vector.reason ? "(" + index.vector.reason + ")" : "") : "off"),
    "ingest: turns=" + (ingest.turns || 0) + " stored=" + (ingest.stored || 0) + " dup=" + (ingest.duplicates || 0) + " skipped=" + (ingest.skipped || 0) + " merges=" + (ingest.merges || 0) + " pending=" + (ingest.pending || 0),
    "inject: budget=" + String(config.injectTokenBudget) + " · turns=" + ledger.turns + " tokens=" + ledger.tokens + (ledger.last ? " · last=" + ledger.last.tokens + " (" + ledger.last.state + ", " + ledger.last.picks + " picks)" : ""),
  ];
  // 分层统计：本次扫描的账 + 显式/自动的存量分布
  const tiering = deps.tiering || {};
  const lastSweep = tiering.last || null;
  let explicit = 0;
  let auto = 0;
  try {
    for (const record of typeof store.all === "function" ? store.all() : []) {
      if (record && record.tierSource === "user") explicit += 1;
      else auto += 1;
    }
  } catch {
    explicit = 0;
    auto = 0;
  }
  lines.push(
    "分层：本次降级 " + (lastSweep ? lastSweep.applied : 0) + " 条（跳过 " + (lastSweep ? lastSweep.skipped : 0) +
      "，来源 " + (lastSweep ? lastSweep.source : "none") + "） · 显式 " + explicit + " 条 / 自动 " + auto + " 条" +
      (ingest.revived ? " · 回升 " + ingest.revived + " 条" : "") +
      (config.tiering && config.tiering.enabled === false ? " · 分层已关闭" : "")
  );
  // 人格桥接：模式看谁负责注入，来源看快照从哪来，hash 用来判断「这次是不是换人了」
  const personaRaw = typeof deps.persona === "function" ? deps.persona() : deps.persona;
  const personaSnap = personaRaw && typeof personaRaw === "object" ? personaRaw : {};
  const personaMode = personaSnap.mode === "external" ? "external" : "self";
  const personaKind = ["none", "file", "http"].indexOf(personaSnap.kind) >= 0 ? personaSnap.kind : "none";
  const personaHash = typeof personaSnap.hash === "string" ? personaSnap.hash : "";
  // 触发来源：turn 是「这轮聊到才同步」，其余（含空/startup）一律按启动触发显示
  const personaTrigger = personaSnap.lastTrigger === "turn" ? "由 turn 触发" : "由启动触发";
  lines.push(
    "人格：模式 " + personaMode + " · 来源 " + personaKind + " · 上次同步 " +
      (Number.isFinite(personaSnap.lastSyncAt) ? new Date(personaSnap.lastSyncAt).toISOString().slice(0, 19).replace("T", " ") + "Z" : "未同步") +
      " · " + personaTrigger +
      (personaHash ? "（hash " + personaHash.slice(0, 4) + "…）" : "")
  );
  // 本会话要不要记：开关来自 captureStore，会话来自「最近活跃会话」
  const captureRaw = typeof deps.capture === "function" ? deps.capture() : deps.capture;
  const captureSnap = captureRaw && typeof captureRaw === "object" ? captureRaw : {};
  const captureSession = typeof captureSnap.sessionId === "string" ? captureSnap.sessionId : "";
  lines.push("本会话记忆：" + (captureSnap.enabled === false ? "关" : "开") + "（会话 " + (captureSession ? captureSession.slice(0, 8) : "暂无") + "）");
  const notes = Array.isArray(deps.notes) ? deps.notes : [];
  // 降级记录前 5 条都露出来：像 ingest.llm 这种「配置项没实现」必须看得见
  if (notes.length) lines.push("degraded: " + notes.slice(0, 5).join(" | "));
  return lines.join("\n");
}

function renderBudget(deps) {
  const config = deps.config || {};
  const ledger = deps.ledger && typeof deps.ledger.snapshot === "function" ? deps.ledger.snapshot() : { turns: 0, tokens: 0, sessions: [], last: null };
  const proactive = config.proactive || {};
  const lines = [
    "mem budget:",
    "  inject: " + String(config.injectTokenBudget) + " tokens/turn · topN=" + String(config.topN) + " · hot=" + String(config.hotTokenBudget),
    "  proactive: " + (proactive.enabled === false ? "off" : "on") + " · quote>=" + String(proactive.quoteThreshold) + " ask>=" + String(proactive.askThreshold) + " noise<=" + String(proactive.noiseFloor) + " max/turn=" + String(proactive.maxPerTurn),
    "  used: " + ledger.turns + " turn(s) · " + ledger.tokens + " tokens total · " + (ledger.skipped || 0) + " skipped",
  ];
  if (ledger.last) lines.push("  last: " + ledger.last.tokens + " tokens (" + ledger.last.state + ", " + ledger.last.picks + " picks, session " + clip(ledger.last.sessionId, 24) + ")");
  for (const session of (ledger.sessions || []).slice(0, 5)) {
    lines.push("  session " + clip(session.sessionId, 24) + ": " + session.turns + " turns · " + session.tokens + " tokens");
  }
  return lines.join("\n");
}

function renderSearch(deps, query) {
  const store = deps.store;
  let records = [];
  try {
    records = typeof store.candidates === "function" ? store.candidates({ limit: 200 }) : [];
  } catch (error) {
    return { kind: "error", text: "mem search: 读记忆库失败 — " + messageOf(error) };
  }
  const rows = rankRecords({
    query,
    records,
    index: deps.index,
    now: typeof deps.now === "function" ? deps.now() : Date.now(),
    limit: 5,
  });
  if (!rows.length) return { kind: "success", text: "mem search: 没有命中（query=" + clip(query, 60) + "）" };
  const lines = ["mem search: " + rows.length + " hit(s) for " + JSON.stringify(clip(query, 60))];
  for (const row of rows) {
    const record = row.record;
    lines.push("  · " + Number(row.score).toFixed(2) + "  " + record.id + "  " + clip(record.text, 80));
  }
  return { kind: "success", text: lines.join("\n") };
}

/**
 * 建 /mem 命令定义（注册由宿主接线层负责）。
 * @param {object} deps 依赖。
 * @returns {object} commands.register 接受的命令定义。
 */
export function createMemCommand(deps = {}) {
  const store = deps.store;

  async function handler(invocation) {
    const rawInput = invocation && typeof invocation.rawInput === "string" ? invocation.rawInput.trim() : "";
    const words = rawInput.split(/\s+/).filter(Boolean);
    const action = (words[0] || "status").toLowerCase();
    const rest = words.slice(1).join(" ").trim();
    try {
      if (action === "status") return { kind: "success", text: renderStatus(deps) };
      if (action === "budget") return { kind: "success", text: renderBudget(deps) };
      if (action === "search") {
        if (!rest) return { kind: "error", text: "mem search: 需要关键词，例：/mem search 下雨天" };
        return renderSearch(deps, rest);
      }
      if (action === "forget") {
        if (!rest) return { kind: "error", text: "mem forget: 需要记忆 id，例：/mem forget turn-xxxx" };
        let removed = false;
        try {
          removed = typeof store.forget === "function" ? store.forget(rest) === true : false;
        } catch (error) {
          return { kind: "error", text: "mem forget: 删除失败 — " + messageOf(error) };
        }
        if (!removed) return { kind: "error", text: "mem forget: 没有这条记忆 — " + clip(rest, 60) };
        if (deps.index && typeof deps.index.remove === "function") deps.index.remove(rest);
        return { kind: "success", text: "mem forget: 已删除 " + rest };
      }
      if (action === "pin") {
        if (!rest) return { kind: "error", text: "mem pin: 需要记忆 id，例：/mem pin turn-xxxx" };
        let saved = null;
        try {
          saved = typeof store.setPinned === "function" ? store.setPinned(rest, true) : null;
        } catch (error) {
          return { kind: "error", text: "mem pin: 钉住失败 — " + messageOf(error) };
        }
        if (!saved) return { kind: "error", text: "mem pin: 没有这条记忆 — " + clip(rest, 60) };
        return { kind: "success", text: "mem pin: 已钉住 " + rest + "（不再参与合并）" };
      }
      if (action === "tier") {
        const id = words[1] || "";
        const tier = (words[2] || "").toLowerCase();
        if (!id || !tier) return { kind: "error", text: "mem tier: 用法 /mem tier <id> <tier>；可用层：" + TIERS.join(" | ") };
        if (!TIERS.includes(tier)) {
          return { kind: "error", text: "mem tier: 无效的层 " + JSON.stringify(words[2]) + "；可用层：" + TIERS.join(" | ") };
        }
        const record = typeof store.get === "function" ? store.get(id) : null;
        if (!record) return { kind: "error", text: "mem tier: 没有这条记忆 — " + clip(id, 60) };
        try {
          store.upsert({ ...record, tier, tierSource: "user" });
        } catch (error) {
          return { kind: "error", text: "mem tier: 写入失败 — " + messageOf(error) };
        }
        return { kind: "success", text: "mem tier: " + id + " 现在在 " + tier + " 层（显式指定，不会被自动降级）" };
      }
      return { kind: "success", text: USAGE };
    } catch (error) {
      return { kind: "error", text: "mem " + action + ": 失败 — " + messageOf(error) };
    }
  }

  return {
    name: COMMAND_NAME,
    description: "本地长期记忆：status（默认）/ search <query> / forget <id> / pin <id> / tier <id> <tier> / budget。",
    input: { hint: "[status | search <query> | forget <id> | pin <id> | tier <id> <tier> | budget]" },
    handler,
  };
}
