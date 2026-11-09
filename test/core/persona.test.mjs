/**
 * 两组互不相干的用例，共用一个人格主题：
 * 1) meta 放行（src/record.mjs）—— 桥接要落库的三个 meta 键；
 * 2) 桥接层（src/persona-bridge.mjs）—— 取快照与出计划。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_DEFAULTS, resolveConfig } from "../../src/config.mjs";
import { hashOf, isLoopbackUrl, PERSONA_DEFAULTS, PERSONA_SOURCE_KEY, planPersonaRecord, readPersonaSource, resolvePersonaUrl } from "../../src/persona-bridge.mjs";
import { createRecord, normalizeMeta } from "../../src/record.mjs";

/* ================================================= 组一：meta 放行（record.mjs） */

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

/* =========================================== 组二：桥接层（persona-bridge.mjs） */

/** 造一份只有 persona 块的配置（绕过 resolveConfig，测模块自身的兜底）。 */
function personaConfig(overrides) {
  return { persona: { ...PERSONA_DEFAULTS, ...(overrides || {}) } };
}

function okResponse(text) {
  return { ok: true, status: 200, text: async function () { return text; } };
}

test("persona: PERSONA_DEFAULTS 冻结，且与 config 默认值逐字一致", () => {
  assert.deepEqual({ ...PERSONA_DEFAULTS }, {
    mode: "self",
    kind: "none",
    adapter: "text",
    path: "",
    url: "",
    timeoutMs: 2000,
    maxChars: 4000,
    refresh: "startup",
  });
  assert.ok(Object.isFrozen(PERSONA_DEFAULTS));
  assert.deepEqual({ ...CONFIG_DEFAULTS.persona }, { ...PERSONA_DEFAULTS });
});

test("persona: kind=none → disabled，且不碰任何 IO", async () => {
  let touched = 0;
  const result = await readPersonaSource(personaConfig(), { readFile: async function () { touched += 1; return "x"; }, fetchImpl: function () { touched += 1; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "disabled");
  assert.equal(touched, 0);
});

test("persona: 未知 kind 也按 disabled 处理", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "carrier-pigeon" }));
  assert.equal(result.code, "disabled");
});

test("persona: file 读取成功 → ok + text + hash", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "file", path: "/tmp/persona.txt" }), {
    readFile: async function (path) { assert.equal(path, "/tmp/persona.txt"); return "  她叫林深，说话简短  "; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "她叫林深，说话简短");
  assert.equal(result.hash, hashOf("她叫林深，说话简短"));
  assert.equal(result.hash.length, 16);
});

test("persona: file 读取失败 → read-failed", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "file", path: "/nope" }), {
    readFile: async function () { throw new Error("ENOENT"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "read-failed");
  assert.ok(result.error.includes("ENOENT"));
});

test("persona: file 但 path 为空 → no-source", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "file", path: "   " }));
  assert.equal(result.code, "no-source");
});

test("persona: http 指向 example.com → not-loopback，且 fetch 一次都没被调用", async () => {
  let calls = 0;
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://example.com/persona" }), {
    fetchImpl: function () { calls += 1; return okResponse("x"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-loopback");
  assert.equal(calls, 0);
});

test("persona: 0.0.0.0 / 169.254.169.254 / https 都不是 loopback", async () => {
  const banned = ["http://0.0.0.0:8080/x", "http://169.254.169.254/latest", "https://127.0.0.1/x", "http://127.0.0.2/x", "http://[::2]/x", "ftp://127.0.0.1/x", "not a url"];
  for (const url of banned) {
    let calls = 0;
    const result = await readPersonaSource(personaConfig({ kind: "http", url }), { fetchImpl: function () { calls += 1; return okResponse("x"); } });
    assert.equal(result.ok, false, url);
    assert.equal(result.code, "not-loopback", url);
    assert.equal(calls, 0, "禁止地址不许发请求：" + url);
  }
});

test("persona: 三种 loopback 写法都被放行", async () => {
  for (const url of ["http://127.0.0.1:1/x", "http://localhost:1/x", "http://[::1]:1/x"]) {
    assert.equal(isLoopbackUrl(url), true, url);
    const result = await readPersonaSource(personaConfig({ kind: "http", url }), { fetchImpl: async function () { return okResponse("她叫林深"); } });
    assert.equal(result.ok, true, url);
    assert.equal(result.text, "她叫林深");
  }
});

test("persona: fetch 抛错 → read-failed", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://127.0.0.1/x" }), {
    fetchImpl: async function () { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "read-failed");
});

test("persona: HTTP 非 200 → read-failed", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://127.0.0.1/x" }), {
    fetchImpl: async function () { return { ok: false, status: 503, text: async function () { return "down"; } }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "read-failed");
  assert.ok(result.error.includes("503"));
});

test("persona: 超时 → timeout（超时信号真的生效）", async () => {
  // 不赌 200ms 的真实时钟：注入自己的 AbortController，用 setImmediate 立刻 abort。
  // 原来靠 AbortSignal.timeout() 的 unref 定时器，在"运行时不替测试保活"的 Node 上
  // 会以 "Promise resolution is still pending but the event loop has already resolved" 失败。
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://127.0.0.1/slow", timeoutMs: 200 }), {
    signalOf: function () {
      const controller = new AbortController();
      setImmediate(function () {
        controller.abort();
      });
      return controller.signal;
    },
    fetchImpl: function (url, init) {
      return new Promise(function (_resolve, reject) {
        const signal = init && init.signal;
        if (!signal) { reject(new Error("没有收到超时信号")); return; }
        signal.addEventListener("abort", function () {
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
});

test("persona: 注入的 signalOf 真的被用上（耗时远低于 timeoutMs，不赌时钟）", async () => {
  const started = Date.now();
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://127.0.0.1/slow", timeoutMs: 5000 }), {
    signalOf: function () {
      const controller = new AbortController();
      setImmediate(function () {
        controller.abort();
      });
      return controller.signal;
    },
    fetchImpl: function (url, init) {
      return new Promise(function (_resolve, reject) {
        init.signal.addEventListener("abort", function () {
          const error = new Error("aborted");
          error.name = "TimeoutError";
          reject(error);
        });
      });
    },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.code, "timeout");
  assert.ok(elapsed < 1000, "用了注入信号就该立刻返回，实际耗时 " + elapsed + "ms（timeoutMs 是 5000）");
});

test("persona: 空文本 → empty", async () => {
  const result = await readPersonaSource(personaConfig({ kind: "file", path: "/tmp/p" }), { readFile: async function () { return "    "; } });
  assert.equal(result.ok, false);
  assert.equal(result.code, "empty");
});

test("persona: 超过 maxChars 被截断，hash 对应截断后的文本", async () => {
  const long = "阿".repeat(500);
  const result = await readPersonaSource(personaConfig({ kind: "file", path: "/tmp/p", maxChars: 200 }), { readFile: async function () { return long; } });
  assert.equal(result.ok, true);
  assert.equal(result.text.length, 200);
  assert.equal(result.hash, hashOf(result.text));
  assert.notEqual(result.hash, hashOf(long));
});

test("persona: hash 稳定且与内容一一对应", () => {
  assert.equal(hashOf("同样的文本"), hashOf("同样的文本"));
  assert.notEqual(hashOf("甲"), hashOf("乙"));
  assert.equal(hashOf("x").length, 16);
  assert.ok(/^[0-9a-f]{16}$/.test(hashOf("x")));
});

test("plan: 没有记录 → create", () => {
  const plan = planPersonaRecord({ records: [], hash: "h1", now: 1 });
  assert.deepEqual(plan, { action: "create", hash: "h1" });
});

test("plan: 同 hash → skip，不同 hash → update 且 targetId 正确", () => {
  const records = [
    { id: "turn-1", tier: "hot", meta: { personaSourceKey: PERSONA_SOURCE_KEY, personaHash: "h1" } },
    { id: "fact-2", tier: "persona", meta: { personaSourceKey: PERSONA_SOURCE_KEY, personaHash: "h1" } },
  ];
  assert.deepEqual(planPersonaRecord({ records, hash: "h1" }), { action: "skip", targetId: "fact-2", hash: "h1" });
  assert.deepEqual(planPersonaRecord({ records, hash: "h2" }), { action: "update", targetId: "fact-2", hash: "h2" });
});

test("plan: 只认 tier=persona 且带 personaSourceKey 的记录", () => {
  const records = [
    { id: "a", tier: "persona" },
    { id: "b", tier: "persona", meta: { personaSourceKey: "other", personaHash: "h1" } },
    { id: "c", tier: "cold", meta: { personaSourceKey: PERSONA_SOURCE_KEY, personaHash: "h1" } },
  ];
  assert.deepEqual(planPersonaRecord({ records, hash: "h1" }), { action: "create", hash: "h1" });
});

test("plan: 纯函数——不改入参", () => {
  const records = [{ id: "fact-2", tier: "persona", meta: { personaSourceKey: PERSONA_SOURCE_KEY, personaHash: "h1" } }];
  const before = JSON.stringify(records);
  planPersonaRecord({ records, hash: "h2" });
  assert.equal(JSON.stringify(records), before);
});

test("config: persona 默认值、钳位与非法枚举回退", () => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  assert.deepEqual({ ...config.persona }, { ...PERSONA_DEFAULTS });
  assert.equal(config.mode, "general", "顶层 mode 不受影响");
  const clamped = resolveConfig({ dataDir: "/tmp/x", persona: { timeoutMs: 50, maxChars: 99999 } });
  assert.equal(clamped.persona.timeoutMs, 200);
  assert.equal(clamped.persona.maxChars, 20000);
  const fallback = resolveConfig({ dataDir: "/tmp/x", persona: { mode: "bogus", kind: "nope", refresh: "sometimes" } });
  assert.equal(fallback.persona.mode, "self");
  assert.equal(fallback.persona.kind, "none");
  assert.equal(fallback.persona.refresh, "startup");
  const external = resolveConfig({ dataDir: "/tmp/x", persona: { mode: "external", kind: "http", url: "http://127.0.0.1:9/p", refresh: "turn" } });
  assert.equal(external.persona.mode, "external");
  assert.equal(external.persona.kind, "http");
  assert.equal(external.persona.refresh, "turn");
});

/* ------------------------------------------------- 人格源适配器（dafeiyu） */

/** 假的 fetch：按 URL 路由返回，同时把每次请求的 URL 记下来。 */
function fakeRoutes(routes) {
  const calls = [];
  const impl = async function (url) {
    calls.push(String(url));
    const handler = routes[String(url)];
    if (!handler) return { ok: false, status: 404, text: async function () { return ""; }, json: async function () { return {}; } };
    return handler();
  };
  return { impl, calls };
}

function jsonResponse(value, status) {
  return { ok: (status || 200) === 200, status: status || 200, text: async function () { return JSON.stringify(value); }, json: async function () { return value; } };
}

test("persona: resolvePersonaUrl —— 相对拼 origin，绝对原样，缺 origin 返回空串", () => {
  assert.equal(resolvePersonaUrl("/api/x", "http://127.0.0.1:50870"), "http://127.0.0.1:50870/api/x");
  assert.equal(resolvePersonaUrl("/api/x", "http://127.0.0.1:50870/"), "http://127.0.0.1:50870/api/x");
  assert.equal(resolvePersonaUrl("/api/x", ""), "", "相对路径但没 origin → 空串");
  assert.equal(resolvePersonaUrl("http://127.0.0.1:1/x", ""), "http://127.0.0.1:1/x", "绝对地址不碰 origin");
  assert.equal(resolvePersonaUrl("  ", "http://127.0.0.1:1"), "");
});

test("persona: dafeiyu 两步取 —— /status 拿 id 再 /persona?id= 拿正文", async () => {
  const base = "http://127.0.0.1:50870/api/dsh-persona-dafeiyu";
  const routes = {};
  routes[base + "/status"] = function () { return jsonResponse({ ok: true, value: { active: true, current: "acha" } }); };
  routes[base + "/persona?id=acha"] = function () { return jsonResponse({ ok: true, value: { id: "acha", name: "阿茶", text: "  你是阿茶，说话慢。  " } }); };
  const fake = fakeRoutes(routes);
  const result = await readPersonaSource(personaConfig({ kind: "http", url: base, adapter: "dafeiyu" }), { fetchImpl: fake.impl });
  assert.deepEqual(fake.calls, [base + "/status", base + "/persona?id=acha"]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "你是阿茶，说话慢。");
  assert.equal(result.hash, hashOf("你是阿茶，说话慢。"));
});

test("persona: dafeiyu 的 current 为空 → 不发第二次请求，返回 no-current-persona", async () => {
  const base = "http://127.0.0.1:1/api/dsh-persona-dafeiyu";
  const routes = {};
  routes[base + "/status"] = function () { return jsonResponse({ ok: true, value: { active: false, current: null } }); };
  const fake = fakeRoutes(routes);
  const result = await readPersonaSource(personaConfig({ kind: "http", url: base, adapter: "dafeiyu" }), { fetchImpl: fake.impl });
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-current-persona");
  assert.equal(fake.calls.length, 1, "不许发第二次请求");
});

test("persona: dafeiyu 的 status 403 / 非 JSON / persona 无 text 都是结构化失败", async () => {
  const base = "http://127.0.0.1:1/api/d";
  const forbidden = fakeRoutes({ [base + "/status"]: function () { return { ok: false, status: 403, text: async function () { return ""; }, json: async function () { return {}; } }; } });
  const r1 = await readPersonaSource(personaConfig({ kind: "http", url: base, adapter: "dafeiyu" }), { fetchImpl: forbidden.impl });
  assert.equal(r1.code, "read-failed");
  assert.ok(r1.error.includes("403"));
  assert.equal(forbidden.calls.length, 1);
  const notJson = fakeRoutes({ [base + "/status"]: function () { return { ok: true, status: 200, text: async function () { return "oops"; }, json: async function () { throw new Error("bad json"); } }; } });
  const r2 = await readPersonaSource(personaConfig({ kind: "http", url: base, adapter: "dafeiyu" }), { fetchImpl: notJson.impl });
  assert.equal(r2.code, "read-failed");
  const noText = fakeRoutes({
    [base + "/status"]: function () { return jsonResponse({ ok: true, value: { current: "acha" } }); },
    [base + "/persona?id=acha"]: function () { return jsonResponse({ ok: true, value: { id: "acha" } }); },
  });
  const r3 = await readPersonaSource(personaConfig({ kind: "http", url: base, adapter: "dafeiyu" }), { fetchImpl: noText.impl });
  assert.equal(r3.code, "read-failed");
  assert.ok(r3.error.includes("text"));
});

test("persona: dafeiyu 解析出非 loopback 地址 → not-loopback 且 0 次请求", async () => {
  const fake = fakeRoutes({});
  const result = await readPersonaSource(personaConfig({ kind: "http", url: "http://example.com/api/d", adapter: "dafeiyu" }), { fetchImpl: fake.impl });
  assert.equal(result.code, "not-loopback");
  assert.equal(fake.calls.length, 0, "禁止地址不许发请求");
});

test("persona: 相对 url 由桥自己解析（deps.origin），拿不到 origin → no-source 且不发请求", async () => {
  const origin = "http://127.0.0.1:50870";
  const routes = {};
  routes[origin + "/api/d/status"] = function () { return jsonResponse({ ok: true, value: { current: "acha" } }); };
  routes[origin + "/api/d/persona?id=acha"] = function () { return jsonResponse({ ok: true, value: { text: "阿茶" } }); };
  const fake = fakeRoutes(routes);
  const ok = await readPersonaSource(personaConfig({ kind: "http", url: "/api/d", adapter: "dafeiyu" }), { fetchImpl: fake.impl, origin });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "阿茶");
  assert.deepEqual(fake.calls, [origin + "/api/d/status", origin + "/api/d/persona?id=acha"]);
  const noOrigin = fakeRoutes({});
  const bad = await readPersonaSource(personaConfig({ kind: "http", url: "/api/d" }), { fetchImpl: noOrigin.impl });
  assert.equal(bad.code, "no-source");
  assert.equal(noOrigin.calls.length, 0);
});

test("config: persona.adapter 默认 text，非法值回退 text", () => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  assert.equal(config.persona.adapter, "text");
  assert.equal(resolveConfig({ dataDir: "/tmp/x", persona: { adapter: "dafeiyu" } }).persona.adapter, "dafeiyu");
  assert.equal(resolveConfig({ dataDir: "/tmp/x", persona: { adapter: "bogus" } }).persona.adapter, "text");
});

