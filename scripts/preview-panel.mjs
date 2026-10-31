#!/usr/bin/env node
/**
 * 把真实的 renderBlocks 输出渲染成一份自包含 HTML，用来肉眼评审面板外观。
 *
 * 用法：node scripts/preview-panel.mjs > /tmp/panel-preview.html
 * 零依赖、不联网：只读同目录的 ../client.js，用假的 window.__ModuleLoader__ 跑 factory，
 * 再拿 exports.__test.renderBlocks 的真实输出序列化成 HTML（不是另画一份）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "client.js");
const SRC = readFileSync(CLIENT, "utf8");

/* ---------------------------------------------------------------- 载入客户端 */
let definition = null;
const sandbox = {
  window: { __ModuleLoader__: { load: (def) => { definition = def; } } },
  document: { baseURI: "http://127.0.0.1:52603/" },
  console: { log() {}, warn() {}, error() {} },
  URL,
  AbortController,
  setTimeout,
  clearTimeout,
};
sandbox.globalThis = sandbox;
vm.runInNewContext(SRC, sandbox, { filename: "client.js" });
if (!definition) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");
const api = definition.factory((id) => {
  throw new Error("preview 不需要模块：" + id);
});
const { buildViewModel, renderBlocks, constellationNodes, ICONS, RECALL_LIMIT } = api.__test;

/* ------------------------------------------------------------- h → HTML */
const KEEP_CASE = new Set(["viewBox", "gradientUnits", "patternUnits", "preserveAspectRatio"]);
const UNITLESS = new Set(["opacity", "flex", "flexGrow", "flexShrink", "fontWeight", "lineHeight", "zIndex", "order", "flexBasis"]);
const SELF_CLOSING = new Set(["path", "circle", "line", "rect", "stop", "polyline", "polygon", "ellipse"]);

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
function kebab(name) {
  if (KEEP_CASE.has(name)) return name;
  return name.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
}
function styleToCss(style) {
  const parts = [];
  for (const key of Object.keys(style || {})) {
    const value = style[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "number" && !UNITLESS.has(key) && key !== "opacity") parts.push(kebab(key) + ":" + value + "px");
    else parts.push(kebab(key) + ":" + value);
  }
  return parts.join(";");
}

function serialize(node, ctx) {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (typeof node === "string") return escapeHtml(node);
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map((n) => serialize(n, ctx)).join("");
  const tag = String(node.tag || "div");
  const props = node.props || {};
  const attrs = [];
  for (const key of Object.keys(props)) {
    if (key === "key" || key === "children") continue;
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === "style") {
      const css = styleToCss(value);
      if (css) attrs.push('style="' + escapeAttr(css) + '"');
      continue;
    }
    if (tag === "option" && ctx && ctx.selected !== undefined && String(props.value) === String(ctx.selected)) {
      attrs.push('selected="selected"');
    }
    attrs.push(kebab(key) + '="' + escapeAttr(value) + '"');
  }
  const open = "<" + tag + (attrs.length ? " " + attrs.join(" ") : "");
  if (SELF_CLOSING.has(tag) && !(node.children || []).length) return open + " />";
  // <select value> 在 HTML 里不生效，得给匹配的 option 打 selected；否则静态预览会显示错层
  const childCtx = tag === "select" ? { selected: props.value } : ctx;
  return open + ">" + (node.children || []).map((n) => serialize(n, childCtx)).join("") + "</" + tag + ">";
}

/* --------------------------------------------------------------- 三份数据 */
const normalPayload = {
  stats: {
    count: 27,
    live: 25,
    merged: 2,
    byTier: { hot: 27, cold: 0, persona: 0, state: 0 },
    byKind: { turn: 20, fact: 5, event: 2 },
    logLines: 27,
    warnings: [],
  },
  budget: { tokens: 420, budget: 600, picks: 4, dropped: [{ id: "a" }, { id: "b" }] },
  vector: { state: "off", reason: "provider-none" },
  recalls: [
    { id: "turn-a1", text: "用户说周末想去海边走走，风大也没关系。", score: 0.876 },
    { id: "turn-a2", text: "用户最近在学做手冲咖啡，磨豆机还没买。", score: 0.612 },
    { id: "turn-a3", text: "用户不太喜欢太吵的地方，偏好安静的户外。", score: 0.455 },
    { id: "turn-a4", text: "下周三要交一份季度总结，用户有点在意这件事。", score: 0.309 },
    { id: "turn-a5", text: "用户提到过想养一只橘猫，但担心房东不让。", score: 0.221 },
  ],
};

const emptyPayload = {
  stats: { count: 0, live: 0, merged: 0, byTier: { hot: 0, cold: 0, persona: 0, state: 0 }, byKind: {}, logLines: 0, warnings: [] },
  budget: { tokens: 0, budget: 0, picks: 0, dropped: [] },
  vector: { state: "degraded", reason: "local:runtime-unavailable" },
  recalls: [],
};

const unavailableReason = "宿主未注册 /.dsh-mnemos/panel（HTTP 404）";

// 操作卡的静态态：一条普通结果 + 一条正处在「确认忘记？」的行
const actionsDemo = {
  query: "海边",
  rows: [
    { id: "turn-a1", text: "用户说周末想去海边走走，风大也没关系。", score: 0.88, tier: "hot", pinned: true },
    { id: "turn-a2", text: "用户最近在学做手冲咖啡，磨豆机还没买。", score: 0.61, tier: "cold", pinned: false },
  ],
  rowStatus: {},
  confirmingId: "turn-a2",
  searchStatus: { state: "ok", text: "命中 2 条" },
};
const realWidth = { html: serialize(renderBlocks(buildViewModel(normalPayload), hStub, null, { tab: "overview", actions: actionsDemo })) };
const aboutWidth = { html: serialize(renderBlocks(buildViewModel(normalPayload), hStub, null, { tab: "about" })) };

const states = [
  {
    id: "normal",
    heading: "正常态",
    caption: "27 条记忆（热 27）· 预算 420/600 · 向量关闭 · 5 条召回。星幕的星点数量与半径由 byTier 决定。",
    html: serialize(renderBlocks(buildViewModel(normalPayload), hStub, null)),
  },
  {
    id: "empty",
    heading: "空态",
    caption: "全 0：星幕画 5 颗待点亮暗星 + 虚线轨迹，分层条宽为 0，预算显示「本会话尚未装配」。",
    html: serialize(renderBlocks(buildViewModel(emptyPayload), hStub, null)),
  },
  {
    id: "unavailable",
    heading: "不可用态",
    caption: "拿不到数据时只显示断线插图 + 原因 + 只读承诺，一个数字都不出。",
    html: serialize(renderBlocks(null, hStub, unavailableReason)),
  },
];

function hStub(tag, props, ...children) {
  return { tag, props: props || {}, children: children.flat(Infinity) };
}

/* ------------------------------------------------------------------ 输出 */
const counts = {
  normal: constellationNodes(normalPayload.stats.byTier).length,
  empty: constellationNodes(emptyPayload.stats.byTier).length,
  iconPaths: Object.keys(ICONS).map((k) => k + ":" + ICONS[k].filter((s) => s.tag === "path").length).join(" "),
};

const page = [
  "<!doctype html>",
  '<html lang="zh-CN">',
  "<head>",
  '<meta charset="utf-8">',
  "<title>dsh-mnemos 记忆面板 · 外观预览</title>",
  "<style>",
  ":root{color-scheme:dark}",
  "*{box-sizing:border-box}",
  "body{margin:0;padding:32px 28px 48px;background:#14101c;color:#C9BFDB;font:14px/1.6 -apple-system,'PingFang SC','Helvetica Neue',sans-serif}",
  ".wrap{max-width:1120px;margin:0 auto;display:flex;flex-direction:column;gap:28px}",
  "h1{font-size:17px;margin:0 0 6px;color:#F2EBFB;font-weight:650;letter-spacing:.2px}",
  ".lede{font-size:12.5px;color:#9E93B4;margin:0}",
  ".cases{display:grid;grid-template-columns:repeat(auto-fit,minmax(430px,1fr));gap:24px;align-items:start}",
  ".case{display:flex;flex-direction:column;gap:10px}",
  ".real{align-items:flex-start}",
  ".sub{font-size:12.5px;margin:8px 0 0;color:#9E93B4;font-weight:600}",
  "h2{font-size:13px;margin:0;color:#D8A7C8;font-weight:600}",
  ".cap{font-size:11.5px;color:#8C8499;margin:0;min-height:32px}",
  ".surface{padding:18px;border-radius:22px;background:radial-gradient(120% 90% at 15% 0%,#1d1730,#14101c 70%);border:1px solid rgba(255,255,255,.05)}",
  "footer{font-size:11.5px;color:#8C8499;border-top:1px solid rgba(255,255,255,.07);padding-top:14px}",
  "</style>",
  "</head>",
  "<body>",
  '<div class="wrap">',
  "<header>",
  "<h1>dsh-mnemos · 只读记忆面板（陪伴向柔和粉紫）</h1>",
  '<p class="lede">这份 HTML 由 scripts/preview-panel.mjs 生成：内容是 client.js 里 renderBlocks 的真实输出，这里只负责把元素树序列化成标签。</p>',
  "</header>",
  '<section class="case real" id="real560">',
  "<h2>① 真实宽度 560px（DSH 设置页里的实际宽度）</h2>",
  '<p class="cap">这块容器就是 560px；面板本体 max-width 也是 560。评审以此为准。</p>',
  '<div class="surface" style="width:560px;max-width:100%">' + realWidth.html + "</div>",
  "</section>",
  '<section class="case real" id="about560">',
  "<h2>② 说明页（560px）</h2>",
  '<p class="cap">点顶部「说明」看到的就是这一屏：纯本地切页，不发请求、不写数据。</p>',
  '<div class="surface" style="width:560px;max-width:100%">' + aboutWidth.html + "</div>",
  "</section>",
  '<h2 class="sub">③ 对照：三态（1280 宽网格，仅看结构差异）</h2>',
  '<div class="cases">',
  ...states.map((s) =>
    [
      '<section class="case" id="' + s.id + '">',
      "<h2>" + s.heading + "</h2>",
      '<p class="cap">' + s.caption + "</p>",
      '<div class="surface">' + s.html + "</div>",
      "</section>",
    ].join(""),
  ),
  "</div>",
  "<footer>",
  "星座节点数：正常态 " + counts.normal + " 个 / 空态 " + counts.empty + " 个（上限 40）；图标 path 数：" + counts.iconPaths + "。",
  "</footer>",
  "</div>",
  "</body>",
  "</html>",
].join("\n");

process.stdout.write(page + "\n");
