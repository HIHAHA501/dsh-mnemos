/**
 * dsh-mnemos 的浏览器半边：只读记忆面板（settings.section）。
 * 形态依据（本机实测）：宿主用 classic script + ModuleLoader 加载——
 *   ofm/client.js:25 window.__ModuleLoader__.load({id, factory})；orb:2832 ctx.slots.inject(...)；
 *   rem_client:3898/3973 ctx.get("slots") / exports.inject = ["slots"]。
 * 数据通道：同源 HTTP 路由，插件自己注册（ofm:2677+2694、orb:2880、rem_client:82）。
 * 本文件因此没有 import/export，顶层只做一件事：把 factory 交给 ModuleLoader。
 *
 * 视觉：柔和粉紫（HSL 饱和度 >= 55%）+ 手绘笔触，全部内联，离线可用。
 * 构图节奏：星幕（主角）-> 手绘首卡（重）-> 分层（中）-> 预算（中）-> 向量/召回（轻）。
 * 装饰随便画，数据图形一律由 {stats,budget,vector,recalls} 真实字段驱动。
 */
/* __clientScopeGuard: 宿主把所有插件的 client.js 拼进同一个脚本作用域，
   顶层 const/function 会互相撞名（实测：dsh-safeguard 与 dsh-mnemos 的 PANEL_PATH 相撞，
   导致 web boot 报 “Identifier has already been declared”）。整份文件包一层 IIFE 隔离。 */
(function () {
const PANEL_PATH = (() => {
  try {
    return new URL(".dsh-mnemos/panel", document.baseURI).pathname;
  } catch {
    return "/.dsh-mnemos/panel";
  }
})();

/** 设置页里的分节名：Mnemos（记忆女神）＋ 面板本体就是星幕，所以叫星图。 */
const SECTION_LABEL = "记忆星图";
const TIER_LABELS = { hot: "热记忆", cold: "冷记忆", persona: "人格前提", state: "当前状态" };
const TIER_SHORT = { hot: "热", cold: "冷", persona: "人格", state: "状态" };
const TIER_ORDER = ["hot", "cold", "persona", "state"];
const VECTOR_LABELS = { on: "可用", off: "关闭", degraded: "降级" };
const RECALL_LIMIT = 5;
const FETCH_TIMEOUT_MS = 8000;
const STAR_MAX_NODES = 40;
const STAR = { W: 560, H: 112, R_MIN: 3, R_MAX: 9, TOP: 20, BOTTOM: 74 };
const TAU = Math.PI * 2;
/** 星图：画布尺寸与布局松弛的全部参数都写死——同一份数据每次画在同一处，截图可复现。 */
const STARMAP = {
  W: 520,
  H: 300,
  PAD: 24,
  R_MIN: 2,
  R_MAX: 18,
  SHELL: 0.42, // 球壳外半径 = 画布短边 × 0.42
  PITCH: -0.35, // 固定俯仰角：把球压出纵深
  FOCUS_LEN: 4, // 透视焦距 = 球壳半径 × 4
  ANCHOR_BASE: 40,
  ANCHOR_BONUS: 4, // 锚点星 40 + 4×权重 → 40~44
  CHAMPION: 1.6, // 每层权重最高的一颗（章首星）
  DEPTH_MIN: 0.68, // 最远的星剩 0.68 的亮度与半径，别暗成黑点
  UNLIT_MAX: 44,
  UNLIT_BASE: 16,
  UNLIT_HUE: 218,
  SPRITE: 64,
};
/** 空闲停帧：设置页常被一直开着，画面不动就别占着 CPU；有指针活动再醒。 */
const STARMAP_IDLE_MS = 10000;

let RESOLVED_REACT = null;

function asObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function asList(v) {
  return Array.isArray(v) ? v : [];
}
function asCount(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function snippet(text, limit) {
  const s = typeof text === "string" ? text.trim() : "";
  if (!s) return "";
  return s.length <= limit ? s : s.slice(0, limit) + "…";
}
function countMap(source) {
  const out = {};
  const input = asObject(source);
  for (const key of Object.keys(input)) out[key] = asCount(input[key]);
  return out;
}
function fmt(n) {
  const digits = String(asCount(n));
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}
function errText(error) {
  return error && error.message ? error.message : String(error);
}
function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
function hash32(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ------------------------------------------------------------ 视觉 token */
/**
 * 强调色是 HSL 且饱和度 >= 55%，并且占面积（星幕铺满 + 首卡双角渐晕）。
 * 文字色仍是实色 hex；WCAG 对比度（底色 #171320 / 卡片 #231D2D）：
 *   text1 15.7 / 14.1   text2 10.4 / 9.3   text3 6.3 / 5.7   dim 5.1 / 4.6
 */
const C = {
  // 宿主的设计 token 优先，深色值兜底：浅色主题下不再白底白字
  text1: "var(--dsw-alias-label-primary, #F4EDFB)",
  text2: "var(--dsw-alias-label-secondary, #D3C8E6)",
  text3: "var(--dsw-alias-label-tertiary, #A79BBB)",
  dim: "var(--dsw-alias-label-caption, #8F87A0)",
  line: "var(--dsw-alias-border-l1, hsla(320, 55%, 80%, 0.20))",
  lineSoft: "var(--dsw-alias-border-l2, rgba(255,255,255,0.075))",
  cardBg: "var(--dsw-alias-bg-module-platform, rgba(255,255,255,0.042))",
  track: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.075))",
  // 粉紫是身份，保留；状态色跟宿主走
  pink: "hsl(320, 66%, 74%)",
  purple: "hsl(265, 62%, 73%)",
  green: "var(--dsw-alias-state-business-primary, hsl(158, 46%, 70%))",
  amber: "var(--dsw-alias-state-warn-primary, hsl(38, 64%, 72%))",
  danger: "var(--dsw-alias-state-error-primary, hsl(6, 72%, 72%))",
  glow: "inset 0 1px 0 rgba(255,255,255,0.075)",
};

function pinkPurple(t) {
  const k = clampNum(t, 0, 1);
  return "hsl(" + Math.round(320 - 55 * k) + ",64%," + Math.round(75 - 6 * k) + "%)";
}
function pinkPurpleA(t, alpha) {
  const k = clampNum(t, 0, 1);
  return "hsla(" + Math.round(320 - 55 * k) + ",64%," + Math.round(72 - 6 * k) + "%," + alpha + ")";
}

const S = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 14,
    width: "100%",
    maxWidth: 560,
    color: C.text2,
    fontVariantNumeric: "tabular-nums",
    lineHeight: 1.5,
  },
  sky: {
    position: "relative",
    height: STAR.H,
    borderRadius: 20,
    overflow: "hidden",
    background:
      "radial-gradient(120% 150% at 12% -10%, hsla(320, 70%, 68%, 0.42), hsla(320, 70%, 68%, 0) 58%)," +
      "radial-gradient(110% 140% at 92% 110%, hsla(265, 70%, 66%, 0.40), hsla(265, 70%, 66%, 0) 62%)," +
      "linear-gradient(150deg, rgba(48,36,64,0.92), rgba(30,24,42,0.96))",
    border: "1px solid hsla(320, 60%, 82%, 0.16)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
  },
  skyCaption: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 10,
    fontSize: 12,
    color: "hsla(320, 45%, 90%, 0.66)",
    letterSpacing: 0.2,
  },
  hero: {
    position: "relative",
    borderRadius: 22,
    padding: "16px 18px 15px",
    background:
      "radial-gradient(120% 130% at 100% 0%, hsla(320, 65%, 70%, 0.22), hsla(320, 65%, 70%, 0) 55%)," +
      "radial-gradient(120% 140% at 0% 100%, hsla(265, 65%, 68%, 0.22), hsla(265, 65%, 68%, 0) 58%)," +
      "var(--dsw-alias-bg-module-platform, rgba(58,44,76,0.55))",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  heroRow: { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" },
  big: { fontSize: 34, lineHeight: 1, fontWeight: 600, color: C.text1, letterSpacing: -0.6 },
  unit: { fontSize: 12, color: C.text3 },
  legend: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px", marginLeft: "auto", minWidth: 170 },
  legendItem: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.text2 },
  legendCount: { marginLeft: "auto", color: C.text1, fontSize: 11.5 },
  legendCountDim: { marginLeft: "auto", color: C.dim, fontSize: 11.5 },
  card: {
    borderRadius: 16,
    border: "1px solid " + C.line,
    background: C.cardBg,
    boxShadow: C.glow,
    padding: "13px 15px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardLight: {
    borderRadius: 14,
    border: "1px solid " + C.lineSoft,
    background: C.cardBg,
    padding: "12px 14px 13px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  head: { display: "flex", alignItems: "center", gap: 9 },
  title: { fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3, color: C.text3 },
  body: { display: "flex", flexDirection: "column", gap: 9 },
  row: { display: "flex", alignItems: "center", gap: 10 },
  type: { fontSize: 12.5, color: C.text2, minWidth: 58 },
  typeDim: { fontSize: 12.5, color: C.dim, minWidth: 58 },
  track: {
    flex: 1,
    height: 11,
    borderRadius: 999,
    background: C.track,
    boxShadow: "inset 0 1px 2px rgba(0,0,0,0.35)",
    overflow: "hidden",
  },
  count: { fontSize: 13, color: C.text1, minWidth: 34, textAlign: "right" },
  countDim: { fontSize: 13, color: C.dim, minWidth: 34, textAlign: "right" },
  note: { fontSize: 11.5, color: C.text3 },
  soft: { fontSize: 12, color: C.text3, lineHeight: 1.55 },
  vectorState: { fontSize: 13, color: C.text1, fontWeight: 600 },
  recall: { display: "flex", alignItems: "flex-start", gap: 10 },
  badge: {
    flex: "none",
    minWidth: 42,
    textAlign: "center",
    fontSize: 11.5,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums",
    color: C.text2,
    background: "hsla(265, 60%, 74%, 0.26)",
    border: "1px solid hsla(265, 62%, 82%, 0.45)",
    borderRadius: 8,
    padding: "2px 0",
  },
  recallText: { fontSize: 13, lineHeight: 1.5, color: C.text2, flex: 1, wordBreak: "break-word" },
  divider: { height: 1, background: C.lineSoft },
  tickRow: { display: "flex", justifyContent: "space-between", fontSize: 10.5, color: C.text3, padding: "0 1px" },
  warn: {
    position: "relative",
    borderRadius: 20,
    border: "1px solid hsla(38, 60%, 74%, 0.30)",
    background: C.cardBg,
    boxShadow: C.glow,
    padding: "18px 18px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 11,
  },
};

// 0 值轨道压暗一档：中性灰在两个主题下都成立（不用白/黑，避免一边看不见）
S.trackZero = Object.assign({}, S.track, { background: "rgba(127,127,127,0.10)" });
S.segGroup = {
  display: "inline-flex",
  alignSelf: "flex-start",
  gap: 3,
  padding: 3,
  borderRadius: 999,
  background: C.track,
  border: "1px solid " + C.lineSoft,
};
S.segOn = {
  padding: "4px 15px",
  borderRadius: 999,
  border: "1px solid transparent",
  fontSize: 12,
  fontWeight: 600,
  color: "#2A2033",
  background: "linear-gradient(135deg, hsl(320, 66%, 78%), hsl(272, 62%, 78%))",
  cursor: "pointer",
  fontFamily: "inherit",
};
S.segOff = {
  padding: "4px 15px",
  borderRadius: 999,
  border: "1px solid transparent",
  fontSize: 12,
  fontWeight: 500,
  color: C.text3,
  background: "transparent",
  cursor: "pointer",
  fontFamily: "inherit",
};
S.prose = { fontSize: 12.5, color: C.text2, lineHeight: 1.62 };
S.entry = { display: "flex", flexDirection: "column", gap: 2 };
S.entryTitle = { fontSize: 12.5, fontWeight: 600, color: C.text1 };
S.actSearch = { display: "flex", gap: 8, alignItems: "center" };
S.input = {
  flex: 1,
  minWidth: 0,
  padding: "6px 10px",
  borderRadius: 10,
  border: "1px solid " + C.line,
  background: C.track,
  color: C.text1,
  fontSize: 12.5,
  fontFamily: "inherit",
  outline: "none",
};
S.btn = {
  flex: "none",
  padding: "6px 14px",
  borderRadius: 10,
  border: "1px solid hsla(320, 55%, 80%, 0.35)",
  background: "hsla(320, 60%, 72%, 0.16)",
  color: C.text1,
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};
S.miniBtn = {
  padding: "3px 10px",
  borderRadius: 8,
  border: "1px solid " + C.line,
  background: C.track,
  color: C.text2,
  fontSize: 11.5,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};
S.dangerBtn = Object.assign({}, S.miniBtn, {
  border: "1px solid hsla(2, 62%, 66%, 0.72)",
  background: "hsla(2, 66%, 58%, 0.28)",
  color: C.text1,
  fontWeight: 600,
});
S.miniSelect = {
  padding: "3px 6px",
  borderRadius: 8,
  border: "1px solid " + C.line,
  background: C.track,
  color: C.text2,
  fontSize: 11.5,
  fontFamily: "inherit",
  cursor: "pointer",
};
S.actRow = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 0 9px",
  borderTop: "1px solid " + C.lineSoft,
};
S.actLine = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
S.actScore = { flex: "none", fontSize: 11, fontVariantNumeric: "tabular-nums", color: C.purple, minWidth: 30 };
S.actText = { flex: 1, minWidth: 0, fontSize: 12.5, color: C.text2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
S.actTier = { flex: "none", fontSize: 10.5, color: C.text3, border: "1px solid rgba(255,255,255,0.10)", borderRadius: 6, padding: "1px 6px" };
S.actPin = { flex: "none", fontSize: 10.5, color: C.pink, border: "1px solid hsla(320, 60%, 78%, 0.35)", borderRadius: 6, padding: "1px 6px" };
S.actOps = { display: "flex", gap: 6, alignItems: "center", paddingLeft: 38 };
S.actOk = { fontSize: 11, color: C.green, paddingLeft: 38 };
// 输入区小胶囊：22px 高，跟旁边的小控件同档，不抢戏
S.pill = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 22,
  padding: "0 10px",
  borderRadius: 999,
  border: "1px solid hsla(320, 50%, 82%, 0.22)",
  background: C.track,
  color: C.text2,
  fontSize: 11.5,
  lineHeight: 1,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};
S.pillDot = { width: 6, height: 6, borderRadius: 999, flex: "none" };
S.captureRow = { display: "flex", alignItems: "center", gap: 10, paddingBottom: 2 };
S.actErr = { fontSize: 11, color: C.danger, paddingLeft: 38 };
// 星图画布：宽跟着设置页走、高写死；底色由 canvas 自己铺满，抽出去单独截图也不发白
S.starmapCanvas = {
  display: "block",
  width: "100%",
  height: STARMAP.H,
  borderRadius: 14,
  border: "1px solid hsla(320, 55%, 82%, 0.16)",
  cursor: "crosshair",
};
S.starmapDetail = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 8, fontSize: 12 };

function fillBar(pct, tone) {
  const k = tone === undefined ? 0.15 : tone;
  return {
    width: clampNum(pct, 0, 100) + "%",
    height: "100%",
    borderRadius: 999,
    background: "linear-gradient(90deg, " + pinkPurple(k) + ", " + pinkPurple(k + 0.35) + ")",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.42)",
  };
}
function dotStyle(color) {
  return { width: 7, height: 7, borderRadius: 999, background: color, flex: "none" };
}

/* ------------------------------------------------------------- 手绘图标 */
const ICONS = {
  memory: [
    { tag: "path", d: "M4 9.8l8-4 8 4-8 4-8-4z" },
    { tag: "path", d: "M4 13.6l8 4 8-4" },
    { tag: "circle", cx: 19.2, cy: 5.4, r: 1.2 },
  ],
  tiers: [{ tag: "path", d: "M4 7.6h16" }, { tag: "path", d: "M4 12h16" }, { tag: "path", d: "M4 16.4h9.5" }],
  budget: [
    { tag: "path", d: "M6 4.4h9v10.4a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V4.4z" },
    { tag: "path", d: "M15 7.9h2.6" },
    { tag: "path", d: "M6.9 11.7h7.2" },
  ],
  vector: [
    { tag: "path", d: "M6 15.4l4-4.4 4 3.1 4-6.6" },
    { tag: "circle", cx: 6, cy: 15.4, r: 1.5 },
    { tag: "circle", cx: 10, cy: 11, r: 1.5 },
    { tag: "circle", cx: 14, cy: 14.1, r: 1.5 },
    { tag: "circle", cx: 18, cy: 7.5, r: 1.5 },
  ],
  recalls: [
    { tag: "path", d: "M4.6 8.2a3.4 3.4 0 0 1 3.4-3.4h8a3.4 3.4 0 0 1 3.4 3.4v4.4a3.4 3.4 0 0 1-3.4 3.4h-3.6L8 19.2v-3.2h-.2a3.2 3.2 0 0 1-3.2-3.2V8.2z" },
    { tag: "circle", cx: 9.4, cy: 10.2, r: 0.85 },
    { tag: "circle", cx: 12.8, cy: 10.2, r: 0.85 },
  ],
  actions: [
    { tag: "path", d: "M6.2 13V6.9a1.55 1.55 0 0 1 3.1 0v4.3" },
    { tag: "path", d: "M9.3 11.2V5.7a1.55 1.55 0 0 1 3.1 0v5.5" },
    { tag: "path", d: "M12.4 11.2V7.6a1.55 1.55 0 0 1 3.1 0v6.1a4.5 4.5 0 0 1-4.5 4.5h-.8a4 4 0 0 1-3.1-1.5l-2.5-3.4" },
  ],
  unplugged: [
    { tag: "path", d: "M3.5 13.6c2.6-3.5 5.4-3.5 7.1-1.2", w: 2.4 },
    { tag: "path", d: "M20.5 10.4c-2.6 3.5-5.4 3.5-7.1 1.2", w: 2.4 },
    { tag: "path", d: "M12 4.4v2.4", w: 1.4 },
    { tag: "path", d: "M12 17v2.4", w: 1.4 },
    { tag: "path", d: "M9.3 7.1l1.2 1.9", w: 0.9 },
    { tag: "path", d: "M14.7 16.9l-1.2-1.9", w: 0.9 },
  ],
};

function icon(name, h, size, color) {
  const shapes = ICONS[name] || [];
  return h(
    "svg",
    {
      key: "icon-" + name,
      width: size || 18,
      height: size || 18,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: color || C.text2,
      strokeWidth: 1.6,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      style: { flex: "none" },
    },
    shapes.map((shape, i) => {
      const props = { key: "s" + i };
      if (shape.w) props.strokeWidth = shape.w;
      for (const k of Object.keys(shape)) if (k !== "tag" && k !== "w") props[k] = shape[k];
      return h(shape.tag, props);
    }),
  );
}

/* --------------------------------------------------------- 星幕（视觉主角） */
/**
 * 星幕不是装饰贴图：每层的横向跨度、星点数量、星点半径都由 stats.byTier 的真实分桶决定。
 * 半径 3..9 按该层占比映射；每颗星三层同心圆做出柔光；连线是 1px 渐变描边 + 二次贝塞尔。
 * 全 0 时画 5 颗「待点亮」暗星 + 虚线轨迹，并在带上写一句温柔说明。
 */
function starNodes(byTier) {
  const counts = TIER_ORDER.map((t) => asCount(asObject(byTier)[t]));
  const total = counts.reduce((a, b) => a + b, 0);
  const nodes = [];
  if (!total) {
    const seeds = [46, 138, 232, 330, 428];
    for (let i = 0; i < seeds.length; i += 1) {
      nodes.push({ key: "pending-" + i, tier: "pending", x: seeds[i], y: 56 + ((i % 3) - 1) * 12, r: 3.2, t: seeds[i] / STAR.W, pending: true });
    }
    return nodes;
  }
  const span = STAR.W - 48;
  let cursor = 24;
  for (let ti = 0; ti < TIER_ORDER.length; ti += 1) {
    const count = counts[ti];
    if (!count) continue;
    const tier = TIER_ORDER[ti];
    const share = count / total;
    const width = span * share;
    const n = Math.max(1, Math.min(9, Math.round(share * 11)));
    for (let i = 0; i < n && nodes.length < STAR_MAX_NODES; i += 1) {
      const jitter = hash32(tier + ":" + i);
      const across = n === 1 ? 0.5 : i / (n - 1);
      const x = cursor + width * across + ((jitter % 9) - 4) * 0.8;
      const y = STAR.TOP + ((jitter >>> 7) % (STAR.BOTTOM - STAR.TOP)) + ((jitter >>> 3) % 5) * 0.6;
      nodes.push({
        key: tier + "-" + i,
        tier,
        x: Math.round(clampNum(x, 20, STAR.W - 20) * 10) / 10,
        y: Math.round(clampNum(y, STAR.TOP, STAR.BOTTOM) * 10) / 10,
        r: Math.round((STAR.R_MIN + (STAR.R_MAX - STAR.R_MIN) * Math.sqrt(share)) * 10) / 10,
        t: clampNum(x / STAR.W, 0, 1),
      });
    }
    cursor += width;
  }
  return nodes;
}

function skyField(byTier, total, h) {
  const nodes = starNodes(byTier);
  const pending = nodes.length > 0 && !!nodes[0].pending;
  const uid = "mn" + hash32(JSON.stringify(asObject(byTier))).toString(36);
  const children = [
    h("defs", { key: "defs" }, [
      h("linearGradient", { key: "g1", id: uid + "arc", x1: "0", y1: "0", x2: "1", y2: "0" }, [
        h("stop", { key: "s1", offset: "0", stopColor: "hsl(320, 68%, 74%)", stopOpacity: 0.55 }),
        h("stop", { key: "s2", offset: "1", stopColor: "hsl(265, 64%, 74%)", stopOpacity: 0.55 }),
      ]),
      h("radialGradient", { key: "g2", id: uid + "vig", cx: "0.18", cy: "0.12", r: "0.9" }, [
        h("stop", { key: "v1", offset: "0", stopColor: "hsl(320, 70%, 70%)", stopOpacity: 0.22 }),
        h("stop", { key: "v2", offset: "1", stopColor: "hsl(320, 70%, 70%)", stopOpacity: 0 }),
      ]),
    ]),
    h("rect", { key: "vig", x: 0, y: 0, width: STAR.W, height: STAR.H, fill: "url(#" + uid + "vig)" }),
  ];

  for (let i = 1; i < nodes.length; i += 1) {
    const a = nodes[i - 1];
    const b = nodes[i];
    const mx = (a.x + b.x) / 2;
    const my = Math.min(a.y, b.y) - 10 - ((i % 3) * 4);
    children.push(
      h("path", {
        key: "arc" + i,
        d: "M" + a.x + " " + a.y + "Q" + mx + " " + my + " " + b.x + " " + b.y,
        fill: "none",
        stroke: pending ? "hsla(320, 40%, 80%, 0.22)" : "url(#" + uid + "arc)",
        strokeWidth: 1,
        strokeDasharray: pending ? "2 7" : undefined,
        strokeLinecap: "round",
        opacity: pending ? 1 : 0.85,
      }),
    );
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i];
    const core = pending ? "hsla(320, 40%, 86%, 0.30)" : pinkPurple(n.t);
    const halo = pending ? "hsla(320, 40%, 86%, 0.06)" : pinkPurpleA(n.t, 0.16);
    const mid = pending ? "hsla(320, 40%, 86%, 0.10)" : pinkPurpleA(n.t, 0.30);
    children.push(h("circle", { key: "halo" + i, cx: n.x, cy: n.y, r: n.r * 2.5, fill: halo }));
    children.push(h("circle", { key: "mid" + i, cx: n.x, cy: n.y, r: n.r * 1.55, fill: mid }));
    children.push(h("circle", { key: "core" + i, cx: n.x, cy: n.y, r: n.r, fill: core }));
    if (!pending) {
      children.push(h("circle", { key: "glint" + i, cx: n.x - n.r * 0.28, cy: n.y - n.r * 0.3, r: Math.max(0.7, n.r * 0.3), fill: "rgba(255,255,255,0.85)" }));
    }
  }

  return h("div", { key: "sky", style: S.sky }, [
    h(
      "svg",
      {
        key: "svg",
        viewBox: "0 0 " + STAR.W + " " + STAR.H,
        width: "100%",
        height: "100%",
        preserveAspectRatio: "xMidYMid meet",
        role: "img",
        "aria-label": pending ? "记忆星座：还没有星点" : "记忆星座：分层计数决定星点数量与大小",
        style: { display: "block" },
      },
      children,
    ),
    h(
      "div",
      { key: "cap", style: S.skyCaption },
      pending ? "还没有星点。等第一批记忆落下，这里会亮起来。" : "记忆星座 · " + fmt(total) + " 颗落在 " + activeTiers(byTier) + " 个分层里。",
    ),
  ]);
}

function activeTiers(byTier) {
  const m = asObject(byTier);
  let n = 0;
  for (const t of TIER_ORDER) if (asCount(m[t]) > 0) n += 1;
  return n;
}

/* ------------------------------------------------------------ 手绘笔触 */
/** 手绘边框：沿圆角矩形采样并做确定性抖动，配合 non-scaling-stroke 贴到任意尺寸。 */
function handBorder(h, key) {
  const W = 300;
  const H = 120;
  const R = 18;
  const seg = 24;
  /** 每条边自己成一条 subpath（M 开头），绝不跨角连直线——上一版在四角画出了斜插。 */
  function edge(x1, y1, x2, y2, seed) {
    let d = "M" + x1.toFixed(1) + " " + y1.toFixed(1);
    for (let i = 1; i <= seg; i += 1) {
      const k = i / seg;
      const j = ((hash32(seed + ":" + i) % 100) / 100 - 0.5) * 0.9;
      const px = x1 + (x2 - x1) * k + (y1 === y2 ? 0 : j);
      const py = y1 + (y2 - y1) * k + (y1 === y2 ? j : 0);
      d += "L" + px.toFixed(1) + " " + py.toFixed(1);
    }
    return d;
  }
  const strokes = [
    edge(R, 1.2, W - R, 1.2, "top"),
    edge(W - 1.2, R, W - 1.2, H - R, "right"),
    edge(W - R, H - 1.2, R, H - 1.2, "bottom"),
    edge(1.2, H - R, 1.2, R, "left"),
    "M" + R + " 1.2Q1.2 1.2 1.2 " + R,
    "M" + (W - R) + " 1.2Q" + (W - 1.2) + " 1.2 " + (W - 1.2) + " " + R,
    "M" + (W - 1.2) + " " + (H - R) + "Q" + (W - 1.2) + " " + (H - 1.2) + " " + (W - R) + " " + (H - 1.2),
    "M" + R + " " + (H - 1.2) + "Q1.2 " + (H - 1.2) + " 1.2 " + (H - R),
  ];
  return h(
    "svg",
    {
      key: key || "handframe",
      viewBox: "0 0 " + W + " " + H,
      preserveAspectRatio: "none",
      "aria-hidden": "true",
      style: { position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" },
    },
    strokes.map((d, i) =>
      h("path", {
        key: "seg" + i,
        d,
        fill: "none",
        stroke: "hsla(320, 62%, 84%, 0.44)",
        strokeWidth: 1.7,
        vectorEffect: "non-scaling-stroke",
        strokeLinecap: "round",
        strokeLinejoin: "round",
      }),
    ),
  );
}

/** 手绘波浪下划线：数字下面那一笔。 */
function wavyUnderline(h, width, color) {
  const seg = 4;
  let d = "M1 5";
  for (let i = 0; i < seg; i += 1) {
    const x = 1 + ((width - 2) / seg) * i;
    d += "q" + (width - 2) / seg / 2 + " -4 " + (width - 2) / seg + " 0";
  }
  return h(
    "svg",
    { key: "wave", width, height: 9, viewBox: "0 0 " + width + " 9", "aria-hidden": "true", style: { display: "block", marginTop: 2 } },
    [h("path", { key: "p", d, fill: "none", stroke: color || "hsla(320, 66%, 80%, 0.55)", strokeWidth: 1.6, strokeLinecap: "round" })],
  );
}

/** 记忆总数的环：进度 = 真实 live / total。 */
function memoryRing(memory, h) {
  const total = asCount(memory.total);
  const live = asCount(memory.live);
  const ratio = total > 0 ? clampNum(live / total, 0, 1) : 0;
  const R = 26;
  const CIRC = 2 * Math.PI * R;
  const uid = "ring" + hash32(total + ":" + live).toString(36);
  return h("svg", { key: "ring", width: 66, height: 66, viewBox: "0 0 66 66", style: { flex: "none" } }, [
    h("defs", { key: "d" }, [
      h("linearGradient", { key: "g", id: uid, x1: "0", y1: "0", x2: "1", y2: "1" }, [
        h("stop", { key: "a", offset: "0", stopColor: "hsl(320, 68%, 76%)" }),
        h("stop", { key: "b", offset: "1", stopColor: "hsl(265, 64%, 76%)" }),
      ]),
    ]),
    h("circle", { key: "track", cx: 33, cy: 33, r: R, fill: "none", stroke: "rgba(127,127,127,0.28)", strokeWidth: 5 }),
    h("circle", {
      key: "glow",
      cx: 33,
      cy: 33,
      r: R,
      fill: "none",
      stroke: "url(#" + uid + ")",
      strokeWidth: 9,
      strokeLinecap: "round",
      strokeDasharray: String(CIRC),
      strokeDashoffset: String(CIRC * (1 - ratio)),
      transform: "rotate(-90 33 33)",
      opacity: total > 0 ? 0.2 : 0.08,
    }),
    h("circle", {
      key: "prog",
      cx: 33,
      cy: 33,
      r: R,
      fill: "none",
      stroke: "url(#" + uid + ")",
      strokeWidth: 5,
      strokeLinecap: "round",
      strokeDasharray: String(CIRC),
      strokeDashoffset: String(CIRC * (1 - ratio)),
      transform: "rotate(-90 33 33)",
      opacity: total > 0 ? 1 : 0.3,
    }),
    h("text", { key: "t", x: 33, y: 37, textAnchor: "middle", fontSize: 11, fontWeight: 600, fill: C.text2 }, total > 0 ? Math.round(ratio * 100) + "%" : "—"),
  ]);
}

/* ------------------------------------------------------------- 操作入口 */
const TIER_CHOICES = ["hot", "cold", "persona", "state"];
const TIER_TEXT = { hot: "热", cold: "冷", persona: "人格", state: "状态" };
const ACTION_TIMEOUT_MS = 8000;
const FORGET_CONFIRM_MS = 3000;
const EMPTY_CAPTURE = {
  status: "unknown", // unknown | ready | sending | failed
  default: true,
  session: { id: null, enabled: true, overridden: false },
  sessions: [],
  note: "",
};
const EMPTY_ACTIONS = { query: "", rows: [], rowStatus: {}, confirmingId: "", searchStatus: null, capture: EMPTY_CAPTURE };
/** 星图初始态：idle 表示「还没问过宿主」，切到星图页才发第一次 universe。 */
const EMPTY_STARMAP = { status: "idle" };

/**
 * 唯一的写入出口。两个必带请求头缺一个宿主就 400，所以这里写死；
 * 非 2xx 也把 body 解开拿人话，任何异常都转成 {ok:false,error}，不抛给 UI。
 */
async function postAction(payload, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { ok: false, error: "当前环境没有 fetch" };
  let timer = null;
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), ACTION_TIMEOUT_MS);
    const response = await doFetch(PANEL_PATH, {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      headers: { "content-type": "application/json", "x-dsh-mnemos": "1", accept: "application/json" },
      body: JSON.stringify(payload || {}),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, error: "响应不是 JSON", status: response.status };
    }
    if (!response.ok) {
      const error = body && typeof body.error === "string" ? body.error : "HTTP " + String(response.status);
      return { ok: false, error, status: response.status, code: body && body.code };
    }
    return body && typeof body === "object" ? body : { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- 会话级开关 */
const CAPTURE_TEXT = { on: "记忆 · 开", off: "记忆 · 关", unknown: "记忆 …", failed: "记忆 · 失败" };

const captureSubscribers = new Set();
function subscribeCapture(fn) {
  if (typeof fn === "function") captureSubscribers.add(fn);
}
function unsubscribeCapture(fn) {
  captureSubscribers.delete(fn);
}
function emitCapture(snapshot) {
  for (const fn of Array.from(captureSubscribers)) {
    try {
      fn(snapshot);
    } catch {
      /* 订阅者自己炸了不影响别人 */
    }
  }
}

/** 找某个会话在 capture 里的条目：先看会话表，再看宿主认为的活跃会话。 */
function findCaptureEntry(capture, sessionId) {
  const s = asObject(capture);
  if (typeof sessionId === "string" && sessionId) {
    const list = asList(s.sessions);
    for (let i = 0; i < list.length; i += 1) if (list[i] && list[i].id === sessionId) return list[i];
    const active = asObject(s.session);
    if (active.id === sessionId) return active;
    return null;
  }
  const active = asObject(s.session);
  return active.id ? active : null;
}

function defaultLabel(on) {
  return "记忆 · 默认（" + (on ? "开" : "关") + "）";
}

/**
 * 三态文案：覆盖开/覆盖关/跟随默认；未知与失败另有文案。
 * 返回值里的 effective 是这一下点击要翻转的“当前有效值”。
 */
function captureDisplay(capture, sessionId) {
  const s = asObject(capture);
  if (s.status === "failed") return { text: CAPTURE_TEXT.failed, dot: C.danger, effective: false, overridden: false, known: false };
  if (s.status !== "ready") return { text: CAPTURE_TEXT.unknown, dot: C.dim, effective: false, overridden: false, known: false };
  const fallback = s.default !== false;
  const entry = findCaptureEntry(s, sessionId);
  if (!entry) return { text: defaultLabel(fallback), dot: C.dim, effective: fallback, overridden: false, known: true };
  const on = entry.enabled !== false;
  if (entry.overridden) return { text: on ? CAPTURE_TEXT.on : CAPTURE_TEXT.off, dot: on ? C.pink : C.dim, effective: on, overridden: true, known: true };
  return { text: defaultLabel(on), dot: C.dim, effective: on, overridden: false, known: true };
}

function captureDotColor(state) {
  const s = asObject(state);
  if (s.status === "failed") return "hsl(6, 72%, 72%)";
  if (s.status === "unknown" || s.status === "sending") return C.dim;
  return s.enabled ? C.pink : C.dim;
}

/** 全局默认那枚开关的显示态。 */
function globalDisplay(capture) {
  const s = asObject(capture);
  if (s.status === "failed") return { text: CAPTURE_TEXT.failed, dot: C.danger, effective: false, known: false };
  if (s.status !== "ready") return { text: CAPTURE_TEXT.unknown, dot: C.dim, effective: false, known: false };
  const on = s.default !== false;
  return { text: on ? CAPTURE_TEXT.on : CAPTURE_TEXT.off, dot: on ? C.pink : C.dim, effective: on, known: true };
}

/** 会话行的状态文案：覆盖 or 跟随默认。 */
function sessionStateText(capture, sessionId) {
  const view = captureDisplay(asObject(capture), sessionId);
  if (!view.known) return "未知";
  if (view.overridden) return view.effective ? "开（覆盖）" : "关（覆盖）";
  return "跟随默认（" + (view.effective ? "开" : "关") + "）";
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 10 ? s.slice(0, 8) + "…" : s;
}

/** 会话列表行里的小开关：开 / 关 / 默认。 */
function renderSessionSwitch(capture, sessionId, onToggle, h) {
  const view = captureDisplay(asObject(capture), sessionId);
  const text = !view.known ? "…" : view.overridden ? (view.effective ? "开" : "关") : "默认";
  return h(
    "button",
    {
      key: "sw-" + sessionId,
      type: "button",
      "aria-pressed": view.known ? Boolean(view.effective) : false,
      title: "切换这个会话的记忆开关",
      onClick: () => {
        if (typeof onToggle === "function") onToggle(sessionId);
      },
      style: S.miniBtn,
    },
    text,
  );
}

/**
 * 「跟随默认」= 清除这个会话的单独设置。只在 overridden === true 时由调用方渲染，
 * 所以不会出现"点了没反应"的死按钮。
 */
function renderClearOverride(sessionId, onClear, h) {
  return h(
    "button",
    {
      key: "clr-" + sessionId,
      type: "button",
      title: "清除这个会话的单独设置，回到全局默认",
      onClick: () => {
        if (typeof onClear === "function") onClear(sessionId);
      },
      style: S.miniBtn,
    },
    "跟随默认",
  );
}

/** POST 成功后把返回值并进本地快照：不额外再打一次 GET。 */
function applyCaptureResult(base, res, body) {
  const next = {
    status: "ready",
    default: base.default !== false,
    session: Object.assign({}, asObject(base.session)),
    sessions: asList(base.sessions).map((row) => Object.assign({}, row)),
    note: "",
  };
  const enabled = res && typeof res.enabled === "boolean" ? res.enabled : null;
  if (body && body.scope === "session" && typeof body.sessionId === "string") {
    const id = body.sessionId;
    const entry = { id, enabled: enabled === null ? next.default : enabled, overridden: enabled !== null, at: Date.now() };
    const at = next.sessions.findIndex((row) => row.id === id);
    if (at >= 0) next.sessions[at] = entry;
    else next.sessions.unshift(entry);
    if (next.session.id === id) {
      next.session.enabled = entry.enabled;
      next.session.overridden = entry.overridden;
    }
  } else {
    if (enabled !== null) next.default = enabled;
    next.sessions = next.sessions.map((row) => (row.overridden ? row : Object.assign({}, row, { enabled: next.default })));
    if (!next.session.overridden) next.session.enabled = next.default;
  }
  return next;
}

/** 老接口：只要文案。 */
function captureLabel(capture) {
  return captureDisplay(capture, "").text;
}

/**
 * 同一枚开关：opts.scope === "global" 显示全局默认，否则显示 opts.sessionId 那个会话。
 * onToggle 收到 "global" 或具体 sessionId，由调用方决定发什么 POST。
 */
function renderCapturePill(capture, onToggle, h, opts) {
  const o = asObject(opts);
  const globalScope = o.scope === "global";
  const sessionId = globalScope ? "" : typeof o.sessionId === "string" ? o.sessionId : "";
  const s = asObject(capture);
  const view = globalScope ? globalDisplay(s) : captureDisplay(s, sessionId);
  return h(
    "button",
    {
      key: "capture",
      type: "button",
      "aria-pressed": view.known ? Boolean(view.effective) : false,
      title: s.status === "failed" ? String(s.note || "切换失败") : globalScope ? "新会话的默认值" : "这个会话要不要记进长期记忆",
      onClick: () => {
        if (typeof onToggle === "function") onToggle(globalScope ? "global" : sessionId);
      },
      style: S.pill,
    },
    [
      h("span", { key: "d", style: Object.assign({}, S.pillDot, { background: view.dot }) }),
      h("span", { key: "t" }, view.text),
    ],
  );
}

/**
 * 「操作」卡：纯渲染，状态与回调都由调用方给，所以没有 hooks 也能画出静态态。
 * 失败只写行内状态，绝不把 rows 清空。
 */
function renderActionsCard(state, handlers, h) {
  const s = asObject(state);
  const on = asObject(handlers);
  const rows = asList(s.rows);
  const rowStatus = asObject(s.rowStatus);
  const confirming = typeof s.confirmingId === "string" ? s.confirmingId : "";
  const call = (name, ...args) => {
    if (typeof on[name] === "function") on[name](...args);
  };

  const searchRow = h("div", { key: "search", style: S.actSearch }, [
    h("input", {
      key: "q",
      type: "search",
      value: typeof s.query === "string" ? s.query : "",
      placeholder: "搜一条记忆…",
      "aria-label": "搜索记忆",
      onChange: (e) => call("onQuery", e && e.target ? e.target.value : ""),
      onKeyDown: (e) => {
        if (e && e.key === "Enter") call("onSearch");
      },
      style: S.input,
    }),
    h("button", { key: "go", type: "button", onClick: () => call("onSearch"), style: S.btn }, "搜索"),
  ]);

  const status = asObject(s.searchStatus);
  const statusLine = status.text
    ? h("div", { key: "st", style: status.state === "error" ? S.actErr : S.note }, String(status.text))
    : null;

  const rowNodes = rows.map((row, i) => {
    const id = String(row.id || "");
    const st = asObject(rowStatus[id]);
    return h("div", { key: "row-" + (id || i), style: S.actRow }, [
      h("div", { key: "line", style: S.actLine }, [
        h("span", { key: "sc", style: S.actScore }, Number(row.score || 0).toFixed(2)),
        h("span", { key: "tx", style: S.actText, title: String(row.text || "") }, String(row.text || "")),
        h("span", { key: "tier", style: S.actTier }, TIER_TEXT[row.tier] || "热"),
        row.pinned ? h("span", { key: "pin", style: S.actPin }, "已钉") : null,
      ]),
      h("div", { key: "ops", style: S.actOps }, [
        h("button", { key: "pin", type: "button", onClick: () => call("onPin", row), style: S.miniBtn }, row.pinned ? "取消钉住" : "钉住"),
        h(
          "select",
          {
            key: "tier",
            value: TIER_CHOICES.indexOf(String(row.tier)) >= 0 ? String(row.tier) : "hot",
            onChange: (e) => call("onTier", row, e && e.target ? e.target.value : "hot"),
            "aria-label": "改层",
            style: S.miniSelect,
          },
          TIER_CHOICES.map((t) => h("option", { key: t, value: t }, TIER_TEXT[t])),
        ),
        h(
          "button",
          { key: "forget", type: "button", onClick: () => call("onForget", row), style: confirming === id ? S.dangerBtn : S.miniBtn },
          confirming === id ? "确认忘记？" : "忘记",
        ),
      ]),
      st.text ? h("div", { key: "st", style: st.state === "error" ? S.actErr : S.actOk }, String(st.text)) : null,
    ]);
  });

  const body = rows.length ? rowNodes : [h("div", { key: "none", style: S.soft }, "输入关键词回车搜索；这里只列命中的前 8 条。")];

  const capture = asObject(s.capture);
  const errors = asObject(s.captureErrors);
  const active = asObject(capture.session);
  const sessionRows = asList(capture.sessions);
  const captureRows = [
    h("div", { key: "cap-global", style: S.captureRow }, [
      renderCapturePill(capture, on.onCaptureToggle, h, { scope: "global" }),
      h("span", { key: "hint", style: { fontSize: 11, color: C.text3 } }, "新会话的默认值"),
    ]),
    active.id
      ? h("div", { key: "cap-session", style: { display: "flex", flexDirection: "column", gap: 4 } }, [
          h("div", { key: "l", style: S.captureRow }, [
            h("span", { key: "t", style: { flex: 1, fontSize: 11.5, color: C.text2 } }, "本会话：" + sessionStateText(capture, active.id) + " · " + shortId(active.id)),
            active.overridden === true ? renderClearOverride(active.id, on.onCaptureClear, h) : null,
            h("button", { key: "b", type: "button", style: S.miniBtn, onClick: () => on.onCaptureToggle && on.onCaptureToggle(active.id) }, "改本会话"),
          ]),
          asObject(errors)[active.id] ? h("div", { key: "e", style: S.actErr }, String(errors[active.id])) : null,
        ])
      : null,
    sessionRows.length
      ? h(
          "div",
          { key: "cap-list", style: { display: "flex", flexDirection: "column", gap: 6 } },
          [h("div", { key: "t", style: { fontSize: 11, color: C.text3 } }, "最近的会话")].concat(
            sessionRows.slice(0, 20).map((row, i) =>
              h("div", { key: "row" + i, style: { display: "flex", flexDirection: "column", gap: 3 } }, [
                h("div", { key: "l", style: { display: "flex", alignItems: "center", gap: 8 } }, [
                  h("span", { key: "id", style: { fontSize: 11, color: C.text3, fontVariantNumeric: "tabular-nums", minWidth: 64 } }, shortId(row.id)),
                  h("span", { key: "st", style: { flex: 1, fontSize: 11, color: C.text2 } }, sessionStateText(capture, row.id)),
                  row.overridden === true ? renderClearOverride(row.id, on.onCaptureClear, h) : null,
                  renderSessionSwitch(capture, row.id, on.onCaptureToggle, h),
                ]),
                asObject(errors)[row.id] ? h("div", { key: "e", style: S.actErr }, String(errors[row.id])) : null,
              ]),
            ),
          ),
        )
      : null,
  ];

  return h("section", { key: "actions", style: S.cardLight }, [headRow(h, "actions", "操作")].concat(captureRows, [searchRow, statusLine], body));
}

/* ------------------------------------------------------------ 视图模型 */
function buildViewModel(input) {
  const source = asObject(input);
  const stats = asObject(source.stats);
  const budget = asObject(source.budget);
  const vector = asObject(source.vector);
  const degraded = [];

  const byTier = countMap(stats.byTier);
  const byKind = countMap(stats.byKind);
  const total = asCount(stats.count) || Object.keys(byTier).reduce((a, k) => a + byTier[k], 0);

  const vectorState = typeof vector.state === "string" ? vector.state : "unknown";
  const vectorReason = typeof vector.reason === "string" ? vector.reason : null;
  if (vectorState !== "on") degraded.push("vector-" + (vectorReason || vectorState));

  const usedTokens = asCount(budget.tokens);
  const budgetTokens = asCount(budget.budget);
  if (budgetTokens && usedTokens > budgetTokens) degraded.push("budget-overflow");

  const recalls = asList(source.recalls).slice(0, RECALL_LIMIT).map((row) => {
    const entry = asObject(row);
    const record = asObject(entry.record);
    // 两种形状都认：宿主路由发扁平 {id, text, score}（index.mjs:288-292），rank 的原始行是 {record, score}
    const text = typeof record.text === "string" ? record.text : typeof entry.text === "string" ? entry.text : "";
    const id = typeof record.id === "string" ? record.id : typeof entry.id === "string" ? entry.id : "";
    return {
      id,
      kind: typeof record.kind === "string" ? record.kind : "unknown",
      tier: typeof record.tier === "string" ? record.tier : "unknown",
      snippet: snippet(text, 48),
      score: Number.isFinite(entry.score) ? Math.round(entry.score * 1000) / 1000 : 0,
    };
  });

  return {
    schema: 1,
    ok: source.ok !== false,
    memory: { total, live: asCount(stats.live) || total, merged: asCount(stats.merged), byKind, byTier },
    tiers: TIER_ORDER.map((tier) => ({
      tier,
      label: TIER_LABELS[tier],
      short: TIER_SHORT[tier],
      count: byTier[tier] || 0,
      pct: total > 0 ? clampNum((byTier[tier] || 0) / total, 0, 1) : 0,
    })),
    budget: {
      usedTokens,
      budgetTokens,
      ratio: budgetTokens ? Math.min(1, usedTokens / budgetTokens) : null,
      picked: Number.isFinite(budget.picks) ? Math.max(0, Math.floor(budget.picks)) : asList(budget.picks).length,
      dropped: asList(budget.dropped).length,
    },
    vector: { state: vectorState, reason: vectorReason, label: VECTOR_LABELS[vectorState] || "未知状态", usable: vectorState === "on" },
    // 会话级开关：enabled=这个会话要不要写记忆，default=全局默认
    // 全局默认 + 会话覆盖 + 最近见过的会话列表
    capture: {
      default: asObject(source.capture).default !== false,
      session: {
        id: typeof asObject(asObject(source.capture).session).id === "string" ? asObject(source.capture).session.id : null,
        enabled: asObject(asObject(source.capture).session).enabled !== false,
        overridden: asObject(asObject(source.capture).session).overridden === true,
      },
      sessions: asList(asObject(source.capture).sessions)
        .slice(0, 20)
        .map((row) => ({
          id: String(asObject(row).id || ""),
          enabled: asObject(row).enabled !== false,
          overridden: asObject(row).overridden === true,
          at: Number.isFinite(asObject(row).at) ? asObject(row).at : 0,
        }))
        .filter((row) => row.id),
    },
    recalls,
    storage: {
      dataDir: typeof stats.dataDir === "string" ? stats.dataDir : null,
      lastSnapshotAt: Number.isFinite(stats.lastSnapshotAt) ? stats.lastSnapshotAt : null,
      warnings: asList(stats.warnings).map((w) => String(w)),
    },
    degraded,
  };
}

/** 纯文本版（CLI 兜底）：行为与之前完全一致，不动。 */
function formatViewModel(view) {
  const v = asObject(view);
  const memory = asObject(v.memory);
  const budget = asObject(v.budget);
  const vector = asObject(v.vector);
  const lines = ["记忆数：" + asCount(memory.total) + "（有效 " + asCount(memory.live) + " / 已合并 " + asCount(memory.merged) + "）"];
  for (const row of asList(v.tiers)) lines.push("  " + row.label + "：" + asCount(row.count));
  const ratio = budget.ratio;
  lines.push(
    "预算：" + asCount(budget.usedTokens) + (asCount(budget.budgetTokens) ? " / " + asCount(budget.budgetTokens) : "") +
      (typeof ratio === "number" ? "（" + Math.round(ratio * 100) + "%）" : "（未设上限）"),
  );
  lines.push("向量通道：" + String(vector.label || "未知") + (vector.reason ? " [" + vector.reason + "]" : ""));
  const recalls = asList(v.recalls);
  if (!recalls.length) lines.push("最近召回：（无）");
  else {
    lines.push("最近召回：");
    for (const row of recalls) lines.push("  " + row.id + "  " + row.score + "  " + row.snippet);
  }
  if (asList(v.degraded).length) lines.push("降级项：" + v.degraded.join(", "));
  return lines;
}

/** 机器原因翻人话：面板上不该出现 provider-none 这种词。 */
function vectorReasonText(vector) {
  const state = String(asObject(vector).state || "unknown");
  const reason = String(asObject(vector).reason || "");
  if (state === "on") return "通道就绪，召回会同时用上向量相似度";
  if (!reason) return state === "off" ? "没有开启向量通道" : "原因未知";
  const fixed = {
    "provider-none": "未配置向量通道",
    "disabled-by-config": "已在配置里关闭",
    unavailable: "宿主没有提供向量通道",
    "status-failed": "状态探测失败",
    "local:no-model-path": "没有指定本地模型路径",
    "local:runtime-unavailable": "本机推理器未就绪",
    "local:model-not-found": "本地模型文件不存在",
    "api:no-endpoint": "没有配置接口地址",
  };
  if (fixed[reason]) return fixed[reason];
  if (reason.indexOf("api:no-api-key:") === 0) return "缺少密钥（环境变量 " + reason.slice(15) + "）";
  if (reason.indexOf("unknown-provider:") === 0) return "未知的通道类型 " + reason.slice(17);
  return reason;
}

function vectorColor(state) {
  if (state === "on") return C.green;
  if (state === "off") return C.dim;
  return C.amber;
}
function tierColor(tier) {
  if (tier === "hot") return C.pink;
  if (tier === "cold") return C.purple;
  if (tier === "persona") return C.green;
  return C.amber;
}

/* ----------------------------------------------------------- 卡片与渲染 */
function headRow(h, iconName, title) {
  return h("div", { key: "head", style: S.head }, [icon(iconName, h, 18), h("span", { key: "t", style: S.title }, title)]);
}

function heroCard(view, h) {
  const memory = asObject(view.memory);
  const total = asCount(memory.total);
  const legendRows = asList(view.tiers).map((row) =>
    h("div", { key: "lg-" + row.tier, style: S.legendItem }, [
      h("span", { key: "d", style: dotStyle(tierColor(row.tier)) }),
      h("span", { key: "n" }, String(row.short || row.label)),
      h("span", { key: "c", style: asCount(row.count) > 0 ? S.legendCount : S.legendCountDim }, String(asCount(row.count))),
    ]),
  );

  return h("section", { key: "hero", style: S.hero }, [
    handBorder(h, "hero-frame"),
    headRow(h, "memory", "记忆总数"),
    h("div", { key: "row", style: S.heroRow }, [
      memoryRing(memory, h),
      h("div", { key: "num", style: { display: "flex", flexDirection: "column", gap: 1, position: "relative" } }, [
        h("div", { key: "v", style: S.big }, [fmt(total), h("span", { key: "u", style: S.unit }, " 条")]),
        wavyUnderline(h, 66),
      ]),
      h("div", { key: "lg", style: S.legend }, legendRows),
    ]),
    h("div", { key: "meta", style: S.note }, "有效 " + fmt(memory.live) + " · 已合并 " + fmt(memory.merged) + (total === 0 ? " · 还没有存下任何记忆。" : "")),
  ]);
}

function tiersCard(view, h) {
  const total = asCount(asObject(view.memory).total);
  const rows = asList(view.tiers).map((row) => {
    const count = asCount(row.count);
    const pct = total > 0 ? (count / total) * 100 : 0;
    return h("div", { key: "tier-" + row.tier, style: S.row }, [
      h("span", { key: "l", style: count > 0 ? S.type : S.typeDim }, String(row.label)),
      h("div", { key: "track", style: count > 0 ? S.track : S.trackZero }, [h("div", { key: "fill", style: fillBar(pct, 0.1 + 0.2 * (1 - (count / Math.max(1, total)))) })]),
      h("span", { key: "c", style: count > 0 ? S.count : S.countDim }, String(count)),
    ]);
  });
  return h("section", { key: "tiers", style: S.card }, [headRow(h, "tiers", "分层分布"), ...rows]);
}

function budgetCard(view, h) {
  const budget = asObject(view.budget);
  const cap = asCount(budget.budgetTokens);
  const used = asCount(budget.usedTokens);
  const pct = cap > 0 ? Math.round(clampNum(used / cap, 0, 1) * 100) : 0;
  // 三行主结构：标题行（右侧直接给数值）-> 进度条 -> 刻度行 -> 一行汇总。单独那行 token 文本已删。
  const value = cap > 0 ? fmt(used) + " / " + fmt(cap) + "（" + pct + "%）" : "本会话尚未装配";
  return h("section", { key: "budget", style: S.card }, [
    h("div", { key: "head", style: S.head }, [
      icon("budget", h, 18),
      h("span", { key: "t", style: S.title }, "本会话注入预算"),
      h("span", { key: "v", style: { marginLeft: "auto", fontSize: 12.5, color: cap > 0 ? C.text1 : C.text3 } }, value),
    ]),
    // S.track 自带 flex:1（给分层卡的横向 flex 用）；这里的父级是纵向 flex，flex-basis:0% 会把它压成 0 高，必须显式 flex:none。
    h("div", { key: "track", style: { ...S.track, flex: "none", height: 8 } }, [h("div", { key: "fill", style: fillBar(pct, 0.2) })]),
    cap > 0
      ? h("div", { key: "ticks", style: S.tickRow }, [
          h("span", { key: "a", style: { textAlign: "left" } }, "0"),
          h("span", { key: "b", style: { textAlign: "center" } }, "50%"),
          h("span", { key: "c", style: { textAlign: "right" } }, "100%"),
        ])
      : null,
    h("div", { key: "sum", style: { fontSize: 12.5, color: C.text2 } }, "入选 " + fmt(budget.picked) + " · 被裁 " + fmt(budget.dropped)),
  ]);
}

function vectorCard(view, h) {
  const vector = asObject(view.vector);
  const color = vectorColor(String(vector.state));
  const tint =
    vector.state === "on" ? "hsla(158, 46%, 70%, 0.14)" : vector.state === "off" ? "rgba(127,127,127,0.12)" : "hsla(38, 64%, 72%, 0.13)";
  return h("section", { key: "vector", style: S.cardLight }, [
    headRow(h, "vector", "向量通道"),
    h("div", { key: "chip", style: { display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 7, padding: "3px 11px", borderRadius: 999, background: tint, border: "1px solid " + color + "55" } }, [
      h("span", { key: "d", style: dotStyle(color) }),
      h("span", { key: "s", style: S.vectorState }, String(vector.state === "on" ? "可用" : vector.state === "off" ? "已关闭" : "降级运行")),
    ]),
    h("div", { key: "why", style: S.soft }, vectorReasonText(vector)),
  ]);
}

function recallsCard(view, h) {
  const recalls = asList(view.recalls);
  const rows = recalls.length
    ? recalls.map((row, i) =>
        h("div", { key: "r" + i, style: S.recall }, [
          h("span", { key: "b", style: S.badge }, Number(row.score || 0).toFixed(2)),
          h("span", { key: "t", style: S.recallText }, String(row.snippet || "（这条记忆没有正文）")),
        ]),
      )
    : [h("div", { key: "none", style: S.soft }, "这段关系还很安静，暂时没有需要回想的时刻。")];
  return h("section", { key: "recalls", style: S.cardLight }, [headRow(h, "recalls", "最近 " + RECALL_LIMIT + " 条召回"), ...rows]);
}

function unavailableCard(reason, h) {
  return h("section", { key: "unavailable", style: S.warn }, [
    h("div", { key: "head", style: S.head }, [icon("unplugged", h, 22, C.amber), h("span", { key: "t", style: { fontSize: 13, fontWeight: 600, color: C.amber } }, "暂时连不上记忆")]),
    h("div", { key: "reason", style: { fontSize: 13, color: C.text1, wordBreak: "break-word" } }, "不可用：" + reason),
    h("div", { key: "note", style: S.soft }, "面板不会写入任何数据。也可能是只读路由还没挂上，或者你不是从本机打开的设置页。"),
  ]);
}

/**
 * 视图模型 -> 元素树。h 由调用方注入（React.createElement / 测试桩 / 预览脚本）。
 * 节奏：星幕（主角）-> 手绘首卡（重）-> 分层（中）-> 预算（中）-> 向量、召回（轻）。
 */
/** 概览页 = 原来的那一屏（星幕 + 五张卡 + 只读页脚），顺序与样式一字未改。 */
function renderOverview(view, h, actionsState, handlers) {
  const v = asObject(view);
  const memory = asObject(v.memory);
  return [
    skyField(memory.byTier, asCount(memory.total), h),
    heroCard({ ...v, memory }, h),
    tiersCard(v, h),
    budgetCard(v, h),
    vectorCard(v, h),
    recallsCard(v, h),
    renderActionsCard(actionsState === undefined ? EMPTY_ACTIONS : actionsState, handlers, h),
    // 面板不再只读：写入只发生在用户按下的动作里，这句承诺跟着改。
    h("div", { key: "readonly", style: { fontSize: 11.5, color: C.text3, textAlign: "center", padding: "2px 0 0" } }, "本机面板 · 只有你按下的操作才会落库"),
  ];
}

/** 顶部两段控件。纯本地状态：点一下只切页，不发请求、不写任何东西。 */
function renderSegments(active, onSelect, h) {
  const seg = (key, label) =>
    h(
      "button",
      {
        key: "seg-" + key,
        type: "button",
        "aria-pressed": active === key,
        onClick: () => {
          if (typeof onSelect === "function") onSelect(key);
        },
        style: active === key ? S.segOn : S.segOff,
      },
      label,
    );
  return h("div", { key: "segments", role: "tablist", style: S.segGroup }, [seg("overview", "概览"), seg("starmap", "星图"), seg("about", "说明")]);
}

/** 说明页：只用面板已有的小标题 + 正文排版，不新造一套组件风格。 */
function renderAbout(h) {
  const section = (key, title, lines) =>
    h("section", { key, style: S.cardLight }, [
      h("div", { key: "t", style: S.title }, title),
    ].concat(lines.map((line, i) => h("div", { key: "l" + i, style: S.prose }, line))));
  const entry = (key, name, text) =>
    h("div", { key, style: S.entry }, [
      h("span", { key: "n", style: S.entryTitle }, name),
      h("span", { key: "d", style: S.prose }, text),
    ]);

  return [
    section("about-what", "这块面板是什么", [
      "「她记得的东西」的视图。数据全部在你本机的 profile 目录里，不会外发；你可以在这里搜索、钉住、改层或忘记，改动只影响这台机器。",
    ]),
    section("about-how", "它怎么工作", [
      "1. 对话里值得留下的内容，被写成一条记录。",
      "2. 记录按热度与权重归并，重复的合并成一条。",
      "3. 每轮只挑少量相关的记忆带回上下文，其余留在库里。",
    ]),
    h("section", { key: "about-blocks", style: S.cardLight }, [
      h("div", { key: "t", style: S.title }, "每一块是什么"),
      entry("b-sky", "星幕", "每颗星是一部分记忆，半径按该层的条数映射——星多星大，说明那层记得多。全 0 时是几颗待点亮的暗星。"),
      entry("b-total", "记忆总数", "总条数。「有效」是还没被合并掉的；「已合并」是被并进别的记录、但仍能检索到的。"),
      entry("b-tiers", "分层分布", "热记忆在写入与启动时各扫一次：满 30 天、未钉住、未被显式指定、热度低于 0.35 就降为冷记忆（没有后台定时器）。冷记忆不参与年代衰减，但整体乘 0.75；被再次提及会回到热记忆。人格前提与当前状态只能显式指定，不参与时间衰减，也不会被自动降级。"),
      entry("b-budget", "本会话注入预算", "每轮最多带多少 token 的记忆进上下文，上限＝人设/状态段 1200 + 召回与提示 600。「入选」是被带上的，「被裁」是被预算挡下的。"),
      entry("b-vector", "向量通道", "可用 / 已关闭 / 降级运行三态，下面是原因。它只是可选增强，关掉也能靠关键词与线索检索。"),
      entry("b-recalls", "最近 5 条召回", "这一轮真正被想起来的记忆与分数。分数只用于排序，不代表重要程度。"),
    ]),
    section("about-ops", "能不能改", [
      "能：搜索、钉住 / 取消钉住、改层、忘记；忘记是两步确认，3 秒内再点才真删。",
      "这是本机面板：非本机地址访问会被直接拒绝，所以这些操作只在你自己的机器上生效。",
    ]),
    section("about-capture", "要不要记进长期记忆", [
      "全局是默认值；每个会话可以单独覆盖，胶囊改的就是你当前这个会话。首屏、输入框、设置页三处同步。",
      "胶囊显示「记忆 · 开 / 关」＝这个会话被单独设过；「记忆 · 默认（开 / 关）」＝它跟随全局默认。设置页还能看到最近的会话列表，逐个改。",
      "关掉只影响之后的写入：已经记住的一条都不删，检索与注入照旧；再打开就继续记。状态存在本机（capture.json）。",
      "会话行上的「跟随默认」＝清除这个会话的单独设置，回到全局默认；没设过的会话不显示这个按钮。",
      "另外，工具清单、子代理回报、工作上下文这类系统内容不会被写进记忆；被挡下的条数在 /mem status 的「已过滤」一行。",
    ]),
    section("about-privacy", "隐私与只读", [
      "数据在 profile 目录下的 dsh-mnemos（或你配置的 dataDir）。",
      "面板只对 /.dsh-mnemos/panel 发请求：看数据用 GET，写入只在你按下按钮时发生（POST），不改配置。",
      "想删某条记忆，用 /mem forget <id>。",
    ]),
  ];
}

/* --------------------------------------------------------------- 星图 */

/** valence -> 色相：正=暖橙 28°，负=冷蓝 215°，接近 0 落在灰青 190°。 */
function starHue(valence) {
  const v = clampNum(valence, -1, 1);
  return Math.round(v >= 0 ? 190 - 162 * v : 190 + 25 * -v);
}
/** 饱和度随 |valence| 上升：情绪淡就接近灰，情绪浓才认得出颜色。 */
function starSat(valence) {
  return Math.round(14 + 46 * Math.abs(clampNum(valence, -1, 1)));
}
/** 大小按正文长度对数压缩，再乘权重：文字越多越大，但不让一条长文撑爆画面。 */
function starRadius(star) {
  const s = asObject(star);
  const text = typeof s.text === "string" ? s.text.length : 0;
  const weight = clampNum(s.weight, 0, 1);
  const base = (2 + Math.min(9, Math.log10(1 + text) * 4.4) * 1.6) * (0.85 + 0.3 * weight);
  return Math.round(clampNum(base, STARMAP.R_MIN, STARMAP.R_MAX) * 10) / 10;
}
/**
 * arousal 0.3 是「平常」（0.55），1.0 是「很亮」（1.0），0 是昏暗但看得见（0.30）。
 * 和空位星的分辨不靠 alpha（空位是 0.20~0.30，会重叠），靠 r 与 sat。
 */
function starAlpha(arousal) {
  const k = clampNum((clampNum(arousal, 0, 1) - 0.3) / 0.7, -1, 1);
  // 地板 0.5 而不是 0.3：最平淡的真实记忆乘上 DEPTH_MIN 0.68 也有 0.34，
  // 永远明显亮于空位的 0.20~0.30 —— 真实星不会被误看成「未点亮」。
  return Math.round(clampNum(0.55 + 0.45 * k, 0.5, 1) * 100) / 100;
}
/** 呼吸相位取自 id：同一颗星每次都停在同一个相位上，截图与测试才可复现。 */
function starPhase(id) {
  return Math.round(((hash32(String(id)) % 6283) / 1000) * 1000) / 1000;
}

/**
 * 空位数量：记忆少的时候补一层「还没点亮」的空位星，免得一片空。
 * 16 条真实记忆时满 44 个，越多越少，60 条起归零——只看条数，可复现。
 */
function unlitCount(realStars) {
  const real = asCount(realStars);
  return Math.round(clampNum(STARMAP.UNLIT_MAX - Math.max(0, real - STARMAP.UNLIT_BASE), 0, STARMAP.UNLIT_MAX));
}

/**
 * 空位星的形状：更小、更暗、灰蓝、不连线。全部由 hash32(索引) 定，
 * 不用随机数，所以同一份数据每次摆在同一处。
 */
function unlitStars(count) {
  const n = Math.round(clampNum(count, 0, STARMAP.UNLIT_MAX));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const jitter = hash32("unlit:" + i);
    out.push({
      id: "unlit-" + i,
      r: Math.round((1.2 + ((jitter >>> 3) % 11) / 10) * 10) / 10,
      alpha: Math.round((0.2 + ((jitter >>> 7) % 11) / 100) * 100) / 100,
      sat: 8 + ((jitter >>> 11) % 9),
      phase: ((jitter >>> 13) % 6283) / 1000,
    });
  }
  return out;
}

/** 这颗是不是空位：看 id 前缀，布局返回的 unlitIds 只放空位。 */
function starmapIsUnlit(layout, id) {
  const ids = layout && Array.isArray(layout.unlitIds) ? layout.unlitIds : [];
  return ids.indexOf(String(id || "")) >= 0;
}

/**
 * 校验宿主回包。形状不对就整页当失败——半份数据会画出半张真的星图，比不画更糟。
 * @param {object} body postAction 的返回体。
 */
function normalizeUniverse(body) {
  const payload = asObject(body);
  if (payload.ok === false) {
    return { status: "error", error: typeof payload.error === "string" && payload.error ? payload.error : "宿主返回失败" };
  }
  if (!Array.isArray(payload.stars) || !Array.isArray(payload.links)) {
    return { status: "error", error: "星图数据结构不对：缺少 stars / links" };
  }
  const stars = [];
  const known = new Set();
  for (const row of payload.stars) {
    const s = asObject(row);
    const id = typeof s.id === "string" || typeof s.id === "number" ? String(s.id) : "";
    if (!id || known.has(id)) continue;
    known.add(id);
    stars.push({
      id,
      text: typeof s.text === "string" ? s.text : "",
      kind: typeof s.kind === "string" ? s.kind : "",
      tier: typeof s.tier === "string" ? s.tier : "",
      weight: clampNum(s.weight, 0, 1),
      mentions: asCount(s.mentions),
      pinned: s.pinned === true,
      valence: Number.isFinite(Number(s.valence)) ? clampNum(s.valence, -1, 1) : 0,
      arousal: Number.isFinite(Number(s.arousal)) ? clampNum(s.arousal, 0, 1) : 0.3,
      at: Number.isFinite(Number(s.at)) ? Number(s.at) : 0,
      tags: asList(s.tags).filter((tag) => typeof tag === "string" && tag.trim()).slice(0, 3),
    });
  }
  // 线只留两端都在场上、且不是自连的对；无向，重复的并掉
  const links = [];
  const seen = new Set();
  for (const pair of payload.links) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = String(pair[0]);
    const b = String(pair[1]);
    if (a === b || !known.has(a) || !known.has(b)) continue;
    const key = a < b ? a + "|" + b : b + "|" + a;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push([a, b]);
  }
  return {
    status: stars.length ? "ready" : "empty",
    stars,
    links,
    total: asCount(payload.total) || stars.length,
    truncated: payload.truncated === true,
  };
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 每层占球壳的哪一段（外半径的比例）：人格前提与热记忆靠内，冷记忆靠外。 */
const STARMAP_BANDS = {
  persona: [0.02, 0.3],
  hot: [0.12, 0.62],
  state: [0.26, 0.8],
  cold: [0.45, 1],
};
function starmapBand(tier) {
  return STARMAP_BANDS[tier] || [0.4, 0.9];
}

/**
 * id 当 FNV-1a 种子，生成一个单位球面方向：同一颗星永远是同一个方向，重绘不乱跳。
 * 思路参考 dsh-xingxi (Yuuyuko-uu)。
 */
function starmapDirection(id) {
  let seed = hash32(String(id) || "star");
  const next = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const y = next() * 2 - 1;
  const angle = next() * TAU;
  const ring = Math.sqrt(Math.max(0, 1 - y * y));
  return { x: ring * Math.cos(angle), y: y, z: ring * Math.sin(angle) };
}

/**
 * 球面 -> 画布：先绕 Y 轴转，再按俯仰角压扁，最后做透视缩放，返回屏幕坐标与深度。
 * 思路参考 dsh-xingxi (Yuuyuko-uu)。
 */
function projectSphere(x, y, z, yaw, pitch, focusLen, w, hgt) {
  const c1 = Math.cos(yaw);
  const s1 = Math.sin(yaw);
  const x1 = x * c1 + z * s1;
  const z1 = -x * s1 + z * c1;
  const c2 = Math.cos(pitch);
  const s2 = Math.sin(pitch);
  const y2 = y * c2 - z1 * s2;
  const z2 = y * s2 + z1 * c2;
  const k = focusLen / (focusLen + z2);
  return { x: w / 2 + x1 * k, y: hgt / 2 + y2 * k, z: z2 };
}

/**
 * 立方根插值：半径按体积均匀铺开，不然点会全挤在球心附近。
 * 思路参考 dsh-xingxi (Yuuyuko-uu)。
 */
function shellRadius(rIn, rOut, t) {
  const k = clampNum(t, 0, 1);
  return Math.cbrt(rIn * rIn * rIn + (rOut * rOut * rOut - rIn * rIn * rIn) * k);
}

/**
 * 三维球壳布局：方向由 id 哈希定，所在层的半径区间由 tier 定，
 * 层内按时间从内到外铺开；钉住/人格前提里权重最高的一颗固定在原点当中心亮核。
 * 投影一次到画布坐标，深度压进 alpha 与 r（节点仍然只有那七个字段），
 * 深度另放 depth 数组给测试与焦点用。不用力导向，也不用随机数。
 */
function layoutUniverse(stars, rawLinks, width, height) {
  const w = width > 0 ? width : STARMAP.W;
  const hgt = height > 0 ? height : STARMAP.H;
  const list = asList(stars).filter((s) => s && s.id);
  const n = list.length;
  // 一条真实记忆都没有时是空状态页：那时不该补空位，也不该画空壳
  if (!n) return { nodes: [], ids: [], links: [], unlitIds: [], depth: [], anchor: -1 };
  const shell = Math.max(36, Math.min(w, hgt) * STARMAP.SHELL);
  const focusLen = shell * STARMAP.FOCUS_LEN;
  // 画布是宽的：球壳在横向拉一点，星图才不至于缩在中间一条
  const stretch = clampNum(w / hgt, 1, 1.6);

  const ids = new Array(n);
  const index = new Map();
  for (let i = 0; i < n; i += 1) {
    ids[i] = String(list[i].id);
    index.set(ids[i], i);
  }
  const links = [];
  for (const pair of asList(rawLinks)) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const a = index.get(String(pair[0]));
    const b = index.get(String(pair[1]));
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
  }

  // 锚点星：钉住的或人格前提里权重最高的一颗，坐在球心当核心
  let anchor = -1;
  for (let i = 0; i < n; i += 1) {
    const star = list[i];
    if (!(star.pinned === true || star.tier === "persona")) continue;
    if (anchor < 0 || clampNum(star.weight, 0, 1) > clampNum(list[anchor].weight, 0, 1)) anchor = i;
  }

  // 分层的成员：同层按时间从早到晚 -> 半径从内到外
  const groups = new Map();
  for (let i = 0; i < n; i += 1) {
    if (i === anchor) continue;
    const tier = typeof list[i].tier === "string" ? list[i].tier : "";
    if (!groups.has(tier)) groups.set(tier, []);
    groups.get(tier).push(i);
  }
  const radiusOf = new Float64Array(n);
  for (const [tier, members] of groups) {
    members.sort((a, b) => Number(list[a].at || 0) - Number(list[b].at || 0) || compareText(ids[a], ids[b]));
    const band = starmapBand(tier);
    const rIn = shell * band[0];
    const rOut = shell * band[1];
    const m = members.length;
    for (let k = 0; k < m; k += 1) {
      radiusOf[members[k]] = shellRadius(rIn, rOut, m === 1 ? 0.5 : k / (m - 1));
    }
  }

  // 每层权重最高的一颗放大一档（章首星）
  const champion = new Set();
  for (const [, members] of groups) {
    let best = -1;
    for (const i of members) {
      if (best < 0 || clampNum(list[i].weight, 0, 1) > clampNum(list[best].weight, 0, 1)) best = i;
    }
    if (best >= 0) champion.add(best);
  }

  const rawX = [];
  const rawY = [];
  const meta = [];
  const depth = [];
  for (let i = 0; i < n; i += 1) {
    const star = list[i];
    const dir = starmapDirection(ids[i]);
    const radius = i === anchor ? 0 : radiusOf[i];
    const at = projectSphere(dir.x * radius, dir.y * radius, dir.z * radius, 0, STARMAP.PITCH, focusLen, w, hgt);
    // far: 0 在最前，1 在最后。深度同时压 alpha 与半径
    const far = clampNum((at.z / shell + 1) / 2, 0, 1);
    const keep = 1 - (1 - STARMAP.DEPTH_MIN) * far;
    let r;
    let alpha;
    if (i === anchor) {
      r = Math.round((STARMAP.ANCHOR_BASE + STARMAP.ANCHOR_BONUS * clampNum(star.weight, 0, 1)) * 10) / 10;
      alpha = 1;
    } else {
      const size = starRadius(star) * (champion.has(i) ? STARMAP.CHAMPION : 1);
      // 下限 2.6：2.4 以下留给空位，绘制函数靠 r 与 sat 一眼分开两者
      r = Math.round(clampNum(size * keep, 2.6, STARMAP.R_MAX) * 10) / 10;
      alpha = Math.round(clampNum(starAlpha(star.arousal) * keep, 0.17, 1) * 100) / 100;
    }
    // 同一种情绪的星不能长得一模一样：用 id 哈希把饱和度抖 ±10%。
    // 明度不抖——它已经被「深度 × 情绪」占满，再抖就把「远=暗」这条语义搅浑了。
    const jitter = ((hash32(ids[i] + ":sat") % 21) - 10) / 100;
    rawX.push(w / 2 + (at.x - w / 2) * stretch);
    rawY.push(at.y);
    meta.push({
      r,
      hue: starHue(star.valence),
      sat: Math.round(clampNum(starSat(star.valence) * (1 + jitter), 0, 100)),
      alpha,
      phase: starPhase(ids[i]),
    });
    depth.push(Math.round(at.z * 100) / 100);
  }

  // 空位：最外层球壳上的灰蓝小点，照旧不连线、不参与 stats
  const extra = unlitStars(unlitCount(n));
  const unlitIds = [];
  for (let k = 0; k < extra.length; k += 1) {
    const item = extra[k];
    const dir = starmapDirection(item.id);
    const dist = shell * (1.15 + 0.15 * ((hash32(item.id + ":shell") % 100) / 100));
    const at = projectSphere(dir.x * dist, dir.y * dist, dir.z * dist, 0, STARMAP.PITCH, focusLen, w, hgt);
    ids.push(item.id);
    unlitIds.push(item.id);
    rawX.push(w / 2 + (at.x - w / 2) * stretch);
    rawY.push(at.y);
    meta.push({ r: item.r, hue: STARMAP.UNLIT_HUE, sat: item.sat, alpha: item.alpha, phase: item.phase });
    depth.push(Math.round(at.z * 100) / 100);
  }

  // 撑满画布：按真实星的包围盒分轴缩放（围绕球心，锚点星不动）。
  // 分轴是因为画布本来就宽：等比会被高度卡住，星空还是只占中间一条。
  // 上界 2.4 免得寥寥几条记忆被放大成几颗巨球；下界 0.6。
  let maxDx = 0;
  let maxDy = 0;
  for (let i = 0; i < n; i += 1) {
    maxDx = Math.max(maxDx, Math.abs(rawX[i] - w / 2));
    maxDy = Math.max(maxDy, Math.abs(rawY[i] - hgt / 2));
  }
  const fitX = clampNum(maxDx > 0 ? (w / 2 - STARMAP.PAD) / maxDx : 1, 0.6, 2.4);
  const fitY = clampNum(maxDy > 0 ? (hgt / 2 - STARMAP.PAD) / maxDy : 1, 0.6, 2.4);
  const nodes = [];
  for (let i = 0; i < meta.length; i += 1) {
    nodes.push({
      x: Math.round((w / 2 + (rawX[i] - w / 2) * fitX) * 10) / 10,
      y: Math.round((hgt / 2 + (rawY[i] - hgt / 2) * fitY) * 10) / 10,
      r: meta[i].r,
      hue: meta[i].hue,
      sat: meta[i].sat,
      alpha: meta[i].alpha,
      phase: meta[i].phase,
    });
  }
  return { nodes, ids, links, unlitIds, depth, anchor };
}

/* @starmap-start */
/**
 * 一帧星图：只认 ctx / nodes / opts，抽出去单放一块画布也能画。
 * opts = { time, links, width, height, sprite, focus }
 *   time   毫秒；0 是确定的静止图（视觉验收取这一帧）
 *   sprite 预渲染好的星点贴图；没有就回落到逐颗径向渐变
 *   focus  聚焦的真实星下标（hover），-1 表示没有
 */
function drawStarmapFrame(ctx, nodes, opts) {
  const o = opts || {};
  const list = Array.isArray(nodes) ? nodes : [];
  const width = Number(o.width) > 0 ? Number(o.width) : 1;
  const height = Number(o.height) > 0 ? Number(o.height) : 1;
  const time = Number(o.time) > 0 ? Number(o.time) : 0;
  const links = Array.isArray(o.links) ? o.links : [];
  const sprite = o.sprite && Number(o.sprite.width) > 0 ? o.sprite : null;
  const focus = Number.isFinite(Number(o.focus)) ? Math.round(Number(o.focus)) : -1;
  const turn = Math.PI * 2;

  const sky = ctx.createLinearGradient(0, 0, width, height);
  sky.addColorStop(0, "#2b2139");
  sky.addColorStop(1, "#171327");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // 每颗星各飘各的：位移只有 2px 量级，构图不动，记住的那颗星一直在原处。
  // 空位只飘一半，别让暗点抢注意力。相位来自节点自己的 phase，所以是确定的。
  const px = [];
  const py = [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i] || {};
    const phase = Number(node.phase) || 0;
    const dark = (Number(node.r) || 0) <= 2.4 && (Number(node.sat) || 0) <= 16;
    px.push((Number(node.x) || 0) + (dark ? 1.1 : 2.2) * Math.sin(time * 0.0007 + phase));
    py.push((Number(node.y) || 0) + (dark ? 0.9 : 1.8) * Math.cos(time * 0.0009 + phase));
  }

  // 焦点：自己与相连的星保持亮度，其余压暗；空位不参与（本来就暗）
  let lit = null;
  if (focus >= 0 && focus < list.length) {
    lit = new Set();
    lit.add(focus);
    for (let k = 0; k < links.length; k += 1) {
      const pair = links[k];
      if (!pair || pair.length < 2) continue;
      if (pair[0] === focus) lit.add(pair[1]);
      else if (pair[1] === focus) lit.add(pair[0]);
    }
  }

  // 暗线：透明度随距离平方衰减，有焦点时不相干的线更淡
  const reach = Math.max(90, Math.max(width, height) * 0.62);
  ctx.lineWidth = 0.7;
  for (let k = 0; k < links.length; k += 1) {
    const pair = links[k];
    if (!pair || pair.length < 2) continue;
    const a = pair[0];
    const b = pair[1];
    if (!(a >= 0 && a < list.length && b >= 0 && b < list.length) || a === b) continue;
    const dx = px[a] - px[b];
    const dy = py[a] - py[b];
    const fall = 1 - Math.sqrt(dx * dx + dy * dy) / reach;
    if (!(fall > 0)) continue;
    const na = list[a] || {};
    const nb = list[b] || {};
    const bright = Math.min(1, Math.max(0, ((Number(na.alpha) || 0.55) + (Number(nb.alpha) || 0.55)) / 2));
    let alpha = 0.2 * fall * fall * (0.45 + 0.55 * bright);
    if (lit && !(lit.has(a) && lit.has(b))) alpha *= 0.35;
    ctx.strokeStyle = "rgba(206,194,232," + alpha.toFixed(3) + ")";
    ctx.beginPath();
    ctx.moveTo(px[a], py[a]);
    ctx.lineTo(px[b], py[b]);
    ctx.stroke();
  }

  for (let i = 0; i < list.length; i += 1) {
    const node = list[i] || {};
    const x = px[i];
    const y = py[i];
    const r = Math.max(0.6, Number(node.r) || 1);
    const hue = Number.isFinite(Number(node.hue)) ? Number(node.hue) : 190;
    const sat = Number.isFinite(Number(node.sat)) ? Number(node.sat) : 18;
    const base = Math.min(1, Math.max(0.08, Number(node.alpha) || 0.55));
    const phase = Number(node.phase) || 0;
    // 空位：比真实星都小、几乎不发色的灰蓝点，不画白热核心（真实星 r 下限 2.6）
    const dim = r <= 2.4 && sat <= 16;
    const alpha = dim || !lit || lit.has(i) ? base : base * 0.45;
    // 呼吸：半径 ±14%，空位只有一半，周期都拉到分钟级
    const breath = dim ? 0.93 + 0.07 * Math.sin(time * 0.0012 + phase) : 0.86 + 0.14 * Math.sin(time * 0.0012 + phase);
    const size = r * breath;

    if (dim) {
      ctx.fillStyle = "hsla(" + hue + "," + sat + "%,74%," + Math.min(1, alpha * 0.9).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(x, y, size, 0, turn);
      ctx.fill();
      continue;
    }

    // 光晕：r 就是这团光的半径（贴图自带软边），有贴图就盖，没有就现建径向渐变
    if (sprite) {
      ctx.globalAlpha = Math.min(1, alpha * breath);
      ctx.drawImage(sprite, x - size, y - size, size * 2, size * 2);
      ctx.globalAlpha = 1;
    } else {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.6, size));
      glow.addColorStop(0, "hsla(" + hue + "," + sat + "%,80%," + (0.62 * alpha * breath).toFixed(3) + ")");
      glow.addColorStop(0.3, "hsla(" + hue + "," + sat + "%,74%," + (0.2 * alpha * breath).toFixed(3) + ")");
      glow.addColorStop(1, "hsla(" + hue + "," + Math.min(100, sat + 8) + "%,70%,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.6, size), 0, turn);
      ctx.fill();
    }

    // 本体只画中心一小坨：剩下的半径都是光晕，大星才看得出「亮核」而不是一块实心饼
    const body = Math.max(0.7, Math.min(4.6, size * 0.3));
    ctx.fillStyle = "hsla(" + hue + "," + sat + "%,78%," + Math.min(1, alpha * 0.95 + 0.05).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(x, y, body, 0, turn);
    ctx.fill();
    ctx.fillStyle = "hsla(" + hue + ",100%,96%," + Math.min(1, alpha * 0.9 + 0.1).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.5, body * 0.55), 0, turn);
    ctx.fill();
  }
}
/* @starmap-end */

/**
 * 预渲染一颗星点：外层辉光 + 内核亮斑。画的时候直接 drawImage，
 * 免得上千颗星每帧都现建径向渐变。思路参考 dsh-xingxi (Yuuyuko-uu)。
 * 拿不到 document（例如 node 里抽出来跑）时返回 null，绘制会回落到渐变。
 * @param {number} size 贴图边长像素。
 * @returns {HTMLCanvasElement|null}
 */
function createStarSprite(size) {
  const px = Math.round(clampNum(size === undefined ? STARMAP.SPRITE : size, 8, 256)) || STARMAP.SPRITE;
  try {
    if (typeof document === "undefined" || !document || typeof document.createElement !== "function") return null;
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (!ctx) return null;
    const half = px / 2;
    const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
    glow.addColorStop(0, "rgba(255,255,255,1)");
    glow.addColorStop(0.12, "rgba(255,250,242,0.92)");
    glow.addColorStop(0.3, "rgba(255,246,236,0.44)");
    glow.addColorStop(0.62, "rgba(232,222,255,0.12)");
    glow.addColorStop(1, "rgba(232,222,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, px, px);
    return canvas;
  } catch {
    return null;
  }
}

/** prefers-reduced-motion：真时只画一帧静态图。win 只为测试注入。 */
function prefersReducedMotion(win) {
  const target = win || (typeof window !== "undefined" ? window : null);
  try {
    const media = target && typeof target.matchMedia === "function" ? target.matchMedia("(prefers-reduced-motion: reduce)") : null;
    return !!(media && media.matches === true);
  } catch {
    return false;
  }
}

/** 时间戳 -> 「2025-02-03 21:04」：本地时区，记忆不需要秒级精度。 */
function formatStamp(at) {
  const ms = Number(at);
  if (!Number.isFinite(ms) || ms <= 0) return "时间未知";
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

/** 命中测试：指针换算成画布坐标，取最近的一颗（多给 7px 余量，小星也点得中）。 */
function starmapStarAt(layout, canvas, event, width, height) {
  const nodes = layout && layout.nodes ? layout.nodes : [];
  const rect = canvas && typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return null;
  const x = ((Number(event && event.clientX) || 0) - rect.left) / rect.width * width;
  const y = ((Number(event && event.clientY) || 0) - rect.top) / rect.height * height;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const d = Math.sqrt((node.x - x) * (node.x - x) + (node.y - y) * (node.y - y));
    if (d <= node.r + 7 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? null : { id: layout.ids[best], index: best };
}

/** 选中那颗星的位置：停帧时也要能画出高亮圈。 */
function starmapPickedNode(layout, id) {
  const ids = layout && layout.ids ? layout.ids : [];
  const at = ids.indexOf(String(id || ""));
  return at >= 0 ? layout.nodes[at] : null;
}

/**
 * 星图页：能画才画星空，其余情况一律给一句人话。
 * state.status：idle / loading / ready / empty / error。
 */
function renderStarmapBody(state, h, handlers) {
  const st = asObject(state);
  const act = asObject(handlers);
  const status = typeof st.status === "string" ? st.status : "idle";
  if (status === "error") {
    return [
      h("section", { key: "starmap-fail", style: S.cardLight }, [
        headRow(h, "memory", "记忆星图"),
        h("div", { key: "why", style: S.soft }, "星图没取到：" + (typeof st.error === "string" && st.error ? st.error : "未知原因")),
        h("div", { key: "note", style: S.note }, "其余几页照常，不受影响。"),
        h("button", { key: "retry", type: "button", style: S.pill, onClick: () => { if (typeof act.onRetry === "function") act.onRetry(); } }, "重试"),
      ]),
    ];
  }
  if (status === "empty") {
    return [
      h("section", { key: "starmap-empty", style: S.cardLight }, [
        headRow(h, "memory", "记忆星图"),
        h("div", { key: "none", style: S.soft }, "还没有记忆，先把上面的记忆开关打开。"),
        h("div", { key: "note", style: S.note }, "星图只画真实条目：库里没有，就一颗都不画。"),
      ]),
    ];
  }
  if (status !== "ready") {
    return [
      h("section", { key: "starmap-wait", style: S.cardLight }, [
        headRow(h, "memory", "记忆星图"),
        h("div", { key: "wait", style: S.soft }, "正在把记忆排成星空…"),
      ]),
    ];
  }
  const stars = asList(st.stars);
  const picked = asObject(st.picked);
  let detail;
  if (st.hoverUnlit === true) {
    // 空位只说这一句：没有正文、层、时间可给，给了就是编
    detail = h("div", { key: "detail", style: S.starmapDetail }, [h("span", { key: "u", style: { color: C.dim } }, "还未点亮的记忆")]);
  } else if (picked.id) {
    detail = h("div", { key: "detail", style: S.starmapDetail }, [
      h("span", { key: "t", style: { color: C.text1 } }, snippet(picked.text, 80) || "（这条没有正文）"),
      h("span", { key: "tier", style: S.note }, TIER_LABELS[picked.tier] || "未分层"),
      h("span", { key: "at", style: S.note }, formatStamp(picked.at)),
    ]);
  } else {
    detail = h("div", { key: "detail", style: S.note }, "点一颗星，看它记得什么。");
  }
  const caption = st.truncated === true
    ? "先画最近 " + stars.length + " 颗（库里有 " + fmt(st.total) + " 条），暗线是共享词面。"
    : "一条记忆一颗星，暗线是它们共享的词面。";
  return [
    h("section", { key: "starmap", style: S.card }, [
      headRow(h, "memory", "记忆星图 · " + fmt(st.total) + " 颗"),
      h("canvas", {
        key: "canvas",
        ref: (node) => { if (typeof act.onCanvas === "function") act.onCanvas(node); },
        role: "img",
        "aria-label": "记忆星图：一条记忆一颗星，共享词面一条暗线",
        style: S.starmapCanvas,
      }),
      // 图例只说亮暗之别，不给任何数字进度
      h("div", { key: "legend", style: S.note }, "亮的是记得的事，暗的是还没点亮的空位"),
      h("div", { key: "caption", style: S.note }, caption),
      detail,
    ]),
  ];
}

/**
 * 渲染入口。opts.tab：overview / starmap / about；不给时按「无 hooks」处理，顺序渲染概览与说明。
 * 不可用态保持原样：只有一张断线卡，不显示数字，也不显示说明页。
 */
function renderBlocks(view, h, unavailable, opts) {
  const reason = typeof unavailable === "string" && unavailable ? unavailable : null;
  if (reason) return [h("div", { key: "panel", style: S.panel }, [unavailableCard(reason, h)])];

  const o = opts || {};
  const tab = o.tab === "about" || o.tab === "overview" || o.tab === "starmap" ? o.tab : null;
  const children = [renderSegments(tab || "overview", null, h)];
  // 星图页只画星图：它要一块 canvas，和另外两页的卡片不是一回事
  if (tab !== "about" && tab !== "starmap") children.push.apply(children, renderOverview(asObject(view), h, o.actions));
  if (tab !== "overview" && tab !== "starmap") children.push.apply(children, renderAbout(h));
  if (tab === "starmap") children.push.apply(children, renderStarmapBody(o.starmap, h, o.handlers));
  return [h("div", { key: "panel", style: S.panel }, children)];
}

/** 打宿主只读路由；失败一律转成"不可用 + 原因"，不抛。 */
async function loadPanel(fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { unavailable: "当前环境没有 fetch" };
  let timer = null;
  try {
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    if (ctrl) timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const response = await doFetch(PANEL_PATH, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!response || !response.ok) {
      return { unavailable: "宿主未注册 " + PANEL_PATH + "（HTTP " + String(response && response.status) + "）" };
    }
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return { unavailable: "响应不是 JSON（前 80 字符：" + String(text).slice(0, 80) + "）" };
    }
    if (!payload || typeof payload !== "object") return { unavailable: "响应为空" };
    return { view: buildViewModel(payload) };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { unavailable: "请求 " + PANEL_PATH + " 失败：" + message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 注册只读面板。slots 缺失、React 缺失、任何异常都返回 {registered:false}，不抛。 */
function register(ctx, React) {
  let slots = null;
  try {
    slots = ctx && typeof ctx.get === "function" ? ctx.get("slots") : null;
  } catch {
    slots = null;
  }
  if (!slots) slots = asObject(ctx).slots || null;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") {
    return { registered: false, reason: "slots-unavailable" };
  }
  const h = React && typeof React.createElement === "function" ? React.createElement : null;
  if (!h) return { registered: false, reason: "react-unavailable" };

  const hooks = typeof React.useState === "function" ? React : null;

  // 取数结果放在 register 的闭包里：来回切页不重复打接口，说明页也不碰网络
  const panelStore = { status: "idle", view: null, reason: null };

  // 星图同样放闭包里。区别是 effect 的依赖里绝不能出现「它自己刚写过的 state」：
  // 那样 cleanup 会先跑，把在途请求的结果按 alive=false 丢掉，页面永远停在 loading。
  const starmapStore = { status: "idle", view: null };

  /**
   * 取一次 universe：状态先落到 store 上，再把回包交给组件。
   * effect 与「重试」共用这一条写入路径，所以不存在两处各自维护 loading 的机会。
   */
  function loadStarmap(setStarmap) {
    starmapStore.status = "loading";
    postAction({ action: "universe" }).then((res) => {
      starmapStore.status = "done";
      starmapStore.view = normalizeUniverse(res);
      if (typeof setStarmap === "function") setStarmap(starmapStore.view);
    });
  }

  // 操作卡的本地状态；放在 register 闭包里，切页/重渲染都不丢，也便于测试直接驱动
  const actionStore = {
    query: "",
    rows: [],
    rowStatus: {},
    confirmingId: "",
    searchStatus: null,
    timer: null,
    capture: Object.assign({}, EMPTY_CAPTURE),
    captureErrors: {},
    captureErrorTimers: {},
    captureTimer: null,
    captureBusy: false,
    captureLoading: false,
  };

  function actionHandlers(setActions) {
    const push = (patch) => {
      Object.assign(actionStore, patch);
      setActions({
        query: actionStore.query,
        rows: actionStore.rows,
        rowStatus: actionStore.rowStatus,
        confirmingId: actionStore.confirmingId,
        searchStatus: actionStore.searchStatus,
        capture: actionStore.capture,
        captureErrors: actionStore.captureErrors,
      });
      // 面板与输入区胶囊共用这一份状态：谁改了都要通知另一边
      emitCapture(actionStore.capture);
    };
    const mark = (id, state, text) => push({ rowStatus: Object.assign({}, actionStore.rowStatus, { [id]: { state, text } }) });
    return {
      onQuery(value) {
        push({ query: String(value == null ? "" : value) });
      },
      onSearch() {
        const query = String(actionStore.query || "").trim();
        if (!query) {
          push({ searchStatus: { state: "error", text: "先输入关键词" } });
          return;
        }
        push({ searchStatus: { state: "sending", text: "搜索中…" } });
        postAction({ action: "search", query, limit: 8 }).then((res) => {
          if (!res.ok) {
            push({ searchStatus: { state: "error", text: "失败：" + String(res.error || "未知原因") } });
            return;
          }
          const rows = asList(res.rows).slice(0, 8);
          push({ rows, rowStatus: {}, confirmingId: "", searchStatus: { state: "ok", text: "命中 " + rows.length + " 条" } });
        });
      },
      onPin(row) {
        const id = String((row && row.id) || "");
        if (!id) return;
        mark(id, "sending", "发送中…");
        postAction({ action: "pin", id, pinned: !(row && row.pinned) }).then((res) => {
          if (!res.ok) {
            mark(id, "error", "失败：" + String(res.error || "未知原因"));
            return;
          }
          const next = typeof res.pinned === "boolean" ? res.pinned : !(row && row.pinned);
          push({
            rows: actionStore.rows.map((r) => (String(r.id) === id ? Object.assign({}, r, { pinned: next }) : r)),
            rowStatus: Object.assign({}, actionStore.rowStatus, { [id]: { state: "ok", text: next ? "已钉住" : "已取消钉住" } }),
          });
        });
      },
      onTier(row, tier) {
        const id = String((row && row.id) || "");
        const target = TIER_CHOICES.indexOf(String(tier)) >= 0 ? String(tier) : "hot";
        if (!id) return;
        mark(id, "sending", "发送中…");
        postAction({ action: "tier", id, tier: target }).then((res) => {
          if (!res.ok) {
            mark(id, "error", "失败：" + String(res.error || "未知原因"));
            return;
          }
          const applied = TIER_CHOICES.indexOf(String(res.tier)) >= 0 ? String(res.tier) : target;
          push({
            rows: actionStore.rows.map((r) => (String(r.id) === id ? Object.assign({}, r, { tier: applied }) : r)),
            rowStatus: Object.assign({}, actionStore.rowStatus, { [id]: { state: "ok", text: "已改为「" + TIER_TEXT[applied] + "」" } }),
          });
        });
      },
      /**
       * 全局开关：只发一次 POST，不再带 sessionId、也不再先 GET。
       * 翻转方向以上一次 GET/POST 返回的 enabled 为准；失败 2 秒后回退到点击前的值。
       */
      onCaptureToggle(target) {
        if (actionStore.captureBusy) return;
        const previous = Object.assign({}, actionStore.capture);
        if (previous.status === "sending") return;
        const sessionId = typeof target === "string" && target && target !== "global" ? target : "";
        const view = sessionId ? captureDisplay(previous, sessionId) : globalDisplay(previous);
        const enabledNow = view.known ? view.effective : previous.default !== false;
        const body = sessionId
          ? { action: "capture", scope: "session", sessionId, enabled: !enabledNow }
          : { action: "capture", scope: "global", enabled: !enabledNow };
        actionStore.captureBusy = true;
        push({ capture: Object.assign({}, previous, { status: "sending", note: "" }) });
        postAction(body)
          .then((res) => {
            actionStore.captureBusy = false;
            if (!res || res.ok !== true) {
              push({ capture: Object.assign({}, previous, { status: "failed", note: String((res && res.error) || "切换失败") }) });
              // 2 秒后回退到点击前的快照（不用 confirm/alert）
              if (actionStore.captureTimer) clearTimeout(actionStore.captureTimer);
              actionStore.captureTimer = setTimeout(() => {
                actionStore.captureTimer = null;
                push({ capture: Object.assign({}, previous, { status: previous.status === "unknown" ? "unknown" : "ready", note: "" }) });
              }, 2000);
              return;
            }
            push({ capture: applyCaptureResult(previous, res, body) });
          })
          .catch((error) => {
            actionStore.captureBusy = false;
            push({ capture: Object.assign({}, previous, { status: "failed", note: errText(error) }) });
          });
      },
      /**
       * 清除这个会话的覆盖，回到跟随全局默认：POST enabled:null。
       * 行内失败只影响这一行（写 captureErrors），2 秒后回退，不把整块打成「失败」。
       */
      onCaptureClear(sessionId) {
        const id = typeof sessionId === "string" ? sessionId : "";
        if (!id || actionStore.captureBusy) return;
        const previous = Object.assign({}, actionStore.capture);
        actionStore.captureBusy = true;
        push({ captureErrors: Object.assign({}, actionStore.captureErrors, { [id]: "" }) });
        postAction({ action: "capture", scope: "session", sessionId: id, enabled: null })
          .then((res) => {
            actionStore.captureBusy = false;
            if (!res || res.ok !== true) {
              const text = String((res && res.error) || "清除失败");
              push({ captureErrors: Object.assign({}, actionStore.captureErrors, { [id]: text }) });
              if (actionStore.captureErrorTimers[id]) clearTimeout(actionStore.captureErrorTimers[id]);
              actionStore.captureErrorTimers[id] = setTimeout(() => {
                actionStore.captureErrorTimers[id] = null;
                const nextErrors = Object.assign({}, actionStore.captureErrors);
                delete nextErrors[id];
                push({ capture: previous, captureErrors: nextErrors });
              }, 2000);
              return;
            }
            // 服务端对清除的返回仍可能是布尔值；本地按契约记成「没有覆盖」
            const cleared = applyCaptureResult(previous, { ok: true, scope: "session", sessionId: id, enabled: null }, { scope: "session", sessionId: id });
            const nextErrors = Object.assign({}, actionStore.captureErrors);
            delete nextErrors[id];
            push({ capture: cleared, captureErrors: nextErrors });
          })
          .catch((error) => {
            actionStore.captureBusy = false;
            push({ captureErrors: Object.assign({}, actionStore.captureErrors, { [id]: errText(error) }) });
          });
      },
      /** 两步忘记：第一次只武装确认，3 秒内再点才真发；点别的行会换目标并重置计时。 */
      onForget(row) {
        const id = String((row && row.id) || "");
        if (!id) return;
        if (actionStore.confirmingId !== id) {
          if (actionStore.timer) clearTimeout(actionStore.timer);
          actionStore.timer = setTimeout(() => {
            actionStore.timer = null;
            if (actionStore.confirmingId === id) push({ confirmingId: "" });
          }, FORGET_CONFIRM_MS);
          push({ confirmingId: id });
          return;
        }
        if (actionStore.timer) {
          clearTimeout(actionStore.timer);
          actionStore.timer = null;
        }
        push({
          confirmingId: "",
          rowStatus: Object.assign({}, actionStore.rowStatus, { [id]: { state: "sending", text: "发送中…" } }),
        });
        postAction({ action: "forget", id }).then((res) => {
          if (!res.ok) {
            mark(id, "error", "失败：" + String(res.error || "未知原因"));
            return;
          }
          push({
            rows: actionStore.rows.filter((r) => String(r.id) !== id),
            rowStatus: Object.assign({}, actionStore.rowStatus, { [id]: { state: "ok", text: "已忘记" } }),
          });
        });
      },
    };
  }


  function MnemosPanel() {
    const tabState = hooks ? hooks.useState("overview") : ["overview", () => {}];
    const tab = tabState[0];
    const setTab = tabState[1];
    const dataState = hooks
      ? hooks.useState(
          panelStore.status === "done"
            ? { status: panelStore.reason ? "unavailable" : "ready", view: panelStore.view, reason: panelStore.reason }
            : { status: "loading" },
        )
      : [{ status: "loading" }, () => {}];
    const data = dataState[0];
    const setData = dataState[1];
    const actState = hooks ? hooks.useState(Object.assign({}, actionStore)) : [EMPTY_ACTIONS, () => {}];
    const actions = actState[0];
    const setActions = actState[1];
    // 星图三格：回包、选中哪颗星、画布句柄。句柄要跟着实例活，别每次渲染重建。
    const starState = hooks ? hooks.useState(starmapStore.view || EMPTY_STARMAP) : [EMPTY_STARMAP, () => {}];
    const starmap = starState[0] || EMPTY_STARMAP;
    const setStarmap = starState[1];
    const pickedState = hooks ? hooks.useState("") : ["", () => {}];
    const picked = pickedState[0];
    const setPicked = pickedState[1];
    const boxState = hooks ? hooks.useState({ canvas: null, selected: "", hover: "", focus: -1 }) : [{ canvas: null, selected: "", hover: "", focus: -1 }, () => {}];
    const box = boxState[0];
    // 指针停在空位上时改画布下面那一行：只影响文案，不动选中态
    const hoverState = hooks ? hooks.useState("") : ["", () => {}];
    const hover = hoverState[0];
    const setHover = hoverState[1];
    if (hooks && typeof hooks.useEffect === "function") {
      // 订阅会话开关：另一处（输入区胶囊）改了，这里要跟着走
      hooks.useEffect(() => {
        const onCapture = (capture) => setActions((prev) => Object.assign({}, prev, { capture }));
        subscribeCapture(onCapture);
        return () => unsubscribeCapture(onCapture);
      }, []);
      hooks.useEffect(() => {
        if (tab !== "overview") return undefined;
        if (panelStore.status !== "idle") return undefined;
        panelStore.status = "loading";
        let alive = true;
        loadPanel().then((result) => {
          if (!alive) return;
          panelStore.status = "done";
          panelStore.view = result.view || null;
          panelStore.reason = result.unavailable || null;
          setData({ status: result.unavailable ? "unavailable" : "ready", view: result.view, reason: result.unavailable || null });
          // 面板拿到的 capture 就是会话真的开关：灌进共享状态，胶囊那边立刻同步
          const cap = result.view ? result.view.capture : null;
          if (cap && actionStore.capture.status === "unknown") {
            actionStore.capture = Object.assign({ status: "ready", note: "" }, cap);
            emitCapture(actionStore.capture);
          }
        });
        return () => {
          alive = false;
        };
      }, [tab]);

      // 切到星图才问宿主：停在概览/说明页时一次请求都不多打。
      // 依赖只写 [tab]——loading 不经过 setStarmap，这个 effect 就不会自己把自己重跑掉。
      hooks.useEffect(() => {
        if (tab !== "starmap" || starmapStore.status !== "idle") return undefined;
        loadStarmap(setStarmap);
      }, [tab]);

      hooks.useEffect(() => {
        // 画布生命周期：量一次尺寸 -> 布局一次 -> 起循环，或者只画一帧
        if (tab !== "starmap" || starmap.status !== "ready") return undefined;
        const canvas = box.canvas;
        const ctx = canvas && typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        if (!ctx) return undefined;
        const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : null;
        const width = Math.round((rect && rect.width) || STARMAP.W) || STARMAP.W;
        const height = STARMAP.H;
        const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        if (typeof ctx.setTransform === "function") ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const layout = layoutUniverse(starmap.stars, starmap.links, width, height);
        // 贴图只造一次：每帧上千次 drawImage 比每次现建径向渐变便宜得多
        const sprite = createStarSprite(STARMAP.SPRITE);
        let at = 0;
        const paint = (time) => {
          at = time;
          drawStarmapFrame(ctx, layout.nodes, {
            time: time,
            links: layout.links,
            width: width,
            height: height,
            sprite: sprite,
            focus: box.focus,
          });
          const ring = starmapPickedNode(layout, box.selected);
          if (!ring) return;
          // 高亮圈画在帧外面：drawStarmapFrame 只认节点自己的七个字段
          ctx.strokeStyle = "hsla(" + ring.hue + "," + Math.min(96, ring.sat + 20) + "%,90%,0.95)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, ring.r + 6, 0, TAU);
          ctx.stroke();
        };
        paint(0);
        const still = prefersReducedMotion() || typeof requestAnimationFrame !== "function";
        let raf = 0;
        let idle = 0;
        const stop = () => {
          if (raf && typeof cancelAnimationFrame === "function") cancelAnimationFrame(raf);
          raf = 0;
        };
        const loop = (stamp) => {
          paint(Number(stamp) || 0);
          raf = requestAnimationFrame(loop);
        };
        // 空闲 10 秒停帧；之后动一下指针就重新起转——停止只是省 CPU，不是结束
        const wake = () => {
          if (still) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(stop, STARMAP_IDLE_MS);
          if (!raf) raf = requestAnimationFrame(loop);
        };
        // 命中的是空位时，详情换一句话；命中真实星时，只把它和相连的星点亮（focus）
        const onMove = (event) => {
          const hit = starmapStarAt(layout, canvas, event, width, height);
          const next = hit && starmapIsUnlit(layout, hit.id) ? hit.id : "";
          const focusAt = hit && !next ? hit.index : -1;
          const focusChanged = box.focus !== focusAt;
          if (box.hover !== next) {
            box.hover = next;
            setHover(next);
          }
          if (focusChanged) {
            box.focus = focusAt;
            paint(at); // 停帧时也要立刻看到压暗，不能等下一帧
          }
          wake();
        };
        const onLeave = () => {
          const focusChanged = box.focus !== -1;
          if (box.hover) {
            box.hover = "";
            setHover("");
          }
          if (focusChanged) {
            box.focus = -1;
            paint(at);
          }
        };
        const onPick = (event) => {
          const hit = starmapStarAt(layout, canvas, event, width, height);
          // 点空位当点空白：它没有可展示的东西，别把选中态钉在一个空 id 上
          box.selected = hit && !starmapIsUnlit(layout, hit.id) ? hit.id : "";
          setPicked(box.selected);
          paint(at);
          wake();
        };
        wake();
        const listen = (name, fn) => {
          if (typeof canvas.addEventListener === "function") canvas.addEventListener(name, fn);
        };
        listen("pointermove", onMove);
        listen("pointerdown", onPick);
        listen("click", wake);
        listen("pointerleave", onLeave);
        return () => {
          stop();
          if (idle) clearTimeout(idle);
          if (typeof canvas.removeEventListener === "function") {
            canvas.removeEventListener("pointermove", onMove);
            canvas.removeEventListener("pointerdown", onPick);
            canvas.removeEventListener("click", wake);
            canvas.removeEventListener("pointerleave", onLeave);
          }
        };
      }, [tab, starmap]);
    }

    if (!hooks) {
      // 没有 hooks：把两页顺序都画出来，不空屏、不抛错
      const both = [renderSegments("overview", null, h)];
      both.push.apply(both, renderOverview({}, h, EMPTY_ACTIONS));
      both.push.apply(both, renderAbout(h));
      return h("div", { style: S.panel }, both);
    }

    const body = [renderSegments(tab, setTab, h)];
    if (tab === "about") {
      body.push.apply(body, renderAbout(h));
    } else if (tab === "starmap") {
      const pickedStar = asList(starmap.stars).filter((star) => star.id === picked)[0] || null;
      body.push.apply(
        body,
        renderStarmapBody(Object.assign({}, starmap, { picked: pickedStar, hoverUnlit: hover !== "" }), h, {
          onCanvas: (node) => {
            box.canvas = node;
          },
          onRetry: () => {
            box.selected = "";
            box.hover = "";
            box.focus = -1;
            setPicked("");
            setHover("");
            starmapStore.status = "idle";
            starmapStore.view = null;
            setStarmap(EMPTY_STARMAP);
            loadStarmap(setStarmap);
          },
        }),
      );
    } else if (data.status === "ready") {
      body.push.apply(body, renderOverview(data.view, h, actions, actionHandlers(setActions)));
    } else if (data.status === "unavailable") {
      body.push(unavailableCard(String(data.reason || ""), h));
    } else {
      body.push(skyField({}, 0, h));
      body.push(h("div", { key: "loading", style: S.soft }, "正在轻轻翻开记忆…"));
    }
    return h("div", { style: S.panel }, body);
  }

  /** 输入区那一带的小胶囊：和面板共用 actionStore.capture，谁改了另一边都会收到广播。 */
  function CapturePill(props) {
    // 宿主给插槽组件的 props 里带 sessionId（dafeiyu/client.js:1646 同款用法）
    const sessionId = props && typeof props.sessionId === "string" ? props.sessionId : "";
    const st = hooks ? hooks.useState(Object.assign({}, actionStore.capture)) : [EMPTY_CAPTURE, () => {}];
    const state = st[0];
    const setState = st[1];
    if (hooks && typeof hooks.useEffect === "function") {
      hooks.useEffect(() => {
        subscribeCapture(setState);
        return () => unsubscribeCapture(setState);
      }, []);
      hooks.useEffect(() => {
        // 挂载时取一次 GET：只为显示刷新，翻转方向不依赖它
        if (actionStore.capture.status !== "unknown" || actionStore.captureLoading) return undefined;
        actionStore.captureLoading = true;
        loadPanel()
          .then((result) => {
            actionStore.captureLoading = false;
            const cap = result && result.view ? result.view.capture : null;
            if (!cap) return;
            actionStore.capture = Object.assign({ status: "ready", note: "" }, cap);
            setState(Object.assign({}, actionStore.capture));
            emitCapture(actionStore.capture);
          })
          .catch(() => {
            actionStore.captureLoading = false;
          });
        return undefined;
      }, []);
    }
    if (!hooks) return renderCapturePill(EMPTY_CAPTURE, null, h, { sessionId });
    const view = asObject(state).capture || state;
    return renderCapturePill(view, () => actionHandlers(setState).onCaptureToggle(sessionId || "global"), h, { sessionId });
  }

  // 同一个组件挂两处：首屏 hero 与会话内 composer dock；两处共用 actionStore.capture
  slots.inject("conversation.hero.options", () =>
    slots.register({ name: "conversation.hero.options", id: "dsh-mnemos-capture-hero", order: 0 }, CapturePill),
  );
  slots.inject("conversation.composer.dock", () =>
    slots.register({ name: "conversation.composer.dock", id: "dsh-mnemos-capture", order: 0 }, CapturePill),
  );

  slots.inject("settings.section", () =>
    slots.register({ name: "settings.section", id: "dsh-mnemos", order: 39, label: () => SECTION_LABEL }, MnemosPanel),
  );
  return { registered: true, id: "dsh-mnemos" };
}

/** ModuleLoader 调的入口。任何异常都吞掉并返回 {registered:false}。 */
function apply(ctx) {
  try {
    const React = RESOLVED_REACT || requireSafe("react");
    const result = register(ctx, React);
    if (!result.registered) {
      try {
        console.warn("dsh-mnemos: 记忆面板未注册 — " + result.reason);
      } catch {
        /* ignore */
      }
    }
    return result;
  } catch (err) {
    try {
      console.warn("dsh-mnemos: apply 失败 — " + (err && err.message ? err.message : String(err)));
    } catch {
      /* ignore */
    }
    return { registered: false, reason: "apply-failed" };
  }
}

function requireSafe(name) {
  try {
    return typeof require === "function" ? require(name) : null;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined" && window && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === "function") {
  window.__ModuleLoader__.load({
    id: "dsh-mnemos",
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      let React = null;
      try {
        React = typeof require === "function" ? require("react") : null;
      } catch {
        React = null;
      }
      RESOLVED_REACT = React;
      exports.inject = ["slots"];
      exports.apply = apply;
      exports.panelPath = PANEL_PATH;
      exports.__test = {
        buildViewModel,
        formatViewModel,
        renderBlocks,
        renderOverview,
        renderAbout,
        renderSegments,
        renderActionsCard,
        renderCapturePill,
        captureLabel,
        EMPTY_CAPTURE,
        postAction,
        loadPanel,
        register,
        starNodes,
        constellationNodes: starNodes,
drawStarmapFrame,
layoutUniverse,
normalizeUniverse,
renderStarmapBody,
createStarSprite,
unlitCount,
unlitStars,
starmapIsUnlit,
prefersReducedMotion,
starmapStarAt,
starRadius,
starHue,
starSat,
starAlpha,
formatStamp,
STARMAP,
STARMAP_IDLE_MS,
        vectorReasonText,
        ICONS,
        STAR,
        COLORS: C,
        PANEL_PATH,
        RECALL_LIMIT,
      };
      return module.exports;
    },
  });
}

})();
