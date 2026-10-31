/**
 * 会话语义 → MemoryRecord 的落地口。
 *
 * 三条规矩写在最前面，因为后面的代码都是它们的推论：
 * 1. 同一 turn 只落一条记录，幂等键由 sessionId + 事件序号（退化到 id/时间戳/正文哈希）组成；
 * 2. 记录 id 由幂等键派生，所以「重启后重放同一事件」是 upsert 覆盖而不是多一条；
 * 3. 落库按批 flush，合并只在写入满 config.ingest.everyTurns 轮时同步跑一次——
 *    没有后台调度器，这是 v1 的边界。
 */

import { planMerge } from "../consolidate.mjs";
import { estimateEmotion } from "../emotion.mjs";
import { createRecord } from "../record.mjs";
import { applyTiering, reviveOnMentionPatch } from "../tiering.mjs";

/** 一批最多攒多少条再落库：攒太多会在崩溃时丢掉整段对话，攒太少等于没批量。 */
export const BATCH_LIMIT = 8;

/** 幂等键去重的记忆深度：只防重复投递，不是历史索引。 */
const SEEN_LIMIT = 4096;

/** turn 记录是低权重的原料：权重高到 0.75 以上就再也进不了合并了。 */
const TURN_WEIGHT = 0.45;

/** 不入库的消息来源：我们自己的注入不能反过来被当成用户说的话。 */
const OWN_SOURCE = "dsh-mnemos";

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function clip(text, max) {
  const source = String(text == null ? "" : text);
  return source.length <= max ? source : source.slice(0, max);
}

/* --------------------------------------------------------------- 元数据抽取 */

/**
 * 确定性元数据抽取：不调模型，只按固定顺序套规则。
 * 顺序是契约的一部分——先命中先赢，同一段文本永远抽出同一份 meta。
 * record.mjs 把 time 收成字符串、把 person/object/topic 收成数组，所以这里只产出这些形状。
 */

const MS_DAY = 86400000;
const WEEKDAY_CHARS = ["日", "一", "二", "三", "四", "五", "六"];

/** 相对日，长的在前：不然「大前天」会被「前天」先吃掉。 */
const RELATIVE_DAYS = [["大前天", -3], ["前天", -2], ["昨天", -1], ["今天", 0], ["明天", 1], ["后天", 2]];

const CITIES = [
  "杭州", "北京", "上海", "深圳", "广州", "成都", "南京", "武汉", "西安", "香港", "台北",
  "东京", "首尔", "纽约", "伦敦", "巴黎", "新加坡", "苏州", "重庆", "天津", "厦门", "青岛",
  "长沙", "合肥", "济南", "郑州", "昆明", "大连", "宁波",
];

const PLACE_SUFFIXES = [
  "咖啡店", "咖啡馆", "超市", "医院", "学校", "大学", "公司", "公园", "机场", "车站",
  "餐厅", "商场", "书店", "图书馆", "小区",
];

const PERSON_WORDS = [
  "男朋友", "女朋友", "我妈", "我爸", "我哥", "我姐", "我弟", "我妹", "我朋友", "我同事",
  "老婆", "老公", "同事", "朋友", "老板", "领导", "老师", "同学", "室友", "妈妈", "爸爸",
  "哥哥", "姐姐", "弟弟", "妹妹", "儿子", "女儿",
];

const OBJECT_SEEDS = [
  "相机", "胶片", "镜头", "电脑", "手机", "键盘", "吉他", "猫", "狗", "咖啡", "论文",
  "游戏", "电影", "音乐", "照片", "代码", "数据库", "自行车", "盆栽",
];

const TOPIC_SEEDS = [
  "摄影", "旅行", "加班", "面试", "考研", "期末", "工作", "学习", "健身", "恋爱", "分手",
  "搬家", "生病", "考试",
];

/** 「的<名词>」里以这些动词开头的多半不是名词：宁可漏抽，不要塞错。 */
const VERB_STARTS = ["准备", "想", "说", "写", "做", "看", "买", "吃", "睡", "学习", "工作", "加班", "开"];

function pad2(value) {
  return String(value).padStart(2, "0");
}

function utcMidnight(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 那一周的周一（UTC，按周一为首日）：相对周的说法都换算成这一天。 */
function mondayOf(ms) {
  const base = utcMidnight(ms);
  const day = new Date(base).getUTCDay();
  return base - ((day + 6) % 7) * MS_DAY;
}

function dedupe(list) {
  const out = [];
  for (const item of list) {
    const value = String(item == null ? "" : item).trim();
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/** 时间：显式 ISO > 年月 > 相对年 > 无年份月份 > 相对周 > 相对日。 */
function timeOf(text, now) {
  let match = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match) return match[1] + "-" + match[2] + "-" + match[3];
  match = /(\d{4})-(\d{2})/.exec(text);
  if (match) return match[1] + "-" + match[2];
  match = /(\d{4})\s*年\s*(\d{1,2})\s*月/.exec(text);
  if (match) return match[1] + "-" + pad2(Number(match[2]));
  match = /(\d{4})\s*年/.exec(text);
  if (match) return match[1];

  const year = new Date(utcMidnight(now)).getUTCFullYear();
  if (text.includes("前年")) return String(year - 2);
  if (text.includes("去年")) return String(year - 1);
  if (text.includes("今年") || text.includes("本年")) return String(year);

  match = /(\d{1,2})\s*月/.exec(text);
  if (match) {
    const month = Number(match[1]);
    if (month >= 1 && month <= 12) return year + "-" + pad2(month);
  }

  match = /([上下这本])\s*(?:周|星期|礼拜)\s*([日一二三四五六天])/.exec(text);
  if (match) {
    const char = match[2] === "天" ? "日" : match[2];
    const offset = (WEEKDAY_CHARS.indexOf(char) + 6) % 7;
    const shift = match[1] === "上" ? -7 : match[1] === "下" ? 7 : 0;
    return isoDay(mondayOf(now) + shift * MS_DAY + offset * MS_DAY);
  }
  match = /([上下这本])\s*(?:周|星期|礼拜)/.exec(text);
  if (match) {
    const shift = match[1] === "上" ? -7 : match[1] === "下" ? 7 : 0;
    return isoDay(mondayOf(now) + shift * MS_DAY);
  }
  for (const [word, delta] of RELATIVE_DAYS) {
    if (text.includes(word)) return isoDay(utcMidnight(now) + delta * MS_DAY);
  }
  return "";
}

/** 地点里夹着时间词是正则回溯的常态：「下周三去医院」要收成「医院」。 */
const LEADING_TIME = /^(?:[上下这本]\s*(?:周|星期|礼拜)[日一二三四五六天]?|大前天|前天|昨天|今天|明天|后天|前年|去年|今年)/;

function cleanPlace(value) {
  let text = String(value).trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const next = text.replace(LEADING_TIME, "").replace(/^[的了在去到\s]+/, "");
    if (next === text) break;
    text = next;
  }
  return text.trim();
}

/** 地点：已知城市优先，其次「在/去 + …店/院/校」，最后才退到裸的「在家」。 */
function placeOf(text) {
  for (const city of CITIES) if (text.includes(city)) return city;
  const suffix = PLACE_SUFFIXES.join("|");
  let match = new RegExp("(?:在|去|到)([\\u4e00-\\u9fff]{1,6}?(?:" + suffix + "))").exec(text);
  if (match) return cleanPlace(match[1]);
  match = new RegExp("([\\u4e00-\\u9fff]{1,4}(?:" + suffix + "))").exec(text);
  if (match) return cleanPlace(match[1]);
  match = /(?:在|去|到)(家)/.exec(text);
  if (match) return match[1];
  return "";
}

/** 人物：角色词优先（长词先匹配并吃掉），其次「他说/她说」，最后「叫某人」。 */
function personOf(text, knownPeople) {
  const pool = dedupe([...PERSON_WORDS, ...(Array.isArray(knownPeople) ? knownPeople : [])]).sort(
    (left, right) => right.length - left.length
  );
  const found = [];
  let rest = text;
  for (const word of pool) {
    if (!rest.includes(word)) continue;
    found.push(word);
    rest = rest.split(word).join("\u3000");
  }
  const speak = /([他她])说/.exec(text);
  if (speak) found.push(speak[1]);
  const named = /(?:叫|名叫)([\u4e00-\u9fff]{2,3})/.exec(text);
  if (named) found.push(named[1]);
  return dedupe(found);
}

/** 物品：种子词 + 「的<名词>」，动词开头与地点后缀一律跳过。 */
/** 紧跟着这些字的种子词其实在说地点（「咖啡店」），不是物品。 */
const PLACE_TAIL = /^[店馆院校司园场站厅楼]/;

function objectOf(text) {
  const found = [];
  for (const word of OBJECT_SEEDS) {
    const at = text.indexOf(word);
    if (at < 0) continue;
    if (PLACE_TAIL.test(text.charAt(at + word.length))) continue;
    found.push(word);
  }
  const possessive = /的([\u4e00-\u9fff]{2,3})/g;
  let match;
  while ((match = possessive.exec(text)) !== null) {
    const word = match[1];
    if (VERB_STARTS.some((verb) => word.startsWith(verb))) continue;
    if (PLACE_SUFFIXES.some((suffix) => word.endsWith(suffix))) continue;
    if (PERSON_WORDS.includes(word)) continue;
    found.push(word);
  }
  return dedupe(found);
}

/**
 * 抽一条文本的元数据；抽不到就整条不写字段（不塞空串）。
 * @param {string} text 正文。
 * @param {{now?: number, knownPeople?: string[]}} options 时间基准与已知昵称。
 * @returns {object} meta（可能为空对象）。
 */
export function extractMeta(text, options = {}) {
  const source = typeof text === "string" ? text : "";
  if (!source.trim()) return {};
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const meta = {};
  const time = timeOf(source, now);
  if (time) meta.time = time;
  const place = placeOf(source);
  if (place) meta.place = place;
  const person = personOf(source, options.knownPeople);
  if (person.length) meta.person = person;
  const object = objectOf(source);
  if (object.length) meta.object = object;
  const topic = dedupe(TOPIC_SEEDS.filter((word) => source.includes(word)));
  if (topic.length) meta.topic = topic;
  return meta;
}

/**
 * 从会话事件里抽取模型可见文本，容忍字符串与 block 数组两种形态。
 * 形状不认识就返回空串——畸形事件不该让记忆层报错。
 * @param {unknown} data 事件 data（或消息体）。
 * @returns {string} 抽到的文本。
 */
export function messageText(data) {
  if (typeof data === "string") return data.trim();
  if (!data || typeof data !== "object") return "";
  const record = data;
  if (typeof record.text === "string") return record.text.trim();
  const content = record.content ?? record.message ?? (record.data && record.data.content);
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") parts.push(block);
    else if (block && typeof block === "object" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

/** 幂等键：优先事件序号，其次事件 id、时间戳，最后退到正文哈希。 */
export function ingestKey(sessionId, event, text) {
  const scope = typeof sessionId === "string" && sessionId ? sessionId : "unknown-session";
  if (event && Number.isFinite(event.seq)) return scope + "|seq:" + event.seq;
  if (event && typeof event.id === "string" && event.id.trim()) return scope + "|id:" + event.id.trim();
  const at = event && Number.isFinite(event.at) ? event.at : event && Number.isFinite(event.time) ? event.time : null;
  if (at !== null) return scope + "|at:" + at;
  return scope + "|text:" + fnv1a(clip(text, 400));
}

/** 由幂等键派生记录 id：同键必然同 id，重复投递只会覆盖同一条。 */
export function recordIdFor(key, createdAt) {
  const stamp = Math.floor(Number.isFinite(createdAt) ? createdAt : Date.now()).toString(36);
  return "turn-" + stamp + "-" + fnv1a(key);
}

/**
 * 分层扫描：先把「够老且还在 hot」的记录粗筛出来，再交给 applyTiering。
 * 粗筛用 createdAt 比时间点，不碰 heatOf —— 全量逐条算热度才是这里真正的 O(n) 成本。
 * @param {{store?: object, config?: object, now?: number, source?: string}} options 依赖。
 * @returns {{changed: number, skipped: number, applied: number, at: number, source: string, enabled: boolean, error?: string}} 扫描结果。
 */
export function demoteSweep(options = {}) {
  const store = options.store;
  const config = options.config || {};
  const tiering = config.tiering || {};
  const at = Number.isFinite(options.now) ? options.now : Date.now();
  const result = { changed: 0, skipped: 0, applied: 0, at, source: options.source || "manual", enabled: tiering.enabled !== false };
  if (tiering.enabled === false) return result;
  if (!store || typeof store.candidates !== "function" || typeof store.upsert !== "function") return result;
  try {
    const demoteAfterDays = Number.isFinite(tiering.demoteAfterDays) ? Math.max(0, tiering.demoteAfterDays) : 30;
    const cutoff = at - demoteAfterDays * MS_DAY;
    // 粗筛：年龄不够或已经不是 hot 的记录根本进不了判据，直接不参与
    const candidates = store.candidates({}).filter(function (record) {
      return record && record.tier === "hot" && Number(record.createdAt) <= cutoff;
    });
    if (!candidates.length) return result;
    const applied = applyTiering(candidates, at, tiering);
    result.changed = applied.changed;
    result.skipped = applied.skipped;
    for (const patch of applied.patches) {
      const record = typeof store.get === "function" ? store.get(patch.id) : null;
      if (!record) continue;
      store.upsert({ ...record, tier: patch.tier, tierSource: patch.tierSource });
      result.applied += 1;
    }
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
  }
  return result;
}

/**
 * 建一个会话事件摄取器。
 * @param {object} options 依赖。
 * @returns {object} 摄取器。
 */
export function createIngest(options = {}) {
  const store = options.store;
  const index = options.index;
  const config = options.config || {};
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const note = typeof options.note === "function" ? options.note : () => {};
  const onTiering = typeof options.onTiering === "function" ? options.onTiering : null;
  const everyTurns = Math.max(1, Math.floor(Number(config.ingest && config.ingest.everyTurns) || 20));

  const seen = new Map();
  const pending = [];
  const counters = { events: 0, stored: 0, duplicates: 0, skipped: 0, batches: 0, turns: 0, merges: 0, mergeErrors: 0, lastMergeAt: 0, demoted: 0, revived: 0 };

  function remember(key) {
    seen.set(key, true);
    if (seen.size <= SEEN_LIMIT) return;
    // 只丢最早的一批键：顺序遍历 Map 就是插入顺序
    let drop = seen.size - SEEN_LIMIT;
    for (const old of seen.keys()) {
      seen.delete(old);
      drop -= 1;
      if (drop <= 0) break;
    }
  }

  /** 合并：一次全量扫描 + 每组一次 store.merge；失败只记账，不打断写入。 */
  function runMerge() {
    if (typeof store.all !== "function" || typeof store.merge !== "function") return 0;
    let groups = 0;
    try {
      const records = store.all();
      const plan = planMerge(records);
      for (let i = 0; i < plan.groups.length; i += 1) {
        const keepId = plan.keep[i];
        const dropIds = plan.groups[i].filter((id) => id !== keepId);
        if (!dropIds.length) continue;
        const before = typeof store.get === "function" ? store.get(keepId) : null;
        const merged = store.merge(keepId, dropIds, plan.patchById[keepId]);
        // 合并把 mentions 累加起来了：冷记录被重新提起过，就该回到 hot
        const revive = reviveOnMentionPatch(merged, before ? Number(before.mentions) || 0 : 0, config.tiering || {});
        if (revive && typeof store.upsert === "function") {
          store.upsert({ ...merged, ...revive });
          counters.revived += 1;
        }
        groups += 1;
      }
    } catch (error) {
      counters.mergeErrors += 1;
      note("合并失败，已跳过这一轮：" + (error && error.message ? error.message : String(error)));
      return groups;
    }
    if (groups > 0) {
      counters.merges += 1;
      // 合并会改正文与 mergedInto，索引必须跟着重建，否则检索仍指向被并掉的旧记录
      if (index && typeof index.reload === "function") {
        try {
          index.reload(typeof store.all === "function" ? store.all() : []);
        } catch (error) {
          note("合并后重建索引失败：" + (error && error.message ? error.message : String(error)));
        }
      }
    }
    return groups;
  }

  /** 把攒下的记录写进库；写满 everyTurns 轮时同步跑一次合并。 */
  function flush() {
    if (!pending.length) return 0;
    const batch = pending.splice(0, pending.length);
    let written = 0;
    for (const record of batch) {
      try {
        if (store && typeof store.upsert === "function") store.upsert(record);
        else if (store && typeof store.insert === "function") store.insert(record);
        else return 0;
        if (index && typeof index.add === "function") index.add(record);
        written += 1;
        counters.stored += 1;
        counters.turns += 1;
      } catch (error) {
        note("写入失败，已跳过这一条：" + (error && error.message ? error.message : String(error)));
      }
    }
    if (written > 0) {
      counters.batches += 1;
      // 只有这次真的写了才扫；扫的是粗筛子集，不是全量逐条算热度
      const swept = demoteSweep({ store, config, now: now(), source: "flush" });
      if (swept.error) note("写入后分层扫描失败（已跳过）：" + swept.error);
      else if (swept.applied > 0) {
        counters.demoted += swept.applied;
        note("分层：写入后降级 " + swept.applied + " 条");
      }
      if (onTiering) {
        try {
          onTiering(swept);
        } catch {
          // 回调只是记账，坏了不影响写入
        }
      }
    }
    // 只在「刚好攒满整轮数」时合并一次，攒不满就一直等——不引入定时器
    if (counters.turns > 0 && counters.turns % everyTurns === 0) {
      const last = counters.turns / everyTurns;
      if (last !== counters.lastMergeAt) {
        counters.lastMergeAt = last;
        runMerge();
      }
    }
    return written;
  }

  /**
   * 消费一条会话事件。
   * @param {object} session 会话（只需 id）。
   * @param {object} event 事件（type/data/seq）。
   * @returns {{stored: number, duplicate?: boolean}} 本次结果。
   */
  function handleEvent(session, event) {
    counters.events += 1;
    if (!event || typeof event !== "object") return { stored: 0 };
    const type = typeof event.type === "string" ? event.type : "";
    if (type !== "user/message") {
      // 轮次结束是天然的批量边界：一条不落就等下一个事件，不为攒批而攒批
      if (type === "turn/end") flush();
      return { stored: 0 };
    }
    const data = event.data;
    if (data && typeof data === "object" && data.source && data.source.kind === OWN_SOURCE) return { stored: 0 };
    const text = messageText(data);
    if (!text || text.length < 2) {
      counters.skipped += 1;
      return { stored: 0 };
    }
    const sessionId = session && typeof session.id === "string" ? session.id : "";
    const key = ingestKey(sessionId, event, text);
    if (seen.has(key)) {
      counters.duplicates += 1;
      return { stored: 0, duplicate: true };
    }
    remember(key);

    const createdAt = now();
    let record;
    try {
      record = createRecord(
        {
          kind: "turn",
          text: clip(text, 4000),
          sessionId: sessionId || undefined,
          weight: TURN_WEIGHT,
          mentions: 1,
          createdAt,
          updatedAt: createdAt,
          // 元数据是检索的软收窄入口：抽不到就不写该字段，空串会把索引撑成假命中
          meta: extractMeta(text, { now: createdAt }),
          emotion: estimateEmotion(text),
          sourceRefs: [key],
        },
        { now: createdAt }
      );
    } catch (error) {
      counters.skipped += 1;
      note("记录构造失败，已跳过这条事件：" + (error && error.message ? error.message : String(error)));
      return { stored: 0 };
    }
    // id 由幂等键派生（createRecord 永远发新 id）：这样重启后重放同一事件也不会多出一条
    pending.push({ ...record, id: recordIdFor(key, createdAt) });
    if (pending.length >= BATCH_LIMIT) flush();
    return { stored: 0, queued: pending.length };
  }

  function stats() {
    return { ...counters, pending: pending.length, everyTurns };
  }

  return { handleEvent, flush, stats, runMerge };
}
