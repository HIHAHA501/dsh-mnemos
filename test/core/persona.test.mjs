/**
 * record.mjs 的 meta 放行规则：只给人格桥接开三个键，其它未知键照旧丢弃。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createRecord, normalizeMeta } from "../../src/record.mjs";

test("meta：personaSourceKey / personaHash / personaSource 三个键放行", () => {
  const record = createRecord({
    text: "我是她的人格设定。",
    kind: "profile",
    tier: "persona",
    meta: { topic: ["persona"], personaSourceKey: "primary", personaHash: "abc123", personaSource: "file" },
  });
  assert.equal(record.meta.personaSourceKey, "primary");
  assert.equal(record.meta.personaHash, "abc123");
  assert.equal(record.meta.personaSource, "file");
  assert.deepEqual(record.meta.topic, ["persona"]);
});

test("meta：超过 64 字符的 persona 值被截断到 64，而不是丢掉", () => {
  const long = "h".repeat(80);
  const record = createRecord({ text: "x", meta: { personaHash: long } });
  assert.equal(record.meta.personaHash.length, 64);
  assert.equal(record.meta.personaHash, long.slice(0, 64));
});

test("meta：非字符串的 persona 值被忽略（数字 / 对象 / 数组）", () => {
  const record = createRecord({
    text: "x",
    meta: { personaSourceKey: 42, personaHash: { a: 1 }, personaSource: ["file"], topic: ["persona"] },
  });
  assert.equal("personaSourceKey" in record.meta, false);
  assert.equal("personaHash" in record.meta, false);
  assert.equal("personaSource" in record.meta, false);
  assert.deepEqual(record.meta.topic, ["persona"]);
});

test("meta：未知键仍然被丢弃（不是放行任意字符串键）", () => {
  const record = createRecord({
    text: "x",
    meta: { unknownKey: "should-drop", anotherOne: "drop", personaHash: "keep-me" },
  });
  assert.equal("unknownKey" in record.meta, false);
  assert.equal("anotherOne" in record.meta, false);
  assert.equal(record.meta.personaHash, "keep-me");
});

test("meta：既有五个白名单键行为不变", () => {
  const meta = normalizeMeta({
    time: "2025-04-01",
    place: "杭州",
    person: ["阿岚"],
    object: ["磨豆机"],
    topic: ["旅行", "旅行"],
    personaHash: "h1",
  });
  assert.equal(meta.time, "2025-04-01");
  assert.equal(meta.place, "杭州");
  assert.deepEqual(meta.person, ["阿岚"]);
  assert.deepEqual(meta.object, ["磨豆机"]);
  assert.deepEqual(meta.topic, ["旅行"]);
  assert.equal(meta.personaHash, "h1");
});

test("meta：persona 值会 trim，纯空白视为空并忽略", () => {
  const meta = normalizeMeta({ personaSourceKey: "  primary  ", personaSource: "   " });
  assert.equal(meta.personaSourceKey, "primary");
  assert.equal("personaSource" in meta, false);
});
