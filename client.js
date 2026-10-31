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
  text1: "#F4EDFB",
  text2: "#D3C8E6",
  text3: "#A79BBB",
  dim: "#8F87A0",
  pink: "hsl(320, 66%, 74%)",
  purple: "hsl(265, 62%, 73%)",
  green: "hsl(158, 46%, 70%)",
  amber: "hsl(38, 64%, 72%)",
  line: "hsla(320, 55%, 80%, 0.20)",
  lineSoft: "rgba(255,255,255,0.075)",
  cardBg: "rgba(255,255,255,0.042)",
  cardBgTop: "rgba(255,255,255,0.062)",
  glow: "inset 0 1px 0 rgba(255,255,255,0.075)",
  track: "rgba(255,255,255,0.075)",
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
      "linear-gradient(160deg, rgba(58,44,76,0.55), rgba(35,29,48,0.72))",
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
    background: "linear-gradient(155deg, " + C.cardBgTop + ", " + C.cardBg + ")",
    boxShadow: C.glow,
    padding: "13px 15px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardLight: {
    borderRadius: 14,
    border: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(255,255,255,0.028)",
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
    background: "linear-gradient(155deg, hsla(38, 60%, 70%, 0.10), rgba(255,255,255,0.03))",
    boxShadow: C.glow,
    padding: "18px 18px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 11,
  },
};

S.trackZero = Object.assign({}, S.track, { background: "rgba(255,255,255,0.028)" });
S.segGroup = {
  display: "inline-flex",
  alignSelf: "flex-start",
  gap: 3,
  padding: 3,
  borderRadius: 999,
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.07)",
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
  border: "1px solid rgba(255,255,255,0.10)",
  background: "rgba(255,255,255,0.05)",
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
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.04)",
  color: C.text2,
  fontSize: 11.5,
  cursor: "pointer",
  fontFamily: "inherit",
  whiteSpace: "nowrap",
};
S.dangerBtn = Object.assign({}, S.miniBtn, {
  border: "1px solid hsla(2, 62%, 66%, 0.72)",
  background: "hsla(2, 66%, 58%, 0.28)",
  color: "#FFE7E4",
  fontWeight: 600,
});
S.miniSelect = {
  padding: "3px 6px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  background: "rgba(255,255,255,0.04)",
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
S.actErr = { fontSize: 11, color: "hsl(6, 72%, 76%)", paddingLeft: 38 };

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
    h("circle", { key: "track", cx: 33, cy: 33, r: R, fill: "none", stroke: "rgba(255,255,255,0.09)", strokeWidth: 5 }),
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
const EMPTY_ACTIONS = { query: "", rows: [], rowStatus: {}, confirmingId: "", searchStatus: null };

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

  return h("section", { key: "actions", style: S.cardLight }, [headRow(h, "actions", "操作"), searchRow, statusLine].concat(body));
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
    vector.state === "on" ? "hsla(158, 46%, 70%, 0.14)" : vector.state === "off" ? "rgba(255,255,255,0.05)" : "hsla(38, 64%, 72%, 0.13)";
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
  return h("div", { key: "segments", role: "tablist", style: S.segGroup }, [seg("overview", "概览"), seg("about", "说明")]);
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
    section("about-privacy", "隐私与只读", [
      "数据在 profile 目录下的 dsh-mnemos（或你配置的 dataDir）。",
      "面板只对 /.dsh-mnemos/panel 发请求：看数据用 GET，写入只在你按下按钮时发生（POST），不改配置。",
      "想删某条记忆，用 /mem forget <id>。",
    ]),
  ];
}

/**
 * 渲染入口。opts.tab：overview / about；不给时按「无 hooks」处理，顺序渲染两页。
 * 不可用态保持原样：只有一张断线卡，不显示数字，也不显示说明页。
 */
function renderBlocks(view, h, unavailable, opts) {
  const reason = typeof unavailable === "string" && unavailable ? unavailable : null;
  if (reason) return [h("div", { key: "panel", style: S.panel }, [unavailableCard(reason, h)])];

  const tab = opts && (opts.tab === "about" || opts.tab === "overview") ? opts.tab : null;
  const children = [renderSegments(tab || "overview", null, h)];
  if (tab !== "about") children.push.apply(children, renderOverview(asObject(view), h, opts && opts.actions));
  if (tab !== "overview") children.push.apply(children, renderAbout(h));
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

  // 操作卡的本地状态；放在 register 闭包里，切页/重渲染都不丢，也便于测试直接驱动
  const actionStore = { query: "", rows: [], rowStatus: {}, confirmingId: "", searchStatus: null, timer: null };

  function actionHandlers(setActions) {
    const push = (patch) => {
      Object.assign(actionStore, patch);
      setActions({
        query: actionStore.query,
        rows: actionStore.rows,
        rowStatus: actionStore.rowStatus,
        confirmingId: actionStore.confirmingId,
        searchStatus: actionStore.searchStatus,
      });
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
    if (hooks && typeof hooks.useEffect === "function") {
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
        });
        return () => {
          alive = false;
        };
      }, [tab]);
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
        postAction,
        loadPanel,
        register,
        starNodes,
        constellationNodes: starNodes,
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
