// 元数据多入口索引：时间 / 地点 / 人物 / 物品 / 主题。
// 检索侧只做「软收窄」：多线索取并集，而不是交集——交集一条对不上就把召回清零。

const MS_DAY = 86400000;

const DIM_KEYS = ['place', 'person', 'object', 'topic'];

// 刻意很小的种子同义词表：只覆盖验收里点名的天气族与几个高频族；扩表属后续可配置项。
const TOPIC_SYNONYMS = new Map([
  ['下雨', ['雨', '降雨', '雨天', '天气']],
  ['天气', ['下雨', '降雨', '雨天', '雨', '气温']],
  ['堵车', ['交通', '事故', '拥堵']],
  ['加班', ['工作', '熬夜']],
  ['开心', ['高兴', '快乐', '愉快']],
  ['难过', ['伤心', '低落']],
]);

function toValues(v) {
  if (v == null) return [];
  if (Array.isArray(v)) {
    const out = [];
    for (const item of v) out.push(...toValues(item));
    return out;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    return s ? [s] : [];
  }
  if (typeof v === 'number') return Number.isFinite(v) ? [String(v)] : [];
  if (v instanceof Date) return [v.toISOString()];
  return [];
}

function norm(s) {
  return String(s)
    .toLowerCase()
    .replace(/[\s,，。、;；:：!！?？"'“”‘’()（）\[\]【】]/g, '');
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function intervalOfParts(y, mo, d) {
  if (mo == null) return [Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1) - 1];
  if (d == null) return [Date.UTC(y, mo - 1, 1), Date.UTC(y, mo, 1) - 1];
  return [Date.UTC(y, mo - 1, d), Date.UTC(y, mo - 1, d + 1) - 1];
}

// 统一成闭区间 [from, to]：区间线索、单点线索、'2024' / '2024-03' / ISO 串都可比。
function parseInterval(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? [v, v] : null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? [t, t] : null;
  }
  if (Array.isArray(v) && v.length === 2) {
    const a = parseInterval(v[0]);
    const b = parseInterval(v[1]);
    if (!a && !b) return null;
    return [a ? a[0] : -Infinity, b ? b[1] : Infinity];
  }
  if (typeof v === 'object') {
    const from = parseInterval(v.from);
    const to = parseInterval(v.to);
    if (!from && !to) return null;
    return [from ? from[0] : -Infinity, to ? to[1] : Infinity];
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) return intervalOfParts(+m[1], +m[2], +m[3]);
    m = /^(\d{4})-(\d{2})$/.exec(s);
    if (m) return intervalOfParts(+m[1], +m[2]);
    m = /^(\d{4})$/.exec(s);
    if (m) return intervalOfParts(+m[1]);
    const t = Date.parse(s);
    return Number.isFinite(t) ? [t, t] : null;
  }
  return null;
}

function intervalsOverlap(a, b) {
  return a[0] <= b[1] && b[0] <= a[1];
}

function expandTopic(key, values) {
  if (key !== 'topic') return values;
  const out = new Set(values);
  for (const v of values) {
    for (const [head, tails] of TOPIC_SYNONYMS) {
      if (v === head || v.includes(head)) {
        out.add(head);
        for (const t of tails) out.add(t);
      }
    }
  }
  return [...out];
}

export function createMetaIndex() {
  const entries = new Map();

  function add(record) {
    if (!record || record.id == null) return;
    const meta = record.meta || {};
    const place = toValues(meta.place).map(norm).filter(Boolean);
    const person = toValues(meta.person).map(norm).filter(Boolean);
    const object = toValues(meta.object).map(norm).filter(Boolean);
    const topic = toValues(meta.topic).map(norm).filter(Boolean);
    // blob 在写入时拼好：排序阶段按记录调用 matchScore 时只剩一次 includes，
    // 否则每条记录每次查询都要重新拼字符串
    const blob = [...place, ...person, ...object, ...topic].join('\u0001');
    entries.set(record.id, { time: parseInterval(meta.time), place, person, object, topic, blob });
  }

  function remove(id) {
    return entries.delete(id);
  }

  function addAll(records) {
    if (!Array.isArray(records)) return 0;
    let n = 0;
    for (const r of records) {
      add(r);
      n++;
    }
    return n;
  }

  function narrow(clues) {
    if (!clues || typeof clues !== 'object') return null;
    const dims = [];
    if (clues.time != null) {
      const range = parseInterval(clues.time);
      if (range) dims.push({ key: 'time', range });
    }
    for (const key of DIM_KEYS) {
      const values = toValues(clues[key]).map(norm).filter(Boolean);
      if (values.length) dims.push({ key, values: expandTopic(key, values) });
    }
    if (!dims.length) return null;

    const hits = new Set();
    for (const [id, entry] of entries) {
      for (const dim of dims) {
        if (dim.key === 'time') {
          if (entry.time && intervalsOverlap(entry.time, dim.range)) {
            hits.add(id);
            break;
          }
          continue;
        }
        const bucket = entry[dim.key];
        if (!bucket.length) continue;
        let matched = false;
        for (const rv of bucket) {
          for (const cv of dim.values) {
            if (overlaps(rv, cv)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) {
          hits.add(id);
          break;
        }
      }
    }
    // fail-open：线索全部落空时返回 null（不缩小范围）而不是空集合——
    // 置空召回比忽略一条错线索更糟，调用方仍需靠 bm25/vector 排序。
    return hits.size ? hits : null;
  }

  // 查询词对元数据字段的亲和度 0..1；id 不在索引里返回 null，
  // 让调用方退回读 record.meta，而不是把「未知」误判成「不相关」
  function matchScore(id, terms) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (!terms || !terms.length || !entry.blob) return 0;
    let hit = 0;
    let total = 0;
    for (const t of terms) {
      const w = t.length >= 2 ? 1 : 0.4; // 单字命中噪声大，权重压低
      total += w;
      if (entry.blob.includes(t)) hit += w;
    }
    return total > 0 ? hit / total : 0;
  }

  function size() {
    return entries.size;
  }

  return { add, remove, addAll, narrow, matchScore, size };
}
