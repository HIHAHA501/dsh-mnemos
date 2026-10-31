import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_DEFAULTS, resolveConfig } from "../../src/config.mjs";
import { heatOf } from "../../src/heat.mjs";
import { normalizeRecord, TIER_SOURCES } from "../../src/record.mjs";
import { applyTiering, reviveOnMentionPatch, TIER_DEFAULTS } from "../../src/tiering.mjs";

const DAY = 86400000;
const NOW = 1700000000000;

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, "期望 " + expected + "，实际 " + actual);
}

/** 默认造一条「低热、够老」的 hot 记录；要别的形态就覆盖字段。 */
function makeRecord(overrides = {}) {
  return normalizeRecord(
    {
      kind: "turn",
      text: "默认记忆",
      weight: 0,
      mentions: 0,
      createdAt: NOW - 31 * DAY,
      updatedAt: NOW - 31 * DAY,
      ...overrides,
    },
    { now: NOW }
  );
}

test("tiering: TIER_DEFAULTS 与契约逐字一致且冻结", () => {
  assert.deepEqual({ ...TIER_DEFAULTS }, {
    enabled: true,
    demoteAfterDays: 30,
    demoteBelowHeat: 0.35,
    coldWeight: 0.75,
    reviveOnMention: true,
  });
  assert.ok(Object.isFrozen(TIER_DEFAULTS));
});

test("tiering: 超龄低热的 hot 记录被降级（主路径）", () => {
  const record = makeRecord();
  const result = applyTiering([record], NOW);
  assert.equal(result.changed, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.patches, [{ id: record.id, tier: "cold", tierSource: "auto" }]);
});

test("tiering: 边界——刚好 demoteAfterDays 天降级，少 1ms 不降", () => {
  const exact = makeRecord({ id: "turn-exact", createdAt: NOW - 30 * DAY, updatedAt: NOW - 30 * DAY });
  const justUnder = makeRecord({ id: "turn-under", createdAt: NOW - 30 * DAY + 1, updatedAt: NOW - 30 * DAY + 1 });
  assert.equal(applyTiering([exact], NOW).changed, 1);
  assert.equal(applyTiering([justUnder], NOW).changed, 0);
});

test("tiering: 边界——heat 等于 demoteBelowHeat 不降，略低才降", () => {
  const record = makeRecord({ createdAt: NOW - 100 * DAY, updatedAt: NOW - 100 * DAY });
  const heat = heatOf(record, NOW);
  assert.ok(heat < 0.35);
  assert.equal(applyTiering([record], NOW, { demoteBelowHeat: heat }).changed, 0);
  const below = applyTiering([record], NOW, { demoteBelowHeat: heat + 1e-9 });
  assert.equal(below.changed, 1);
});

test("tiering: pinned 的记录不降级", () => {
  const pinned = makeRecord({ pinned: true });
  const result = applyTiering([pinned], NOW);
  assert.equal(result.changed, 0);
  assert.equal(result.skipped, 1);
});

test("tiering: tierSource=user 的记录不降级", () => {
  const result = applyTiering([makeRecord({ tierSource: "user" })], NOW);
  assert.equal(result.changed, 0);
  assert.deepEqual(result.patches, []);
});

test("tiering: persona/state/cold 永不被降级", () => {
  const records = [
    makeRecord({ tier: "persona" }),
    makeRecord({ tier: "state" }),
    makeRecord({ tier: "cold" }),
  ];
  const result = applyTiering(records, NOW);
  assert.equal(result.changed, 0);
  assert.equal(result.skipped, 3);
});

test("tiering: 没有改动时 patches 是空数组（不是 undefined）", () => {
  const result = applyTiering([makeRecord({ createdAt: NOW, updatedAt: NOW })], NOW);
  assert.ok(Array.isArray(result.patches));
  assert.deepEqual(result.patches, []);
  assert.equal(result.changed, 0);
  const empty = applyTiering([], NOW);
  assert.deepEqual(empty.patches, []);
  assert.equal(empty.skipped, 0);
});

test("tiering: 纯函数——不改入参，两次同输入同输出", () => {
  const records = [makeRecord({ id: "turn-a" }), makeRecord({ id: "turn-b", tier: "persona" })];
  const before = JSON.stringify(records);
  const first = applyTiering(records, NOW);
  const second = applyTiering(records, NOW);
  assert.equal(JSON.stringify(records), before, "入参不得被改写");
  assert.deepEqual(first, second);
});

test("tiering: enabled=false 一条都不降", () => {
  const result = applyTiering([makeRecord()], NOW, { enabled: false });
  assert.equal(result.changed, 0);
  assert.deepEqual(result.patches, []);
});

test("heat: 冷层 recency 恒为 1——200 天前与 1 天前同 heat", () => {
  const old = makeRecord({ tier: "cold", createdAt: NOW - 200 * DAY, updatedAt: NOW - 200 * DAY });
  const fresh = makeRecord({ tier: "cold", createdAt: NOW - 1 * DAY, updatedAt: NOW - 1 * DAY });
  approx(heatOf(old, NOW), heatOf(fresh, NOW));
  approx(heatOf(old, NOW), 0.45 * 0.75);
});

test("heat: 冷层整体乘 coldWeight——同一记录 cold 与 hot 的比值是 0.75", () => {
  const hot = makeRecord({ tier: "hot", createdAt: NOW, updatedAt: NOW, weight: 0.5 });
  const cold = makeRecord({ tier: "cold", createdAt: NOW, updatedAt: NOW, weight: 0.5 });
  approx(heatOf(cold, NOW), 0.75 * heatOf(hot, NOW));
  approx(heatOf(hot, NOW), 0.6);
  assert.ok(heatOf(cold, NOW) <= 1);
});

test("heat: coldWeight 可配，且钳到 0..1", () => {
  const cold = makeRecord({ tier: "cold", createdAt: NOW, updatedAt: NOW, weight: 0.5 });
  approx(heatOf(cold, NOW, { coldWeight: 0.5 }), 0.3);
  approx(heatOf(cold, NOW, { coldWeight: 2 }), 0.6);
  approx(heatOf(cold, NOW, { coldWeight: -1 }), 0);
  approx(heatOf(cold, NOW, { coldWeight: "0.5" }), 0.3);
});

test("revive: mentions 变大才回升，tierSource 按契约保持", () => {
  const cold = makeRecord({ tier: "cold", mentions: 3 });
  assert.deepEqual(reviveOnMentionPatch(cold, 2), { tier: "hot", tierSource: "auto" });
  assert.equal(reviveOnMentionPatch(cold, 3), null, "mentions 没变大不回升");
  assert.equal(reviveOnMentionPatch(cold, 4), null);
  assert.equal(reviveOnMentionPatch(makeRecord({ tier: "hot", mentions: 3 }), 2), null);
  assert.equal(reviveOnMentionPatch(cold, 2, { reviveOnMention: false }), null);
  const userCold = makeRecord({ tier: "cold", mentions: 3, tierSource: "user" });
  assert.deepEqual(reviveOnMentionPatch(userCold, 2), { tier: "hot", tierSource: "user" });
});

test("record: tierSource 缺省 auto、非法回退 auto、user 保留", () => {
  assert.deepEqual([...TIER_SOURCES], ["auto", "user"]);
  assert.equal(normalizeRecord({ text: "x" }).tierSource, "auto");
  assert.equal(normalizeRecord({ text: "x", tierSource: "nope" }).tierSource, "auto");
  assert.equal(normalizeRecord({ text: "x", tierSource: "user" }).tierSource, "user");
  assert.equal(normalizeRecord({ text: "x", tier: "cold", tierSource: "user" }).tier, "cold");
});

test("config: tiering 默认值取自 TIER_DEFAULTS，非法值被夹住", () => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  assert.deepEqual({ ...config.tiering }, { ...TIER_DEFAULTS });
  assert.deepEqual({ ...CONFIG_DEFAULTS.tiering }, { ...TIER_DEFAULTS });
  assert.equal(config.injectTokenBudget, 600, "既有字段不受影响");
  const clamped = resolveConfig({
    dataDir: "/tmp/x",
    tiering: { demoteAfterDays: -9, demoteBelowHeat: 2, coldWeight: -1, enabled: false },
  });
  assert.deepEqual({ ...clamped.tiering }, {
    enabled: false,
    demoteAfterDays: 0,
    demoteBelowHeat: 1,
    coldWeight: 0,
    reviveOnMention: true,
  });
  assert.equal(resolveConfig({ dataDir: "/tmp/x", tiering: { demoteAfterDays: 99999 } }).tiering.demoteAfterDays, 3650);
});

test("tiering: 只 import heat.mjs 这一个本地模块", () => {
  const source = readFileSync(fileURLToPath(new URL("../../src/tiering.mjs", import.meta.url)), "utf8");
  const localImports = [...source.matchAll(/^import .* from "(\.[^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(localImports, ["./heat.mjs"]);
});
