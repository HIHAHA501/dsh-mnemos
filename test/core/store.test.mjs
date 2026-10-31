import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createStore } from "../../src/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-mnemos-store-"));
}

function newStore(t, options = {}) {
  const dir = tempDir();
  const store = createStore({ dataDir: dir, ...options });
  t.after(() => {
    try {
      store.close();
    } catch {
      // 用例里已经关掉了
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}

function captureThrow(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

test("store: 增查改查与副本隔离", (t) => {
  const { store } = newStore(t, { now: 1700000000000 });
  const created = store.insert({ kind: "fact", text: "她叫阿满", subject: "user", weight: 0.6 });
  assert.match(created.id, /^fact-[0-9a-z]+-[0-9a-z]{6}$/);
  assert.equal(created.createdAt, 1700000000000);
  assert.equal(store.get(created.id).text, "她叫阿满");
  assert.equal(store.get("不存在"), null);

  // 拿到的必须是副本，改它不能改到库里
  const copy = store.get(created.id);
  copy.text = "改了库里的原文";
  copy.meta.person = ["污染"];
  assert.equal(store.get(created.id).text, "她叫阿满");
  assert.deepEqual(store.get(created.id).meta, {});

  const updated = store.upsert({ id: created.id, text: "她叫阿满，住海边", weight: 0.9 });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, 1700000000000);
  assert.equal(store.get(created.id).text, "她叫阿满，住海边");
  assert.equal(store.all().length, 1);
});

test("store: 重复 id 抛 duplicate-id，缺 dataDir 抛 invalid-datadir", (t) => {
  const { store } = newStore(t);
  const created = store.insert({ text: "第一条" });
  const error = captureThrow(() => store.insert({ ...created }));
  assert.ok(error);
  assert.equal(error.code, "duplicate-id");
  assert.equal(captureThrow(() => createStore({})).code, "invalid-datadir");
});

test("store: pinned 与 forget 生效，recent/candidates 支持 since+limit", (t) => {
  const { store } = newStore(t);
  const first = store.insert({ text: "第一条", createdAt: 1000, updatedAt: 1000 });
  const second = store.insert({ text: "第二条", createdAt: 2000, updatedAt: 2000 });
  const third = store.insert({ text: "第三条", createdAt: 3000, updatedAt: 3000 });

  assert.equal(store.setPinned(first.id, true).pinned, true);
  assert.equal(store.get(first.id).pinned, true);
  assert.equal(store.setPinned("不存在", true), null);

  assert.deepEqual(store.recent(2).map((record) => record.id), [third.id, second.id]);
  assert.deepEqual(store.candidates({ limit: 1 }).map((record) => record.id), [third.id]);
  assert.deepEqual(store.candidates({ since: 2000 }).map((record) => record.id), [third.id, second.id]);

  assert.equal(store.forget(second.id), true);
  assert.equal(store.forget(second.id), false);
  assert.equal(store.get(second.id), null);
  assert.equal(store.all().length, 2);
});

test("store: merge 求 mentions、weight 饱和提升、sourceRefs 去重", (t) => {
  const { store } = newStore(t, { now: 1700000000000 });
  const keep = store.insert({ text: "第一条说法", mentions: 2, weight: 0.5, sourceRefs: ["a", "b"] });
  const dropA = store.insert({ text: "第二条说法", mentions: 3, weight: 0.7, sourceRefs: ["b", "c"] });
  const dropB = store.insert({ text: "第三条说法", mentions: 1, weight: 0.9, sourceRefs: ["d"] });

  const merged = store.merge(keep.id, [dropA.id, dropB.id], { text: "合并后的正文", meta: { place: "海边" }, mentions: 999 });
  assert.equal(merged.mentions, 6);
  assert.ok(Math.abs(merged.weight - 0.95) < 1e-9);
  assert.deepEqual(merged.sourceRefs, ["a", "b", "c", "d"]);
  assert.equal(merged.text, "合并后的正文");
  assert.deepEqual(merged.meta.place, "海边");
  assert.equal(merged.updatedAt, 1700000000000);
  assert.equal(merged.mergedInto, undefined);

  // 被合并的记录不物理删除，只是从候选里退场
  assert.equal(store.all().length, 3);
  assert.equal(store.candidates().length, 1);
  const dropped = store.all().filter((record) => record.mergedInto);
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((record) => record.mergedInto), [keep.id, keep.id]);

  assert.equal(captureThrow(() => store.merge("不存在", [], null)).code, "not-found");
  assert.equal(captureThrow(() => store.merge(keep.id, ["不存在"], null)).code, "not-found");
  assert.equal(store.get(dropA.id).mergedInto, keep.id);
});

test("store: merge 的 weight 提升封顶 1", (t) => {
  const { store } = newStore(t);
  const keep = store.insert({ text: "甲", weight: 0.98 });
  const drop = store.insert({ text: "乙", weight: 0.99 });
  assert.equal(store.merge(keep.id, [drop.id]).weight, 1);
});

test("store: 关闭后重开，数据与 pinned 状态都还在", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = createStore({ dataDir: dir, now: 1700000000000 });
  const fact = first.insert({ kind: "fact", text: "她叫阿满", subject: "user" });
  const turn = first.insert({ kind: "turn", text: "今天下雨", mentions: 3 });
  first.setPinned(fact.id, true);
  first.upsert({ id: turn.id, text: "今天下雨了", mentions: 4 });
  first.close();

  const second = createStore({ dataDir: dir });
  assert.equal(second.all().length, 2);
  assert.equal(second.get(fact.id).pinned, true);
  assert.equal(second.get(turn.id).text, "今天下雨了");
  assert.equal(second.get(turn.id).mentions, 4);
  assert.equal(second.stats().count, 2);
  second.close();
});

test("store: 崩溃留下的半行 JSON 被跳过并记 warning，之后仍可写", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const crashed = createStore({ dataDir: dir, now: 1700000000000 });
  const keeper = crashed.insert({ kind: "fact", text: "她叫阿满", subject: "user" });
  crashed.insert({ kind: "turn", text: "今天下雨" });

  // 模拟硬杀：锁还在、日志尾巴被截断
  rmSync(join(dir, "store.lock"), { force: true });
  appendFileSync(join(dir, "records.jsonl"), '{"op":"put","r":{"id":"turn-broken');

  const recovered = createStore({ dataDir: dir });
  const stats = recovered.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.warnings.length >= 1, true);
  assert.match(stats.warnings.join(" "), /不完整/);
  assert.equal(recovered.get(keeper.id).text, "她叫阿满");

  // 半行已被清掉，新写入必须落在干净的行尾上
  recovered.insert({ kind: "turn", text: "崩溃之后写进来的" });
  recovered.close();

  const reloaded = createStore({ dataDir: dir });
  assert.equal(reloaded.all().length, 3);
  assert.equal(reloaded.stats().warnings.length, 0);
  reloaded.close();
  assert.equal(readFileSync(join(dir, "records.jsonl"), "utf8"), "");
});

test("store: 同一目录第二个实例被 store-locked 挡住，过期锁可接管", (t) => {
  const { dir, store } = newStore(t);
  store.insert({ text: "第一条" });

  const blocked = captureThrow(() => createStore({ dataDir: dir }));
  assert.ok(blocked);
  assert.equal(blocked.code, "store-locked");
  assert.equal(JSON.parse(JSON.stringify(blocked)).code, "store-locked");
  assert.equal(JSON.parse(JSON.stringify(blocked)).detail.holder.pid, process.pid);

  store.close();
  const reopened = createStore({ dataDir: dir });
  assert.equal(reopened.all().length, 1);
  reopened.close();

  // 上一个进程被硬杀：锁文件还在，但已经过期
  writeFileSync(join(dir, "store.lock"), JSON.stringify({ owner: "dead-process", at: Date.now() - 60000 }));
  const taken = createStore({ dataDir: dir });
  assert.equal(taken.all().length, 1);
  taken.close();
});

test("store: 5000 条 insert + candidates() 全量返回 < 300ms", (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let tick = 1700000000000;
  const store = createStore({ dataDir: dir, now: () => (tick += 1) });
  try {
    const started = process.hrtime.bigint();
    for (let index = 0; index < 5000; index += 1) {
      store.insert({
        kind: "turn",
        text: "第 " + index + " 条记忆，今天发生了点值得记住的事",
        mentions: index % 7,
        weight: (index % 10) / 10,
      });
    }
    const list = store.candidates();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(list.length, 5000);
    assert.ok(elapsedMs < 300, "insert 5000 + candidates 耗时 " + elapsedMs.toFixed(1) + "ms");
    t.diagnostic("insert 5000 + candidates: " + elapsedMs.toFixed(1) + "ms");
  } finally {
    store.close();
  }
});

test("store: 顶层无副作用（import 不创建任何文件）", () => {
  const dir = tempDir();
  try {
    const before = readdirSync(dir);
    const entry = pathToFileURL(join(ROOT, "src", "store.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(" + JSON.stringify(entry) + ")"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(dir), before);
    assert.deepEqual(before, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
