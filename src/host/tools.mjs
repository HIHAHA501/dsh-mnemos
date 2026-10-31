/**
 * 记忆工具：搜索 / 写入 / 忘记，最多三个。
 *
 * 不用 defineTool 而是手写注册就绪的定义（parameters 是 JSON Schema 本体）：
 * 宿主包不在本插件的运行时可解析范围里，静态 import 会让裸 node 连 index.mjs 都打不开。
 * 形状与 defineTool 的产物逐字段一致：{name, description, parameters, output:{schema, render}, execute}。
 */

import { createRecord, TIERS } from "../record.mjs";
import { rankRecords } from "./inject.mjs";

export const TOOL_SEARCH = "mem_search";
export const TOOL_WRITE = "mem_write";
export const TOOL_FORGET = "mem_forget";
export const TOOL_NAMES = Object.freeze([TOOL_SEARCH, TOOL_WRITE, TOOL_FORGET]);

/** 工具回给模型的文本上限：工具结果是上下文，不是档案。 */
const RESULT_CHAR_CAP = 400;
const MAX_ROWS = 8;

function clip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

function textBlock(text) {
  return [{ type: "text", text }];
}

function searchTool(deps) {
  return {
    name: TOOL_SEARCH,
    description: "Search the local long-term memory by keywords. Returns matching memories with their ids; use it when the user refers to something that happened earlier.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or a short phrase to look for." },
        limit: { type: "integer", description: "Maximum number of memories to return (1-8, default 5)." },
      },
      required: ["query"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer" },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                score: { type: "number" },
              },
            },
          },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlock("mem_search 失败：" + ((value && value.error) || "unknown error"));
        if (!value.count) return textBlock("mem_search: 没有命中（记忆里没有相关的事，别硬编）");
        const lines = ["mem_search: " + value.count + " 条相关记忆"];
        for (const row of value.rows || []) lines.push("· " + row.id + " " + row.text);
        lines.push("不确定就把它当成线索先问一句，别当成事实。");
        return textBlock(clip(lines.join("\n"), RESULT_CHAR_CAP));
      },
    },
    async execute(args) {
      const query = String((args && args.query) || "").trim();
      if (!query) return { ok: false, error: "query 不能为空" };
      const rawLimit = Number(args && args.limit);
      const limit = Number.isFinite(rawLimit) ? Math.min(MAX_ROWS, Math.max(1, Math.floor(rawLimit))) : 5;
      const store = deps.store;
      let records = [];
      try {
        records = typeof store.candidates === "function" ? store.candidates({ limit: 200 }) : [];
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      const rows = rankRecords({
        query,
        records,
        index: deps.index,
        now: typeof deps.now === "function" ? deps.now() : Date.now(),
        limit,
      });
      return {
        ok: true,
        count: rows.length,
        rows: rows.map((row) => ({
          id: String(row.record.id),
          text: clip(row.record.text, RESULT_CHAR_CAP),
          score: Number(Number(row.score).toFixed(3)),
        })),
      };
    },
  };
}

function writeTool(deps) {
  return {
    name: TOOL_WRITE,
    description: "Store one durable memory (a fact the user stated, a decision, or something worth remembering next session). Keep it short and factual.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory, in one or two sentences." },
        kind: { type: "string", description: "fact | event | profile | milestone | musing (default fact)." },
        tier: { type: "string", description: "hot | cold | persona | state — pin the storage tier explicitly (tierSource becomes user, so automatic demotion never touches it)." },
      },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          tier: { type: "string" },
          error: { type: "string" },
          allowed: { type: "array", items: { type: "string" } },
        },
        required: ["ok"],
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlock("mem_write 失败：" + ((value && value.error) || "unknown error"));
        return textBlock("mem_write: 已记住 " + value.id + (value.tier ? "（层：" + value.tier + "，显式指定）" : ""));
      },
    },
    async execute(args) {
      const text = String((args && args.text) || "").trim();
      if (!text) return { ok: false, error: "text 不能为空" };
      // 显式层是用户意图：非法值必须在落库前就拒绝，别写进去再靠自动降级兜
      const rawTier = args && typeof args.tier === "string" ? args.tier.trim().toLowerCase() : "";
      if (rawTier && !TIERS.includes(rawTier)) {
        return { ok: false, error: "tier 只能是 " + TIERS.join(" | ") + "，收到 " + JSON.stringify(String(args.tier)), allowed: [...TIERS] };
      }
      const store = deps.store;
      const now = typeof deps.now === "function" ? deps.now() : Date.now();
      let record;
      try {
        record = createRecord(
          {
            kind: typeof (args && args.kind) === "string" ? args.kind : "fact",
            text: clip(text, 2000),
            weight: 0.7,
            mentions: 1,
            createdAt: now,
            updatedAt: now,
            sourceRefs: ["tool:" + TOOL_WRITE],
            ...(rawTier ? { tier: rawTier, tierSource: "user" } : {}),
          },
          { now }
        );
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      try {
        if (typeof store.insert === "function") store.insert(record);
        else if (typeof store.upsert === "function") store.upsert(record);
        else return { ok: false, error: "记忆库不可写" };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      if (deps.index && typeof deps.index.add === "function") deps.index.add(record);
      return { ok: true, id: record.id, tier: record.tier };
    },
  };
}

function forgetTool(deps) {
  return {
    name: TOOL_FORGET,
    description: "Delete one memory by id. Use it when the user asks to forget something, or when the stored memory is wrong.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory id, as returned by mem_search or mem_write." },
      },
      required: ["id"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          id: { type: "string" },
          error: { type: "string" },
        },
        required: ["ok"],
      },
      render(_args, value) {
        if (!value || !value.ok) return textBlock("mem_forget 失败：" + ((value && value.error) || "unknown error"));
        return textBlock("mem_forget: 已删除 " + value.id);
      },
    },
    async execute(args) {
      const id = String((args && args.id) || "").trim();
      if (!id) return { ok: false, error: "id 不能为空" };
      const store = deps.store;
      let removed = false;
      try {
        removed = typeof store.forget === "function" ? store.forget(id) === true : false;
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
      if (!removed) return { ok: false, error: "没有这条记忆：" + clip(id, 60) };
      if (deps.index && typeof deps.index.remove === "function") deps.index.remove(id);
      return { ok: true, id };
    },
  };
}

/**
 * 建三个记忆工具的定义（注册由宿主接线层负责）。
 * @param {object} deps 依赖。
 * @returns {Array} 注册就绪的工具定义。
 */
export function createMemoryTools(deps = {}) {
  return [searchTool(deps), writeTool(deps), forgetTool(deps)];
}
