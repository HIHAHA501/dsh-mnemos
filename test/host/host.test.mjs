import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, createPanelHandler, mount, name as pluginName, PANEL_PATH, SECTION_NAME, SECTION_ORDER } from "../../index.mjs";
import { estimateTokens } from "../../src/budget.mjs";
import { resolveConfig } from "../../src/config.mjs";
import { createRecord } from "../../src/record.mjs";
import { createStore } from "../../src/store.mjs";
import { createRetrievalIndex, INSTRUCTION, renderInjection } from "../../src/host/inject.mjs";
import { demoteSweep, extractMeta } from "../../src/host/ingest.mjs";
import { buildFoldText, isFoldMessage, messagesTokens, projectMessages, repairBoundary } from "../../src/host/project.mjs";
import { decide, hasRecallConstraint, renderHint } from "../../src/host/proactive.mjs";
import { COMMAND_NAME, USAGE } from "../../src/host/commands.mjs";
import { TOOL_NAMES } from "../../src/host/tools.mjs";

const NOW = 1700000000000;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mnemos-host-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** systemPrompt 服务替身：记录的段就是接线层挂上去的那一段。 */
function fakeSystemPrompt() {
  const sections = [];
  return {
    sections,
    section(definition) {
      sections.push(definition);
      return () => {
        const index = sections.indexOf(definition);
        if (index >= 0) sections.splice(index, 1);
      };
    },
  };
}

function fakeRegistry(label) {
  const entries = [];
  return {
    entries,
    label,
    register(definition) {
      entries.push(definition);
      return () => {
        const index = entries.indexOf(definition);
        if (index >= 0) entries.splice(index, 1);
      };
    },
  };
}

/**
 * 假 ctx：记录注册调用、可注入服务缺失、可注入失败。
 * 只实现接线层真正用到的那几个面（get/on/inject/effect/logger）。
 */
function createFakeCtx(options = {}) {
  const services = { ...(options.services || {}) };
  const listeners = new Map();
  const effects = [];
  const logs = [];
  const injectCalls = [];
  const ctx = {
    services,
    listeners,
    effects,
    logs,
    injectCalls,
    get(serviceName) {
      return services[serviceName];
    },
    on(event, listener, opts) {
      const list = listeners.get(event) || [];
      list.push({ listener, opts });
      listeners.set(event, list);
      return () => {
        const current = listeners.get(event) || [];
        listeners.set(event, current.filter((entry) => entry.listener !== listener));
      };
    },
    inject(deps, callback) {
      injectCalls.push(deps);
      if (deps.every((dep) => services[dep] !== undefined)) callback(ctx);
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === "function") effects.push(disposer);
      return disposer;
    },
    logger() {
      return {
        debug: (message) => logs.push(["debug", String(message)]),
        info: (message) => logs.push(["info", String(message)]),
        warn: (message) => logs.push(["warn", String(message)]),
        error: (message) => logs.push(["error", String(message)]),
      };
    },
    dispose() {
      for (const disposer of effects.splice(0).reverse()) disposer();
    },
  };
  return ctx;
}

/** 建一份带库的运行时；测试结束自动关库（否则锁文件会挡住下一个用例）。 */
function boot(t, config = {}, options = {}) {
  const dir = tempDir(t);
  const ctx = createFakeCtx(options);
  const runtime = mount(ctx, { dataDir: dir, ...config });
  assert.ok(runtime, "插件必须挂载成功");
  t.after(() => ctx.dispose());
  return { ctx, runtime, dir };
}

function seed(runtime, overrides = {}) {
  const record = createRecord(
    { kind: "turn", text: "默认记忆", weight: 0.6, createdAt: NOW, updatedAt: NOW, ...overrides },
    { now: NOW }
  );
  runtime.store.insert(record);
  runtime.index.add(record);
  return record;
}

function sessionWith(sessionId, texts) {
  const events = texts.map((text, index) => ({ type: "user/message", seq: index + 1, data: { content: [{ type: "text", text }] } }));
  return { id: sessionId, events };
}

function preStep(ctx) {
  const list = ctx.listeners.get("agent/pre-step") || [];
  assert.equal(list.length, 1, "应当恰好挂一个 pre-step 监听");
  return list[0].listener;
}

function sessionListener(ctx) {
  const list = ctx.listeners.get("session/event") || [];
  assert.equal(list.length, 1, "应当恰好挂一个 session/event 监听");
  return list[0].listener;
}

/* ------------------------------------------------------------------ 1. 出口 */

test("index: 导出 name/apply，且 mounting 前不碰磁盘", (t) => {
  assert.equal(pluginName, "dsh-mnemos");
  assert.equal(typeof apply, "function");
  assert.equal(typeof mount, "function");
  assert.equal(SECTION_NAME, "dsh-mnemos:memory");
  assert.ok(Number.isFinite(SECTION_ORDER));
});

/* -------------------------------------------------- ① systemPrompt 缺失降级 */

test("① systemPrompt 缺失时只走 pre-step 追加", async (t) => {
  const { ctx, runtime } = boot(t, {});
  seed(runtime, { text: "用户养了一只叫年糕的橘猫" });
  const session = sessionWith("s-1", ["年糕今天又拆家了"]);
  const decision = { kind: "enter", messages: [] };
  const result = await preStep(ctx)({ agent: { session } }, async () => decision);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].source.kind, "dsh-mnemos");
  assert.match(result.messages[0].content[0].text, /\[记忆\]/);
  assert.match(result.messages[0].content[0].text, /年糕/);
});

/* ------------------------------------------------------------ ② 异常吞并 */

test("② pre-step 内异常被吞并，原样返回下游 decision", async (t) => {
  const { ctx, runtime } = boot(t, {});
  seed(runtime, { text: "用户住在香港" });
  const decision = { kind: "enter", messages: [] };
  const payload = {};
  Object.defineProperty(payload, "agent", {
    get() {
      throw new Error("boom-agent");
    },
  });
  const result = await preStep(ctx)(payload, async () => decision);
  assert.equal(result, decision, "异常时必须返回同一个 decision 对象");
  assert.equal(result.messages.length, 0);
  assert.ok(runtime.ingest, "异常之后运行时仍然可用");
});

/* ---------------------------------------------------------- ③ 预算裁剪 */

test("③ 注入 token 超预算时被裁到预算内", (t) => {
  const { runtime } = boot(t, { injectTokenBudget: 200, topN: 8 });
  for (let i = 0; i < 12; i += 1) {
    seed(runtime, { text: "第 " + i + " 条：用户提到周末去海边散步，顺便买了咖啡和面包，回程一直在下雨，衣服都湿透了。" });
  }
  const session = sessionWith("s-2", ["周末去海边散步下雨了"]);
  const text = runtime.render({ agent: { session } });
  assert.ok(text.length > 0, "预算够时必须真的注入");
  assert.ok(estimateTokens(text) <= 200, "注入花费必须落在预算内，实际 " + estimateTokens(text));
  assert.ok(text.includes("不确定就说不确定，别编"));
});

test("③b 预算小到装不下指令时宁可不注入", (t) => {
  const { runtime } = boot(t, { injectTokenBudget: 8 });
  seed(runtime, { text: "用户养了一只叫年糕的橘猫" });
  const session = sessionWith("s-3", ["年糕"]);
  assert.equal(runtime.render({ agent: { session } }), "");
});

/* ------------------------------------------------------- ④ 三态阈值边界 */

test("④ proactive 三态阈值边界", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x", proactive: { quoteThreshold: 0.62, askThreshold: 0.45, noiseFloor: 0.18 } });
  assert.equal(decide({ score: 0.62, config, text: "普通记忆" }).state, "quote", "等于引用阈值就进引用档");
  assert.equal(decide({ score: 0.619, config, text: "普通记忆" }).state, "ask");
  assert.equal(decide({ score: 0.45, config, text: "普通记忆" }).state, "ask", "等于试探阈值就进试探档");
  assert.equal(decide({ score: 0.449, config, text: "普通记忆" }).state, "silence");
  assert.equal(decide({ score: 0.18, config, text: "普通记忆" }).state, "silence", "噪声阈值是排斥边界");
  assert.equal(decide({ score: 0.18, config, text: "普通记忆" }).reason, "noise");
  assert.equal(decide({ score: Number.NaN, config, text: "普通记忆" }).state, "silence");
  const reversed = resolveConfig({ dataDir: "/tmp/x", proactive: { quoteThreshold: 0.3, askThreshold: 0.9, noiseFloor: 0.1 } });
  assert.equal(decide({ score: 0.5, config: reversed, text: "普通记忆" }).state, "ask", "阈值配反时按更严的那档判引用");
});

/* ------------------------------------------------- ⑧ 想不起约束不进引用档 */

test("⑧ 文本里含「想不起」约束时不出现在 quote 分支", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  assert.equal(hasRecallConstraint("用户说他记不清那天了"), true);
  const decision = decide({ score: 0.95, config, text: "这件事你想不起来了，只记得大概" });
  assert.equal(decision.state, "ask");
  assert.equal(decision.reason, "recall-constraint");
  const hint = renderHint(decision, { text: "这件事你想不起来了，只记得大概" });
  assert.match(hint, /\[试探想起\]/);
  assert.ok(!hint.includes("[主动想起]"));
  const quoted = renderHint(decide({ score: 0.95, config, text: "用户养了一只叫年糕的橘猫" }), { text: "用户养了一只叫年糕的橘猫" });
  assert.match(quoted, /\[主动想起\]/);
});

/* ------------------------------------------------- ⑦ companion 才注入人设 */

test("⑦ companion 关闭时不注入 persona/state", (t) => {
  const general = boot(t, { mode: "general" });
  seed(general.runtime, { kind: "profile", tier: "persona", subject: "self", text: "你叫林深，说话简短" });
  seed(general.runtime, { text: "用户喜欢在深夜写代码，常喝冰美式" });
  const session = sessionWith("s-4", ["深夜写代码喝什么"]);
  const generalText = general.runtime.render({ agent: { session } });
  assert.ok(!generalText.includes("[人设与状态]"), "general 模式不该注入人设块");

  const companion = boot(t, { mode: "companion" });
  seed(companion.runtime, { kind: "profile", tier: "persona", subject: "self", text: "你叫林深，说话简短" });
  seed(companion.runtime, { text: "用户喜欢在深夜写代码，常喝冰美式" });
  const companionText = companion.runtime.render({ agent: { session } });
  assert.ok(companionText.includes("[人设与状态]"), "companion 模式必须注入人设块");
  assert.ok(companionText.includes("林深"));
});

/* ------------------------------------------------------- ⑥ 摄取幂等 */

test("⑥ ingest 幂等：同一事件投递两次不产生第二条记录", (t) => {
  const { ctx, runtime } = boot(t);
  const listener = sessionListener(ctx);
  const session = { id: "s-5" };
  const event = { type: "user/message", seq: 7, data: { content: [{ type: "text", text: "今天面试挂了，有点沮丧" }] } };
  listener(session, event);
  listener(session, { type: "turn/end", seq: 8 });
  listener(session, event);
  listener(session, { type: "turn/end", seq: 9 });
  const all = runtime.store.all();
  assert.equal(all.length, 1, "同一事件只该落一条");
  assert.equal(runtime.ingest.stats().duplicates, 1);
});

test("⑥b 摄取忽略自己注入的消息与空文本", (t) => {
  const { ctx, runtime } = boot(t);
  const listener = sessionListener(ctx);
  listener({ id: "s-6" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "记忆注入" }], source: { kind: "dsh-mnemos" } } });
  listener({ id: "s-6" }, { type: "user/message", seq: 2, data: { content: [{ type: "text", text: " " }] } });
  listener({ id: "s-6" }, { type: "turn/end", seq: 3 });
  assert.equal(runtime.store.all().length, 0);
  assert.equal(runtime.ingest.stats().skipped, 1);
});

/* --------------------------------------------------------- ⑨ 合并时机 */

test("⑨ 合并只在写入满 everyTurns 轮时触发一次", (t) => {
  const { ctx, runtime } = boot(t, { ingest: { everyTurns: 2 } });
  const listener = sessionListener(ctx);
  const text = "用户说周末去海边散步，回程下雨";
  listener({ id: "s-7" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text }] } });
  listener({ id: "s-7" }, { type: "turn/end", seq: 2 });
  let stats = runtime.store.stats();
  assert.equal(stats.merged, 0, "第 1 轮不该合并");
  assert.equal(runtime.ingest.stats().merges, 0);

  listener({ id: "s-7" }, { type: "user/message", seq: 3, data: { content: [{ type: "text", text }] } });
  listener({ id: "s-7" }, { type: "turn/end", seq: 4 });
  stats = runtime.store.stats();
  assert.equal(stats.count, 2);
  assert.equal(stats.merged, 1, "第 2 轮攒满 everyTurns 后应当合并");
  assert.equal(stats.live, 1);
  assert.equal(runtime.ingest.stats().merges, 1);
});

/* ------------------------------------------------------ ⑩ dispose 关库 */

test("⑩ ctx.dispose 时 flush 并关闭 store", (t) => {
  const { ctx, runtime } = boot(t);
  const listener = sessionListener(ctx);
  listener({ id: "s-8" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "还没 flush 的这条要在关库前落盘" }] } });
  assert.equal(runtime.ingest.stats().pending, 1);
  ctx.dispose();
  assert.equal(runtime.store.stats().closed, true, "dispose 必须关库");
  assert.equal(runtime.ingest.stats().pending, 0, "关库前必须 flush");
  assert.equal(runtime.store.stats().count, 1);
});

/* ------------------------------------------------------- ⑤ /mem 命令族 */

test("⑤ /mem 五个子命令与未知子命令的输出形状", async (t) => {
  const service = fakeRegistry("commands");
  const { runtime } = boot(t, {}, { services: { commands: service } });
  seed(runtime, { text: "用户养了一只叫年糕的橘猫，特别黏人" });
  const registered = service.entries[0];
  assert.ok(registered, "/mem 必须注册到 commands");
  assert.equal(registered.name, COMMAND_NAME);
  assert.equal(typeof registered.description, "string");

  async function run(rawInput) {
    const result = await registered.handler({ rawInput });
    assert.ok(result && (result.kind === "success" || result.kind === "error"), "结果必须是 {kind,text}");
    assert.equal(typeof result.text, "string");
    assert.ok(result.text.length > 0);
    return result;
  }

  const status = await run("");
  assert.match(status.text, /^mem: /);
  assert.match(status.text, /records: /);
  assert.match(status.text, /index: /);
  assert.match(status.text, /inject: /);

  const budget = await run("budget");
  assert.match(budget.text, /^mem budget:/);
  assert.match(budget.text, /inject: 600 tokens\/turn/);

  const search = await run("search 年糕");
  assert.equal(search.kind, "success");
  assert.match(search.text, /mem search: \d+ hit/);

  const emptySearch = await run("search");
  assert.equal(emptySearch.kind, "error");

  const id = runtime.store.all()[0].id;
  const pin = await run("pin " + id);
  assert.equal(pin.kind, "success");
  assert.equal(runtime.store.get(id).pinned, true);

  const missingPin = await run("pin turn-nope");
  assert.equal(missingPin.kind, "error");

  const forget = await run("forget " + id);
  assert.equal(forget.kind, "success");
  assert.equal(runtime.store.get(id), null);

  const missingForget = await run("forget turn-nope");
  assert.equal(missingForget.kind, "error");

  const unknown = await run("who-knows");
  assert.equal(unknown.kind, "success");
  assert.equal(unknown.text, USAGE);
});

/* ------------------------------------------------------------- 工具面 */

test("工具：注册三个记忆工具并跑通 write → search → forget", async (t) => {
  const tools = fakeRegistry("tools");
  const { runtime } = boot(t, {}, { services: { tools } });
  assert.equal(tools.entries.length, 3);
  assert.deepEqual(tools.entries.map((tool) => tool.name), [...TOOL_NAMES]);

  const byName = new Map(tools.entries.map((tool) => [tool.name, tool]));
  const written = await byName.get("mem_write").execute({ text: "用户在做 dsh-mnemos 这个插件" });
  assert.equal(written.ok, true);
  assert.equal(typeof written.id, "string");

  const found = await byName.get("mem_search").execute({ query: "dsh-mnemos 插件" });
  assert.equal(found.ok, true);
  assert.ok(found.count >= 1);
  assert.ok(found.rows.some((row) => row.id === written.id));

  const rendered = byName.get("mem_search").output.render({}, found);
  assert.equal(rendered[0].type, "text");
  assert.ok(rendered[0].text.length > 0);

  const removed = await byName.get("mem_forget").execute({ id: written.id });
  assert.equal(removed.ok, true);
  assert.equal(runtime.store.get(written.id), null);

  const again = await byName.get("mem_forget").execute({ id: written.id });
  assert.equal(again.ok, false);
});

/* ---------------------------------------------------- 服务缺失的降级面 */

test("服务缺失时降级：没有 commands/tools 也不抛，并记账", async (t) => {
  const { ctx, runtime } = boot(t, {});
  assert.ok(runtime.degraded().some((line) => line.includes("/mem")));
  assert.ok(runtime.degraded().some((line) => line.includes("记忆工具")));
  const result = await preStep(ctx)({ agent: { session: sessionWith("s-9", ["随便说点"]) } }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(result.kind, "enter");
});

test("库打不开时 apply 不抛，返回降级句柄", (t) => {
  const dir = tempDir(t);
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  const ctx = createFakeCtx({});
  const runtime = apply(ctx, { dataDir: blocker });
  assert.ok(runtime, "apply 本身不许抛");
  assert.equal(runtime.store, null);
  assert.ok(runtime.degraded().some((line) => line.includes("记忆库打不开")));
});

/* ------------------------------------------------------------ 日志门控 */

test("debug 关闭时一条日志都不写；打开时才写", (t) => {
  const quiet = boot(t, {});
  seed(quiet.runtime, { text: "用户养了一只叫年糕的橘猫" });
  quiet.runtime.render({ agent: { session: sessionWith("s-10", ["年糕"]) } });
  quiet.ctx.dispose();
  assert.deepEqual(quiet.ctx.logs, []);

  const loud = boot(t, { debug: true });
  seed(loud.runtime, { text: "用户养了一只叫年糕的橘猫" });
  loud.runtime.render({ agent: { session: sessionWith("s-11", ["年糕"]) } });
  assert.ok(loud.ctx.logs.length > 0);
});

/* ------------------------------------------------- 渲染口径（非 JSON dump） */

test("渲染块是中文指令 + 事实，单块 ≤ 600 字，且带不确定约束", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x", mode: "companion" });
  const now = Date.now();
  const records = [
    createRecord({ kind: "profile", tier: "persona", subject: "self", text: "你叫林深，说话简短", weight: 0.9, createdAt: now, updatedAt: now }, { now }),
    createRecord({ kind: "turn", text: "用户养了一只叫年糕的橘猫，特别黏人，晚上会踩键盘", weight: 0.6, createdAt: now, updatedAt: now }, { now }),
  ];
  // 排序靠 bm25 倒排表，所以这里必须带上索引（宿主路径上索引在挂载时建好）
  const index = createRetrievalIndex({ config });
  index.load(records);
  const rendered = renderInjection({ query: "年糕 橘猫", records, index, config, now });
  assert.ok(rendered.text.length > 0);
  assert.ok(rendered.text.includes("不确定就说不确定，别编"));
  assert.ok(!rendered.text.trim().startsWith("{"), "注入块不能是 JSON dump");
  assert.match(INSTRUCTION, /\[记忆\]/);
  for (const block of rendered.text.split("\n\n")) {
    assert.ok(block.length <= 600, "单块超过 600 字：" + block.length);
  }
  assert.ok(estimateTokens(rendered.text) <= config.injectTokenBudget);
  // 同一条事实在一轮里只能出现一次：主动召回提到它时说「上面第一条」，不抄正文
  assert.equal(rendered.text.split("年糕").length - 1, 1);
});

test("段注册形状：name/order/text 函数，段文本按会话重算", (t) => {
  const systemPrompt = fakeSystemPrompt();
  const { runtime } = boot(t, {}, { services: { systemPrompt } });
  assert.equal(systemPrompt.sections.length, 1);
  const section = systemPrompt.sections[0];
  assert.equal(section.name, SECTION_NAME);
  assert.equal(section.order, SECTION_ORDER);
  assert.equal(typeof section.text, "function");
  seed(runtime, { text: "用户养了一只叫年糕的橘猫" });
  const text = section.text({ agent: { session: sessionWith("s-12", ["年糕最近怎么样"]) } });
  assert.match(text, /\[记忆\]/);
});

/* ------------------------------------------------ 面板只读路由（第 2 次运行） */

function fakeWebServer() {
  const routes = [];
  return {
    routes,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
  };
}

/** 假 req/res：够 handler 用的最小形状（method/headers/socket + writeHead/end）。 */
function fakeExchange(method) {
  const res = {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = String(body == null ? "" : body);
    },
  };
  const req = {
    method: method || "GET",
    headers: { host: "127.0.0.1:52603" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  return { req, res };
}

test("面板①：GET 返回 200，含 stats/budget/vector/recalls 四个键", (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  assert.equal(webServer.routes.length, 1);
  assert.equal(webServer.routes[0].kind, "exact");
  assert.equal(webServer.routes[0].path, PANEL_PATH);
  seed(runtime, { text: "用户养了一只叫年糕的橘猫，晚上会踩键盘" });
  runtime.render({ agent: { session: sessionWith("panel-1", ["年糕踩键盘"]) } });
  const exchange = fakeExchange("GET");
  webServer.routes[0].handler(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 200);
  const body = JSON.parse(exchange.res.body);
  for (const key of ["stats", "budget", "vector", "recalls"]) assert.ok(key in body, "缺少 " + key);
  assert.ok(body.recalls.length <= 5);
  assert.equal(typeof body.recalls[0].id, "string");
  assert.equal(typeof body.recalls[0].score, "number");
  assert.ok(Number.isFinite(body.budget.tokens));
  assert.ok(Number.isFinite(body.budget.budget));
  assert.ok(Array.isArray(body.budget.dropped));
  assert.equal(typeof body.vector.state, "string");
});

test("面板②：GET/POST 之外的方法被拒（405），且不写任何数据", (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const before = runtime.store.stats().count;
  const exchange = fakeExchange("PUT");
  webServer.routes[0].handler(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 405);
  assert.equal(exchange.res.headers.allow, "GET, POST");
  assert.ok(JSON.parse(exchange.res.body).error.reason.includes("只接受 GET（读）与 POST（写）"));
  assert.equal(runtime.store.stats().count, before);
});

test("面板③：没有 webServer 面时 503 + 具体 reason", (t) => {
  const { runtime } = boot(t, {});
  const exchange = fakeExchange("GET");
  runtime.panel(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 503);
  assert.ok(JSON.parse(exchange.res.body).error.reason.includes("webServer"));
});

test("面板④：非本机请求被拒（403），记忆正文不外泄", (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const exchange = fakeExchange("GET");
  exchange.req.socket.remoteAddress = "10.0.0.5";
  webServer.routes[0].handler(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 403);
  assert.ok(JSON.parse(exchange.res.body).error.reason.includes("本机"));
});

test("面板⑤：未挂载时 createPanelHandler 单独调用也是 503，不会假装 200", (t) => {
  const { runtime } = boot(t, {});
  const handler = createPanelHandler(runtime);
  const exchange = fakeExchange("GET");
  handler(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 503);
  assert.ok(JSON.parse(exchange.res.body).error.reason.length > 0);
});

/* -------------------------------------------------- 元数据抽取（第 2 次运行） */

test("元数据⑥：一条文本抽出时间/地点/人物/物品主题", (t) => {
  const meta = extractMeta("上周在杭州的咖啡店她说想学胶片摄影", { now: Date.UTC(2024, 4, 15, 10) });
  assert.equal(meta.place, "杭州");
  assert.deepEqual(meta.person, ["她"]);
  assert.ok(meta.object.includes("胶片"));
  assert.equal(meta.time.slice(0, 7), "2024-05");
  assert.equal(meta.time.length, 10);
  assert.ok(meta.topic.includes("摄影"));
  const present = ["time", "place", "person", "object"].filter((key) => meta[key]);
  assert.ok(present.length >= 3, "至少三项，实际 " + present.join(","));
});

test("元数据⑦：抽不到就不写字段（不塞空串）", (t) => {
  assert.deepEqual(extractMeta("嗯嗯"), {});
  assert.deepEqual(extractMeta(""), {});
  const meta = extractMeta("今天在家写代码");
  assert.deepEqual(Object.keys(meta).sort(), ["object", "place", "time"]);
});

test("元数据⑧：落库后 meta 非空，metaIndex.narrow 按地点命中", (t) => {
  const { ctx, runtime } = boot(t);
  const listener = sessionListener(ctx);
  listener({ id: "meta-1" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "上周在杭州的咖啡店她说想学胶片摄影" }] } });
  listener({ id: "meta-1" }, { type: "turn/end", seq: 2 });
  const records = runtime.store.all();
  assert.equal(records.length, 1);
  assert.equal(records[0].meta.place, "杭州");
  assert.ok(Array.isArray(records[0].meta.person) && records[0].meta.person.length > 0);
  assert.ok(records[0].meta.time.length > 0);
  const hits = runtime.index.metaIndex.narrow({ place: "杭州" });
  assert.ok(hits && hits.has(records[0].id), "narrow({place:杭州}) 必须命中该记录");
});

/* ---------------------------------------------------- 预算分段（第 2 次运行） */

function personaFixtures(now) {
  return [
    createRecord({ kind: "profile", tier: "persona", subject: "self", text: "你叫林深，说话简短，不夸张，遇到不确定的事会直接说不确定", weight: 0.9, createdAt: now, updatedAt: now }, { now }),
    createRecord({ kind: "profile", tier: "persona", subject: "self", text: "你喜欢在深夜写代码，白天几乎不回消息，习惯用短句", weight: 0.9, createdAt: now, updatedAt: now }, { now }),
    createRecord({ kind: "turn", text: "用户养了一只叫年糕的橘猫，晚上会踩键盘", weight: 0.6, createdAt: now, updatedAt: now }, { now }),
  ];
}

test("预算⑨：人设块受 hotTokenBudget、召回块受 injectTokenBudget 约束", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x", mode: "companion", hotTokenBudget: 60, injectTokenBudget: 120 });
  const now = Date.now();
  const records = personaFixtures(now);
  const index = createRetrievalIndex({ config });
  index.load(records);
  const rendered = renderInjection({ query: "年糕 橘猫", records, index, config, now });
  assert.ok(rendered.text.length > 0);
  assert.ok(rendered.hotTokens > 0, "人设块应当渲染出来");
  assert.ok(rendered.hotTokens <= 60, "人设块超 hotTokenBudget：" + rendered.hotTokens);
  assert.ok(rendered.injectTokens <= 120, "召回块超 injectTokenBudget：" + rendered.injectTokens);
  assert.ok(rendered.tokens <= 180, "合计超两笔预算之和：" + rendered.tokens);
});

test("预算⑩：超 hotTokenBudget 的人设条目记进 dropped（reason=hot-budget）", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x", mode: "companion", hotTokenBudget: 60, injectTokenBudget: 120 });
  const now = Date.now();
  const records = personaFixtures(now);
  const index = createRetrievalIndex({ config });
  index.load(records);
  const rendered = renderInjection({ query: "年糕 橘猫", records, index, config, now });
  assert.ok(rendered.dropped.some((item) => item.reason === "hot-budget"), "应当记下 hot-budget 裁剪");
  for (const item of rendered.dropped) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.reason, "string");
  }
});

test("预算⑪：召回预算装不下指令行时只砍召回，人设段照旧", (t) => {
  const config = resolveConfig({ dataDir: "/tmp/x", mode: "companion", hotTokenBudget: 60, injectTokenBudget: 4 });
  const now = Date.now();
  const records = personaFixtures(now);
  const index = createRetrievalIndex({ config });
  index.load(records);
  const rendered = renderInjection({ query: "年糕 橘猫", records, index, config, now });
  assert.ok(rendered.text.includes("[人设与状态]"), "人设段不该被召回预算拖累");
  assert.ok(!rendered.text.includes("[记忆]"), "召回指令行放不下时不该出现");
  assert.equal(rendered.picks.length, 0);
});

/* ------------------------------------------------ ingest.llm 不静默（第 2 次运行） */

test("LLM⑫：ingest.llm!=='off' 时启动即记账，/mem status 看得到", async (t) => {
  const commands = fakeRegistry("commands");
  const { runtime } = boot(t, { ingest: { llm: "auto" } }, { services: { commands } });
  assert.ok(runtime.degraded().some((line) => line.includes("LLM 抽取未实现")));
  const status = await commands.entries[0].handler({ rawInput: "status" });
  assert.ok(status.text.includes("LLM 抽取未实现"), "status 输出里必须看得到这条 note");
});

test("LLM⑬：ingest.llm==='off' 时不写这条 note", (t) => {
  const { runtime } = boot(t, { ingest: { llm: "off" } });
  assert.ok(!runtime.degraded().some((line) => line.includes("LLM 抽取未实现")));
});

/* -------------------------------------------------- 召回投影（第 2 次运行） */

test("面板⑭：ledger 留下最近一轮的召回投影（≤5 条，带 id/text/score）", (t) => {
  const { runtime } = boot(t, {});
  for (let i = 0; i < 8; i += 1) {
    seed(runtime, { text: "第 " + i + " 条关于年糕和橘猫的记忆，用户提到它时心情很好" });
  }
  runtime.render({ agent: { session: sessionWith("panel-2", ["年糕 橘猫"]) } });
  const last = runtime.ledger.snapshot().last;
  assert.ok(last, "必须留下最近一轮的计账");
  assert.ok(last.recalls.length > 0 && last.recalls.length <= 5);
  for (const item of last.recalls) {
    assert.equal(typeof item.id, "string");
    assert.equal(typeof item.text, "string");
    assert.equal(typeof item.score, "number");
  }
  assert.ok(Number.isFinite(last.budget));
});

/* ---------------------------------------------------- 上下文投影（第 3 次运行） */

function plainMessage(role, text, id) {
  return { id: id || role + "-" + text.length, role, content: [{ type: "text", text }] };
}

function toolCallMessage(id) {
  return { id: "call-" + id, role: "assistant", content: [{ type: "tool-call", id, name: "read", arguments: { path: "/tmp/" + id } }] };
}

function toolResultMessage(id) {
  return { id: "res-" + id, role: "tool", toolCallId: id, content: [{ type: "text", text: "工具结果 " + id }] };
}

/** 造一段超长会话：每轮两条长正文，可选在中段与末段各插一对 tool 调用。 */
function longConversation(turns) {
  const messages = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ id: "u" + i, role: "user", content: [{ type: "text", text: "第 " + i + " 轮：" + "旧正文一直在上下文里累积。".repeat(24) }] });
    messages.push({ id: "a" + i, role: "assistant", content: [{ type: "text", text: "回答 " + i + "：" + "模型的回复也同样冗长。".repeat(24) }] });
    if (i === 3) {
      messages.push(toolCallMessage("mid"));
      messages.push(toolResultMessage("mid"));
    }
  }
  messages.push(toolCallMessage("last"));
  messages.push(toolResultMessage("last"));
  messages.push(plainMessage("user", "最后这条用户消息必须原样保留"));
  return messages;
}

function projectionPayload(sessionId) {
  return { agent: { session: { id: sessionId, events: [] } } };
}

test("投影①：短会话不折叠、不新增，messages 与上游深相等", async (t) => {
  const systemPrompt = fakeSystemPrompt();
  const { ctx } = boot(t, {}, { services: { systemPrompt } });
  const messages = [
    plainMessage("user", "你好", "s1"),
    plainMessage("assistant", "你好呀", "s2"),
    plainMessage("user", "今天天气怎么样", "s3"),
    plainMessage("assistant", "还行", "s4"),
    plainMessage("user", "嗯", "s5"),
    plainMessage("assistant", "嗯", "s6"),
  ];
  const upstream = messages.slice();
  const decision = { kind: "enter", messages };
  const out = await preStep(ctx)(projectionPayload("p-1"), async () => decision);
  assert.equal(out.messages.length, 6);
  assert.deepEqual(out.messages, upstream);
  assert.ok(!out.messages.some(isFoldMessage));
});

test("投影②：长会话折叠旧正文，尾部与 tool 配对完整保留", async (t) => {
  const systemPrompt = fakeSystemPrompt();
  const { ctx, runtime } = boot(t, { projection: { triggerTokens: 2000 } }, { services: { systemPrompt } });
  const messages = longConversation(24);
  const before = messagesTokens(messages);
  assert.ok(before > 2000, "构造的会话必须超过触发线，实际 " + before);
  const decision = { kind: "enter", messages };
  const out = await preStep(ctx)(projectionPayload("p-2"), async () => decision);
  const after = messagesTokens(out.messages);
  assert.ok(out.messages.length < messages.length, "条数必须下降");
  assert.ok(after <= 2000, "折叠后 token 必须回到触发线以内，实际 " + after);
  // 最后一条 user 原样保留
  const lastUser = messages.filter((m) => m.role === "user").pop();
  const keptLastUser = out.messages.filter((m) => m.role === "user").pop();
  assert.equal(keptLastUser.id, lastUser.id);
  assert.deepEqual(keptLastUser, lastUser);
  // 保留区里 tool-call 与 tool-result 必须成对
  const keptCalls = new Set();
  const keptResults = new Set();
  for (const message of out.messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === "tool-call") keptCalls.add(block.id);
    }
    if (message.toolCallId) keptResults.add(message.toolCallId);
  }
  assert.ok(keptCalls.size > 0, "尾部的那对工具调用必须留下");
  for (const id of keptCalls) assert.ok(keptResults.has(id), "保留的 tool-call 缺配对 result: " + id);
  for (const id of keptResults) assert.ok(keptCalls.has(id), "保留的 tool-result 缺配对 call: " + id);
  assert.ok(runtime.projection && runtime.projection.folded > 0);
  assert.ok(runtime.projection.after <= 2000);
});

test("投影③：projection.enabled=false 时任何长度都不折叠", async (t) => {
  const systemPrompt = fakeSystemPrompt();
  const { ctx } = boot(t, { projection: { enabled: false, triggerTokens: 100 } }, { services: { systemPrompt } });
  const messages = longConversation(24);
  const decision = { kind: "enter", messages };
  const out = await preStep(ctx)(projectionPayload("p-3"), async () => decision);
  assert.equal(out.messages, messages, "关闭时必须原样返回同一条 messages");
  assert.ok(!out.messages.some(isFoldMessage));
});

test("投影④：同一 step 连续两次不叠加折叠消息（幂等）", async (t) => {
  const systemPrompt = fakeSystemPrompt();
  const { ctx } = boot(t, { projection: { triggerTokens: 2000 } }, { services: { systemPrompt } });
  const messages = longConversation(24);
  const handler = preStep(ctx);
  const first = await handler(projectionPayload("p-4"), async () => ({ kind: "enter", messages }));
  assert.equal(first.messages.filter(isFoldMessage).length, 1);
  // 把结果再喂一遍：不再改变
  const second = await handler(projectionPayload("p-4"), async () => ({ kind: "enter", messages: first.messages }));
  assert.equal(second.messages, first.messages);
  assert.equal(second.messages.filter(isFoldMessage).length, 1);
  // 用原始 messages 再跑一遍：结果与第一次逐条一致（不倍增垃圾消息）
  const again = await handler(projectionPayload("p-4"), async () => ({ kind: "enter", messages }));
  assert.deepEqual(again.messages.map((m) => m.id), first.messages.map((m) => m.id));
  assert.equal(again.messages.filter(isFoldMessage).length, 1);
});

test("投影⑤：/mem status 显示最近一次投影的 folded/foldedTokens/kept", async (t) => {
  const systemPrompt = fakeSystemPrompt();
  const commands = fakeRegistry("commands");
  const { ctx, runtime } = boot(t, { projection: { triggerTokens: 2000 } }, { services: { systemPrompt, commands } });
  const messages = longConversation(24);
  await preStep(ctx)(projectionPayload("p-5"), async () => ({ kind: "enter", messages }));
  // 真实时序：pre-step 之后紧接着就是这次请求的装配，计账落在那里
  runtime.render({ agent: { session: { id: "p-5", events: [] } } });
  const status = await commands.entries[0].handler({ rawInput: "status" });
  assert.ok(status.text.includes("folded="), "status 必须带 folded");
  assert.ok(status.text.includes("foldedTokens="), "status 必须带 foldedTokens");
  assert.ok(status.text.includes("kept="), "status 必须带 kept");
  const last = runtime.ledger.snapshot().last;
  assert.ok(last.projection && last.projection.folded > 0);
  assert.ok(last.projection.foldedTokens > 0);
  assert.ok(last.projection.kept > 0);
});

test("投影⑥：tool 配对跨界与判不出配对时的边界规则", () => {
  const plain = (role, text) => ({ role, content: [{ type: "text", text }] });
  // 成对都在折叠区：边界不动
  let messages = [plain("user", "1"), plain("assistant", "2"), toolCallMessage("c1"), toolResultMessage("c1"), plain("user", "3"), plain("assistant", "4")];
  assert.equal(repairBoundary(messages, 4, 4), 4);
  // 跨界（调用在折叠区、结果正好落在保留区）：整对一起处理
  messages = [plain("user", "1"), toolCallMessage("c1"), toolResultMessage("c1"), plain("user", "3"), plain("assistant", "4")];
  assert.equal(repairBoundary(messages, 2, 3), 3);
  // 有结果没调用：判不出配对 → 整条保留
  messages = [plain("user", "1"), plain("assistant", "2"), toolResultMessage("zz"), plain("user", "3")];
  assert.equal(repairBoundary(messages, 3, 3), 2);
});

test("投影⑦：折叠消息受 maxFoldedTokens 约束，且写明「不是遗忘」", () => {
  const records = [];
  for (let i = 0; i < 20; i += 1) records.push({ text: "要点 " + i + "：" + "很长的记忆正文".repeat(12) });
  const text = buildFoldText(37, records, 120);
  assert.ok(estimateTokens(text) <= 120, "折叠消息超上限：" + estimateTokens(text));
  assert.ok(text.includes("不是遗忘"));
  assert.ok(text.includes("37 条消息已折叠"));
  const tight = buildFoldText(9, records, 4);
  assert.equal(tight.split("\n").length, 1, "上限太小时只留一行表头，不再挂要点");
});

test("投影⑧：projection 默认值保守，非法值被夹住且不影响既有字段", () => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  assert.deepEqual({ ...config.projection }, { enabled: true, triggerTokens: 6000, keepRecentTurns: 8, maxFoldedTokens: 400 });
  assert.equal(config.injectTokenBudget, 600);
  assert.equal(config.hotTokenBudget, 1200);
  const custom = resolveConfig({ dataDir: "/tmp/x", projection: { triggerTokens: -5, keepRecentTurns: "3" } });
  assert.equal(custom.projection.triggerTokens, 0);
  assert.equal(custom.projection.keepRecentTurns, 3);
  assert.equal(custom.projection.enabled, true);
});

test("投影⑨：折叠要点取自本会话记录", () => {
  const config = resolveConfig({ dataDir: "/tmp/x", projection: { triggerTokens: 2000 } });
  const records = [{ sessionId: "s1", text: "用户养了一只叫年糕的橘猫" }];
  const out = projectMessages({ messages: longConversation(24), records, config });
  assert.equal(out.changed, true);
  const text = out.messages[0].content[0].text;
  assert.ok(text.includes("年糕"), "要点应当来自记录");
  assert.ok(isFoldMessage(out.messages[0]));
});

test("投影⑩：未超触发线时原样返回（引用相等）", () => {
  const config = resolveConfig({ dataDir: "/tmp/x" });
  const messages = [plainMessage("user", "短", "x1"), plainMessage("assistant", "也短", "x2")];
  const out = projectMessages({ messages, config });
  assert.equal(out.changed, false);
  assert.equal(out.messages, messages);
  assert.equal(out.stats.folded, 0);
});

/* ------------------------------------------------------ 分层接线（第 2 阶段） */

const DAY_MS = 86400000;

/** 造一条指定年龄的记录（字段形状与真实落库一致）。 */
function agedRecord(ageDays, overrides) {
  const stamp = Date.now() - ageDays * DAY_MS;
  return createRecord({ kind: "turn", text: "年龄 " + ageDays + " 天的记忆", weight: 0, mentions: 0, createdAt: stamp, updatedAt: stamp, ...(overrides || {}) }, { now: stamp });
}

test("分层①：启动时对存量重算一次，40 天前的 hot 记录被降级且 notes 有计数", (t) => {
  const dir = tempDir(t);
  const seedStore = createStore({ dataDir: dir });
  const record = agedRecord(40, { text: "四十天前的旧事" });
  seedStore.insert(record);
  seedStore.close();
  const ctx = createFakeCtx({});
  const runtime = mount(ctx, { dataDir: dir });
  t.after(() => ctx.dispose());
  const saved = runtime.store.get(record.id);
  assert.equal(saved.tier, "cold", "启动重算必须把它降级");
  assert.equal(saved.tierSource, "auto");
  assert.equal(runtime.tiering.last.source, "startup");
  assert.equal(runtime.tiering.last.applied, 1);
  assert.equal(runtime.tiering.totals.applied, 1);
  assert.ok(runtime.degraded().some((line) => line.includes("分层：本次降级 1 条")), "notes 里要有降级计数：" + runtime.degraded().join(" | "));
});

test("分层②：写入落库后扫一次——超龄降级、未超龄不动", (t) => {
  const { ctx, runtime } = boot(t, {});
  const listener = sessionListener(ctx);
  const old = agedRecord(40, { text: "很老的记忆" });
  const young = agedRecord(1, { text: "刚发生的记忆" });
  runtime.store.insert(old);
  runtime.store.insert(young);
  listener({ id: "sweep-1" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "今天有点累" }] } });
  listener({ id: "sweep-1" }, { type: "turn/end", seq: 2 });
  assert.equal(runtime.store.get(old.id).tier, "cold");
  assert.equal(runtime.store.get(young.id).tier, "hot");
  assert.ok(runtime.ingest.stats().demoted >= 1);
  assert.equal(runtime.tiering.last.source, "flush");
});

test("分层③：合并让 mentions 变大时冷记录回升 hot，status 显示回升数", async (t) => {
  const commands = fakeRegistry("commands");
  const { ctx, runtime } = boot(t, { ingest: { everyTurns: 1 } }, { services: { commands } });
  const listener = sessionListener(ctx);
  const text = "用户养了一只叫年糕的橘猫";
  const cold = createRecord({ kind: "turn", text, weight: 0.5, mentions: 1, tier: "cold", tierSource: "auto" }, { now: Date.now() });
  runtime.store.insert(cold);
  listener({ id: "revive-1" }, { type: "user/message", seq: 1, data: { content: [{ type: "text", text }] } });
  listener({ id: "revive-1" }, { type: "turn/end", seq: 2 });
  const saved = runtime.store.get(cold.id);
  assert.equal(saved.tier, "hot", "mentions 变大应当回升");
  assert.ok(runtime.ingest.stats().revived >= 1);
  const status = await commands.entries[0].handler({ rawInput: "status" });
  assert.ok(status.text.includes("回升"), "status 要能看到回升数：" + status.text);
});

test("分层④：mem_write 支持显式 tier；非法值结构化报错且不落库", async (t) => {
  const tools = fakeRegistry("tools");
  const { runtime } = boot(t, {}, { services: { tools } });
  const byName = new Map(tools.entries.map((tool) => [tool.name, tool]));
  const ok = await byName.get("mem_write").execute({ text: "用户要求把这条放进人设层", tier: "persona" });
  assert.equal(ok.ok, true);
  assert.equal(ok.tier, "persona");
  const saved = runtime.store.get(ok.id);
  assert.equal(saved.tier, "persona");
  assert.equal(saved.tierSource, "user");
  const rendered = byName.get("mem_write").output.render({}, ok);
  assert.ok(rendered[0].text.includes("persona"));
  const before = runtime.store.all().length;
  const bad = await byName.get("mem_write").execute({ text: "这条不该落库", tier: "bogus" });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.allowed, ["hot", "cold", "persona", "state"]);
  assert.ok(bad.error.includes("hot | cold | persona | state"));
  assert.equal(runtime.store.all().length, before, "非法 tier 不许落库");
});

test("分层⑤：/mem tier 显式改层、非法层报错列可选值、未知 id 报错", async (t) => {
  const commands = fakeRegistry("commands");
  const { runtime } = boot(t, {}, { services: { commands } });
  const record = seed(runtime, { text: "要改层的记忆" });
  const handler = commands.entries[0].handler;
  const ok = await handler({ rawInput: "tier " + record.id + " cold" });
  assert.equal(ok.kind, "success");
  assert.ok(ok.text.includes("现在在 cold 层"));
  assert.ok(ok.text.includes("不会被自动降级"));
  const saved = runtime.store.get(record.id);
  assert.equal(saved.tier, "cold");
  assert.equal(saved.tierSource, "user");
  const bad = await handler({ rawInput: "tier " + record.id + " bogus" });
  assert.equal(bad.kind, "error");
  assert.ok(bad.text.includes("hot | cold | persona | state"));
  assert.equal(runtime.store.get(record.id).tier, "cold", "非法层不该改动记录");
  const missing = await handler({ rawInput: "tier turn-nope cold" });
  assert.equal(missing.kind, "error");
  assert.ok(missing.text.includes("没有这条记忆"));
  const noArgs = await handler({ rawInput: "tier" });
  assert.equal(noArgs.kind, "error");
  assert.ok(noArgs.text.includes("可用层"));
});

test("分层⑥：/mem status 有分层统计行（显式/自动/本次降级）", async (t) => {
  const commands = fakeRegistry("commands");
  const { runtime } = boot(t, {}, { services: { commands } });
  seed(runtime, { text: "自动层的记忆" });
  const explicit = seed(runtime, { text: "显式层的记忆" });
  runtime.store.upsert({ ...runtime.store.get(explicit.id), tier: "persona", tierSource: "user" });
  const status = await commands.entries[0].handler({ rawInput: "status" });
  assert.ok(status.text.includes("分层：本次降级"), status.text);
  assert.ok(status.text.includes("显式 1 条"));
  assert.ok(status.text.includes("自动 1 条"));
});

test("分层⑦：tiering.enabled=false 时启动不降级", (t) => {
  const dir = tempDir(t);
  const seedStore = createStore({ dataDir: dir });
  const record = agedRecord(40, { text: "关闭时不该被降级" });
  seedStore.insert(record);
  seedStore.close();
  const ctx = createFakeCtx({});
  const runtime = mount(ctx, { dataDir: dir, tiering: { enabled: false } });
  t.after(() => ctx.dispose());
  assert.equal(runtime.store.get(record.id).tier, "hot");
  assert.equal(runtime.tiering.last.enabled, false);
  assert.equal(runtime.tiering.last.applied, 0);
});

test("分层⑧：粗筛——年龄不够的不进判定，tierSource=user 的也不动", (t) => {
  const { runtime } = boot(t, {});
  const young = agedRecord(2, { text: "还很年轻" });
  const pinnedByUser = agedRecord(90, { text: "用户显式钉在 hot", tierSource: "user" });
  runtime.store.insert(young);
  runtime.store.insert(pinnedByUser);
  const swept = demoteSweep({ store: runtime.store, config: runtime.config, now: Date.now(), source: "test" });
  assert.equal(swept.changed, 0);
  assert.equal(runtime.store.get(young.id).tier, "hot");
  assert.equal(runtime.store.get(pinnedByUser.id).tier, "hot");
});

test("分层⑨：扫不到东西时不炸（缺 store / 缺方法）", () => {
  const empty = demoteSweep({ store: null, config: { tiering: { enabled: true } }, now: Date.now() });
  assert.equal(empty.changed, 0);
  assert.equal(empty.applied, 0);
  assert.equal(empty.error, undefined);
  const partial = demoteSweep({ store: {}, config: { tiering: { enabled: true } }, now: Date.now() });
  assert.equal(partial.changed, 0);
});

test("分层⑩：/mem status 在分层关闭时注明已关闭", async (t) => {
  const commands = fakeRegistry("commands");
  boot(t, { tiering: { enabled: false } }, { services: { commands } });
  const status = await commands.entries[0].handler({ rawInput: "status" });
  assert.ok(status.text.includes("分层已关闭"), status.text);
});

test("分层⑪：显式 tier 的记录不会被后续扫描降级", (t) => {
  const { runtime } = boot(t, {});
  const explicit = agedRecord(40, { text: "显式 hot", tierSource: "user" });
  runtime.store.insert(explicit);
  const swept = demoteSweep({ store: runtime.store, config: runtime.config, now: Date.now(), source: "test" });
  assert.equal(swept.changed, 0);
  assert.equal(runtime.store.get(explicit.id).tier, "hot");
});

test("分层⑫：快照里带着分层账（面板/命令共用一份）", (t) => {
  const { runtime } = boot(t, {});
  const snap = runtime.snapshot();
  assert.ok(snap.tiering);
  assert.equal(snap.tiering.last.source, "startup");
  assert.ok(Number.isFinite(snap.tiering.totals.applied));
});

/* --------------------------------------------- 面板受控写（第 3 阶段升级） */

const PANEL_HEADERS = { host: "127.0.0.1:52603", "content-type": "application/json", "x-dsh-mnemos": "1" };

/** 假 http：res 收状态/头/体，req 是可写流的替身（data/end/error 三个事件）。 */
function fakeHttp(options) {
  const opts = options || {};
  const res = { status: 0, headers: {}, body: "", writeHead(status, headers) { this.status = status; this.headers = headers || {}; }, end(body) { this.body = String(body == null ? "" : body); } };
  const handlers = { data: [], end: [], error: [] };
  const payload = opts.body == null ? "" : String(opts.body);
  const req = {
    method: opts.method || "GET",
    headers: opts.headers || { host: "127.0.0.1:52603" },
    socket: { remoteAddress: opts.remoteAddress || "127.0.0.1" },
    on(name, fn) {
      (handlers[name] || (handlers[name] = [])).push(fn);
      if (name === "end") {
        queueMicrotask(function () {
          const half = Math.floor(payload.length / 2);
          for (const handler of handlers.data) {
            if (half > 0) handler(Buffer.from(payload.slice(0, half)));
            if (payload.length > half) handler(Buffer.from(payload.slice(half)));
          }
          for (const handler of handlers.end) handler();
        });
      }
      return req;
    },
    removeListener(name, fn) {
      const list = handlers[name] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
      return req;
    },
    pause() {},
    destroy() {},
  };
  return { req, res };
}

/** 打一次 POST。 */
async function postPanel(handler, body, options) {
  const opts = options || {};
  const exchange = fakeHttp({ method: "POST", headers: opts.headers || PANEL_HEADERS, body: typeof body === "string" ? body : JSON.stringify(body), remoteAddress: opts.remoteAddress });
  await handler(exchange.req, exchange.res);
  let json = {};
  try { json = JSON.parse(exchange.res.body); } catch { json = {}; }
  return { status: exchange.res.status, json, res: exchange.res };
}

test("面板⑥：GET 的四键载荷逐字不变，且不带 ok 字段", (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const exchange = fakeExchange("GET");
  webServer.routes[0].handler(exchange.req, exchange.res);
  assert.equal(exchange.res.status, 200);
  const body = JSON.parse(exchange.res.body);
  assert.deepEqual(Object.keys(body).sort(), ["budget", "recalls", "stats", "vector"]);
  assert.equal(body.ok, undefined);
});

test("面板⑦：POST 缺 x-dsh-mnemos 头 → 400，且 store 未被碰", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "不该被改动的记忆" });
  const before = { tier: record.tier, pinned: record.pinned };
  const headers = { host: "127.0.0.1:52603", "content-type": "application/json" };
  const result = await postPanel(webServer.routes[0].handler, { action: "tier", id: record.id, tier: "cold" }, { headers });
  assert.equal(result.status, 400);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, "bad-request");
  const after = runtime.store.get(record.id);
  assert.equal(after.tier, before.tier);
  assert.equal(after.pinned, before.pinned);
});

test("面板⑧：POST content-type 不是 json → 400，且 store 未被碰", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "类型不对时也不许动" });
  const headers = { host: "127.0.0.1:52603", "content-type": "text/plain", "x-dsh-mnemos": "1" };
  const result = await postPanel(webServer.routes[0].handler, { action: "pin", id: record.id, pinned: true }, { headers });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "bad-request");
  assert.equal(runtime.store.get(record.id).pinned, false);
});

test("面板⑨：POST 非本机来源 → 403，且 store 未被碰", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "外网不许写" });
  const result = await postPanel(webServer.routes[0].handler, { action: "forget", id: record.id }, { remoteAddress: "10.0.0.5" });
  assert.equal(result.status, 403);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, "bad-request");
  assert.ok(runtime.store.get(record.id), "记录必须还在");
});

test("面板⑩：POST body 超 8KB → 413，且 store 未被碰", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "超大包也不许动" });
  const huge = JSON.stringify({ action: "forget", id: record.id, pad: "x".repeat(9000) });
  const result = await postPanel(webServer.routes[0].handler, huge);
  assert.equal(result.status, 413);
  assert.ok(runtime.store.get(record.id), "记录必须还在");
});

test("面板⑪：body 不是 JSON 或不是对象 → 400", async (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const broken = await postPanel(webServer.routes[0].handler, "{not json");
  assert.equal(broken.status, 400);
  assert.ok(broken.json.error.includes("JSON"));
  const arrayBody = await postPanel(webServer.routes[0].handler, "[1,2,3]");
  assert.equal(arrayBody.status, 400);
  assert.ok(arrayBody.json.error.includes("JSON 对象"));
});

test("面板⑫：未知 action → 400 + code unsupported", async (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const result = await postPanel(webServer.routes[0].handler, { action: "self-destruct" });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "unsupported");
  assert.ok(result.json.error.includes("self-destruct"));
});

test("面板⑬：search 返回 rows（含 id/text/score/tier/pinned）", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  seed(runtime, { text: "用户养了一只叫年糕的橘猫" });
  const result = await postPanel(webServer.routes[0].handler, { action: "search", query: "年糕", limit: 3 });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.ok(result.json.rows.length >= 1);
  const row = result.json.rows[0];
  for (const key of ["id", "text", "score", "tier", "pinned"]) assert.ok(key in row, "缺 " + key);
  assert.equal(typeof row.score, "number");
  assert.ok(row.text.includes("年糕"));
});

test("面板⑭：search 缺 query → 400", async (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const result = await postPanel(webServer.routes[0].handler, { action: "search", query: "   " });
  assert.equal(result.status, 400);
  assert.equal(result.json.code, "bad-request");
});

test("面板⑮：pin true/false 生效并回显", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "要钉住的记忆" });
  const on = await postPanel(webServer.routes[0].handler, { action: "pin", id: record.id, pinned: true });
  assert.equal(on.status, 200);
  assert.deepEqual(on.json, { ok: true, id: record.id, pinned: true });
  assert.equal(runtime.store.get(record.id).pinned, true);
  const off = await postPanel(webServer.routes[0].handler, { action: "pin", id: record.id, pinned: false });
  assert.equal(off.json.pinned, false);
  assert.equal(runtime.store.get(record.id).pinned, false);
  const missing = await postPanel(webServer.routes[0].handler, { action: "pin", id: "turn-nope", pinned: true });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, "not-found");
  const badFlag = await postPanel(webServer.routes[0].handler, { action: "pin", id: record.id, pinned: "yes" });
  assert.equal(badFlag.status, 400);
});

test("面板⑯：tier 落到 tierSource=user；非法层 400、未知 id 404", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "要改层的记忆" });
  const ok = await postPanel(webServer.routes[0].handler, { action: "tier", id: record.id, tier: "persona" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, id: record.id, tier: "persona", tierSource: "user" });
  const saved = runtime.store.get(record.id);
  assert.equal(saved.tier, "persona");
  assert.equal(saved.tierSource, "user");
  const bad = await postPanel(webServer.routes[0].handler, { action: "tier", id: record.id, tier: "bogus" });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.includes("hot | cold | persona | state"));
  assert.equal(runtime.store.get(record.id).tier, "persona", "非法层不该改动记录");
  const missing = await postPanel(webServer.routes[0].handler, { action: "tier", id: "turn-nope", tier: "cold" });
  assert.equal(missing.status, 404);
});

test("面板⑰：forget 删得掉，再删 404", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "要被忘掉的记忆" });
  const first = await postPanel(webServer.routes[0].handler, { action: "forget", id: record.id });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { ok: true, id: record.id });
  assert.equal(runtime.store.get(record.id), null);
  const second = await postPanel(webServer.routes[0].handler, { action: "forget", id: record.id });
  assert.equal(second.status, 404);
  assert.equal(second.json.code, "not-found");
});

test("面板⑱：store 抛异常时回 500 + code internal，handler 不抛", async (t) => {
  const webServer = fakeWebServer();
  const { runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "写坏的库" });
  const broken = {
    store: {
      candidates: runtime.store.candidates.bind(runtime.store),
      get: runtime.store.get.bind(runtime.store),
      forget: runtime.store.forget.bind(runtime.store),
      setPinned: runtime.store.setPinned.bind(runtime.store),
      stats: runtime.store.stats.bind(runtime.store),
      upsert() { throw new Error("boom-upsert"); },
    },
    index: runtime.index,
    ledger: runtime.ledger,
    state: {},
    panelState: { mounted: true },
    log: { debug() {} },
  };
  const handler = createPanelHandler(broken);
  const result = await postPanel(handler, { action: "tier", id: record.id, tier: "cold" });
  assert.equal(result.status, 500);
  assert.equal(result.json.ok, false);
  assert.equal(result.json.code, "internal");
  assert.ok(result.json.error.includes("boom-upsert"));
});

test("面板⑲：缺 id 的 forget / pin → 400", async (t) => {
  const webServer = fakeWebServer();
  boot(t, {}, { services: { webServer } });
  const forget = await postPanel(webServer.routes[0].handler, { action: "forget" });
  assert.equal(forget.status, 400);
  assert.ok(forget.json.error.includes("id"));
  const pin = await postPanel(webServer.routes[0].handler, { action: "pin", pinned: true });
  assert.equal(pin.status, 400);
});

test("面板⑳：插件已卸载后 POST 走 503，不炸", async (t) => {
  const webServer = fakeWebServer();
  const { ctx, runtime } = boot(t, {}, { services: { webServer } });
  const record = seed(runtime, { text: "卸掉之后" });
  // 卸载会撤销路由注册，所以先拿住处理器引用（宿主也是这么持有它的）
  const handler = webServer.routes[0].handler;
  ctx.dispose();
  const result = await postPanel(handler, { action: "tier", id: record.id, tier: "cold" });
  assert.equal(result.status, 503);
  assert.equal(result.json.ok, false);
});

/* ------------------------------------------------- 人格桥接（启动同步 + 让位） */

/** 按契约写的假桥：readPersonaSource 返回给定文本，planPersonaRecord 只看 meta。 */
function fakeBridge(textRef) {
  const calls = [];
  return {
    PERSONA_SOURCE_KEY: "primary",
    calls,
    async readPersonaSource(config, deps) {
      calls.push({ config, deps });
      const text = typeof textRef === "function" ? textRef() : textRef;
      if (!text) return { ok: false, code: "empty", error: "空快照" };
      return { ok: true, text, hash: "h" + String(text).length };
    },
    planPersonaRecord({ records, text, hash, now }) {
      void now;
      const hit = (Array.isArray(records) ? records : []).filter((r) => r.tier === "persona" && r.meta && r.meta.personaSourceKey === "primary")[0];
      if (!hit) return { action: "create", hash };
      if (hit.meta.personaHash === hash) return { action: "skip", targetId: hit.id, hash };
      return { action: "update", targetId: hit.id, hash };
    },
  };
}

function mountAt(ctx, dir, persona, bridge) {
  return mount(ctx, { dataDir: dir, mode: "companion" }, { persona, bridge });
}

test("人格快照：kind=none 时不同步，只记一条 note", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "none" }, fakeBridge("不管用"));
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  assert.equal(runtime.persona.kind, "none");
  assert.equal(runtime.persona.result, "idle");
  assert.equal(runtime.store.all().filter((r) => r.tier === "persona").length, 0);
  assert.ok(runtime.notes.some((n) => n.includes("kind=none")));
});

test("人格快照：真实桥接读 file 来源，缺文件只记 note 不炸", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const missing = join(dir, "not-here.md");
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "file", path: missing, maxChars: 4000, timeoutMs: 2000 }, null);
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  assert.equal(runtime.persona.result, "failed");
  assert.equal(runtime.persona.code, "read-failed");
  assert.equal(runtime.store.all().filter((r) => r.tier === "persona").length, 0);
  assert.ok(runtime.notes.some((n) => n.includes("人格快照：读取失败")));
});

test("人格快照：真实桥接 + 临时文件 → 落库一条 persona 记录", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "persona.md");
  writeFileSync(file, "  我是她的人格设定。  ", "utf8");
  const ctx = createFakeCtx();
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "file", path: file, maxChars: 4000, timeoutMs: 2000 }, null);
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const persona = runtime.store.all().filter((r) => r.tier === "persona");
  assert.equal(persona.length, 1);
  assert.equal(persona[0].text, "我是她的人格设定。", "trim 之后才落库");
  assert.equal(runtime.persona.result, "create");
  assert.equal(runtime.persona.kind, "file");
});

test("人格快照：首次同步建一条 persona 记录（显式层 + 钉住）", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "file" }, fakeBridge("我是她的人格设定。"));
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const persona = runtime.store.all().filter((r) => r.tier === "persona");
  assert.equal(persona.length, 1);
  assert.equal(persona[0].tierSource, "user");
  assert.equal(persona[0].pinned, true);
  assert.equal(persona[0].subject, "self");
  assert.equal(persona[0].text, "我是她的人格设定。");
  assert.ok(Array.isArray(persona[0].sourceRefs) && persona[0].sourceRefs.includes("persona-snapshot:primary"));
  t.diagnostic("meta.personaHash = " + String(persona[0].meta && persona[0].meta.personaHash));
  assert.equal(runtime.persona.result, "create");
  assert.ok(runtime.persona.hash);
  assert.ok(runtime.notes.some((n) => n.includes("人格快照：已建立")));
});

test("人格快照：同内容重启不新增记录（幂等）", async (t) => {
  const dir = tempDir(t);
  const file = join(dir, "persona.md");
  writeFileSync(file, "我是她的人格设定。", "utf8");
  const persona = { mode: "self", kind: "file", path: file, maxChars: 4000, timeoutMs: 2000 };
  const ctx1 = createFakeCtx();
  const first = mountAt(ctx1, dir, persona, null);
  await first.personaReady;
  ctx1.dispose();

  const ctx2 = createFakeCtx();
  const second = mountAt(ctx2, dir, persona, null);
  t.after(() => ctx2.dispose());
  await second.personaReady;
  assert.equal(second.store.all().filter((r) => r.tier === "persona").length, 1);
  assert.equal(second.persona.result, "skip");
});

test("人格快照：内容变了更新同一条（id / createdAt 不变）", async (t) => {
  const dir = tempDir(t);
  let text = "旧的人格设定。";
  const bridge = fakeBridge(() => text);
  const ctx1 = createFakeCtx();
  const first = mountAt(ctx1, dir, { mode: "self", kind: "file" }, bridge);
  await first.personaReady;
  const before = first.store.all().filter((r) => r.tier === "persona")[0];
  ctx1.dispose();

  text = "新的人格设定，长一点。";
  const ctx2 = createFakeCtx();
  const second = mountAt(ctx2, dir, { mode: "self", kind: "file" }, bridge);
  t.after(() => ctx2.dispose());
  await second.personaReady;
  const list = second.store.all().filter((r) => r.tier === "persona");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, before.id);
  assert.equal(list[0].createdAt, before.createdAt);
  assert.equal(list[0].text, "新的人格设定，长一点。");
  assert.equal(second.persona.result, "update");
});

test("人格快照：读取失败只记 note，不建记录", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "http" }, fakeBridge(""));
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  assert.equal(runtime.persona.result, "failed");
  assert.equal(runtime.persona.code, "empty");
  assert.equal(runtime.store.all().filter((r) => r.tier === "persona").length, 0);
  assert.ok(runtime.notes.some((n) => n.includes("读取失败")));
});

test("人格快照：桥接抛异常也被吞掉", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const boom = {
    PERSONA_SOURCE_KEY: "primary",
    async readPersonaSource() {
      throw new Error("网络抽风");
    },
    planPersonaRecord() {
      return { action: "skip", hash: "" };
    },
  };
  const runtime = mountAt(ctx, dir, { mode: "self", kind: "http" }, boom);
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  assert.equal(runtime.persona.result, "failed");
  assert.ok(runtime.notes.some((n) => n.includes("网络抽风")));
});

/** 一份能同时产出「人设段」和「记忆段」的输入。 */
function injectionInput(config) {
  const records = [
    createRecord({ kind: "profile", tier: "persona", tierSource: "user", subject: "self", text: "我是她，说话慢一点。", pinned: true, weight: 0.95 }),
    createRecord({ kind: "turn", tier: "hot", text: "她说周末想去海边走走。", weight: 0.8, mentions: 2 }),
  ];
  const base = {
    mode: "companion",
    injectTokenBudget: 600,
    hotTokenBudget: 1200,
    topN: 6,
    proactive: { enabled: true, quoteThreshold: 0.62, askThreshold: 0.45, noiseFloor: 0.18, maxPerTurn: 1 },
    ...config,
  };
  return { records, index: createRetrievalIndex({ config: base }), config: base, now: NOW, query: "海边" };
}

test("注入让位：external 模式不再渲染 [人设与状态]，hot 预算不消费", () => {
  const input = injectionInput({});
  const self = renderInjection(input);
  assert.ok(self.text.includes("[人设与状态]"), "self 模式必须有人设段");
  assert.ok(self.hotTokens > 0);

  const extInput = injectionInput({ persona: { mode: "external" } });
  const ext = renderInjection(extInput);
  assert.equal(ext.text.includes("[人设与状态]"), false, "external 不该再注入人设段");
  assert.equal(ext.hotTokens, 0, "external 不再消费 hotTokenBudget");
  assert.ok(ext.text.includes("[记忆]"), "指令行与记忆段要留下");
});

test("注入让位：external 下记忆段与召回段照旧", () => {
  const ext = renderInjection(injectionInput({ persona: { mode: "external" } }));
  const self = renderInjection(injectionInput({}));
  const persistent = self.blocks[0] || "";
  assert.ok(persistent.length > 0, "self 必须先有人设段，才谈得上让位");
  assert.ok(self.text.includes(persistent), "self 的文本里要含人设段");
  // 让位只拿掉人设段：把 self 里的人设段去掉，其余必须与 external 逐字一致
  assert.equal(self.text.split("\n\n" + persistent).join(""), ext.text, "去掉人设段后其余文本应逐字一致");
  assert.equal(ext.text.includes(persistent), false, "external 里不该再有人设段");
  assert.deepEqual(ext.picks.map((r) => r.id), self.picks.map((r) => r.id), "被选中的记忆不该因为让位而变");
  assert.equal(ext.text.includes(INSTRUCTION), true, "指令行照旧");
});

test("注入让位：mode=self 时与不写 persona 字段逐字一致", () => {
  const withoutPersona = renderInjection(injectionInput({}));
  const withSelf = renderInjection(injectionInput({ persona: { mode: "self", kind: "file", path: "/tmp/x" } }));
  assert.equal(withSelf.text, withoutPersona.text);
  assert.equal(withSelf.tokens, withoutPersona.tokens);
  assert.equal(withSelf.hotTokens, withoutPersona.hotTokens);
});

test("/mem status：人格行显示 self / none / 未同步", async (t) => {
  const service = fakeRegistry("commands");
  const { runtime } = boot(t, {}, { services: { commands: service } });
  void runtime;
  const registered = service.entries[0];
  const result = await registered.handler({ rawInput: "status" });
  assert.equal(result.kind, "success");
  assert.ok(result.text.includes("人格："), "status 必须有「人格：」这一行");
  assert.ok(result.text.includes("模式 self"));
  assert.ok(result.text.includes("来源 none"));
  assert.ok(result.text.includes("未同步"));
});

test("/mem status：已同步时显示时间与 hash 前 4 位", async (t) => {
  const dir = tempDir(t);
  const ctx = createFakeCtx();
  const service = fakeRegistry("commands");
  ctx.services.commands = service;
  const runtime = mountAt(ctx, dir, { mode: "external", kind: "file" }, fakeBridge("我是她的人格设定。"));
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const registered = service.entries[0];
  const result = await registered.handler({ rawInput: "status" });
  assert.ok(result.text.includes("模式 external"));
  assert.ok(result.text.includes("来源 file"));
  assert.match(result.text, /hash h\w+…/, "要显示 hash 前 4 位");
});

/* ------------------------------------------- 人格桥接：按轮刷新（无定时器） */

/** 触发所有 pre-step 监听，返回各自的结果。 */
async function firePreStep(ctx, payload = { agent: null }) {
  const list = ctx.listeners.get("agent/pre-step") || [];
  const next = async () => ({ kind: "enter", messages: [] });
  const out = [];
  for (const entry of list) out.push(await entry.listener(payload, next));
  return out;
}

/** 会计数的假桥；readPersonaSource 每次调用 reads+1。 */
function countingBridge(text, options = {}) {
  const state = { reads: 0 };
  const bridge = {
    PERSONA_SOURCE_KEY: "primary",
    state,
    async readPersonaSource() {
      state.reads += 1;
      if (typeof options.onRead === "function") await options.onRead(state.reads);
      return { ok: true, text, hash: "h" + String(text).length };
    },
    planPersonaRecord({ records, hash }) {
      const hit = (Array.isArray(records) ? records : []).filter((r) => r.tier === "persona")[0];
      if (!hit) return { action: "create", hash };
      return hit.meta && hit.meta.personaHash === hash ? { action: "skip", targetId: hit.id, hash } : { action: "update", targetId: hit.id, hash };
    },
  };
  return bridge;
}

test("按轮刷新：同一分钟内多次 pre-step 只同步一次", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 1000000 };
  const bridge = countingBridge("人格文本。");
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "turn" }, bridge, now: () => clock.now });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const base = bridge.state.reads;
  // 启动同步本身算「上次同步」，所以要显式走过 60 秒才轮到第一次按轮刷新
  clock.now += 61000;
  await firePreStep(ctx);
  await firePreStep(ctx);
  await runtime.personaPending;
  assert.equal(bridge.state.reads, base + 1, "一分钟内只该同步一次");
  assert.equal(runtime.persona.lastTrigger, "turn");
  assert.equal(runtime.persona.turnSyncs, 1);
  assert.equal(runtime.persona.inFlight, false);
});

test("按轮刷新：推进 61 秒后触发第二次", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 2000000 };
  const bridge = countingBridge("人格文本。");
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "turn" }, bridge, now: () => clock.now });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const base = bridge.state.reads;
  clock.now += 61000;
  await firePreStep(ctx);
  await runtime.personaPending;
  clock.now += 61000;
  await firePreStep(ctx);
  await runtime.personaPending;
  assert.equal(bridge.state.reads, base + 2);
  assert.equal(runtime.persona.turnSyncs, 2);
});

test("按轮刷新：上一次还没回来时不再触发（in-flight 去重）", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 3000000 };
  let release = null;
  const bridge = {
    PERSONA_SOURCE_KEY: "primary",
    reads: 0,
    readPersonaSource() {
      bridge.reads += 1;
      if (bridge.reads === 1) return Promise.resolve({ ok: true, text: "启动", hash: "h0" });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    planPersonaRecord({ hash }) {
      return { action: "skip", hash };
    },
  };
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "turn" }, bridge, now: () => clock.now });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  clock.now += 61000;
  await firePreStep(ctx);
  assert.equal(bridge.reads, 2, "第一次按轮同步发出去了");
  assert.equal(runtime.persona.inFlight, true);
  clock.now += 61000;
  await firePreStep(ctx);
  assert.equal(bridge.reads, 2, "挂住的同步没回来之前不该再发");
  if (release) release({ ok: true, text: "挂住的", hash: "h2" });
  await runtime.personaPending;
  assert.equal(runtime.persona.inFlight, false);
});

test("按轮刷新：同步抛错不影响这一轮装配", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 4000000 };
  const bridge = countingBridge("人格文本。", {
    onRead(read) {
      if (read > 1) throw new Error("按轮炸了");
    },
  });
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "turn" }, bridge, now: () => clock.now });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  clock.now += 61000;
  const results = await firePreStep(ctx);
  await runtime.personaPending;
  const decision = results.filter((r) => r && typeof r === "object" && r.kind === "enter")[0];
  assert.ok(decision, "pre-step 仍要原样把 decision 交下去");
  assert.ok(Array.isArray(decision.messages), "decision 形状不被同步影响");
  assert.equal(decision.kind, "enter", "决策类型原样");
  assert.equal(runtime.persona.result, "failed", "失败要落到快照上");
  assert.ok(runtime.notes.some((n) => n.includes("人格快照读取失败")), "失败要写进 notes：" + runtime.notes.join(" | "));
});

test("refresh=startup：pre-step 不触发任何同步", async (t) => {
  const dir = tempDir(t);
  const clock = { now: 5000000 };
  const bridge = countingBridge("人格文本。");
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "startup" }, bridge, now: () => clock.now });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  const base = bridge.state.reads;
  await firePreStep(ctx);
  clock.now += 300000;
  await firePreStep(ctx);
  assert.equal(bridge.state.reads, base, "startup 模式不该有任何按轮同步");
  assert.equal(runtime.persona.turnSyncs, 0);
});

test("按轮刷新：同步挂住也不阻塞 pre-step（fire-and-forget）", async (t) => {
  const dir = tempDir(t);
  let hang = false;
  const bridge = {
    PERSONA_SOURCE_KEY: "primary",
    readPersonaSource() {
      if (!hang) return Promise.resolve({ ok: true, text: "启动", hash: "h0" });
      return new Promise(() => {});
    },
    planPersonaRecord({ hash }) {
      return { action: "skip", hash };
    },
  };
  const ctx = createFakeCtx();
  const runtime = mount(ctx, { dataDir: dir }, { persona: { kind: "file", refresh: "turn" }, bridge, now: () => 6000000 + 0 });
  t.after(() => ctx.dispose());
  await runtime.personaReady;
  hang = true;
  runtime.personaClock = () => 6000000 + 61000;
  const raced = await Promise.race([
    firePreStep(ctx).then(() => "fast"),
    new Promise((resolve) => setTimeout(() => resolve("slow"), 150)),
  ]);
  assert.equal(raced, "fast", "pre-step 不能被挂住的同步拖住");
  assert.equal(runtime.persona.inFlight, true, "同步确实还在飞");
});
