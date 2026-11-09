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
  const renderPill = (surface, props) => {
    const which = surface === "hero" ? "hero" : "dock";
    index = 0;
    frame = "pill-" + which;
    return componentOf(captured, which === "hero" ? "conversation.hero.options" : "conversation.composer.dock").component(props);
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

/**
 * v3 载荷夹具：{ default, session, sessions }。
 * options: { default, active, overrides: {id: enabled}, failPost }
 */
function captureReply(options = {}) {
  const def = options.default !== false;
  const overrides = options.overrides || {};
  const activeId = typeof options.active === "string" ? options.active : null;
  const sessions = Object.keys(overrides).map((id) => ({ id, enabled: overrides[id], overridden: true, at: 1 }));
  return (opt, body) => {
    if (opt.method === "POST") {
      if (options.failPost) return { status: 500, body: { ok: false, error: "写不进去", code: "internal" } };
      if (body && body.scope === "session" && typeof body.sessionId === "string") {
        return { body: { ok: true, scope: "session", sessionId: body.sessionId, enabled: body.enabled === null ? def : body.enabled } };
      }
      return { body: { ok: true, scope: "global", enabled: body && typeof body.enabled === "boolean" ? body.enabled : def } };
    }
    const active = activeId
      ? { id: activeId, enabled: activeId in overrides ? overrides[activeId] : def, overridden: activeId in overrides }
      : { id: null, enabled: def, overridden: false };
    return { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [], capture: { default: def, session: active, sessions } } };
  };
}

test("会话开关：没有覆盖时胶囊显示「跟随默认」", async () => {
  const { renderPill } = await mountPanel(captureReply({ default: true }));
  const tree = renderPill();
  assert.ok(texts(tree).includes("记忆 · 默认（开）"), texts(tree));
  const dot = findAll(tree, (n) => n.tag === "span" && n.props.style && n.props.style.background)[0];
  assert.ok(dot, "胶囊要有个状态点");
});

function pillTextOf(cap, opts) {
  const { exports } = loadClient();
  return texts(exports.__test.renderCapturePill(cap, null, makeReactWith().react.createElement, opts));
}

test("会话开关：三态文案（覆盖开 / 覆盖关 / 跟随默认）都能渲染", () => {
  const cap = {
    status: "ready",
    default: true,
    session: { id: "s-on", enabled: true, overridden: true },
    sessions: [
      { id: "s-on", enabled: true, overridden: true },
      { id: "s-off", enabled: false, overridden: true },
      { id: "s-def", enabled: true, overridden: false },
    ],
    note: "",
  };
  assert.ok(pillTextOf(cap, { sessionId: "s-on" }).includes("记忆 · 开"));
  assert.ok(pillTextOf(cap, { sessionId: "s-off" }).includes("记忆 · 关"));
  assert.ok(pillTextOf(cap, { sessionId: "s-def" }).includes("记忆 · 默认（开）"));
  assert.ok(pillTextOf(cap, { sessionId: "s-unknown" }).includes("记忆 · 默认（开）"), "没见过的会话跟默认");
  assert.ok(pillTextOf(cap, { scope: "global" }).includes("记忆 · 开"), "全局开关显示默认值本身");
});

test("会话开关：带 sessionId 时 POST 是 scope:session", async () => {
  const { calls, renderPill } = await mountPanel(captureReply({ default: true, active: "s-1" }));
  renderPill("dock", { sessionId: "s-1" });
  await tick();
  findAll(renderPill("dock", { sessionId: "s-1" }), (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.ok(sent, "应当发出 capture");
  assert.deepEqual(sent.body, { action: "capture", scope: "session", sessionId: "s-1", enabled: false }, "带 sessionId 走会话级");
});

test("会话开关：没有 sessionId 时退化为 scope:global", async () => {
  const { calls, renderPill } = await mountPanel(captureReply({ default: true }));
  renderPill();
  await tick();
  findAll(renderPill(), (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.deepEqual(sent.body, { action: "capture", scope: "global", enabled: false }, "没有会话身份就改全局默认");
});

test("会话开关：点击只发一次 POST，成功后按返回值更新文案", async () => {
  const { calls, renderPill } = await mountPanel(captureReply({ default: true }));
  renderPill();
  await tick();
  assert.ok(texts(renderPill()).includes("记忆 · 默认（开）"));
  findAll(renderPill(), (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  const capturePosts = posts(calls).filter((c) => c.body.action === "capture");
  assert.equal(capturePosts.length, 1, "点击只发一次 POST");
  assert.equal(capturePosts[0].body.enabled, false, "从开切成关");
  assert.equal(texts(renderPill()).includes("记忆 · 默认（关）"), true, texts(renderPill()));
});

test("会话开关：失败显示「记忆 · 失败」，2 秒后回退", async () => {
  const timers = [];
  const react = makeReactWith();
  const fetchImpl = async (url, options) => {
    const opt = options || {};
    const res = captureReply({ failPost: true })(opt, opt.body ? JSON.parse(opt.body) : null);
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
  assert.ok(texts(pill()).includes("记忆 · 默认（开）"), "回退到点击前的状态");
});

test("会话开关：面板操作卡与胶囊共用同一份状态", async () => {
  const { calls, render, renderPill } = await mountPanel(captureReply(true));
  renderPill();
  await tick();
  render();
  await tick();
  const card = findAll(render(), (n) => n.tag === "button" && texts(n).trim() === "记忆 · 开")[0];
  assert.ok(card, "操作卡顶部要有全局开关");
  card.props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.ok(sent, "面板也要发同一个 POST");
  assert.equal(sent.body.scope, "global", "设置页顶部是全局默认");
  assert.ok(texts(renderPill()).includes("记忆 · 默认（关）"), "胶囊跟着变：" + texts(renderPill()));
});

test("视图模型：capture 透出 default / session / sessions 三段", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel({
    capture: {
      default: false,
      session: { id: "s-9", enabled: true, overridden: true },
      sessions: [{ id: "s-9", enabled: true, overridden: true, at: 5 }, { id: "s-8", enabled: false, overridden: false, at: 4 }],
    },
  });
  assert.equal(view.capture.default, false);
  assert.equal(view.capture.session.id, "s-9");
  assert.equal(view.capture.session.enabled, true);
  assert.equal(view.capture.session.overridden, true);
  assert.equal(view.capture.sessions.length, 2);
  assert.equal(view.capture.sessions[0].id, "s-9");
  const blank = exports.__test.buildViewModel({});
  assert.equal(blank.capture.default, true, "缺省按开启");
  assert.equal(blank.capture.session.id, null);
  assert.equal(blank.capture.sessions.length, 0);
});

test("设置页：会话列表每行按自己的 id 发 scope:session", async () => {
  const { calls, render } = await mountPanel(captureReply({ default: true, active: "s-9", overrides: { "s-a": true, "s-b": false } }));
  render();
  await tick();
  const tree = render();
  assert.ok(texts(tree).includes("最近的会话"), texts(tree).slice(0, 240));
  const switches = findAll(tree, (n) => n.tag === "button" && ["开", "关", "默认"].indexOf(texts(n).trim()) >= 0);
  assert.ok(switches.length >= 2, "至少两行各有一个开关");
  switches[0].props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.equal(sent.body.scope, "session");
  assert.ok(["s-a", "s-b"].indexOf(sent.body.sessionId) >= 0, "带的必须是那一行的 id：" + sent.body.sessionId);
});

test("设置页：本会话行可以单独改", async () => {
  const { calls, render } = await mountPanel(captureReply({ default: true, active: "s-9" }));
  render();
  await tick();
  const tree = render();
  assert.ok(texts(tree).includes("本会话："), texts(tree).slice(0, 240));
  const btn = findAll(tree, (n) => n.tag === "button" && texts(n).trim() === "改本会话")[0];
  assert.ok(btn, "要有「改本会话」");
  btn.props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.deepEqual(sent.body, { action: "capture", scope: "session", sessionId: "s-9", enabled: false });
});

test("跟随默认：只有被覆盖的行才显示按钮，点击发 enabled:null", async () => {
  const { calls, render } = await mountPanel(captureReply({ default: true, active: "s-a", overrides: { "s-a": true, "s-b": true } }));
  render();
  await tick();
  const buttons = findAll(render(), (n) => n.tag === "button" && texts(n).trim() === "跟随默认");
  assert.ok(buttons.length >= 1, "有覆盖的行要显示「跟随默认」");
  buttons[0].props.onClick();
  await tick();
  await tick();
  const sent = posts(calls).filter((c) => c.body.action === "capture")[0];
  assert.equal(sent.body.action, "capture");
  assert.equal(sent.body.scope, "session");
  assert.equal(sent.body.enabled, null, "清除覆盖要发 null");
  assert.ok(["s-a", "s-b"].indexOf(sent.body.sessionId) >= 0);
  assert.equal(Object.keys(sent.body).length, 4);
});

test("跟随默认：没有覆盖就不显示按钮（不会摆死按钮）", async () => {
  const none = await mountPanel(captureReply({ default: true, active: "s-a" }));
  none.render();
  await tick();
  assert.equal(findAll(none.render(), (n) => n.tag === "button" && texts(n).trim() === "跟随默认").length, 0, "一条覆盖都没有时应当是 0 个");

  const some = await mountPanel(captureReply({ default: true, active: "s-a", overrides: { "s-b": false } }));
  some.render();
  await tick();
  assert.equal(findAll(some.render(), (n) => n.tag === "button" && texts(n).trim() === "跟随默认").length, 1, "只有 s-b 被覆盖");
});

test("跟随默认：失败时行内报错，2 秒后回退", async () => {
  const timers = [];
  const react = makeReactWith();
  const fetchImpl = async (url, options) => {
    const opt = options || {};
    const res = captureReply({ default: true, active: "s-a", overrides: { "s-a": true }, failPost: true })(opt, opt.body ? JSON.parse(opt.body) : null);
    const status = res.status === undefined ? 200 : res.status;
    return { ok: status < 400, status, text: async () => JSON.stringify(res.body) };
  };
  const client = loadClient({
    react: react.react,
    extra: { fetch: fetchImpl, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {} },
  });
  const captured = [];
  client.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const panel = () => captured.map((f) => f()).filter((e) => e.d.name === "settings.section")[0].c();
  panel();
  await tick();
  const btn = findAll(panel(), (n) => n.tag === "button" && texts(n).trim() === "跟随默认")[0];
  assert.ok(btn, "要先有按钮");
  btn.props.onClick();
  await tick();
  await tick();
  assert.ok(texts(panel()).includes("写不进去"), "行内要显示原因");
  const revert = timers.filter((t) => t.ms === 2000)[0];
  assert.ok(revert, "要排 2 秒回退");
  revert.fn();
  assert.equal(texts(panel()).includes("写不进去"), false, "回退后错误消失");
});

/* ------------------------------------------------------- 首屏 hero + 主题 */

test("胶囊在 hero 与 dock 两处渲染同一组件，且共享同一份状态", async () => {
  const { calls, renderPill } = await mountPanel(captureReply(true));
  const captured = calls;
  void captured;
  const dockTree = renderPill("dock");
  const heroTree = renderPill("hero");
  assert.ok(texts(dockTree).includes("记忆 · 默认（开）"));
  assert.ok(texts(heroTree).includes("记忆 · 默认（开）"), "hero 首屏也要有同一枚胶囊");
  // 点 hero 那枚，dock 那枚跟着变（同一份 actionStore + 广播）
  findAll(heroTree, (n) => n.tag === "button")[0].props.onClick();
  await tick();
  await tick();
  assert.ok(texts(renderPill("dock")).includes("记忆 · 默认（关）"), "一处点击，另一处同步：" + texts(renderPill("dock")));
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
/* --------------------------------------------------------------- 星图 */

/** 星图绘制段：验收会原样抽出去截图，所以这里也按标记抽。 */
function starmapSlice() {
  const open = "/* @starmap-start */";
  const close = "/* @starmap-end */";
  const start = CLIENT_SRC.indexOf(open);
  const end = CLIENT_SRC.indexOf(close);
  assert.ok(start >= 0 && end > start, "星图标记要在场：" + start + " / " + end);
  return CLIENT_SRC.slice(start + open.length, end);
}

test("星图：第三个页签叫「星图」，点一下切到 starmap", () => {
  const { exports } = loadClient();
  const view = exports.__test.buildViewModel(hostPayload());
  const tree = exports.__test.renderBlocks(view, makeReact().createElement, null, { tab: "overview" });
  const seg = buttonByText(tree, "星图");
  assert.ok(seg, "缺第三个页签「星图」");
  assert.equal(seg.props["aria-pressed"], false, "默认不该是按下态");
  assert.equal(buttonByText(tree, "概览").props["aria-pressed"], true);
  const group = findAll(tree, (n) => n.props && n.props.role === "tablist")[0];
  assert.equal(group.children.length, 3, "概览 / 星图 / 说明 三段都在");

  // 切页只动本地状态：setter 收到 starmap
  const react = makeReactWith({ 0: "overview" });
  const client = loadClient({ react: react.react, extra: { fetch: () => new Promise(() => {}) } });
  const captured = [];
  client.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const panel = componentOf(captured, "settings.section").component();
  buttonByText(panel, "星图").props.onClick();
  assert.ok(react.calls.set.indexOf("starmap") >= 0, "setter 应收到 starmap");
});

test("星图：切到星图才发 POST，请求体是 universe，回来才画 canvas", async () => {
  const { calls, render } = await mountPanel((opt, body) => {
    if (body && body.action === "universe") {
      return {
        body: {
          ok: true,
          total: 2,
          truncated: false,
          stars: [
            { id: "a1", text: "用户说周末想去海边走走", kind: "turn", tier: "hot", weight: 0.8, mentions: 2, pinned: false, valence: 0.6, arousal: 0.8, at: 1738312800000, tags: ["海边"] },
            { id: "b2", text: "用户最近在学手冲咖啡", kind: "turn", tier: "cold", weight: 0.4, mentions: 0, pinned: false, valence: -0.2, arousal: 0.3, at: 1738312900000, tags: ["咖啡"] },
          ],
          links: [["a1", "b2"]],
        },
      };
    }
    return { body: { stats: { count: 2 }, budget: {}, vector: { state: "on" }, recalls: [] } };
  });
  buttonByText(render(), "星图").props.onClick();
  render(); // 切页后要再渲染一次：effect 是在渲染里跑的
  await tick();
  const tree = render();

  const sent = posts(calls).filter((c) => c.body && JSON.stringify(c.body).includes("universe"));
  assert.equal(sent.length, 1, "切到星图应当只问一次，实际 " + sent.length);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].body.action, "universe");
  assert.equal(sent[0].headers["content-type"], "application/json");
  assert.equal(sent[0].headers["x-dsh-mnemos"], "1", "必带请求头不能少");
  assert.equal(findAll(tree, (n) => n.tag === "canvas").length, 1, "有数据才摆画布");
  assert.ok(texts(tree).includes("记忆星图 · 2 颗"), texts(tree).slice(0, 300));

  // 重渲染不该重复请求
  render();
  await tick();
  assert.equal(posts(calls).filter((c) => c.body && c.body.action === "universe").length, 1);
});

test("星图：宿主失败时给可读文案，不把设置节带崩", async () => {
  const { render } = await mountPanel((opt, body) => {
    if (body && body.action === "universe") return { status: 503, body: { ok: false, error: "宿主忙，稍后再试" } };
    return { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [] } };
  });
  buttonByText(render(), "星图").props.onClick();
  render();
  await tick();
  const flat = texts(render());
  assert.ok(flat.includes("星图没取到：宿主忙，稍后再试"), flat.slice(0, 300));
  assert.ok(flat.includes("其余几页照常"), "要说明别的页没被拖累");
  assert.ok(flat.includes("重试"), "失败要留一条重试");
  assert.equal(findAll(render(), (n) => n.tag === "canvas").length, 0, "失败不许摆一块空画布");
});

test("星图：空库说实话，不画空星空", async () => {
  const { render } = await mountPanel((opt, body) => {
    if (body && body.action === "universe") return { body: { ok: true, total: 0, truncated: false, stars: [], links: [] } };
    return { body: { stats: { count: 0 }, budget: {}, vector: { state: "off" }, recalls: [] } };
  });
  buttonByText(render(), "星图").props.onClick();
  render();
  await tick();
  const tree = render();
  const flat = texts(tree);
  assert.ok(flat.includes("还没有记忆，先把上面的记忆开关打开"), flat.slice(0, 300));
  assert.equal(findAll(tree, (n) => n.tag === "canvas").length, 0, "没有记忆就不该有画布");
});

test("星图：空闲 10 秒停帧，reduced-motion 只画一帧", () => {
  const { exports } = loadClient();
  const { STARMAP_IDLE_MS, prefersReducedMotion } = exports.__test;
  assert.equal(STARMAP_IDLE_MS, 10000);
  assert.ok(/STARMAP_IDLE_MS = 10000/.test(CLIENT_SRC), "常量要写死 10000，测试盯的就是它");
  assert.ok(CLIENT_SRC.includes("setTimeout(stop, STARMAP_IDLE_MS)"), "停帧由这个 setTimeout 触发");
  assert.ok(CLIENT_SRC.includes('listen("pointermove", onMove)'), "指针一有活动就要重新起转");
  assert.ok(CLIENT_SRC.includes("prefers-reduced-motion"), "reduced-motion 分支要在源码里点名");

  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(prefersReducedMotion({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(prefersReducedMotion({ matchMedia: () => { throw new Error("boom"); } }), false, "取不到就按能动处理");
  assert.equal(prefersReducedMotion({}), false);
});

test("星图：颜色 / 亮度 / 大小按约定的字段映射", () => {
  const { starHue, starSat, starAlpha, starRadius } = loadClient().exports.__test;
  assert.equal(starHue(1), 28, "正情绪是暖橙");
  assert.equal(starHue(-1), 215, "负情绪是冷蓝");
  assert.equal(starHue(0), 190, "接近 0 落在灰青");
  assert.ok(starSat(0) < starSat(0.5) && starSat(0.5) < starSat(1), "饱和度随 |valence| 上升");
  assert.ok(starSat(0) <= 20, "情绪很淡时接近灰，别一上来就艳");
  assert.equal(starAlpha(0.3), 0.55, "0.3 是平常亮度");
  assert.equal(starAlpha(1), 1, "1.0 是很亮");
  assert.ok(starAlpha(0) < starAlpha(0.3));
  const base = { text: "十个字的正文长度", weight: 0.4 };
  assert.ok(starRadius({ text: "一段很长很长的正文，".repeat(12), weight: 0.4 }) > starRadius(base), "正文越长的星越大");
  assert.ok(starRadius({ text: base.text, weight: 0.9 }) > starRadius(base), "weight 大的星要大");
  assert.equal(starRadius({ text: "", weight: 0 }), 2, "空正文 + 零权重落到下限");
  assert.ok(starRadius({ text: "长".repeat(400), weight: 1 }) <= 18, "再长也不许超过上限");
});

test("星图：布局确定性、不出界，节点就是约定的七个字段", () => {
  const { layoutUniverse, STARMAP } = loadClient().exports.__test;
  const stars = [
    { id: "a", tier: "hot", kind: "turn", tags: ["海边"], weight: 0.8, mentions: 3, pinned: true, valence: 0.7, arousal: 0.9 },
    { id: "b", tier: "hot", kind: "turn", tags: ["海边"], weight: 0.4, mentions: 0, pinned: false, valence: -0.5, arousal: 0.3 },
    { id: "c", tier: "cold", kind: "turn", tags: ["咖啡"], weight: 0.5, mentions: 1, pinned: false, valence: 0, arousal: 0.3 },
    { id: "d", tier: "persona", kind: "note", tags: [], weight: 0.6, mentions: 0, pinned: false, valence: 0.1, arousal: 0.5 },
  ];
  const links = [["a", "b"], ["b", "c"], ["a", "a"], ["a", "nope"]];
  const one = layoutUniverse(stars, links, 520, 300);
  const two = layoutUniverse(stars, links, 520, 300);
  assert.equal(JSON.stringify(one), JSON.stringify(two), "同一份数据必须画出同一张图");
  // 跨 realm：数组原型不同，deepEqual 会假红，按 JSON 比
  assert.equal(JSON.stringify(one.links), "[[0,1],[1,2]]", "自连与不存在的 id 都要丢掉，留下的是下标对");
  assert.equal(one.unlitIds.length, 44, "4 条真实记忆时补满 44 个空位");
  assert.equal(one.nodes.length, stars.length + one.unlitIds.length, "真实星在前，空位在后，一起进布局");
  for (const node of one.nodes) {
    assert.deepEqual(Object.keys(node).sort(), ["alpha", "hue", "phase", "r", "sat", "x", "y"], "节点只该有这七个字段");
    assert.ok(node.phase >= 0 && node.phase < 2 * Math.PI, "呼吸相位在 0..2π");
  }
  assert.equal(one.depth.length, one.nodes.length, "深度与节点一一对应");
  assert.equal(one.anchor, 0, "钉住且权重最高的那颗当锚点");
  for (let i = 0; i < stars.length; i += 1) {
    const node = one.nodes[i];
    assert.ok(
      node.x >= STARMAP.PAD && node.x <= 520 - STARMAP.PAD && node.y >= STARMAP.PAD && node.y <= 300 - STARMAP.PAD,
      "真实星要落在画布内并留出 PAD：" + JSON.stringify(node),
    );
    if (i === one.anchor) {
      assert.ok(node.r >= 40 && node.r <= 44, "锚点星半径 40~44：" + node.r);
      assert.equal(node.alpha, 1, "核心星是最亮的");
      continue;
    }
    assert.ok(node.r >= 2.6 && node.r <= STARMAP.R_MAX, "真实星半径（深度会压小，地板 2.6）：" + node.r);
    assert.ok(node.alpha >= 0.17 && node.alpha <= 1, "真实星 alpha 由深度定，范围 0.17~1：" + node.alpha);
  }
  for (let i = stars.length; i < one.nodes.length; i += 1) {
    const node = one.nodes[i];
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), "空位坐标要有限：" + JSON.stringify(node));
    assert.ok(node.r >= 1.2 && node.r <= 2.2, "空位半径 1.2~2.2：" + node.r);
    assert.ok(node.alpha >= 0.2 && node.alpha <= 0.3, "空位透明度 0.20~0.30：" + node.alpha);
    assert.equal(node.hue, 218, "空位是灰蓝");
    assert.ok(node.sat >= 8 && node.sat <= 16, "空位饱和度 8~16：" + node.sat);
  }
  for (const pair of one.links) {
    assert.ok(pair[0] < stars.length && pair[1] < stars.length, "空位不参与连线");
  }
  assert.ok(one.unlitIds.every((id) => id.indexOf("unlit-") === 0), "空位 id 带 unlit- 前缀");
  // 一颗星也不许崩
  const solo = layoutUniverse([stars[0]], [], 520, 300);
  assert.equal(solo.unlitIds.length, 44);
  assert.ok(Number.isFinite(solo.nodes[0].x) && Number.isFinite(solo.nodes[0].y));
});

test("星图：锚点星坐在球心、半径 40~44，没有候选就不造", () => {
  const { layoutUniverse } = loadClient().exports.__test;
  const stars = [
    { id: "p1", tier: "persona", text: "她怕吵", weight: 0.5, pinned: false, valence: 0, arousal: 0.3, at: 1 },
    { id: "h1", tier: "hot", text: "海边", weight: 0.9, pinned: true, valence: 0.5, arousal: 0.5, at: 2 },
    { id: "h2", tier: "hot", text: "咖啡", weight: 0.2, pinned: false, valence: 0, arousal: 0.3, at: 3 },
  ];
  const layout = layoutUniverse(stars, [], 520, 300);
  assert.equal(layout.anchor, 1, "钉住 / 人格前提里权重最高的那颗当锚点");
  const node = layout.nodes[layout.anchor];
  assert.ok(Math.abs(node.x - 260) < 1 && Math.abs(node.y - 150) < 1, "锚点星落在球心（画布中心）：" + JSON.stringify(node));
  assert.ok(node.r >= 40 && node.r <= 44, "锚点星半径 40~44：" + node.r);

  const plain = stars.map((s) => Object.assign({}, s, { pinned: false, tier: "hot" }));
  assert.equal(layoutUniverse(plain, [], 520, 300).anchor, -1, "没有钉住也没有人格前提时不该硬造锚点");
});

test("星图：16 条输入跑两次，坐标逐位相同", () => {
  const { layoutUniverse } = loadClient().exports.__test;
  const stars = [];
  for (let i = 0; i < 16; i += 1) {
    stars.push({
      id: "x" + i,
      tier: ["hot", "cold", "persona", "state"][i % 4],
      text: "记忆".repeat(1 + i),
      weight: i / 16,
      pinned: i === 3,
      valence: i / 16,
      arousal: (i % 5) / 5,
      at: 1738312800000 + i * 1000,
    });
  }
  const one = JSON.stringify(layoutUniverse(stars, [["x0", "x1"]], 520, 300));
  const two = JSON.stringify(layoutUniverse(stars, [["x0", "x1"]], 520, 300));
  assert.equal(one, two, "同一份 16 条输入必须逐位相同");
});

test("星图：深度越远，alpha 越小（也越小颗）", () => {
  const { layoutUniverse } = loadClient().exports.__test;
  const stars = [];
  for (let i = 0; i < 12; i += 1) {
    stars.push({ id: "d" + i, tier: "cold", text: "一样长的正文", weight: 0.5, pinned: false, valence: 0, arousal: 0.6, at: i });
  }
  const layout = layoutUniverse(stars, [], 520, 300);
  const order = stars.map((_, i) => i).sort((a, b) => layout.depth[a] - layout.depth[b]);
  for (let k = 1; k < order.length; k += 1) {
    const near = layout.nodes[order[k - 1]];
    const far = layout.nodes[order[k]];
    assert.ok(layout.depth[order[k]] >= layout.depth[order[k - 1]]);
    assert.ok(far.alpha <= near.alpha + 1e-9, "越远越暗：" + near.alpha + " -> " + far.alpha);
  }
  assert.ok(layout.nodes[order[0]].alpha > layout.nodes[order[order.length - 1]].alpha, "深度要把亮度真拉开，不能只差一点点");
});

test("星图：绘制段自包含——抽出来放进空上下文也能画", () => {
  const slice = starmapSlice();
  assert.equal((CLIENT_SRC.match(/@starmap-start/g) || []).length, 1, "标记只能出现一次");
  assert.equal((CLIENT_SRC.match(/@starmap-end/g) || []).length, 1);
  assert.equal((slice.match(/function\s+\w+/g) || []).length, 1, "标记之间只该有一个函数");
  assert.equal((slice.match(/function drawStarmapFrame/g) || []).length, 1);

  const drawn = { fills: 0, strokes: 0, arcs: 0, colors: [] };
  const ctx = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() { drawn.fills += 1; },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    arc() { drawn.arcs += 1; },
    stroke() { drawn.strokes += 1; },
    fill() {},
    set fillStyle(value) { drawn.colors.push(String(value)); },
    set strokeStyle(value) { drawn.colors.push(String(value)); },
    lineWidth: 1,
  };
  const nodes = [
    { x: 30, y: 60, r: 4, hue: 190, sat: 30, alpha: 0.55, phase: 0 },
    { x: 140, y: 90, r: 3, hue: 28, sat: 52, alpha: 0.9, phase: 1.2 },
    { x: 90, y: 150, r: 1.6, hue: 218, sat: 11, alpha: 0.2, phase: 2.4 },
  ];
  const opts = { time: 0, links: [[0, 1]], width: 320, height: 200 };
  // 沙箱里只有 ctx / nodes / opts 和标准库：引用了文件里别的函数会直接抛
  vm.runInNewContext(slice + ";drawStarmapFrame(ctx, nodes, opts);", { ctx, nodes, opts, Math, Set, Map });
  assert.equal(drawn.fills, 1, "底色要自己铺满，不能靠宿主背景");
  assert.equal(drawn.arcs, 7, "真实星三笔（光晕 + 星体 + 白热核心），空位只画一笔本体");
  const hotCores = drawn.colors.filter((c) => c.indexOf(",100%,96%,") > 0);
  assert.equal(hotCores.length, 2, "白热核心只给两颗真实星，空位不许带亮点");
  assert.equal(drawn.strokes, 1, "一条线画一次");
  assert.ok(drawn.colors.some((c) => c.indexOf("hsla(") === 0), "星色走 hsla：" + drawn.colors.join("|"));
});

test("星图：给了贴图就走 drawImage，不再每帧现建渐变", () => {
  const slice = starmapSlice();
  const drawn = { images: 0, radial: 0 };
  const ctx = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => {
      drawn.radial += 1;
      return { addColorStop() {} };
    },
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    drawImage() {
      drawn.images += 1;
    },
    set fillStyle(value) {},
    set strokeStyle(value) {},
    set globalAlpha(value) {},
    lineWidth: 1,
  };
  const nodes = [
    { x: 30, y: 60, r: 6, hue: 190, sat: 30, alpha: 0.8, phase: 0 },
    { x: 90, y: 50, r: 9, hue: 28, sat: 52, alpha: 0.6, phase: 1 },
    { x: 60, y: 120, r: 1.6, hue: 218, sat: 11, alpha: 0.2, phase: 2 },
  ];
  const opts = { time: 1200, links: [[0, 1]], width: 320, height: 200, sprite: { width: 64, height: 64 }, focus: -1 };
  vm.runInNewContext(slice + ";drawStarmapFrame(ctx, nodes, opts);", { ctx, nodes, opts, Math, Set, Map });
  assert.equal(drawn.images, 2, "两颗真实星各盖一次贴图，空位不盖");
  assert.equal(drawn.radial, 0, "有贴图就不该再逐颗建径向渐变");
});

test("星图：时间是每颗星各自漂移（≤3px），不是把整张图转一个角度", () => {
  const slice = starmapSlice();
  const shoot = (time) => {
    const pts = [];
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      drawImage(sprite, x, y, w, h) {
        pts.push({ x: x + w / 2, y: y + h / 2 });
      },
      set fillStyle(value) {},
      set strokeStyle(value) {},
      set globalAlpha(value) {},
      lineWidth: 1,
    };
    // 三颗真实星分散在画布四角附近：整图旋转会让它们沿圆弧跑很远，漂移不会
    const nodes = [
      { x: 40, y: 40, r: 6, hue: 190, sat: 40, alpha: 0.8, phase: 0.4 },
      { x: 280, y: 60, r: 8, hue: 28, sat: 50, alpha: 0.7, phase: 2.1 },
      { x: 120, y: 220, r: 5, hue: 215, sat: 45, alpha: 0.9, phase: 4.4 },
    ];
    const opts = { time: time, links: [], width: 320, height: 260, sprite: { width: 64, height: 64 }, focus: -1 };
    vm.runInNewContext(slice + ";drawStarmapFrame(ctx, nodes, opts);", { ctx, nodes, opts, Math, Set, Map });
    return pts;
  };
  const home = [
    { x: 40, y: 40 },
    { x: 280, y: 60 },
    { x: 120, y: 220 },
  ];
  let moved = 0;
  for (const time of [0, 700, 1500, 2244, 3312, 5400]) {
    const pts = shoot(time);
    assert.equal(pts.length, 3, "三颗真实星各盖一次贴图");
    for (let i = 0; i < pts.length; i += 1) {
      // 与布局位置比：整图旋转会让边角的星跑出几十像素，漂移永远只差几个像素
      const away = Math.hypot(pts[i].x - home[i].x, pts[i].y - home[i].y);
      assert.ok(away <= 3, "第 " + i + " 颗在 t=" + time + " 偏离布局位置 " + away.toFixed(2) + "px");
      if (away > 1) moved += 1;
    }
  }
  assert.ok(moved > 0, "得真的在飘，不能一动不动");
});

test("星图：聚焦一颗星时，只有它和相连的星保持亮度", () => {
  const slice = starmapSlice();
  const shoot = (focus) => {
    const alphas = [];
    const ctx = {
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      fillRect() {},
      beginPath() {},
      arc() {},
      fill() {},
      moveTo() {},
      lineTo() {},
      stroke() {},
      drawImage() {
        alphas.push(ctx.alphaNow);
      },
      set fillStyle(value) {},
      set strokeStyle(value) {},
      set globalAlpha(value) {
        ctx.alphaNow = value;
      },
      get globalAlpha() {
        return ctx.alphaNow;
      },
      lineWidth: 1,
    };
    const nodes = [
      { x: 60, y: 60, r: 8, hue: 190, sat: 30, alpha: 0.9, phase: 0 },
      { x: 120, y: 60, r: 8, hue: 28, sat: 50, alpha: 0.9, phase: 1 },
      { x: 90, y: 120, r: 8, hue: 215, sat: 50, alpha: 0.9, phase: 2 },
      { x: 60, y: 140, r: 1.5, hue: 218, sat: 11, alpha: 0.2, phase: 3 },
    ];
    const opts = { time: 0, links: [[0, 1]], width: 200, height: 200, sprite: { width: 64, height: 64 }, focus: focus };
    vm.runInNewContext(slice + ";drawStarmapFrame(ctx, nodes, opts);", { ctx, nodes, opts, Math, Set, Map });
    return alphas;
  };
  const plain = shoot(-1);
  const focused = shoot(0);
  assert.equal(plain.length, 3, "三颗真实星各盖一次贴图（空位不盖）");
  assert.equal(focused.length, 3);
  assert.ok(Math.abs(focused[0] - plain[0]) < 1e-9, "聚焦的星保持亮度");
  assert.ok(Math.abs(focused[1] - plain[1]) < 1e-9, "与它相连的星保持亮度");
  assert.ok(focused[2] < plain[2] * 0.5, "不相干的星压到 0.45 以下：" + plain[2] + " -> " + focused[2]);
});

test("星图：没有贴图就回落渐变，三种残缺输入都不抛", () => {
  const slice = starmapSlice();
  const ctx = {
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    set fillStyle(value) {},
    set strokeStyle(value) {},
    set globalAlpha(value) {},
    lineWidth: 1,
  };
  const nodes = [{ x: 10, y: 10, r: 5, hue: 190, sat: 30, alpha: 0.7, phase: 0 }];
  const base = { time: 0, links: [], width: 200, height: 120 };
  for (const opts of [base, Object.assign({}, base, { sprite: null }), Object.assign({}, base, { sprite: { width: 0 } })]) {
    assert.doesNotThrow(() => vm.runInNewContext(slice + ";drawStarmapFrame(ctx, nodes, opts);", { ctx, nodes, opts, Math, Set, Map }));
  }
});

test("星图：点中一颗星才显示正文 / 层 / 时间", () => {
  const { renderStarmapBody, formatStamp } = loadClient().exports.__test;
  const h = makeReact().createElement;
  const base = { status: "ready", total: 1, truncated: false, stars: [], links: [], picked: null };
  assert.ok(texts(renderStarmapBody(base, h, null)).includes("点一颗星"), "没选中时给一句提示");
  const star = { id: "a", text: "用户说周末想去海边走走", tier: "hot", at: 1738312800000 };
  const on = texts(renderStarmapBody(Object.assign({}, base, { picked: star }), h, null));
  assert.ok(on.includes("用户说周末想去海边走走"), "正文要有：" + on);
  assert.ok(on.includes("热记忆"), "层要翻成人话，不把 hot 直接甩出来");
  assert.ok(on.includes(formatStamp(star.at)), "时间要按本地时区给");
  assert.equal(on.includes("点一颗星"), false, "选中后提示要让位给详情");
});


test("星图：空位数量随真实记忆递减，60 条起归零，且都是确定的", () => {
  const { unlitCount, unlitStars } = loadClient().exports.__test;
  assert.equal(unlitCount(0), 44);
  assert.equal(unlitCount(16), 44, "16 条真实记忆时正好补满 44 个空位");
  assert.equal(unlitCount(30), 30);
  assert.equal(unlitCount(59), 1);
  assert.equal(unlitCount(60), 0, "60 条起一个空位都不摆");
  assert.equal(unlitCount(999), 0);
  for (let real = 0; real < 80; real += 1) assert.ok(unlitCount(real + 1) <= unlitCount(real), "只能越攒越少");
  assert.equal(JSON.stringify(unlitStars(44)), JSON.stringify(unlitStars(44)), "同一批索引每次长一样");
  const first = unlitStars(3)[0];
  assert.ok(first.id.indexOf("unlit-") === 0, "空位 id 前缀：" + first.id);
  assert.ok(first.r >= 1.2 && first.r <= 2.2, "空位半径：" + first.r);
  assert.ok(first.alpha >= 0.2 && first.alpha <= 0.3, "空位透明度 0.20~0.30：" + first.alpha);
  assert.ok(first.sat >= 8 && first.sat <= 16, "空位饱和度：" + first.sat);
});

test("星图：真实记忆到 60 条，layout 一个空位都不补", () => {
  const { layoutUniverse } = loadClient().exports.__test;
  const many = Array.from({ length: 60 }, (_, i) => ({ id: "m" + i, tier: "hot", kind: "turn", tags: [], weight: 0.5, mentions: 0, pinned: false, valence: 0, arousal: 0.3 }));
  const layout = layoutUniverse(many, [["m0", "m1"]], 520, 300);
  assert.equal(layout.unlitIds.length, 0, "60 条真实记忆时不该再补空位");
  assert.equal(layout.nodes.length, 60, "画布上只有真实星");
  assert.equal(JSON.stringify(layout.links), "[[0,1]]");
});

test("星图：停在空位上只说一句「还未点亮的记忆」，移开就回原详情", () => {
  const { renderStarmapBody } = loadClient().exports.__test;
  const h = makeReact().createElement;
  const base = { status: "ready", total: 1, truncated: false, stars: [], links: [], picked: { id: "a", text: "用户说周末想去海边走走", tier: "hot", at: 1738312800000 } };
  const on = texts(renderStarmapBody(Object.assign({}, base, { hoverUnlit: true }), h, null));
  assert.ok(on.includes("还未点亮的记忆"), on);
  assert.equal(on.includes("用户说周末想去海边走走"), false, "空位不许带出真实记忆的正文");
  assert.equal(on.includes("热记忆"), false, "也不给层与时间");
  const off = texts(renderStarmapBody(base, h, null));
  assert.ok(off.includes("用户说周末想去海边走走"), "移开后回到原来的详情");
  assert.equal(off.includes("还未点亮的记忆"), false);
});


test("星图：指针真的停在空位上时，详情换成那句话，移开就回原样", async () => {
  const universe = {
    ok: true,
    total: 1,
    truncated: false,
    stars: [{ id: "a1", text: "用户说周末想去海边走走", kind: "turn", tier: "hot", weight: 0.8, mentions: 2, pinned: false, valence: 0.6, arousal: 0.8, at: 1738312800000, tags: ["海边"] }],
    links: [],
  };
  const { render } = await mountPanel((opt, body) => {
    if (body && body.action === "universe") return { body: universe };
    return { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [] } };
  });
  buttonByText(render(), "星图").props.onClick();
  render();
  await tick();

  // 画布是假 DOM：记下监听器，按需要回调
  const listeners = {};
  const rect = { left: 10, top: 20, width: 520, height: 300 };
  const ctx = {
    setTransform() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    fillRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    set fillStyle(value) {},
    set strokeStyle(value) {},
    lineWidth: 1,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => rect,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    removeEventListener: () => {},
  };

  // 模拟 React 挂 ref，再渲染一次让 effect 拿到画布
  const first = render();
  findAll(first, (n) => n.tag === "canvas")[0].props.ref(canvas);
  render();
  for (const name of ["pointermove", "pointerdown", "click", "pointerleave"]) {
    assert.equal(typeof listeners[name], "function", "画布该挂上 " + name);
  }

  // 布局是确定的，所以能算出空位在哪
  const { normalizeUniverse, layoutUniverse } = loadClient().exports.__test;
  const model = normalizeUniverse(universe);
  const layout = layoutUniverse(model.stars, model.links, rect.width, rect.height);
  const unlitId = layout.unlitIds[0];
  const at = layout.nodes[layout.ids.indexOf(unlitId)];
  listeners.pointermove({ clientX: rect.left + at.x, clientY: rect.top + at.y });
  const hovering = texts(render());
  assert.ok(hovering.includes("还未点亮的记忆"), hovering.slice(0, 200));
  assert.equal(hovering.includes("点一颗星"), false, "停到空位上时不该还是那句提示");

  listeners.pointerleave();
  const left = texts(render());
  assert.ok(left.includes("点一颗星，看它记得什么。"), "移开后回到未选中态");
  assert.equal(left.includes("还未点亮的记忆"), false);

  // 停在真实星上不该触发空位文案
  const realAt = layout.nodes[0];
  listeners.pointermove({ clientX: rect.left + realAt.x, clientY: rect.top + realAt.y });
  assert.equal(texts(render()).includes("还未点亮的记忆"), false, "真实星不走空位那条路");
});


/**
 * 更贴近 React 的 hooks 桩：记住每个 effect 的依赖数组，
 * 依赖变了就先跑上一次的 cleanup 再重跑。mountPanel 那个桩不认依赖与 cleanup，
 * 「effect 把自己重跑掉、结果被 alive=false 丢掉」这类 bug 在它下面看不见。
 */
function mountWithDeps() {
  const state = [];
  const effects = [];
  let ui = 0;
  let ei = 0;
  const react = {
    createElement: (tag, props, ...children) => ({ tag, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial) => {
      const i = ui;
      ui += 1;
      if (!(i in state)) state[i] = initial;
      return [state[i], (next) => { state[i] = typeof next === "function" ? next(state[i]) : next; }];
    },
    useEffect: (fn, deps) => {
      const i = ei;
      ei += 1;
      const prev = effects[i];
      const same = !!(prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, k) => d === prev.deps[k]));
      if (same) return;
      if (prev && typeof prev.cleanup === "function") prev.cleanup();
      effects[i] = { deps: deps ? deps.slice() : null, cleanup: fn() };
    },
  };
  return {
    react,
    state,
    render: (component) => {
      ui = 0;
      ei = 0;
      return component();
    },
  };
}

test("星图：取数在 React 的真实顺序里也要落到 ready（effect 重跑不许吞掉结果）", async () => {
  const universe = {
    ok: true,
    total: 2,
    truncated: false,
    stars: [
      { id: "a1", text: "用户说周末想去海边走走", kind: "turn", tier: "hot", weight: 0.8, mentions: 2, pinned: false, valence: 0.6, arousal: 0.8, at: 1738312800000, tags: ["海边"] },
      { id: "b2", text: "用户最近在学手冲咖啡", kind: "turn", tier: "cold", weight: 0.4, mentions: 0, pinned: false, valence: -0.2, arousal: 0.3, at: 1738312900000, tags: ["咖啡"] },
    ],
    links: [["a1", "b2"]],
  };
  const sent = [];
  const fetchImpl = async (url, options) => {
    const opt = options || {};
    let body = null;
    try {
      body = opt.body ? JSON.parse(opt.body) : null;
    } catch {
      body = null;
    }
    sent.push({ method: opt.method || "GET", body });
    const payload = body && body.action === "universe" ? universe : { stats: { count: 2 }, budget: {}, vector: { state: "on" }, recalls: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  const harness = mountWithDeps();
  const client = loadClient({ react: harness.react, extra: { fetch: fetchImpl } });
  const captured = [];
  client.exports.apply({ get: () => ({ inject: (n, f) => captured.push(f), register: (d, c) => ({ d, c }) }) });
  const component = componentOf(captured, "settings.section").component;
  const render = () => harness.render(component);

  let tree = render();
  buttonByText(tree, "星图").props.onClick();
  tree = render();
  assert.ok(texts(tree).includes("正在把记忆排成星空"), "起请求时先给一句等待");
  // 关键一步：setState 会让 React 立刻再渲染一次，旧写法在这里就跑到了 cleanup
  render();
  await tick();
  tree = render();

  assert.equal(harness.state[3].status, "ready", "请求回来后必须是 ready，不能停在 loading");
  assert.ok(harness.state[3].stars && harness.state[3].stars.length === 2, "画布数据不许是空的");
  const flat = texts(tree);
  assert.ok(flat.includes("记忆星图 · 2 颗"), flat.slice(0, 240));
  assert.equal(flat.includes("正在把记忆排成星空"), false, "不许再停在等待文案");
  assert.equal(findAll(tree, (n) => n.tag === "canvas").length, 1);
  assert.equal(sent.filter((p) => p.body && p.body.action === "universe").length, 1, "只问一次宿主");
});


test("星图：失败后按重试会重新问一次，并且落到 ready", async () => {
  let fail = true;
  const { calls, render } = await mountPanel((opt, body) => {
    if (body && body.action === "universe") {
      if (fail) return { status: 503, body: { ok: false, error: "宿主忙" } };
      return {
        body: {
          ok: true,
          total: 1,
          truncated: false,
          stars: [{ id: "a1", text: "用户说周末想去海边走走", tier: "hot", kind: "turn", weight: 0.5, mentions: 0, pinned: false, valence: 0.2, arousal: 0.4, at: 1738312800000, tags: [] }],
          links: [],
        },
      };
    }
    return { body: { stats: { count: 1 }, budget: {}, vector: { state: "on" }, recalls: [] } };
  });
  buttonByText(render(), "星图").props.onClick();
  render();
  await tick();
  assert.ok(texts(render()).includes("星图没取到"), "先落到失败态");

  fail = false;
  buttonByText(render(), "重试").props.onClick();
  await tick();
  const flat = texts(render());
  assert.ok(flat.includes("记忆星图 · 1 颗"), "重试后要真的到 ready：" + flat.slice(0, 200));
  assert.equal(flat.includes("星图没取到"), false);
  assert.equal(calls.filter((c) => c.body && c.body.action === "universe").length, 2, "失败一次 + 重试一次");
});

test("星图：createStarSprite 用离屏画布造贴图，没有 document 时返回 null", () => {
  const fakeCanvas = {
    width: 0,
    height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, set fillStyle(value) {} }),
  };
  const withDoc = loadClient({ extra: { document: { baseURI: "http://127.0.0.1:52603/", createElement: () => fakeCanvas } } });
  assert.equal(typeof withDoc.exports.__test.createStarSprite, "function", "视觉验收要直接拿它造贴图");
  const sprite = withDoc.exports.__test.createStarSprite(64);
  assert.ok(sprite, "应当返回一块画布");
  assert.equal(sprite.width, 64);
  assert.equal(sprite.height, 64);

  const noDoc = loadClient().exports.__test.createStarSprite(64);
  assert.equal(noDoc, null, "没有 document 就返回 null，绘制自动回落渐变");
});

test("星图：图例说清亮暗，且不出现任何数字进度", () => {
  const { renderStarmapBody } = loadClient().exports.__test;
  const flat = texts(renderStarmapBody({ status: "ready", total: 3, truncated: false, stars: [], links: [] }, makeReact().createElement, null));
  assert.ok(flat.includes("亮的是记得的事，暗的是还没点亮的空位"), flat);
  for (const bad of ["再攒", "还差", "进度", "点亮还"]) assert.equal(flat.includes(bad), false, "不许出现进度文案：" + bad);
});

