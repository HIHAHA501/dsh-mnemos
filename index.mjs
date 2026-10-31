/**
 * dsh-mnemos 的唯一宿主面：读配置 → 开库 → 落记忆 → 建索引 → 每轮注入 → 命令/工具 → 统计。
 *
 * 三条硬规矩：
 * 1. 只消费公开服务，全部走 ctx.get + 能力探测；缺哪个面就降级成「没有这个面」，
 *    不声明 inject（硬依赖会让插件在 bare profile 上一直 pending）。
 * 2. 任何一条路径失败都不许把异常抛给宿主：注入段渲染失败就返回空段，
 *    pre-step 失败就原样返回下游 decision，落库失败就跳过这一条。
 * 3. 无常驻定时器：合并只在「写入满 ingest.everyTurns 轮」时同步跑一次。
 */

import { resolveConfig } from "./src/config.mjs";
import { createMemCommand } from "./src/host/commands.mjs";
import { createIngest, demoteSweep } from "./src/host/ingest.mjs";
import { createLedger, createRetrievalIndex, latestUserText, rankRecords, renderInjection } from "./src/host/inject.mjs";
import { projectMessages } from "./src/host/project.mjs";
import { createMemoryTools } from "./src/host/tools.mjs";
import { TIERS, createRecord } from "./src/record.mjs";
import { createStore } from "./src/store.mjs";

/** 插件名；宿主日志与 cordis 诊断都用它。 */
export const name = "dsh-mnemos";

/** 注入段名：同名段在全局层只能注册一次，名字带上插件名才不会撞车。 */
export const SECTION_NAME = "dsh-mnemos:memory";

/** 段的排序位：落在全部工具段（1000-3000）之后、MCP 段（3100）之前。 */
export const SECTION_ORDER = 3050;

/** 每轮最多拿多少条候选进排序：全量候选配上一次排序就够，不为省一点算力把 recall 砍掉。 */
const CANDIDATE_LIMIT = 200;

/** 我们的注入消息挂在 source.kind 上，落到会话日志里能认出来、也据此避免自食其果。 */
const OWN_SOURCE = "dsh-mnemos";

function messageOf(error) {
  return error && error.message ? error.message : String(error);
}

/* ------------------------------------------------------- 人格桥接（启动同步） */
/** 兜底定位标记：record.mjs 的 normalizeMeta 只保留白名单键，sourceRefs 一定活得下来。 */
const PERSONA_REF = "persona-snapshot:primary";
const PERSONA_KEY_FALLBACK = "primary";

let personaBridgeCache = null;
let personaBridgeTried = false;

/** 并行任务还没落盘时这里会失败：插件照常加载，只记一条 note。 */
async function loadPersonaBridge() {
  if (personaBridgeTried) return personaBridgeCache;
  personaBridgeTried = true;
  try {
    personaBridgeCache = await import("./src/persona-bridge.mjs");
  } catch {
    personaBridgeCache = null;
  }
  return personaBridgeCache;
}

/** 只认 persona 块本身；块缺席时退回 self/none（config.mjs 的 persona 块由并行任务提供）。 */

/* ------------------------------------------------- 人格桥接（按轮刷新 · 无定时器） */
const PERSONA_TURN_MIN_MS = 60000;

/** 该不该现在刷：turn 模式、配了来源、没有进行中的同步、距上次 ≥ 60s。 */
function personaTurnDue(runtime) {
  const snap = runtime.persona;
  if (!snap || snap.refresh !== "turn" || snap.kind === "none" || snap.inFlight) return false;
  const last = Math.max(Number(snap.lastAttemptAt) || 0, Number(snap.lastSyncAt) || 0);
  return runtime.personaClock() - last >= PERSONA_TURN_MIN_MS;
}

/**
 * 点火：不 await、不返回结果，调用方拿到的是同步返回。
 * 同一时刻只允许一个进行中的同步（inFlight 标记），失败只写 note。
 */
function triggerPersonaTurn(runtime) {
  if (!personaTurnDue(runtime)) return null;
  const snap = runtime.persona;
  snap.inFlight = true;
  snap.lastAttemptAt = runtime.personaClock();
  snap.lastTrigger = "turn";
  snap.turnSyncs = (snap.turnSyncs || 0) + 1;
  const task = syncPersona(runtime)
    .catch((error) => {
      snap.result = "failed";
      runtime.note("人格快照按轮同步失败：" + messageOf(error));
      return snap;
    })
    .then((value) => {
      snap.inFlight = false;
      runtime.personaPending = null;
      return value;
    });
  runtime.personaPending = task;
  return task;
}

/** 独立监听：只点火，然后照常把 decision 交下去（不改写、不阻塞）。 */
function mountPersonaTurn(ctx, runtime) {
  if (runtime.persona.refresh !== "turn" || runtime.persona.kind === "none") return;
  if (!ctx || typeof ctx.on !== "function") {
    runtime.note("人格快照：没有事件面，按轮刷新不可用");
    return;
  }
  try {
    ctx.on("agent/pre-step", (payload, next) => {
      try {
        triggerPersonaTurn(runtime);
      } catch (error) {
        runtime.note("人格快照按轮同步触发失败：" + messageOf(error));
      }
      return typeof next === "function" ? next() : undefined;
    });
  } catch (error) {
    runtime.note("人格快照按轮监听注册失败：" + messageOf(error));
  }
}

function personaConfigOf(block) {
  const raw = block && typeof block === "object" ? block : {};
  return {
    mode: raw.mode === "external" ? "external" : "self",
    kind: ["none", "file", "http"].indexOf(raw.kind) >= 0 ? raw.kind : "none",
  };
}

/** 记录的 hash：优先 meta（契约），meta 被 record 层丢掉时退回 sourceRefs 里的标记。 */
function personaHashOf(record) {
  const meta = record && record.meta ? record.meta : {};
  if (typeof meta.personaHash === "string" && meta.personaHash) return meta.personaHash;
  const refs = record && Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
  for (let i = 0; i < refs.length; i += 1) {
    if (typeof refs[i] === "string" && refs[i].indexOf("persona-hash:") === 0) return refs[i].slice("persona-hash:".length);
  }
  return "";
}

function findPersonaRecord(records, bridge) {
  const key = bridge && typeof bridge.PERSONA_SOURCE_KEY === "string" ? bridge.PERSONA_SOURCE_KEY : PERSONA_KEY_FALLBACK;
  const list = Array.isArray(records) ? records : [];
  const byMeta = list.filter((r) => r && r.tier === "persona" && r.meta && r.meta.personaSourceKey === key);
  if (byMeta.length) return byMeta[0];
  return list.find((r) => r && r.tier === "persona" && Array.isArray(r.sourceRefs) && r.sourceRefs.indexOf(PERSONA_REF) >= 0) || null;
}

/**
 * 启动时同步一次人格快照。失败只写 note，绝不让插件加载失败。
 * 返回快照对象（runtime.persona 是同一个引用）。
 */
async function syncPersona(runtime) {
  const snapshot = runtime.persona;
  const cfg = personaConfigOf(runtime.personaConfig);
  snapshot.mode = cfg.mode;
  snapshot.kind = cfg.kind;
  snapshot.result = "idle";
  if (cfg.kind === "none") {
    runtime.note("人格快照：未配置来源（kind=none），本次跳过");
    return snapshot;
  }
  const bridge = runtime.personaBridge || (await loadPersonaBridge());
  if (!bridge) {
    snapshot.result = "unavailable";
    runtime.note("人格快照：persona-bridge 未就绪，本次跳过（kind=" + cfg.kind + "）");
    return snapshot;
  }
  let source = null;
  try {
    // 桥接只认 config.persona；override 注入的块也要合进去，否则真实桥会看到 kind=none
    const block = Object.assign({}, runtime.personaConfig || {}, { mode: cfg.mode, kind: cfg.kind });
    source = await bridge.readPersonaSource(Object.assign({}, runtime.config, { persona: block }), {});
  } catch (error) {
    snapshot.result = "failed";
    runtime.note("人格快照读取失败：" + messageOf(error));
    return snapshot;
  }
  if (!source || source.ok !== true) {
    snapshot.result = "failed";
    snapshot.code = (source && source.code) || "read-failed";
    runtime.note("人格快照：读取失败（" + snapshot.code + "）");
    return snapshot;
  }
  const now = runtime.personaClock();
  let records = [];
  try {
    records = runtime.store.all();
  } catch {
    records = [];
  }
  const plan = bridge.planPersonaRecord({ records, text: source.text, hash: source.hash, now });
  const existing = findPersonaRecord(records, bridge);
  const meta = { topic: ["persona"], personaSourceKey: PERSONA_KEY_FALLBACK, personaHash: String(source.hash), personaSource: cfg.kind };
  const refs = [PERSONA_REF, "persona-hash:" + String(source.hash)];
  try {
    // 契约给的计划优先；当 record 层丢掉扩展 meta 时（今天就是这样），用 sourceRefs 兜底保持幂等
    let action = plan && plan.action ? plan.action : "skip";
    if (action === "create" && existing) {
      action = personaHashOf(existing) === source.hash ? "skip" : "update";
    }
    let targetId = plan && plan.targetId ? plan.targetId : existing ? existing.id : "";
    if (action === "create") {
      const saved = runtime.store.insert(
        createRecord({ kind: "profile", tier: "persona", tierSource: "user", subject: "self", text: source.text, pinned: true, weight: 0.95, meta, sourceRefs: refs, createdAt: now }),
      );
      if (!saved.meta || saved.meta.personaSourceKey !== PERSONA_KEY_FALLBACK) {
        runtime.note("人格快照：record 层未保留扩展 meta，已用 sourceRefs 兜底定位");
      }
    } else if (action === "update") {
      const current = targetId ? runtime.store.get(targetId) : null;
      if (current) {
        runtime.store.upsert(Object.assign({}, current, { text: source.text, meta: Object.assign({}, current.meta, meta), sourceRefs: refs, updatedAt: now }));
      } else {
        action = "skip";
      }
    }
    snapshot.result = action;
    snapshot.lastSyncAt = now;
    snapshot.hash = String(source.hash || "");
    snapshot.code = "";
    const short = snapshot.hash.slice(0, 4) || "----";
    runtime.note(
      "人格快照：" + (action === "create" ? "已建立" : action === "update" ? "已更新" : "内容未变，跳过") + "（" + cfg.kind + "，hash " + short + "…）",
    );
  } catch (error) {
    snapshot.result = "failed";
    runtime.note("人格快照落库失败（已跳过）：" + messageOf(error));
  }
  return snapshot;
}

/**
 * 建 debug 门控日志器。
 * 所有输出都过这一道：debug 关掉时插件一个字符都不往宿主日志里写。
 * @param {object} ctx 宿主上下文。
 * @param {object} config 已解析配置。
 * @returns {{debug: Function, enabled: boolean}} 日志器。
 */
function createLog(ctx, config) {
  let logger = null;
  try {
    logger = ctx && typeof ctx.logger === "function" ? ctx.logger(name) : null;
  } catch {
    logger = null;
  }
  const enabled = Boolean(config && config.debug === true);
  function debug(message) {
    if (!enabled) return;
    try {
      if (logger && typeof logger.info === "function") logger.info(message);
    } catch {
      // 日志器自身报错不影响插件
    }
  }
  return { debug, enabled };
}

/** 读一个服务；不存在或读的时候炸了都当「没有这个面」。 */
function readService(ctx, serviceName) {
  try {
    if (!ctx || typeof ctx.get !== "function") return undefined;
    const service = ctx.get(serviceName);
    return service === null ? undefined : service;
  } catch {
    return undefined;
  }
}

/**
 * 服务现在就绪就立刻接线；没就绪则交给 ctx.inject 的软注入。
 * 软注入只延后回调，不会让插件停在 pending。
 * @param {object} ctx 宿主上下文。
 * @param {string} serviceName 服务名。
 * @param {Function} callback 拿到服务后的接线动作。
 * @returns {"ready"|"deferred"|"missing"} 接线状态。
 */
function whenService(ctx, serviceName, callback) {
  const current = readService(ctx, serviceName);
  if (current !== undefined) {
    try {
      callback(current, ctx);
    } catch {
      // 接线失败的降级由各自的面负责记账
    }
    return "ready";
  }
  if (ctx && typeof ctx.inject === "function") {
    try {
      ctx.inject([serviceName], (scoped) => {
        const service = readService(scoped, serviceName);
        if (service === undefined) return;
        try {
          callback(service, scoped);
        } catch {
          // 同上
        }
      });
      return "deferred";
    } catch {
      // 没有软注入面：保留「没有这个面」的降级
    }
  }
  return "missing";
}

/** 我们的注入消息（角色与形状照宿主自己的 notice 走）。 */
function ownMessage(text) {
  return {
    id: "mnemos-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: OWN_SOURCE },
  };
}

function isOwnMessage(message) {
  return Boolean(message && message.source && message.source.kind === OWN_SOURCE);
}

/**
 * 一轮该注入什么：拿候选 → 排序 → 渲染 → 计账。
 * 同步完成，异常一律吞成空串（注入面坏掉不能连累这一轮对话）。
 * @param {object} runtime 运行时。
 * @param {object} context 装配上下文（{agent, scope}）。
 * @returns {string} 注入文本。
 */
function renderForContext(runtime, context) {
  const config = runtime.config;
  const agent = context && context.agent ? context.agent : null;
  const session = agent && agent.session ? agent.session : null;
  const sessionId = session && typeof session.id === "string" ? session.id : "";
  let records;
  try {
    records = runtime.store.candidates({ limit: CANDIDATE_LIMIT });
  } catch (error) {
    runtime.note("读候选失败，这一轮不注入：" + messageOf(error));
    try {
      runtime.ledger.skip();
    } catch {
      // 计账失败也不影响注入
    }
    return "";
  }
  const query = latestUserText(session);
  const rendered = renderInjection({ query, records, index: runtime.index, config, now: Date.now() });
  try {
    runtime.ledger.record(sessionId, {
      ...rendered,
      budget: config.hotTokenBudget + config.injectTokenBudget,
      projection: runtime.projection,
    });
  } catch {
    // 计账失败不影响注入
  }
  return rendered.text;
}

/** 主注入面：systemPrompt 段。段文本是函数，每次装配按当前会话重算。 */
function mountSection(ctx, runtime) {
  const status = whenService(ctx, "systemPrompt", (service) => {
    if (!service || typeof service.section !== "function") {
      runtime.note("systemPrompt 没有 section()，主注入面改用 pre-step 追加");
      return;
    }
    if (runtime.state.sectionMounted) return;
    const disposer = service.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context) => {
        try {
          return renderForContext(runtime, context);
        } catch {
          return "";
        }
      },
    });
    runtime.track(disposer);
    runtime.state.sectionMounted = true;
    runtime.log.debug("注入段已挂载：" + SECTION_NAME);
  });
  if (status !== "ready") runtime.note("systemPrompt 面" + (status === "deferred" ? "未就绪（已挂软注入）" : "不存在") + "，主注入面改用 pre-step 追加");
}

/**
 * 上下文投影：旧正文超过 projection.triggerTokens 时折成一条合成消息。
 * 要点取自 store 里本会话已落的 turn 记录（不调模型）；任何异常都退回原 decision。
 * @param {object} runtime 运行时。
 * @param {object} payload pre-step 载荷（{agent, messages, step}）。
 * @param {object} decision 下游 decision（kind=enter）。
 * @returns {object} 可能改写 messages 的 decision。
 */
function projectDecision(runtime, payload, decision) {
  if (!runtime || !runtime.config) return decision;
  const projection = runtime.config.projection;
  if (!projection || projection.enabled === false) return decision;
  const messages = Array.isArray(decision.messages) ? decision.messages : null;
  if (!messages || messages.length === 0) return decision;
  try {
    const agent = payload ? payload.agent : null;
    const session = agent && agent.session ? agent.session : null;
    const sessionId = session && typeof session.id === "string" ? session.id : "";
    let records = [];
    if (sessionId) {
      try {
        records = runtime.store.candidates({ limit: CANDIDATE_LIMIT }).filter((record) => record.sessionId === sessionId);
      } catch {
        records = [];
      }
    }
    const result = projectMessages({ messages, records, config: runtime.config, now: Date.now() });
    if (!result.changed) return decision;
    runtime.projection = { ...result.stats, sessionId, at: Date.now() };
    runtime.log.debug("上下文投影：折叠 " + result.stats.folded + " 条 → " + result.stats.after + " tokens");
    return { ...decision, messages: result.messages };
  } catch (error) {
    runtime.note("上下文投影失败，本轮按原样发送：" + messageOf(error));
    return decision;
  }
}

/**
 * 辅助注入面：agent/pre-step 追加一条我们自己的消息。
 * 段已经挂上时什么都不做——同一段记忆在一轮里出现两次，比少注入更糟。
 */
function mountPreStep(ctx, runtime) {
  if (!ctx || typeof ctx.on !== "function") {
    runtime.note("没有事件面，pre-step 追加不可用");
    return;
  }
  runtime.state.preStepMounted = true;
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (!decision || typeof decision !== "object") return decision;
    if (decision.kind !== "enter") return decision;
    // 投影先跑：它管的是「删旧正文」，与注入面在不在无关
    const projected = projectDecision(runtime, payload, decision);
    if (runtime.state.sectionMounted) return projected;
    try {
      const agent = payload ? payload.agent : null;
      const text = renderForContext(runtime, { agent });
      if (!text) return projected;
      const messages = Array.isArray(projected.messages) ? projected.messages.slice() : [];
      const existing = messages.findIndex(isOwnMessage);
      const message = ownMessage(text);
      if (existing >= 0) messages[existing] = message;
      else messages.push(message);
      return { ...projected, messages };
    } catch {
      // 任何异常都退回原 decision：追加是锦上添花，不许改写下游决策
      return projected;
    }
  });
}

/** 落记忆面：会话事件。 */
function mountSessionEvents(ctx, runtime) {
  if (!ctx || typeof ctx.on !== "function") {
    runtime.note("没有事件面，会话事件无法落记忆");
    return;
  }
  const listener = (session, event) => {
    try {
      runtime.ingest.handleEvent(session, event);
    } catch (error) {
      runtime.note("摄取事件失败（已跳过）：" + messageOf(error));
    }
  };
  try {
    // global：会话事件是按会话派发的，全局监听才收得到别的 agent 的轮次
    ctx.on("session/event", listener, { global: true });
  } catch {
    try {
      ctx.on("session/event", listener);
    } catch {
      runtime.note("session/event 监听注册失败，落记忆降级为不可用");
    }
  }
}

/** 运维面：/mem 命令族。 */
function mountCommands(ctx, runtime) {
  const status = whenService(ctx, "commands", (service) => {
    if (!service || typeof service.register !== "function") {
      runtime.note("commands 没有 register()，/mem 不可用");
      return;
    }
    if (runtime.state.commandMounted) return;
    const definition = createMemCommand({
      persona: () => runtime.persona,
      store: runtime.store,
      config: runtime.config,
      index: runtime.index,
      ledger: runtime.ledger,
      ingest: runtime.ingest,
      tiering: runtime.tiering,
      notes: runtime.notes,
      now: () => Date.now(),
    });
    runtime.track(service.register(definition));
    runtime.state.commandMounted = true;
  });
  if (status !== "ready") runtime.note("commands 面" + (status === "deferred" ? "未就绪（已挂软注入）" : "不存在") + "，/mem 暂不可用");
}

/** 把工具返回值/渲染函数都关进 try/catch：工具异常只回报错值，不冒到管道上。 */
function guardTool(definition) {
  const execute = definition.execute;
  const render = definition.output && definition.output.render;
  return {
    ...definition,
    output: {
      ...definition.output,
      render(args, value) {
        try {
          return render(args, value);
        } catch {
          return [{ type: "text", text: definition.name + ": 结果渲染失败" }];
        }
      },
    },
    async execute(args, exec) {
      try {
        return await execute(args, exec);
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
  };
}

/** 工具面：搜索/写入/忘记。 */
function mountTools(ctx, runtime) {
  const status = whenService(ctx, "tools", (service) => {
    if (!service || typeof service.register !== "function") {
      runtime.note("tools 没有 register()，记忆工具不可用");
      return;
    }
    if (runtime.state.toolsMounted) return;
    const definitions = createMemoryTools({
      store: runtime.store,
      config: runtime.config,
      index: runtime.index,
      now: () => Date.now(),
    });
    for (const definition of definitions) {
      try {
        runtime.track(service.register(guardTool(definition)));
      } catch (error) {
        runtime.note("注册工具 " + definition.name + " 失败：" + messageOf(error));
      }
    }
    runtime.state.toolsMounted = true;
  });
  if (status !== "ready") runtime.note("tools 面" + (status === "deferred" ? "未就绪（已挂软注入）" : "不存在") + "，记忆工具暂不可用");
}

/* --------------------------------------------------------------- 面板路由 */

/** 面板取数路由：客户端按 `new URL('.dsh-mnemos/panel', document.baseURI)` 拼出来的就是它。 */
export const PANEL_PATH = "/.dsh-mnemos/panel";

function jsonResponse(res, status, payload, headers) {
  const body = JSON.stringify(payload);
  const base = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(headers || {}) };
  try {
    if (res && typeof res.writeHead === "function") res.writeHead(status, { ...base, "content-length": Buffer.byteLength(body) });
    if (res && typeof res.end === "function") res.end(body);
  } catch {
    // 连接已经断了：响应写不出去也没别的可做
  }
}

/**
 * 只放行本机请求：面板会带出记忆正文，绑定到 0.0.0.0 或被隧道转发时不该外泄。
 * 拿不到地址信息就放行——那是客户端形状的问题，不是安全判断。
 */
function nonLoopbackReason(req) {
  const socket = req && req.socket;
  const remote = socket && typeof socket.remoteAddress === "string" ? socket.remoteAddress : "";
  if (remote && !/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(remote)) {
    return "只允许本机访问（remoteAddress=" + remote + "）";
  }
  const headers = (req && req.headers) || {};
  const host = typeof headers.host === "string" ? headers.host : "";
  const hostname = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (hostname && !/^(127\.0\.0\.1|localhost|::1)$/.test(hostname)) return "只允许本机访问（Host=" + hostname + "）";
  return "";
}

/* --------------------------------------------------------- 面板：读与受控写 */

/** POST 的硬门槛：8KB 上限 + 自定义请求头。两者都是写通道的必要条件。 */
const PANEL_BODY_LIMIT = 8 * 1024;
const PANEL_HEADER = "x-dsh-mnemos";

function headerOf(req, name) {
  const headers = (req && req.headers) || {};
  const value = headers[name];
  if (Array.isArray(value)) return value.length ? String(value[0]) : "";
  return value == null ? "" : String(value);
}

/** 允许 application/json 与 application/*+json；charset 之类的参数不影响判定。 */
function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9.+-]+\+)?json\b/i.test(String(value == null ? "" : value).trim());
}

function panelClip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

function panelFail(res, status, error, code) {
  jsonResponse(res, status, { ok: false, error, code });
}

/**
 * 读 body，超限立刻放弃：不把整包收进内存，也不等对方发完。
 * @param {object} req http 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<{text?: string, tooLarge?: boolean, failed?: boolean}>} 读取结果。
 */
function readPanelBody(req, limit) {
  return new Promise(function (resolve) {
    if (!req || typeof req.on !== "function") {
      resolve({ failed: true });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    function done(result) {
      if (settled) return;
      settled = true;
      if (typeof req.removeListener === "function") {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
      }
      resolve(result);
    }
    function onData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > limit) {
        // 超限即断：先停流再销毁，避免对端继续灌
        try { if (typeof req.pause === "function") req.pause(); } catch { /* 已结束 */ }
        try { if (typeof req.destroy === "function") req.destroy(); } catch { /* 已销毁 */ }
        done({ tooLarge: true });
        return;
      }
      chunks.push(buffer);
    }
    function onEnd() {
      done({ text: Buffer.concat(chunks).toString("utf8") });
    }
    function onError() {
      done({ failed: true });
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/** 读通道：与升级前逐字一致（stats / budget / vector / recalls）。 */
function panelRead(runtime, res) {
  if (!runtime || !runtime.store) {
    jsonResponse(res, 503, { error: { reason: "记忆库未就绪（插件按降级挂载）" } });
    return;
  }
  if (runtime.state && runtime.state.closed) {
    jsonResponse(res, 503, { error: { reason: "记忆库已关闭（插件已卸载）" } });
    return;
  }
  if (runtime.panelState && runtime.panelState.mounted === false) {
    jsonResponse(res, 503, { error: { reason: runtime.panelState.reason || "面板路由未挂载" } });
    return;
  }
  const stats = runtime.store.stats();
  const snapshot = typeof runtime.ledger.snapshot === "function" ? runtime.ledger.snapshot() : {};
  const last = snapshot.last || {};
  jsonResponse(res, 200, {
    stats,
    budget: {
      tokens: Number.isFinite(last.tokens) ? last.tokens : 0,
      budget: Number.isFinite(last.budget) ? last.budget : 0,
      picks: Number.isFinite(last.picks) ? last.picks : 0,
      dropped: Array.isArray(last.dropped) ? last.dropped : [],
    },
    vector: typeof runtime.index.vectorStatus === "function" ? runtime.index.vectorStatus() : { state: "off" },
    recalls: Array.isArray(last.recalls) ? last.recalls : [],
  });
}

/**
 * 写通道：四个动作全部走与命令层相同的 store 调用。
 * 所有门槛（方法之外的头、体、本机）在碰到 store 之前判完。
 * @param {object} runtime 挂载句柄。
 * @param {object} body 已解析的 JSON 对象。
 * @param {object} res http 响应。
 * @returns {void}
 */
function panelAction(runtime, body, res) {
  const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
  const id = typeof body.id === "string" ? body.id.trim() : "";

  if (action === "search") {
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      panelFail(res, 400, "query 不能为空", "bad-request");
      return;
    }
    const rawLimit = Number(body.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(8, Math.max(1, Math.floor(rawLimit))) : 5;
    const records = runtime.store.candidates({ limit: 200 });
    const rows = rankRecords({ query, records, index: runtime.index, now: Date.now(), limit });
    jsonResponse(res, 200, {
      ok: true,
      rows: rows.map(function (row) {
        const record = row.record;
        return {
          id: String(record.id),
          text: panelClip(record.text, 200),
          score: Number(Number(row.score).toFixed(3)),
          tier: record.tier,
          pinned: record.pinned === true,
        };
      }),
    });
    return;
  }

  if (action === "forget") {
    if (!id) {
      panelFail(res, 400, "id 不能为空", "bad-request");
      return;
    }
    const removed = runtime.store.forget(id) === true;
    if (!removed) {
      panelFail(res, 404, "没有这条记忆：" + panelClip(id, 60), "not-found");
      return;
    }
    if (runtime.index && typeof runtime.index.remove === "function") runtime.index.remove(id);
    jsonResponse(res, 200, { ok: true, id });
    return;
  }

  if (action === "pin") {
    if (!id) {
      panelFail(res, 400, "id 不能为空", "bad-request");
      return;
    }
    if (typeof body.pinned !== "boolean") {
      panelFail(res, 400, "pinned 必须是 true 或 false", "bad-request");
      return;
    }
    const saved = runtime.store.setPinned(id, body.pinned);
    if (!saved) {
      panelFail(res, 404, "没有这条记忆：" + panelClip(id, 60), "not-found");
      return;
    }
    jsonResponse(res, 200, { ok: true, id, pinned: saved.pinned === true });
    return;
  }

  if (action === "tier") {
    const tier = typeof body.tier === "string" ? body.tier.trim().toLowerCase() : "";
    if (!id) {
      panelFail(res, 400, "id 不能为空", "bad-request");
      return;
    }
    if (!TIERS.includes(tier)) {
      panelFail(res, 400, "tier 只能是 " + TIERS.join(" | "), "bad-request");
      return;
    }
    const record = runtime.store.get(id);
    if (!record) {
      panelFail(res, 404, "没有这条记忆：" + panelClip(id, 60), "not-found");
      return;
    }
    runtime.store.upsert({ ...record, tier, tierSource: "user" });
    jsonResponse(res, 200, { ok: true, id, tier, tierSource: "user" });
    return;
  }

  panelFail(res, 400, "未知的 action：" + (action || "(空)") + "；只支持 search | forget | pin | tier", "unsupported");
}

/** 写通道的门槛判定：任何一条不过就拒绝，且此时还没碰过 store。 */
function panelWriteGate(runtime, req, res) {
  if (!isJsonContentType(headerOf(req, "content-type"))) {
    panelFail(res, 400, "content-type 必须是 application/json", "bad-request");
    return false;
  }
  if (headerOf(req, PANEL_HEADER) !== "1") {
    panelFail(res, 400, "缺少请求头 " + PANEL_HEADER + ": 1", "bad-request");
    return false;
  }
  const declared = Number(headerOf(req, "content-length"));
  if (Number.isFinite(declared) && declared > PANEL_BODY_LIMIT) {
    panelFail(res, 413, "body 超过 " + PANEL_BODY_LIMIT + " 字节", "bad-request");
    return false;
  }
  if (!runtime || !runtime.store) {
    panelFail(res, 503, "记忆库未就绪（插件按降级挂载）", "unsupported");
    return false;
  }
  if (runtime.state && runtime.state.closed) {
    panelFail(res, 503, "记忆库已关闭（插件已卸载）", "unsupported");
    return false;
  }
  if (runtime.panelState && runtime.panelState.mounted === false) {
    panelFail(res, 503, runtime.panelState.reason || "面板路由未挂载", "unsupported");
    return false;
  }
  return true;
}

/**
 * 面板处理器：GET 读、POST 受控写，任何失败都回可读 JSON。
 * @param {object} runtime 挂载句柄。
 * @returns {Function} http 处理器。
 */
export function createPanelHandler(runtime) {
  return async function panelHandler(req, res) {
    try {
      const method = String((req && req.method) || "GET").toUpperCase();
      if (method !== "GET" && method !== "POST") {
        jsonResponse(res, 405, { error: { reason: "只接受 GET（读）与 POST（写）" } }, { allow: "GET, POST" });
        return;
      }
      const guard = nonLoopbackReason(req);
      if (guard) {
        // 读通道沿用旧形状（客户端按 reason 取文案），写通道给结构化 {ok:false,code}
        if (method === "POST") panelFail(res, 403, guard, "bad-request");
        else jsonResponse(res, 403, { error: { reason: guard } });
        return;
      }
      if (method === "GET") {
        panelRead(runtime, res);
        return;
      }
      if (!panelWriteGate(runtime, req, res)) return;
      const body = await readPanelBody(req, PANEL_BODY_LIMIT);
      if (body.tooLarge) {
        panelFail(res, 413, "body 超过 " + PANEL_BODY_LIMIT + " 字节", "bad-request");
        return;
      }
      if (body.failed || typeof body.text !== "string") {
        panelFail(res, 400, "读取请求体失败", "bad-request");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        panelFail(res, 400, "body 必须是合法 JSON", "bad-request");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        panelFail(res, 400, "body 必须是 JSON 对象", "bad-request");
        return;
      }
      panelAction(runtime, parsed, res);
    } catch (error) {
      // 宿主 await 这个 handler 且不吞异常：兜住，别让一次请求打穿 HTTP 循环
      panelFail(res, 500, messageOf(error), "internal");
      try {
        runtime.log.debug("面板请求失败：" + messageOf(error));
      } catch {
        // 日志器自身报错也不能影响响应
      }
    }
  };
}

/** 面板路由：webServer 在真实组合里晚于插件发布，所以走软注入而不是一次性 ctx.get。 */
function mountPanel(ctx, runtime) {
  const handler = createPanelHandler(runtime);
  runtime.panel = handler;
  runtime.panelState = { mounted: false, reason: "webServer 面不存在，面板路由未挂载" };
  const status = whenService(ctx, "webServer", (server) => {
    if (!server || typeof server.register !== "function") {
      runtime.panelState = { mounted: false, reason: "webServer 没有 register()，面板路由未挂载" };
      return;
    }
    if (runtime.panelState.mounted) return;
    runtime.track(server.register({ kind: "exact", path: PANEL_PATH, handler }));
    runtime.panelState = { mounted: true, reason: "" };
    runtime.log.debug("面板路由已挂载：" + PANEL_PATH);
  });
  if (status !== "ready" && !runtime.panelState.mounted) {
    runtime.note(
      "webServer 面" + (status === "deferred" ? "未就绪（已挂软注入）" : "不存在") + "，面板路由未挂载（面板会显示不可用）"
    );
  }
}

/** 卸载面：先撤注册，再 flush 未落库的记录，最后关库。 */
function mountDispose(ctx, runtime) {
  const cleanup = () => {
    if (runtime.state.closed) return;
    runtime.state.closed = true;
    for (let i = runtime.disposables.length - 1; i >= 0; i -= 1) {
      try {
        runtime.disposables[i]();
      } catch {
        // 撤销注册失败不影响关库
      }
    }
    runtime.disposables.length = 0;
    try {
      runtime.ingest.flush();
    } catch (error) {
      runtime.note("关库前 flush 失败：" + messageOf(error));
    }
    try {
      runtime.store.close();
    } catch (error) {
      runtime.note("关库失败：" + messageOf(error));
    }
  };
  runtime.dispose = cleanup;
  try {
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => cleanup(), "dsh-mnemos.dispose");
      return;
    }
  } catch (error) {
    runtime.note("effect 注册失败：" + messageOf(error));
  }
  try {
    if (typeof ctx.on === "function") ctx.on("dispose", cleanup);
  } catch {
    runtime.note("dispose 监听注册失败，退出时不会自动关库");
  }
}

/**
 * 挂载插件（apply 的可测形态：返回运行时句柄，失败返回 undefined 或降级句柄）。
 * @param {object} ctx 宿主上下文。
 * @param {object} rawConfig 宿主配置（不可信）。
 * @returns {object|undefined} 运行时句柄。
 */
export function mount(ctx, rawConfig, overrides) {
  const notes = [];
  const warnings = [];
  let config;
  try {
    config = resolveConfig(rawConfig, { warnings });
  } catch (error) {
    return undefined;
  }
  for (const warning of warnings) notes.push(warning);

  const log = createLog(ctx, config);
  const base = { config, notes, log, degraded: () => notes.slice(), dispose() {} };
  if (!config.enabled) {
    log.debug("enabled=false：不注册任何宿主面");
    return { ...base, disabled: true };
  }

  let store;
  try {
    store = createStore({ dataDir: config.dataDir, now: () => Date.now() });
  } catch (error) {
    notes.push("记忆库打不开，插件这次不挂载：" + messageOf(error));
    log.debug(notes[notes.length - 1]);
    return { ...base, store: null };
  }

  const note = (message) => {
    if (notes.length >= 32) return;
    notes.push(String(message));
    log.debug(String(message));
  };

  // ingest.llm 不是摆设：没实现就在启动时说清楚，别让配置项假装生效
  if (config.ingest && config.ingest.llm !== "off") {
    note("LLM 抽取未实现（v2 才有），本轮走规则抽取：ingest.llm=" + String(config.ingest.llm));
  }

  const index = createRetrievalIndex({ config, note });
  try {
    index.load(store.all());
  } catch (error) {
    note("索引初建失败，检索退化为纯热度：" + messageOf(error));
  }

  // 启动时重算一次分层：惰性判定的账一次性结清，运行期只按写入扫
  const tieringState = { last: null, totals: { changed: 0, applied: 0 } };
  const startupSweep = demoteSweep({ store, config, now: Date.now(), source: "startup" });
  tieringState.last = startupSweep;
  tieringState.totals.changed += startupSweep.changed;
  tieringState.totals.applied += startupSweep.applied;
  if (startupSweep.error) note("启动分层重算失败（已跳过）：" + startupSweep.error);
  else if (startupSweep.enabled) {
    note("分层：本次降级 " + startupSweep.applied + " 条（跳过 " + startupSweep.skipped + "，启动重算）");
  }

  const personaBlock = (overrides && overrides.persona) || (config && config.persona) || null;
  const runtime = {
    ...base,
    store,
    index,
    tiering: tieringState,
    personaClock: overrides && typeof overrides.now === "function" ? overrides.now : () => Date.now(),
    personaPending: null,
    // 人格桥接快照：/mem status 与面板读这一份
    persona: {
      mode: personaConfigOf(personaBlock).mode,
      kind: personaConfigOf(personaBlock).kind,
      refresh: personaBlock && personaBlock.refresh === "turn" ? "turn" : "startup",
      lastSyncAt: null,
      hash: "",
      result: "idle",
      code: "",
      lastTrigger: "startup",
      lastAttemptAt: 0,
      turnSyncs: 0,
      inFlight: false,
    },
    // 生产读 config.persona；overrides.persona 只给测试注入用
    personaConfig: personaBlock,
    personaBridge: (overrides && overrides.bridge) || null,
    personaReady: null,
    notes,
    log,
    ledger: createLedger(),
    ingest: null,
    // 最近一次投影的账：/mem status 与面板读这一份，不在别处另算
    projection: null,
    disposables: [],
    state: { sectionMounted: false, preStepMounted: false, commandMounted: false, toolsMounted: false, closed: false },
    note,
    degraded() {
      return notes.slice();
    },
    track(value) {
      if (typeof value === "function") runtime.disposables.push(value);
      return value;
    },
    render(context) {
      return renderForContext(runtime, context);
    },
    snapshot() {
      let stats = {};
      try {
        stats = store.stats();
      } catch (error) {
        stats = { error: messageOf(error) };
      }
      return {
        config,
        stats,
        index: index.stats(),
        ledger: runtime.ledger.snapshot(),
        ingest: runtime.ingest ? runtime.ingest.stats() : null,
        tiering: { last: runtime.tiering.last, totals: { ...runtime.tiering.totals } },
        persona: { ...runtime.persona },
        state: { ...runtime.state },
        notes: notes.slice(),
      };
    },
  };
  runtime.ingest = createIngest({
    store,
    index,
    config,
    note,
    // 写入后扫描的结果回填到同一份快照，/mem status 只读这一份
    onTiering(swept) {
      runtime.tiering.last = swept;
      runtime.tiering.totals.changed += swept.changed;
      runtime.tiering.totals.applied += swept.applied;
    },
  });

  // 人格快照：启动同步一次；失败只记 note，不阻塞挂载
  runtime.personaReady = syncPersona(runtime).catch((error) => {
    runtime.persona.result = "failed";
    runtime.note("人格快照同步异常（已跳过）：" + messageOf(error));
    return runtime.persona;
  });

  mountSection(ctx, runtime);
  mountPreStep(ctx, runtime);
  mountPersonaTurn(ctx, runtime);
  mountSessionEvents(ctx, runtime);
  mountCommands(ctx, runtime);
  mountTools(ctx, runtime);
  mountPanel(ctx, runtime);
  mountDispose(ctx, runtime);
  return runtime;
}

/**
 * 宿主入口。
 * @param {object} ctx cordis 上下文。
 * @param {object} config 宿主传入的插件配置。
 * @returns {object|undefined} 运行时句柄（宿主忽略返回值）。
 */
export function apply(ctx, config) {
  try {
    return mount(ctx, config);
  } catch {
    // 最后一道闸：宁可这次不挂载，也不把异常抛回宿主。
    // 这里连日志都不写：走到这一步说明配置都没解析出来，debug 开关不可知。
    return undefined;
  }
}
