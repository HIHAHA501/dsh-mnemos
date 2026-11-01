/**
 * client.js（浏览器半边）的回归测试。
 *
 * 做法：用假的 `window.__ModuleLoader__` 捕获定义，再用假的 `require('react')` 把 factory 跑起来，
 * 于是浏览器里能验的部分（导出形状、settings.section 注册、五块渲染、全部降级路径）在 node 里可断言。
 *
 * 期望值不复制第二份常量：插件名和面板路径都从 `index.mjs` 的真实导出取，
 * 面板一旦和宿主侧漂移，这些用例会直接红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { name as PLUGIN_NAME, PANEL_PATH as HOST_PANEL_PATH } from "../../index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, "..", "..", "client.js");
const CLIENT_SRC = readFileSync(CLIENT_PATH, "utf8");

/** 最小 React 桩：createElement 产出可断言的普通对象，hooks 同步执行。 */
function makeReact() {
  const createElement = (tag, props, ...children) => ({
    tag,
    props: props || {},
    children: children.flat(Infinity),
  });
  return {
    createElement,
    useState: (value) => [value, () => {}],
    useEffect: (fn) => {
      fn();
    },
  };
}

/** 在 vm 里以 classic script 方式执行 client.js，返回捕获到的 ModuleLoader 定义与 exports。 */
function loadClient(options = {}) {
  const react = options.react === undefined ? makeReact() : options.react;
  const requireImpl =
    options.requireImpl ||
    ((id) => {
      if (id === "react") return react;
      throw new Error("no such module: " + id);
    });

  let definition = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
    document: { baseURI: "http://127.0.0.1:52603/" },
    console: { log() {}, warn() {}, error() {} },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    require: requireImpl,
  };
  Object.assign(sandbox, options.extra || {});
  sandbox.globalThis = sandbox;
  vm.runInNewContext(CLIENT_SRC, sandbox, { filename: "client.js" });
  assert.ok(definition, "client.js 应调用 window.__ModuleLoader__.load");
  return { definition, exports: definition.factory(requireImpl), sandbox, react };
}


/** 从 inject 捕获列表里按槽位名取组件（现在注册了两个槽位，不能靠下标）。 */
function componentOf(captured, slotName) {
  for (const call of captured) {
    const entry = typeof call === "function" ? call() : call;
    if (entry && entry.d && entry.d.name === slotName) return { component: entry.c, definition: entry.d };
  }
  return null;
}
/** 把渲染树摊平成文本，用于「五块都在」这类断言。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  return (node.children || []).map(textOf).join(" ");
}

function texts(tree) {
  return textOf(tree).replace(/\s+/g, " ");
}

/** 宿主路由真实发的 payload 形状（index.mjs:385-395）。 */
function hostPayload(overrides = {}) {
  return {
    stats: { count: 42, live: 40, merged: 2, byTier: { hot: 30, cold: 8, persona: 2, state: 2 }, byKind: { turn: 40 }, logLines: 12, warnings: [] },
    budget: { tokens: 420, budget: 600, picks: 3, dropped: [{ id: "turn-x", reason: "budget" }] },
    vector: { state: "degraded", reason: "provider-none" },
    recalls: [
      { id: "turn-a", text: "用户说周末想去海边走走", score: 0.876 },
      { id: "turn-b", text: "用户最近在学手冲咖啡", score: 0.412 },
    ],
    ...overrides,
  };
}

function fakeSlots() {
  const calls = [];
  const slots = {
    inject(name, fn) {
      calls.push({ name, fn });
    },
    register(definition, component) {
      return { definition, component };
    },
  };
  return { slots, calls };
}

/* ------------------------------------------------------------ 导出形状 */

test("ModuleLoader 定义用宿主同一个插件名", () => {
  const { definition } = loadClient();
  assert.equal(definition.id, PLUGIN_NAME);
});

test("exports.inject 只声明 slots", () => {
  const { exports } = loadClient();
  assert.deepEqual([...exports.inject], ["slots"]);
});

test("exports.apply 是函数", () => {
  const { exports } = loadClient();
  assert.equal(typeof exports.apply, "function");
});

test("面板路径与 index.mjs 的 PANEL_PATH 一致（跨模块契约）", () => {
  const { exports } = loadClient();
  assert.equal(exports.panelPath, HOST_PANEL_PATH);
});

test("exports.__test 暴露可断言的纯函数", () => {
  const { exports } = loadClient();
  for (const key of ["buildViewModel", "formatViewModel", "renderBlocks", "loadPanel", "register"]) {
    assert.equal(typeof exports.__test[key], "function", key + " 应该是函数");
  }
  assert.equal(typeof exports.__test.RECALL_LIMIT, "number");
});

/* ------------------------------------------------------- settings.section */

test("apply 通过 ctx.get('slots') 注册 settings.section", () => {
  const { exports } = loadClient();
  const { slots, calls } = fakeSlots();
  const result = exports.apply({ get: (n) => (n === "slots" ? slots : undefined) });
  assert.equal(result.registered, true);
  const names = calls.map((c) => c.name).sort();
  assert.deepEqual(names, ["conversation.composer.dock", "conversation.hero.options", "settings.section"], "三个槽位都要注册");
  const registered = calls.filter((c) => c.name === "settings.section")[0].fn();
  assert.equal(registered.definition.name, "settings.section");
  assert.equal(registered.definition.id, PLUGIN_NAME);
  assert.equal(typeof registered.definition.order, "number");
  assert.equal(typeof registered.definition.label, "function");
  assert.equal(registered.definition.label(), "记忆星图");
  assert.equal(typeof registered.component, "function");
});

test("apply 也支持 ctx.slots 直接挂载（dsh-orb 那种写法）", () => {
  const { exports } = loadClient();
  const { slots, calls } = fakeSlots();
  const result = exports.apply({ get: () => undefined, slots });
  assert.equal(result.registered, true);
  assert.deepEqual(calls.map((c) => c.name).sort(), ["conversation.composer.dock", "conversation.hero.options", "settings.section"]);
});

/* ------------------------------------------------------------ 五块渲染 */

test("真实宿主 payload 渲染出五块，数值与 payload 一致", () => {
  const { exports } = loadClient();
  const { buildViewModel, renderBlocks } = exports.__test;
  const view = buildViewModel(hostPayload());
  const flat = texts(renderBlocks(view, makeReact().createElement, null));
  for (const title of ["记忆总数", "分层分布", "本会话注入预算", "向量通道", "最近 5 条召回"]) {
    assert.ok(flat.includes(title), "缺少块：" + title);
  }
  assert.ok(flat.includes("42"), "记忆总数应为 42");
  assert.ok(flat.includes("30"), "热记忆应为 30");
  assert.ok(flat.includes("70%"), "预算占用应为 70%");
  assert.ok(flat.includes("本机面板"), "面板本体要留住本机承诺");
  assert.ok(flat.includes("只有你按下的操作才会落库"), "写入必须只发生在用户动作里");
  assert.equal(view.budget.picked, 3, "picks 是条数（宿主形状）也要认");
  assert.equal(view.budget.dropped, 1);
});

test("recalls 用宿主扁平形状时正文不丢", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel(hostPayload());
  assert.equal(view.recalls.length, 2);
  assert.equal(view.recalls[0].id, "turn-a");
  assert.equal(view.recalls[0].snippet, "用户说周末想去海边走走");
  assert.equal(view.recalls[0].score, 0.876);
});

test("recalls 也认 hybrid.rank 的 {record, score} 形状", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ recalls: [{ record: { id: "turn-z", text: "旧形状" }, score: 0.5 }] });
  assert.equal(view.recalls[0].id, "turn-z");
  assert.equal(view.recalls[0].snippet, "旧形状");
});

test("budget.picks 是数组时按长度算", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ budget: { picks: [1, 2] } });
  assert.equal(view.budget.picked, 2);
});

test("召回最多 RECALL_LIMIT 条", () => {
  const { exports } = loadClient();
  const { buildViewModel, RECALL_LIMIT } = exports.__test;
  const many = Array.from({ length: 12 }, (_, i) => ({ id: "turn-" + i, text: "记忆" + i, score: 0.1 * i }));
  assert.equal(buildViewModel({ recalls: many }).recalls.length, RECALL_LIMIT);
  assert.equal(RECALL_LIMIT, 5);
});

test("formatViewModel 给出可读文本", () => {
  const { exports } = loadClient();
  const { buildViewModel, formatViewModel } = exports.__test;
  const lines = formatViewModel(buildViewModel(hostPayload()));
  const joined = lines.join("\n");
  assert.ok(joined.includes("记忆数：42"), joined);
  assert.ok(joined.includes("预算：420 / 600（70%）"), joined);
  assert.ok(joined.includes("provider-none"), joined);
  assert.ok(joined.includes("turn-a"), joined);
});

test("不可用态只显示原因，不显示任何数字", () => {
  const { exports } = loadClient();
  const flat = texts(exports.__test.renderBlocks(null, makeReact().createElement, "宿主未注册 /x（HTTP 404）"));
  assert.ok(flat.includes("不可用："));
  assert.ok(flat.includes("HTTP 404"));
  assert.ok(!flat.includes("记忆总数"), "不可用态不该渲染数据块");
});

/* ------------------------------------------------------------- 降级路径 */

test("没有 slots 时不注册，也不抛", () => {
  const { exports } = loadClient();
  const result = exports.apply({ get: () => undefined });
  assert.equal(result.registered, false);
  assert.equal(result.reason, "slots-unavailable");
});

test("ctx.get 抛错时不抛", () => {
  const { exports } = loadClient();
  const result = exports.apply({ get: () => { throw new Error("boom"); } });
  assert.equal(result.registered, false);
});

test("ctx 为 undefined 时不抛", () => {
  const { exports } = loadClient();
  const result = exports.apply(undefined);
  assert.equal(result.registered, false);
});

test("拿不到 react 时降级而不抛", () => {
  const react = null;
  const { exports } = loadClient({ react, requireImpl: () => { throw new Error("react missing"); } });
  const { slots } = fakeSlots();
  const result = exports.apply({ get: () => slots });
  assert.equal(result.registered, false);
  assert.equal(result.reason, "react-unavailable");
});

test("loadPanel: 404 报不可用并带状态码", async () => {
  const { exports } = loadClient();
  const result = await exports.__test.loadPanel(async () => ({ ok: false, status: 404, text: async () => "nope" }));
  assert.equal(typeof result.unavailable, "string");
  assert.ok(result.unavailable.includes("HTTP 404"), result.unavailable);
});

test("loadPanel: 非 JSON 响应报不可用", async () => {
  const { exports } = loadClient();
  const result = await exports.__test.loadPanel(async () => ({ ok: true, status: 200, text: async () => "<html></html>" }));
  assert.ok(result.unavailable.includes("不是 JSON"), result.unavailable);
});

test("loadPanel: 网络异常把原文带进原因", async () => {
  const { exports } = loadClient();
  const result = await exports.__test.loadPanel(async () => { throw new Error("ECONNREFUSED"); });
  assert.ok(result.unavailable.includes("ECONNREFUSED"), result.unavailable);
});

test("loadPanel: 没有 fetch 时报不可用", async () => {
  const { exports } = loadClient();
  const result = await exports.__test.loadPanel(null);
  assert.equal(typeof result.unavailable, "string");
});

test("loadPanel: 正常响应映射成视图模型", async () => {
  const { exports } = loadClient();
  const result = await exports.__test.loadPanel(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(hostPayload()),
  }));
  assert.equal(result.unavailable, undefined);
  assert.equal(result.view.memory.total, 42);
  assert.equal(result.view.recalls[0].id, "turn-a");
});

/* ------------------------------------------------------- 视觉结构的断言 */

test("星幕节点与分层计数一致：全 0 时只留待点亮星位，有数据时按占比排布", () => {
  const { exports } = loadClient();
  const { starNodes } = exports.__test;
  const empty = starNodes({ hot: 0, cold: 0, persona: 0, state: 0 });
  assert.equal(empty.length, 5, "空态应画 5 颗待点亮暗星");
  assert.ok(empty.every((n) => n.pending === true), "空态的星必须标记为 pending");
  assert.equal(starNodes({}).length, 5);
  const one = starNodes({ hot: 27, cold: 0, persona: 0, state: 0 });
  assert.ok(one.length > 0 && one.length <= 40, "节点数应在 1..40，实际 " + one.length);
  assert.ok(one.every((n) => !n.pending));
  assert.ok(one.every((n) => n.r >= 3 && n.r <= 9), "半径应落在 3..9");
  const two = starNodes({ hot: 20, cold: 7, persona: 0, state: 0 });
  assert.ok(two.length >= one.length, "多一层不该更少点");
  assert.ok(two.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && n.r > 0));
});

test("星幕位置是确定性的（截图与测试可复现）", () => {
  const { exports } = loadClient();
  const { starNodes } = exports.__test;
  assert.equal(
    JSON.stringify(starNodes({ hot: 9, cold: 4, persona: 1, state: 1 })),
    JSON.stringify(starNodes({ hot: 9, cold: 4, persona: 1, state: 1 })),
  );
});

test("每个手绘图标最多 6 条 path", () => {
  const { exports } = loadClient();
  for (const name of Object.keys(exports.__test.ICONS)) {
    const paths = exports.__test.ICONS[name].filter((s) => s.tag === "path");
    assert.ok(paths.length > 0 && paths.length <= 6, name + " 有 " + paths.length + " 条 path");
  }
});

test("预算上限为 0 时显示「本会话尚未装配」，不出现含糊的「未设上限」", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ stats: { count: 2 }, budget: { tokens: 0, budget: 0 }, vector: { state: "on" } });
  const flat = texts(exports.__test.renderBlocks(view, makeReact().createElement, null));
  assert.ok(flat.includes("本会话尚未装配"), flat.slice(0, 200));
  assert.equal(flat.includes("未设上限"), false);
});

test("向量原因翻成人话，不把 provider-none 直接甩到脸上", () => {
  const { exports } = loadClient();
  const say = exports.__test.vectorReasonText;
  assert.equal(say({ state: "off", reason: "provider-none" }), "未配置向量通道");
  assert.equal(say({ state: "degraded", reason: "local:runtime-unavailable" }), "本机推理器未就绪");
  assert.ok(say({ state: "degraded", reason: "api:no-api-key:MY_KEY" }).includes("MY_KEY"));
  assert.equal(say({ state: "on" }).includes("provider"), false);
  assert.equal(say({ state: "degraded", reason: "weird-thing" }), "weird-thing");
});

test("空态有两句温柔说明，且五块骨架都在", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ stats: { count: 0 }, budget: {}, vector: { state: "off", reason: "provider-none" }, recalls: [] });
  const flat = texts(exports.__test.renderBlocks(view, makeReact().createElement, null));
  assert.ok(flat.includes("还没有存下任何记忆"));
  assert.ok(flat.includes("暂时没有需要回想的时刻"));
  for (const title of ["记忆总数", "分层分布", "本会话注入预算", "向量通道", "最近 5 条召回"]) {
    assert.ok(flat.includes(title), "空态缺少块：" + title);
  }
});

/* --------------------------------------------------------- 概览 / 说明两页 */

/** 在元素树里按谓词找节点（跨 realm 安全：只看 tag/props/children）。 */
function findAll(node, pred, out) {
  const acc = out || [];
  if (!node || typeof node !== "object") return acc;
  if (Array.isArray(node)) {
    for (const n of node) findAll(n, pred, acc);
    return acc;
  }
  if (pred(node)) acc.push(node);
  for (const child of node.children || []) findAll(child, pred, acc);
  return acc;
}
function buttonByText(tree, label) {
  return findAll(tree, (n) => n.tag === "button" && texts(n).trim() === label)[0];
}

/** 可控 React 桩：第 n 次 useState 返回指定初值，并记录 setter 收到的值。 */
function makeReactWith(initialByCall) {
  const h = (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) });
  const calls = { index: 0, set: [] };
  return {
    react: {
      createElement: h,
      useState: (value) => {
        const index = calls.index;
        calls.index += 1;
        const init = initialByCall && initialByCall[index] !== undefined ? initialByCall[index] : value;
        const setter = (next) => calls.set.push(next);
        return [init, setter];
      },
      useEffect: (fn) => {
        fn();
      },
    },
    calls,
  };
}
function renderPanel(result) {
  return result.component();
}

test("默认停在概览：分段控件两段都在，且「概览」是按下态", () => {
  const { exports } = loadClient();
  const captured = [];
  exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const tree = componentOf(captured, "settings.section").component();
  const overview = buttonByText(tree, "概览");
  const about = buttonByText(tree, "说明");
  assert.ok(overview && about, "两段都要在");
  assert.equal(overview.props["aria-pressed"], true);
  assert.equal(about.props["aria-pressed"], false);
  assert.equal(texts(tree).includes("每一块是什么"), false, "默认不该渲染说明页内容");
});

test("点「说明」只切本地页签：setter 收到 about，且不再发请求", () => {
  const fetches = [];
  const react = makeReactWith();
  const { exports } = loadClient({
    react: react.react,
    extra: { fetch: (u) => { fetches.push(String(u)); return new Promise(() => {}); } },
  });
  const captured = [];
  exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const tree = componentOf(captured, "settings.section").component();
  const before = fetches.length;
  const about = buttonByText(tree, "说明");
  assert.equal(typeof about.props.onClick, "function");
  about.props.onClick();
  assert.equal(react.calls.set.indexOf("about") >= 0, true, "setter 应收到 about");
  assert.equal(fetches.length, before, "切页不该再发请求");
});

test("说明页写全六块 + 隐私说明", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ stats: { count: 3, byTier: { hot: 3 } }, budget: {}, vector: { state: "off", reason: "provider-none" } });
  const flat = texts(exports.__test.renderBlocks(view, makeReactWith().react.createElement, null, { tab: "about" }));
  for (const name of ["星幕", "记忆总数", "分层分布", "本会话注入预算", "向量通道", "最近 5 条召回"]) {
    assert.ok(flat.includes(name), "说明页缺少：" + name);
  }
  assert.ok(flat.includes("不会外发"), "缺一句话定位里的不外发承诺");
  assert.ok(flat.includes("只在你按下按钮时"), "缺写入边界说明");
  assert.ok(flat.includes("非本机地址访问会被直接拒绝"), "缺本机限制说明");
  assert.ok(flat.includes("/mem forget"), "缺删除入口");
  assert.ok(flat.includes("不参与时间衰减"), "必须点名哪几层不衰减");
});

test("没有 hooks 时顺序渲染概览与说明两页，不空屏", () => {
  const { exports } = loadClient({ react: null });
  const view = exports.__test.buildViewModel({ stats: { count: 2, byTier: { hot: 2 } }, budget: {}, vector: { state: "on" } });
  const flat = texts(exports.__test.renderBlocks(view, makeReactWith().react.createElement, null));
  assert.ok(flat.includes("记忆总数"), "无 hooks 时概览应当在场");
  assert.ok(flat.includes("每一块是什么"), "无 hooks 时说明页也应当在場");
  assert.ok(flat.includes("这块面板是什么"));
});

test("说明页不发起任何 fetch，概览才取一次数", () => {
  const fetches = [];
  const counting = { fetch: (url) => { fetches.push(String(url)); return new Promise(() => {}); } };

  // 说明页：初始页签就是 about
  const aboutReact = makeReactWith({ 0: "about" });
  const aboutClient = loadClient({ react: aboutReact.react, extra: counting });
  const captured = [];
  aboutClient.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const aboutTree = componentOf(captured, "settings.section").component();
  assert.ok(texts(aboutTree).includes("每一块是什么"));
  assert.equal(fetches.length, 0, "说明页不该请求宿主，实际请求了 " + fetches.join(","));

  // 对照：概览页会取一次
  const overviewReact = makeReactWith({ 0: "overview" });
  const overviewClient = loadClient({ react: overviewReact.react, extra: counting });
  const captured2 = [];
  overviewClient.exports.apply({ get: () => ({ inject: (n, f) => captured2.push(f), register: (d, c) => ({ d, c }) }) });
  componentOf(captured2, "settings.section").component();
  assert.equal(fetches.length, 1, "概览应当只取一次数据");
});

/* --------------------------------------------------------------- 操作卡 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 挂一个面板：带状态的 hooks 桩（第 n 个 useState 共用同一格），所以 setData/setActions 之后重渲染能看见。
 * 默认 GET 返回空 payload，POST 按 reply 决定；返回请求记录与渲染函数。
 */
async function mountPanel(reply) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const opt = options || {};
    let body = null;
    try {
      body = opt.body ? JSON.parse(opt.body) : null;
    } catch {
      body = null;
    }
    calls.push({ url: String(url), method: opt.method || "GET", headers: opt.headers || {}, body });
    const res = (reply && reply(opt, body)) || {};
    const status = res.status === undefined ? 200 : res.status;
    const payload = res.body === undefined ? { ok: status < 400 } : res.body;
    return { ok: status < 400, status, text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)) };
  };
  const slots = {};
  let index = 0;
  let frame = "panel";
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const key = frame + ":" + index;
      index += 1;
      if (!(key in slots)) slots[key] = initial;
      return [slots[key], (next) => {
        slots[key] = typeof next === "function" ? next(slots[key]) : next;
      }];
    },
    useEffect: (fn) => {
      try {
        fn();
      } catch {
        /* effect 抛错不该拖垮渲染 */
      }
    },
  };
  const client = loadClient({ react, extra: { fetch: fetchImpl } });
  const captured = [];
  client.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const render = () => {
    index = 0;
    frame = "panel";
    return componentOf(captured, "settings.section").component();
  };
  // surface: dock / hero —— 两个真实实例，各自一份 hooks 状态，只靠广播同步
  const renderPill = (surface) => {
    const which = surface === "hero" ? "hero" : "dock";
    index = 0;
    frame = "pill-" + which;
    return componentOf(captured, which === "hero" ? "conversation.hero.options" : "conversation.composer.dock").component();
  };
  render();
  await tick();
  return { calls, render, renderPill };
}

function searchInput(tree) {
  return findAll(tree, (n) => n.tag === "input")[0];
}
function posts(calls) {
  return calls.filter((c) => c.method === "POST");
}

test("操作卡：搜索发 POST，带两个必带请求头与 action/query", async () => {
  const { calls, render } = await mountPanel((opt) =>
    opt.method === "POST" ? { body: { ok: true, rows: [{ id: "a1", text: "用户说周末想去海边走走", score: 0.91, tier: "hot", pinned: false }] } } : { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [] } },
  );
  const tree = render();
  searchInput(tree).props.onChange({ target: { value: "海边" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();

  const sent = posts(calls)[0];
  assert.ok(sent, "应当发出 POST");
  assert.equal(sent.method, "POST");
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers["x-dsh-mnemos"], "1");
  assert.equal(sent.body.action, "search");
  assert.equal(sent.body.query, "海边");
  assert.equal(sent.body.limit, 8);
  const flat = texts(render());
  assert.ok(flat.includes("用户说周末想去海边走走"), "结果要渲染出来");
  assert.ok(flat.includes("命中 1 条"));
});

test("操作卡：钉住发 POST pin，成功后背离到「已钉住」", async () => {
  const { calls, render } = await mountPanel((opt, body) => {
    if (opt.method !== "POST") return { body: { stats: { count: 1 }, budget: {}, vector: {}, recalls: [] } };
    if (body && body.action === "search") return { body: { ok: true, rows: [{ id: "a1", text: "用户说周末想去海边走走", score: 0.8, tier: "hot", pinned: false }] } };
    return { body: { ok: true, id: "a1", pinned: true } };
  });
  let tree = render();
  searchInput(tree).props.onChange({ target: { value: "海边" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();
  buttonByText(render(), "钉住").props.onClick();
  await tick();

  const pin = posts(calls).filter((c) => c.body.action === "pin")[0];
  assert.ok(pin, "应当发出 pin");
  assert.equal(pin.body.id, "a1");
  assert.equal(pin.body.pinned, true);
  const flat = texts(render());
  assert.ok(flat.includes("已钉住"));
  assert.ok(flat.includes("取消钉住"), "按钮要变成取消钉住");
});

test("操作卡：改层发 POST tier 并带目标层", async () => {
  const { calls, render } = await mountPanel((opt) =>
    opt.method === "POST" && JSON.parse(opt.body || "{}").action === "search"
      ? { body: { ok: true, rows: [{ id: "a1", text: "一条", score: 0.5, tier: "hot", pinned: false }] } }
      : opt.method === "POST"
        ? { body: { ok: true, id: "a1", tier: "cold", tierSource: "user" } }
        : { body: { stats: { count: 1 }, budget: {}, vector: {}, recalls: [] } },
  );
  const tree = render();
  searchInput(tree).props.onChange({ target: { value: "一条" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();
  const select = findAll(render(), (n) => n.tag === "select")[0];
  assert.ok(select, "每行要有改层下拉");
  select.props.onChange({ target: { value: "cold" } });
  await tick();

  const tier = posts(calls).filter((c) => c.body.action === "tier")[0];
  assert.ok(tier, "应当发出 tier");
  assert.equal(tier.body.tier, "cold");
  assert.equal(tier.body.id, "a1");
  assert.ok(texts(render()).includes("已改为「冷」"));
});

test("操作卡：忘记是两步，第一次点击不发请求", async () => {
  const { calls, render } = await mountPanel((opt) =>
    opt.method === "POST" && JSON.parse(opt.body || "{}").action === "search"
      ? { body: { ok: true, rows: [{ id: "a1", text: "要被忘记的一条", score: 0.4, tier: "hot", pinned: false }] } }
      : opt.method === "POST"
        ? { body: { ok: true, id: "a1" } }
        : { body: { stats: { count: 1 }, budget: {}, vector: {}, recalls: [] } },
  );
  const tree = render();
  searchInput(tree).props.onChange({ target: { value: "忘记" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();
  const before = posts(calls).length;

  buttonByText(render(), "忘记").props.onClick();
  await tick();
  assert.equal(posts(calls).length, before, "第一次点击不该发请求");
  assert.ok(texts(render()).includes("确认忘记？"), "按钮要变成确认态");

  buttonByText(render(), "确认忘记？").props.onClick();
  await tick();
  const sent = posts(calls);
  assert.equal(sent.length, before + 1, "第二次点击才发请求");
  assert.equal(sent[sent.length - 1].body.action, "forget");
  assert.equal(sent[sent.length - 1].body.id, "a1");
  assert.equal(texts(render()).includes("要被忘记的一条"), false, "成功后该行消失");
});

test("操作卡：失败只写行内状态，列表不清空", async () => {
  const { render } = await mountPanel((opt) => {
    const body = opt.body ? JSON.parse(opt.body) : {};
    if (opt.method !== "POST") return { body: { stats: { count: 1 }, budget: {}, vector: {}, recalls: [] } };
    if (body.action === "search") return { body: { ok: true, rows: [{ id: "a1", text: "留下的一条", score: 0.3, tier: "hot", pinned: false }] } };
    return { status: 500, body: { ok: false, error: "库锁住了", code: "internal" } };
  });
  const tree = render();
  searchInput(tree).props.onChange({ target: { value: "留下" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();
  buttonByText(render(), "钉住").props.onClick();
  await tick();

  const flat = texts(render());
  assert.ok(flat.includes("失败：库锁住了"), "要显示服务端原因");
  assert.ok(flat.includes("留下的一条"), "失败不能清空列表");
});

test("操作卡：404 也按 body.error 显示，不吞成裸状态码", async () => {
  const { render } = await mountPanel((opt) => {
    const body = opt.body ? JSON.parse(opt.body) : {};
    if (opt.method !== "POST") return { body: { stats: { count: 1 }, budget: {}, vector: {}, recalls: [] } };
    if (body.action === "search") return { body: { ok: true, rows: [{ id: "gone", text: "已经不在了", score: 0.2, tier: "hot", pinned: false }] } };
    return { status: 404, body: { ok: false, error: "没有这条记忆", code: "not-found" } };
  });
  const tree = render();
  searchInput(tree).props.onChange({ target: { value: "不在" } });
  buttonByText(render(), "搜索").props.onClick();
  await tick();
  buttonByText(render(), "忘记").props.onClick();
  await tick();
  buttonByText(render(), "确认忘记？").props.onClick();
  await tick();

  const flat = texts(render());
  assert.ok(flat.includes("失败：没有这条记忆"), "404 要显示人话");
  assert.ok(flat.includes("已经不在了"), "失败行仍在");
});

/* --------------------------------------------------------- 会话级开关 */

function captureReply(enabled, options = {}) {
  return (opt, body) => {
    if (opt.method === "POST") {
      if (options.failPost) return { status: 500, body: { ok: false, error: "写不进去", code: "internal" } };
      return { body: { ok: true, enabled: body && typeof body.enabled === "boolean" ? body.enabled : !enabled, scope: "global" } };
    }
    return { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [], capture: { enabled, default: true, scope: "global" } } };
  };
}

test("会话开关：胶囊初始态取自 GET 的 capture.enabled", async () => {
  const { renderPill } = await mountPanel(captureReply(true));
  const tree = renderPill();
  assert.ok(texts(tree).includes("记忆 · 开"), texts(tree));
  const dot = findAll(tree, (n) => n.tag === "span" && n.props.style && n.props.style.background)[0];
  assert.ok(dot, "胶囊要有个状态点");
});

test("会话开关：点击发 POST capture，enabled 取反，成功后按返回值更新", async () => {
  const { calls, renderPill } = await mountPanel(captureReply(true));
  renderPill();
  await tick();
  const tree = renderPill();
  assert.ok(texts(tree).includes("记忆 · 开"));
  findAll(tree, (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  const capturePosts = posts(calls).filter((c) => c.body.action === "capture");
  assert.equal(capturePosts.length, 1, "点击只发一次 POST");
  const sent = capturePosts[0];
  assert.equal(sent.body.enabled, false, "从开切成关");
  assert.deepEqual(Object.keys(sent.body).sort(), ["action", "enabled"], "body 只有 action 与 enabled，不再带 sessionId");
  assert.equal("sessionId" in sent.body, false);
  assert.equal(texts(renderPill()).includes("记忆 · 关"), true);
});

test("会话开关：失败显示「记忆 · 失败」，2 秒后回退", async () => {
  const timers = [];
  const react = makeReactWith();
  const fetchImpl = async (url, options) => {
    const opt = options || {};
    const res = captureReply(true, { failPost: true })(opt, opt.body ? JSON.parse(opt.body) : null);
    const status = res.status === undefined ? 200 : res.status;
    return { ok: status < 400, status, text: async () => JSON.stringify(res.body) };
  };
  const client = loadClient({
    react: react.react,
    extra: { fetch: fetchImpl, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} },
  });
  const captured = [];
  client.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  let index = 0;
  const pill = () => {
    index = 0;
    return captured.map((f) => f()).filter((e) => e.d.name === "conversation.composer.dock")[0].c();
  };
  pill();
  await tick();
  const tree = pill();
  findAll(tree, (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  assert.ok(texts(pill()).includes("记忆 · 失败"), texts(pill()));
  const revert = timers.filter((t) => t.ms === 2000)[0];
  assert.ok(revert, "失败后要排一个 2 秒回退");
  revert.fn();
  assert.ok(texts(pill()).includes("记忆 · 开"), "回退到点击前的状态");
});

test("会话开关：面板操作卡与胶囊共用同一份状态", async () => {
  const { calls, render, renderPill } = await mountPanel(captureReply(true));
  renderPill();
  await tick();
  render();
  await tick();
  const card = findAll(render(), (n) => n.tag === "button" && texts(n).trim() === "记忆 · 开")[0];
  assert.ok(card, "操作卡顶部要有同一枚开关");
  card.props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.ok(sent, "面板也要发同一个 POST");
  assert.ok(texts(renderPill()).includes("记忆 · 关"), "胶囊跟着变：" + texts(renderPill()));
});

test("全局开关：视图模型只透出 enabled / default / scope，没有会话维度", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ capture: { enabled: false, default: true, scope: "global" } });
  assert.equal(view.capture.enabled, false);
  assert.equal(view.capture.default, true);
  assert.equal(view.capture.scope, "global");
  assert.equal("sessionId" in view.capture, false, "载荷不再有会话维度");
  const blank = exports.__test.buildViewModel({});
  assert.equal(blank.capture.enabled, true, "缺省按开启");
});

/* ------------------------------------------------------- 首屏 hero + 主题 */

test("胶囊在 hero 与 dock 两处渲染同一组件，且共享同一份状态", async () => {
  const { calls, renderPill } = await mountPanel(captureReply(true));
  const captured = calls;
  void captured;
  const dockTree = renderPill("dock");
  const heroTree = renderPill("hero");
  assert.ok(texts(dockTree).includes("记忆 · 开"));
  assert.ok(texts(heroTree).includes("记忆 · 开"), "hero 首屏也要有同一枚胶囊");
  // 点 hero 那枚，dock 那枚跟着变（同一份 actionStore + 广播）
  findAll(heroTree, (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  assert.ok(texts(renderPill("dock")).includes("记忆 · 关"), "一处点击，另一处同步：" + texts(renderPill("dock")));
});

test("主题：文字/边框/底色走宿主 token，深色值兜底", () => {
  const { exports } = loadClient();
  const colors = exports.__test.COLORS;
  assert.ok(String(colors.text1).startsWith("var(--dsw-alias-label-primary,"), colors.text1);
  assert.ok(String(colors.text2).startsWith("var(--dsw-alias-label-secondary,"), colors.text2);
  assert.ok(String(colors.dim).startsWith("var(--dsw-alias-label-caption,"), colors.dim);
  assert.ok(String(colors.line).startsWith("var(--dsw-alias-border-l1,"), colors.line);
  assert.ok(String(colors.cardBg).startsWith("var(--dsw-alias-bg-module-platform,"), colors.cardBg);
  assert.ok(String(colors.track).startsWith("var(--dsw-alias-interactive-bg-hover,"), colors.track);
  // 粉紫是身份，不动
  assert.equal(colors.pink, "hsl(320, 66%, 74%)");
});

test("主题：按钮文字跟着 label 变量走，不会白底白字", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({ stats: { count: 1 }, budget: {}, vector: { state: "on" } });
  const tree = exports.__test.renderBlocks(view, makeReactWith().react.createElement, null, { tab: "overview" });
  const search = findAll(tree, (n) => n.tag === "button" && texts(n).trim() === "搜索")[0];
  assert.ok(search, "操作卡要有搜索按钮");
  assert.ok(String(search.props.style.color).includes("var(--dsw-alias-label-primary"), "按钮文字必须是 label 变量：" + String(search.props.style.color));
});

/* ------------------------------------------------------------- 源码形态 */

test("client.js 不含 ESM import/export 语句（classic script）", () => {
  assert.equal(/^\s*(import|export)\s/m.test(CLIENT_SRC), false);
});

test("没有 window.__ModuleLoader__ 时整份文件不做事也不抛", () => {
  const sandbox = { console: { log() {}, warn() {} }, URL, setTimeout, clearTimeout };
  sandbox.globalThis = sandbox;
  assert.doesNotThrow(() => vm.runInNewContext(CLIENT_SRC, sandbox, { filename: "client.js" }));
});