import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { estimateTokens, project, tokenParts } from "../../src/budget.mjs";
import { CONFIG_DEFAULTS, defaultDataDir, resolveConfig } from "../../src/config.mjs";
import { bigramSimilarity, planMerge } from "../../src/consolidate.mjs";
import { estimateEmotion } from "../../src/emotion.mjs";
import { heatOf } from "../../src/heat.mjs";
import { createId, createRecord, normalizeRecord } from "../../src/record.mjs";

const DAY = 86400000;
const NOW = 1700000000000;

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, "期望 " + expected + "，实际 " + actual);
}

function makeRecord(overrides = {}) {
  return normalizeRecord({ kind: "turn", text: "默认文本", createdAt: NOW, updatedAt: NOW, ...overrides }, { now: NOW });
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mnemos-config-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("config: 默认值与契约逐字一致", () => {
  const config = resolveConfig({}, { env: { DSH_MNEMOS_DATA_DIR: "/tmp/mnemos-test" } });
  assert.equal(config.enabled, CONFIG_DEFAULTS.enabled);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "general");
  assert.equal(config.hotTokenBudget, 1200);
  assert.equal(config.injectTokenBudget, 600);
  assert.equal(config.topN, 6);
  assert.deepEqual({ ...config.vector }, { enabled: "auto", provider: "none", model: null, endpoint: null, apiKeyEnv: null });
  assert.deepEqual({ ...config.proactive }, { enabled: true, quoteThreshold: 0.62, askThreshold: 0.45, noiseFloor: 0.18, maxPerTurn: 1 });
  assert.deepEqual({ ...config.ingest }, { llm: "auto", everyTurns: 20, capture: true });
  assert.equal(config.debug, false);
  assert.equal(config.dataDir, "/tmp/mnemos-test");
});

test("config: 脏值被钳位或回退，且不抛异常", () => {
  const warnings = [];
  const config = resolveConfig(
    {
      mode: "weird",
      hotTokenBudget: -5,
      injectTokenBudget: "abc",
      topN: 9999,
      vector: { enabled: "sometimes", provider: "api" },
      proactive: { quoteThreshold: 3, maxPerTurn: "x" },
      ingest: { everyTurns: 0 },
    },
    { env: { DSH_MNEMOS_DATA_DIR: "/tmp/mnemos-test" }, warnings },
  );
  assert.equal(config.mode, "general");
  assert.equal(config.hotTokenBudget, 0);
  assert.equal(config.injectTokenBudget, 600);
  assert.equal(config.topN, 100);
  assert.equal(config.vector.enabled, "auto");
  assert.equal(config.vector.provider, "api");
  assert.equal(config.proactive.quoteThreshold, 1);
  assert.equal(config.proactive.maxPerTurn, 1);
  assert.equal(config.ingest.everyTurns, 1);
  assert.ok(warnings.length >= 4);
});

test("config: 解析结果是冻结的", () => {
  const config = resolveConfig({}, { env: { DSH_MNEMOS_DATA_DIR: "/tmp/mnemos-test" } });
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.proactive));
  assert.throws(() => {
    config.mode = "companion";
  }, TypeError);
});

test("config: 默认 dataDir 落在 profile 目录下", (t) => {
  const home = tempDir(t);
  mkdirSync(join(home, "profiles", "alpha"), { recursive: true });
  assert.equal(defaultDataDir({ DSH_HOME: home }), join(home, "profiles", "alpha", "dsh-mnemos"));
  mkdirSync(join(home, "profiles", "beta"), { recursive: true });
  assert.equal(defaultDataDir({ DSH_HOME: home }), join(home, "profiles", "default", "dsh-mnemos"));
  assert.equal(defaultDataDir({ DSH_HOME: home, DSH_PROFILE: "beta" }), join(home, "profiles", "beta", "dsh-mnemos"));
  assert.equal(defaultDataDir({ DSH_HOME: home, DSH_MNEMOS_DATA_DIR: "/data/mem" }), "/data/mem");
});

test("record: id 形如 <kind>-<base36 时间戳>-<6 位随机>", () => {
  const id = createId("turn", NOW);
  const parts = id.split("-");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "turn");
  assert.equal(parseInt(parts[1], 36), Math.floor(NOW));
  assert.match(parts[2], /^[0-9a-z]{6}$/);
  assert.notEqual(createId("turn", NOW), createId("turn", NOW));
});

test("record: 越界字段被钳位、列表去重、缺省值补齐", () => {
  const record = makeRecord({
    id: "turn-fixed-aaaaaa",
    text: "  带空格  ",
    emotion: { valence: 5, arousal: -2 },
    weight: 9,
    mentions: -3,
    sourceRefs: ["a", "a", "b", ""],
    meta: { person: ["阿满", "阿满"], time: "昨晚", place: "" },
  });
  assert.equal(record.id, "turn-fixed-aaaaaa");
  assert.equal(record.text, "带空格");
  assert.equal(record.emotion.valence, 1);
  assert.equal(record.emotion.arousal, 0);
  assert.equal(record.weight, 1);
  assert.equal(record.mentions, 0);
  assert.deepEqual(record.sourceRefs, ["a", "b"]);
  assert.deepEqual(record.meta.person, ["阿满"]);
  assert.equal(record.meta.time, "昨晚");
  assert.equal("place" in record.meta, false);
  assert.equal(record.tier, "hot");
  assert.equal(record.subject, "world");
  assert.equal(record.pinned, false);
});

test("record: 无情绪时 arousal 保留 0.3 中性基线", () => {
  const a = makeRecord({ emotion: {} });
  assert.equal(a.emotion.arousal, 0.3);
  assert.equal(a.emotion.valence, 0);
  assert.equal(createRecord({ text: "hi" }, { now: NOW }).emotion.arousal, 0.3);
});

test("record: 空文本被拒绝", () => {
  assert.throws(
    () => normalizeRecord({ text: "   " }),
    (error) => error.code === "invalid-record",
  );
});

test("heat: 时间越久越冷，且落在 0..1", () => {
  const fresh = makeRecord({ mentions: 0, weight: 0 });
  const week = makeRecord({ mentions: 0, weight: 0, updatedAt: NOW - 7 * DAY, createdAt: NOW - 7 * DAY });
  const month = makeRecord({ mentions: 0, weight: 0, updatedAt: NOW - 30 * DAY, createdAt: NOW - 30 * DAY });
  approx(heatOf(fresh, NOW), 0.45);
  approx(heatOf(week, NOW), 0.45 * Math.pow(0.5, 0.5));
  approx(heatOf(month, NOW), 0.45 * Math.pow(0.5, 30 / 14));
  assert.ok(heatOf(fresh, NOW) > heatOf(week, NOW));
  assert.ok(heatOf(week, NOW) > heatOf(month, NOW));
  assert.ok(heatOf(month, NOW) >= 0);
});

test("heat: persona/state 层不参与时间衰减", () => {
  const oldPersona = makeRecord({ tier: "persona", updatedAt: NOW - 900 * DAY, createdAt: NOW - 900 * DAY, weight: 0, mentions: 0 });
  const newPersona = makeRecord({ tier: "persona", weight: 0, mentions: 0 });
  const oldState = makeRecord({ tier: "state", updatedAt: NOW - 900 * DAY, createdAt: NOW - 900 * DAY, weight: 0, mentions: 0 });
  approx(heatOf(oldPersona, NOW), heatOf(newPersona, NOW));
  approx(heatOf(oldPersona, NOW), 0.45);
  approx(heatOf(oldState, NOW), 0.45);
  const oldHot = makeRecord({ updatedAt: NOW - 900 * DAY, createdAt: NOW - 900 * DAY, weight: 0, mentions: 0 });
  assert.ok(heatOf(oldPersona, NOW) > heatOf(oldHot, NOW));
});

test("heat: mentions 触发递减收益，且 opts 可覆盖权重与半衰期", () => {
  const zero = makeRecord({ mentions: 0, weight: 0 });
  const once = makeRecord({ mentions: 1, weight: 0 });
  const five = makeRecord({ mentions: 5, weight: 0 });
  const fifty = makeRecord({ mentions: 50, weight: 0 });
  assert.ok(heatOf(once, NOW) > heatOf(zero, NOW));
  assert.ok(heatOf(five, NOW) > heatOf(once, NOW));
  assert.ok(heatOf(fifty, NOW) <= 1);
  approx(heatOf(five, NOW), 0.45 + 0.25 * (1 - Math.pow(0.5, 5 / 3)));
  const week = makeRecord({ mentions: 0, weight: 0, updatedAt: NOW - 7 * DAY, createdAt: NOW - 7 * DAY });
  approx(heatOf(week, NOW, { halfLifeDays: 7 }), 0.45 * 0.5);
  approx(heatOf(week, NOW, { weights: { recency: 0, mentions: 0, weight: 1 } }), 0);
});

test("emotion: 三个正例与一个中性例", () => {
  const tired = estimateEmotion("我今天好累");
  assert.ok(tired.valence < 0);
  assert.ok(tired.arousal > 0.3);
  assert.ok(tired.cues.includes("累"));

  const happy = estimateEmotion("今天特别开心，事情都办完了");
  assert.ok(happy.valence > 0.5);
  assert.ok(happy.cues.includes("开心"));

  const anxious = estimateEmotion("有点焦虑，明天要面试");
  assert.ok(anxious.valence < 0);
  assert.ok(anxious.arousal > 0.5);
  assert.ok(anxious.cues.includes("焦虑"));

  assert.deepEqual(estimateEmotion("今天下午三点开会"), { valence: 0, arousal: 0.3, cues: [] });
  assert.deepEqual(estimateEmotion(""), { valence: 0, arousal: 0.3, cues: [] });
});

test("emotion: 程度副词放大 / 削弱，重叠线索只算长的", () => {
  const strong = estimateEmotion("特别烦");
  const weak = estimateEmotion("有点烦");
  const plain = estimateEmotion("烦");
  assert.ok(strong.valence < plain.valence);
  assert.ok(weak.valence > plain.valence);
  const overlap = estimateEmotion("今天很烦躁");
  assert.deepEqual(overlap.cues, ["烦躁"]);
});

test("emotion: 英文线索也能认出来", () => {
  const result = estimateEmotion("I am so tired today");
  assert.ok(result.cues.includes("tired"));
  assert.ok(result.valence < 0);
});

test("consolidate: 相似的同类低权重记录成组，保留 body 最长的正文", () => {
  const a = makeRecord({ id: "turn-1-aaaaaa", text: "今天去了海边，风很大", weight: 0.4 });
  const b = makeRecord({ id: "turn-2-bbbbbb", text: "今天去了海边，风很大。", weight: 0.3, meta: { place: "海边" } });
  const far = makeRecord({ id: "turn-3-cccccc", text: "明天要去面试", weight: 0.4 });
  const plan = planMerge([a, b, far]);
  assert.equal(plan.groups.length, 1);
  assert.deepEqual(plan.groups[0].slice().sort(), ["turn-1-aaaaaa", "turn-2-bbbbbb"]);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.drop.length, 1);
  assert.equal(plan.keep[0] + plan.drop[0], "turn-1-aaaaaa" + "turn-2-bbbbbb");
  assert.equal(plan.patchById[plan.keep[0]].text, "今天去了海边，风很大。");
  assert.deepEqual(plan.patchById[plan.keep[0]].meta.place, "海边");
  assert.ok(bigramSimilarity(a.text, b.text) >= 0.82);
});

test("consolidate: 高权重与 pinned 永不合并", () => {
  const heavy = makeRecord({ id: "turn-1-aaaaaa", text: "她说她喜欢下雨天", weight: 0.8 });
  const light = makeRecord({ id: "turn-2-bbbbbb", text: "她说她喜欢下雨天。", weight: 0.3 });
  assert.deepEqual(planMerge([heavy, light]).groups, []);

  const pinned = makeRecord({ id: "turn-3-cccccc", text: "她说她喜欢下雨天", weight: 0.3, pinned: true });
  const other = makeRecord({ id: "turn-4-dddddd", text: "她说她喜欢下雨天。", weight: 0.3 });
  assert.deepEqual(planMerge([pinned, other]).groups, []);
});

test("consolidate: 跨 kind、低相似度、已合并的记录都不参与", () => {
  const a = makeRecord({ id: "turn-1-aaaaaa", kind: "turn", text: "她喜欢下雨天", weight: 0.3 });
  const b = makeRecord({ id: "fact-2-bbbbbb", kind: "fact", text: "她喜欢下雨天", weight: 0.3 });
  assert.deepEqual(planMerge([a, b]).groups, []);

  const c = makeRecord({ id: "turn-3-cccccc", text: "完全不同的另一句话", weight: 0.3 });
  assert.deepEqual(planMerge([a, c]).groups, []);

  const merged = makeRecord({ id: "turn-4-dddddd", text: "她喜欢下雨天", weight: 0.3, mergedInto: "turn-1-aaaaaa" });
  assert.deepEqual(planMerge([a, merged]).groups, []);
});

test("consolidate: 一组最多 3 条", () => {
  const text = "周末一个人去了美术馆看展";
  const records = ["1", "2", "3", "4"].map((suffix) =>
    makeRecord({ id: "turn-" + suffix + "-aaaaaa", text, weight: 0.2, createdAt: NOW + Number(suffix) }),
  );
  const plan = planMerge(records);
  assert.equal(plan.groups.length, 1);
  assert.equal(plan.groups[0].length, 3);
  assert.equal(plan.keep.length, 1);
  assert.equal(plan.drop.length, 2);
  const involved = new Set([...plan.keep, ...plan.drop]);
  assert.equal(records.filter((record) => !involved.has(record.id)).length, 1);
});

test("budget: token 估算按 CJK 字 + 拉丁词 + 标点*0.3 的口径", () => {
  assert.deepEqual(tokenParts("我爱 iPhonE 两点，OK"), { cjk: 4, words: 2, punct: 1 });
  assert.equal(estimateTokens("我爱 iPhonE 两点，OK"), 7);
  assert.equal(estimateTokens("hello world"), 2);
  assert.equal(estimateTokens("你好"), 2);
  assert.equal(estimateTokens("。"), 1);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("a b c"), 3);
  assert.equal(estimateTokens("こんにちは"), 5);
});

test("budget: persona/state 永远先入选且不被预算裁掉", () => {
  const persona = makeRecord({ id: "fact-1-aaaaaa", tier: "persona", text: "我是小满，陪你聊天的那个人" });
  const cold = makeRecord({ id: "turn-2-bbbbbb", text: "aaaaaaaaa bbbbbbbbb" });
  const result = project([cold, persona], { budget: 3, topN: 4, now: NOW });
  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0].id, "fact-1-aaaaaa");
  assert.ok(result.tokens > 3);
  assert.deepEqual(result.dropped, [{ id: "turn-2-bbbbbb", reason: "budget" }]);
});

test("budget: topN 裁剪与 mergedInto 去重，且保持输入顺序", () => {
  const records = [1, 2, 3, 4].map((index) =>
    makeRecord({ id: "turn-" + index + "-aaaaaa", text: "第" + index + "条" }),
  );
  const droppedByMerged = makeRecord({ id: "turn-5-eeeee0", text: "第1条", mergedInto: "turn-1-aaaaaa" });
  const result = project([...records, droppedByMerged], { budget: 1000, topN: 2, now: NOW });
  assert.deepEqual(result.picks.map((record) => record.id), ["turn-1-aaaaaa", "turn-2-aaaaaa"]);
  assert.equal(result.tokens, 6);
  assert.deepEqual(
    result.dropped.map((entry) => entry.reason),
    ["topN", "topN", "dup"],
  );
});

test("budget: persona 占位后剩余槽位仍按 topN 收口", () => {
  const persona = makeRecord({ id: "fact-1-aaaaaa", tier: "persona", text: "设定" });
  const others = [1, 2, 3].map((index) => makeRecord({ id: "turn-" + index + "-aaaaaa", text: "第" + index + "条" }));
  const result = project([persona, ...others], { budget: 1000, topN: 2, now: NOW });
  assert.equal(result.picks.length, 2);
  assert.equal(result.picks[0].id, "fact-1-aaaaaa");
  assert.equal(result.dropped.filter((entry) => entry.reason === "topN").length, 2);
});
