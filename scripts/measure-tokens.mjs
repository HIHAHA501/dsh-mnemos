#!/usr/bin/env node
/**
 * dsh-mnemos 上下文账：三个口径、同一份输入、同一条估算公式。
 *
 *   A 基线     = 全部 turn 文本 + 人设/状态全文（不装插件时的上下文）
 *   B 仅注入   = A + 注入块（projection.enabled=false：只加不删，这是 v1 的行为）
 *   C 注入+投影 = projectMessages 折叠旧正文 + 注入块（默认配置，线上真实行为）
 *
 * 三件事写在最前面，否则表会被读成宣传：
 * 1. 注入块有固定开销（指令行 + 段标题），fixture 只有 4-6 轮，
 *    所以短会话 C > A —— 不是 bug，是"投影默认只在历史超 6000 tokens 时触发"的直接后果。
 * 2. 重放档位排到 256×，正是因为 64× 时最长的一份会话历史只有 4864 tokens，
 *    还够不到触发线：触发线没被跨过时 C 与 B 完全相同。
 * 3. 人设/状态记录在重放里不复制（它是"一直成立的一条状态"，不是每轮新增的历史）。
 *
 * 确定性：时间戳全部取 fixture 的 now（重放按天平移），不读时钟、不联网、零第三方依赖。
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "../src/budget.mjs";
import { resolveConfig } from "../src/config.mjs";
import { createRetrievalIndex, renderInjection } from "../src/host/inject.mjs";
import { messagesTokens, projectMessages } from "../src/host/project.mjs";
import { normalizeRecord } from "../src/record.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(REPO_ROOT, "fixtures");
const FIXTURE_GLOB = /^conversation-.*\.json$/;
const MS_DAY = 86400000;
const FACTORS = [1, 8, 32, 64, 128, 256];

function isPersistent(record) {
  return record.tier === "persona" || record.tier === "state";
}

function lastUserText(turns) {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn && turn.role === "user" && typeof turn.text === "string" && turn.text.trim()) return turn.text.trim();
  }
  return "";
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) width += char.codePointAt(0) > 0x2e7f ? 2 : 1;
  return width;
}

const padRight = (text, width) => String(text) + " ".repeat(Math.max(0, width - displayWidth(text)));
const padLeft = (text, width) => " ".repeat(Math.max(0, width - displayWidth(text))) + String(text);
/** 相对 A 的变化率：负数 = 更省，正数 = 更贵。 */
const delta = (base, value) => (base > 0 ? (value / base - 1) * 100 : 0);
const signedPercent = (value) => (value > 0 ? "+" : value < 0 ? "-" : " ") + Math.abs(value).toFixed(1) + "%";

function toMessages(turns) {
  return turns.map((turn) => ({
    role: turn && turn.role === "assistant" ? "assistant" : "user",
    content: [{ type: "text", text: String(turn && turn.text != null ? turn.text : "") }],
  }));
}

/** 一个会话走三个口径。index 由调用方按当前 records 建好。 */
function evaluate(input, config) {
  const { turns, records, now, index } = input;
  const messages = toMessages(turns);
  const persistentTokens = estimateTokens(records.filter(isPersistent).map((record) => record.text).join("\n"));
  const historyTokens = messagesTokens(messages);
  const baseline = historyTokens + persistentTokens;

  const rendered = renderInjection({ query: lastUserText(turns), records, index, config, now });
  const inject = rendered.tokens;

  // B 的口径证据：enabled=false 时必须原样返回，证明"只加不删"
  const off = projectMessages({ messages, records, config: { projection: { ...config.projection, enabled: false } } });
  const on = projectMessages({ messages, records, config, now });
  const projectedHistory = messagesTokens(on.messages);
  const total = projectedHistory + persistentTokens + inject;

  return {
    turns: turns.length,
    records: records.length,
    baseline,
    historyTokens,
    persistentTokens,
    inject,
    b: baseline + inject,
    bDelta: delta(baseline, baseline + inject),
    c: total,
    cDelta: delta(baseline, total),
    fired: on.changed === true,
    offRespected: off.changed === false && off.messages === messages,
    folded: on.stats.folded,
    historyAfterFold: projectedHistory,
    picks: rendered.picks.length,
    dropped: rendered.dropped.length,
  };
}

function buildIndex(records, config) {
  const index = createRetrievalIndex({ config });
  index.load(records);
  return index;
}

function loadFixture(file) {
  const fixture = JSON.parse(readFileSync(file, "utf8"));
  const now = Number.isFinite(Date.parse(fixture.now)) ? Date.parse(fixture.now) : 0;
  const turns = Array.isArray(fixture.turns) ? fixture.turns : [];
  const records = (Array.isArray(fixture.records) ? fixture.records : []).map((raw) => normalizeRecord(raw, { now }));
  return { name: fixture.fixture || file.replace(/^.*\//, ""), scenario: fixture.scenario || "", turns, records, now };
}

/** 重放：历史按天复制 factor 份；人设/状态只留一份。 */
function replay(fixture, factor) {
  const turns = [];
  const records = [];
  for (let k = 0; k < factor; k += 1) for (const turn of fixture.turns) turns.push(turn);
  for (const record of fixture.records) {
    if (isPersistent(record)) {
      records.push(record);
      continue;
    }
    for (let k = 0; k < factor; k += 1) {
      const shift = k * MS_DAY;
      records.push({
        ...record,
        id: k === 0 ? record.id : record.id + "-d" + k,
        createdAt: record.createdAt + shift,
        updatedAt: record.updatedAt + shift,
      });
    }
  }
  return { turns, records, now: fixture.now + (factor - 1) * MS_DAY };
}

function table(headers, rows, rightFrom) {
  const widths = headers.map((header, i) => Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[i]))));
  const line = (values) => values.map((value, i) => (i >= rightFrom ? padLeft(value, widths[i]) : padRight(value, widths[i]))).join("  ");
  const out = [line(headers), widths.map((width) => "-".repeat(width)).join("  ")];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function main() {
  const config = resolveConfig({ mode: "companion", vector: { enabled: "off" } }, { env: {} });
  const files = readdirSync(FIXTURE_DIR).filter((name) => FIXTURE_GLOB.test(name)).sort();
  if (files.length === 0) {
    console.error("没有找到 fixtures/conversation-*.json");
    return 2;
  }
  const fixtures = files.map((name) => loadFixture(join(FIXTURE_DIR, name)));

  console.log("dsh-mnemos 上下文账（A 基线 / B 仅注入 / C 注入+投影）");
  console.log("A = 全部 turn 文本 + 人设/状态全文；B = A + 注入块（projection.enabled=false，只加不删）；");
  console.log("C = projectMessages 折叠旧正文后 + 注入块（默认配置，线上真实行为）。");
  console.log("三列都逐条累加计费（与注入/投影内部同一口径，文本一次性拼接会因取整略低，故不采用）。");
  console.log("百分比 = 相对 A：负数更省、正数更贵。估算 estimateTokens：CJK×1 + 英文词×1 + 标点×0.3 向上取整。");
  console.log("配置 mode=" + config.mode + " injectTokenBudget=" + config.injectTokenBudget + " hotTokenBudget=" + config.hotTokenBudget +
    "；投影 enabled=" + config.projection.enabled + " triggerTokens=" + config.projection.triggerTokens +
    " keepRecentTurns=" + config.projection.keepRecentTurns + " maxFoldedTokens=" + config.projection.maxFoldedTokens);
  console.log("");

  /* ------------------------------------------------ 表 1：fixture 原样 */
  const singles = fixtures.map((fixture) => {
    const index = buildIndex(fixture.records, config);
    return { fixture, row: evaluate({ turns: fixture.turns, records: fixture.records, now: fixture.now, index }, config) };
  });

  // 取整口径自检：逐条累加 vs 一次性拼接，差值只能是每条 0.3 标点的小数部分被分别取整
  const joinedTokens = singles.map(({ fixture, row }) => {
    const texts = [...fixture.turns.map((turn) => String(turn.text)), ...fixture.records.filter(isPersistent).map((record) => record.text)];
    return { joined: estimateTokens(texts.filter((text) => text.length > 0).join("\n")), row };
  });
  const roundingGap = joinedTokens.reduce((acc, item) => acc + (item.row.baseline - item.joined), 0);

  console.log("表 1 · fixture 原样（4-6 轮；投影未触发时 C 与 B 完全相同）");
  console.log(
    table(
      ["fixture", "场景", "turns", "A 基线", "B 仅注入", "C 注入+投影", "B vs A", "C vs A", "投影", "picks", "被裁"],
      singles.map(({ fixture, row }) => [
        fixture.name.replace(/^conversation-/, ""),
        fixture.scenario,
        String(row.turns),
        String(row.baseline),
        String(row.b),
        String(row.c),
        signedPercent(row.bDelta),
        signedPercent(row.cDelta),
        row.fired ? "折" + row.folded + "条" : "未触发",
        String(row.picks),
        String(row.dropped),
      ]),
      2
    )
  );
  const sum = (key) => singles.reduce((total, item) => total + item.row[key], 0);
  const totalA = sum("baseline");
  const totalB = sum("b");
  const totalC = sum("c");
  console.log(
    "合计：A " + totalA + " / B " + totalB + "（" + signedPercent(delta(totalA, totalB)) + "）/ C " + totalC +
      "（" + signedPercent(delta(totalA, totalC)) + "）"
  );
  console.log("口径自检：逐条累加比一次性拼接多 " + roundingGap + " tokens（每条的小数标点被分别向上取整，属预期）；" +
    "projection.enabled=false 时消息原样返回? " + (singles.every(({ row }) => row.offRespected) ? "是（只加不删）" : "否！"));
  console.log("");

  /* --------------------------------------------------- 表 2：重放各档 */
  const levels = FACTORS.map((factor) => {
    const rows = fixtures.map((fixture) => {
      const replayed = replay(fixture, factor);
      const index = buildIndex(replayed.records, config);
      return evaluate({ turns: replayed.turns, records: replayed.records, now: replayed.now, index }, config);
    });
    const total = (key) => rows.reduce((acc, row) => acc + row[key], 0);
    const longest = rows.reduce((best, row) => (row.historyTokens > best.historyTokens ? row : best), rows[0]);
    return {
      factor,
      turns: total("turns"),
      baseline: total("baseline"),
      b: total("b"),
      c: total("c"),
      bDelta: delta(total("baseline"), total("b")),
      cDelta: delta(total("baseline"), total("c")),
      fired: rows.filter((row) => row.fired).length,
      folded: total("folded"),
      historyBefore: total("historyTokens"),
      longestHistory: longest.historyTokens,
      historyAfter: total("historyAfterFold"),
      inject: total("inject"),
      picks: total("picks"),
      dropped: total("dropped"),
    };
  });

  console.log("表 2 · 同一份 fixture 按天重放（人设/状态不复制；投影触发线 " + config.projection.triggerTokens + " tokens，按单个会话计）");
  console.log(
    table(
      ["档位", "合计turns", "历史合计", "A 基线", "B 仅注入", "C 注入+投影", "B vs A", "C vs A", "投影", "折叠后历史", "picks", "被裁"],
      levels.map((level) => [
        level.factor + "×",
        String(level.turns),
        String(level.historyBefore),
        String(level.baseline),
        String(level.b),
        String(level.c),
        signedPercent(level.bDelta),
        signedPercent(level.cDelta),
        level.fired + "/" + fixtures.length + " 触发",
        String(level.historyAfter),
        String(level.picks),
        String(level.dropped),
      ]),
      1
    )
  );

  const firstFired = levels.find((level) => level.fired > 0);
  const cross = levels.find((level) => level.cDelta < 0);
  const last = levels[levels.length - 1];
  const at64 = levels.find((level) => level.factor === 64);
  const shortLevel = levels[0];

  console.log("");
  console.log("读表要点：");
  console.log("  · 短会话（1×）：C 比 A 贵 " + (totalC - totalA) + " tokens（" + signedPercent(delta(totalA, totalC)) + "）。" +
    "原因有两个，都得说：注入块有固定开销（指令行 + 段标题，1× 注入 " + shortLevel.inject + " tokens），" +
    "而历史只有 " + shortLevel.historyBefore + " tokens，远不到 " + config.projection.triggerTokens + " 的触发线，投影根本不介入。");
  console.log("  · 触发线是按单个会话算的：64× 时最大的一份会话历史只有 " + (at64 ? at64.longestHistory : "?") + " tokens（" +
    (at64 ? at64.longestHistory < config.projection.triggerTokens ? "低于" : "高于" : "?") + " " + config.projection.triggerTokens +
    "），所以那一档 0/" + fixtures.length + " 触发、C 仍等于 B。全组合计历史 " + (at64 ? at64.historyBefore : "?") +
    " 看着很大，但不能拿来判定触发。");
  console.log("  · 第一次触发出现在 " + (firstFired ? firstFired.factor + "×（" + firstFired.fired + "/" + fixtures.length + " 份触发，折叠 " + firstFired.folded + " 条）" : "无") +
    "；C 首次低于 A 在 " + (cross ? cross.factor + "×（" + signedPercent(cross.cDelta) + "）" : "未出现") + "。");
  console.log("  · 长会话（" + last.factor + "×，" + last.turns + " turns）：历史 " + last.historyBefore + " → 折叠后 " + last.historyAfter +
    "，C = " + last.c + " vs A = " + last.baseline + "（" + signedPercent(last.cDelta) + "）。" +
    "注入侧从 8× 起就恒定在 " + levels[1].inject + " tokens，不随历史增长。");
  console.log("");
  console.log("一行汇总：" + fixtures.length + " 份合成会话、estimateTokens 同一口径：短会话（1×，" + shortLevel.turns + " turns）A " + totalA +
    " → C " + totalC + "（" + signedPercent(delta(totalA, totalC)) + "，注入固定开销大于整段历史，且历史 " + shortLevel.historyBefore +
    " tokens 远未到 " + config.projection.triggerTokens + " 的投影触发线，C 与 B 相同）；" +
    last.factor + "× 重放（" + last.turns + " turns）A " + last.baseline + " → C " + last.c + "（" + signedPercent(last.cDelta) +
    "），折叠 " + last.folded + " 条、折叠后历史 " + last.historyAfter + "、注入侧恒定 " + levels[1].inject + " tokens。");
  return 0;
}

process.exitCode = main();
