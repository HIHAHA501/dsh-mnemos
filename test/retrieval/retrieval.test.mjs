import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { tokenize } from '../../src/retrieval/tokenize.mjs';
import { createBm25 } from '../../src/retrieval/bm25.mjs';
import { createMetaIndex } from '../../src/retrieval/metadata.mjs';
import { createVector, cosine } from '../../src/retrieval/vector.mjs';
import { rank, effectiveWeights, DEFAULT_WEIGHTS, MAX_RESULTS, UNI_GRAM_WEIGHT } from '../../src/retrieval/hybrid.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..', '..');

// ---------- 关键实现要求 1：中文友好分词 ----------

test('tokenize: 中文连续串切 1-gram 与 2-gram', () => {
  const t = tokenize('那台拍胶片的机器');
  for (const want of ['胶片', '机器', '拍', '那台', '的']) {
    assert.ok(t.includes(want), '缺少 token ' + want);
  }
  assert.ok(!t.some((x) => x.length > 2), 'CJK gram 不应超过 2 个字符');
});

test('tokenize: 拉丁词小写、数字保留、CJK 仍切 gram', () => {
  const t = tokenize('iPhone 15 Pro 的相机');
  for (const want of ['iphone', '15', 'pro', '相机']) {
    assert.ok(t.includes(want), '缺少 token ' + want);
  }
  assert.ok(!t.includes('iPhone'));
});

test('tokenize: 标点丢弃、不产生空 token', () => {
  const t = tokenize('天气，下雨了！真的吗？--ok');
  assert.ok(t.includes('ok'));
  assert.ok(t.includes('天气'));
  assert.ok(!t.includes('，'));
  assert.ok(!t.some((x) => x.length === 0));
});

test('tokenize: 超过 10000 字符截断并计数，不抛错', () => {
  tokenize.resetStats();
  const long = '雨'.repeat(12000);
  const t = tokenize(long);
  assert.ok(Array.isArray(t));
  assert.ok(t.length > 0 && t.length <= 20000);
  const s = tokenize.stats();
  assert.equal(s.truncatedInputs, 1);
  assert.equal(tokenize('短句').length > 0, true);
  assert.equal(tokenize.stats().truncatedInputs, 1);
});

test('tokenize: maxTokenLen 保护超长 ASCII 串', () => {
  tokenize.resetStats();
  const blob = 'a'.repeat(5000);
  const t = tokenize(blob);
  assert.equal(t.length, 1);
  assert.equal(t[0].length, tokenize.MAX_TOKEN_LEN);
  assert.equal(tokenize.stats().truncatedTokens, 1);
});

test('tokenize: null/空输入安全', () => {
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
  assert.deepEqual(tokenize(undefined), []);
});

// ---------- 关键实现要求 2：BM25 ----------

test('bm25: 与查询 token 完全相同的文档得分最高', () => {
  const bm = createBm25();
  bm.add({ id: 'a', text: '胶片相机' });
  bm.add({ id: 'b', text: '胶片相机 胶片相机 收藏 展示 说明书' });
  bm.add({ id: 'c', text: '天气预报' });
  const q = tokenize('胶片相机');
  const hits = bm.score(q);
  assert.ok(hits instanceof Map);
  const sorted = [...hits.entries()].sort((x, y) => y[1] - x[1]);
  assert.equal(sorted[0][0], 'a');
  assert.ok(sorted[0][1] > hits.get('b'));
  assert.ok(!hits.has('c'));
});

test('bm25: remove 之后不再计分，再 add 可恢复', () => {
  const bm = createBm25();
  bm.add({ id: 'a', text: '胶片相机' });
  bm.add({ id: 'b', text: '胶片相机' });
  const q = tokenize('胶片');
  assert.equal(bm.score(q).size, 2);
  bm.remove('a');
  const after = bm.score(q);
  assert.equal(after.size, 1);
  assert.ok(!after.has('a'));
  bm.add({ id: 'a', text: '胶片相机' });
  assert.equal(bm.score(q).size, 2);
  assert.equal(bm.remove('不存在'), false);
});

test('bm25: stats 形状与数值', () => {
  const bm = createBm25();
  assert.deepEqual(bm.stats(), { docs: 0, avgLen: 0, terms: 0 });
  bm.add({ id: 'a', text: '杭州 下雨' });
  bm.add({ id: 'b', text: '杭州 下雨 好吃' });
  const s = bm.stats();
  assert.equal(s.docs, 2);
  assert.ok(s.avgLen > 0);
  assert.ok(s.terms > 0);
});

test('bm25: 空查询返回空 Map，空索引不抛错', () => {
  const bm = createBm25();
  assert.equal(bm.score(tokenize('')).size, 0);
  assert.equal(bm.score([]).size, 0);
  bm.add({ id: 'a', text: '胶片' });
  assert.equal(bm.score([]).size, 0);
});

// ---------- 关键实现要求 3：元数据多入口 ----------

function metaFixture() {
  const mi = createMetaIndex();
  mi.addAll([
    { id: 'r1', meta: { place: '杭州', topic: ['天气', '下雨'] } },
    { id: 'r2', meta: { place: '杭州市西湖区', topic: ['工作'] } },
    { id: 'r3', meta: { place: '上海', topic: ['下雨'] } },
    { id: 'r4', meta: { place: '北京', topic: ['旅行'] } },
    { id: 'r5', meta: { time: '2024-03-05T10:00:00Z', person: ['小王'] } },
  ]);
  return mi;
}

test('metadata.narrow: 杭州 + 下雨 只命中 place 含杭州 或 topic 含下雨/天气', () => {
  const mi = metaFixture();
  const hits = mi.narrow({ place: '杭州', topic: '下雨' });
  assert.ok(hits instanceof Set);
  assert.deepEqual([...hits].sort(), ['r1', 'r2', 'r3']);
  assert.ok(!hits.has('r4'));
  // 同义扩展：线索写「天气」也要能命中 topic 只有「下雨」的记录
  assert.ok(mi.narrow({ topic: '天气' }).has('r3'));
});

test('metadata.narrow: 无线索返回 null（不缩小范围），线索全落空也 fail-open', () => {
  const mi = metaFixture();
  assert.equal(mi.narrow(null), null);
  assert.equal(mi.narrow(undefined), null);
  assert.equal(mi.narrow({}), null);
  assert.equal(mi.narrow({ place: '广州' }), null);
});

test('metadata.narrow: 时间区间 {from,to} 与单值都能匹配', () => {
  const mi = metaFixture();
  const inside = mi.narrow({ time: { from: '2024-03-01', to: '2024-03-31' } });
  assert.ok(inside && inside.has('r5'));
  const outside = mi.narrow({ time: { from: '2025-01-01', to: '2025-02-01' } });
  assert.equal(outside, null);
  assert.ok(mi.narrow({ time: '2024-03-05' }).has('r5'));
  assert.ok(!mi.narrow({ time: '2024-03-06' })?.has('r5'));
});

test('metadata.narrow: person / object 入口与 remove', () => {
  const mi = createMetaIndex();
  mi.addAll([
    { id: 'a', meta: { person: ['小王'], object: ['相机'] } },
    { id: 'b', meta: { person: ['小李'], object: ['自行车'] } },
  ]);
  assert.deepEqual([...mi.narrow({ person: '小王' })], ['a']);
  assert.deepEqual([...mi.narrow({ object: '自行车' })], ['b']);
  mi.remove('a');
  assert.equal(mi.narrow({ person: '小王' }), null);
});

// ---------- 关键实现要求 4：向量三态 ----------

test('vector.status: provider=none -> off/provider-none', () => {
  const v = createVector({ config: { vector: { provider: 'none' } } });
  assert.deepEqual(v.status(), { state: 'off', reason: 'provider-none' });
});

test('vector.status: local 不可加载 -> degraded 且原因具体', () => {
  const noModel = createVector({ config: { vector: { provider: 'local' } } });
  const s1 = noModel.status();
  assert.equal(s1.state, 'degraded');
  assert.match(s1.reason, /^local:/);

  const noRuntime = createVector({ config: { vector: { provider: 'local', model: '/tmp/not-a-model.onnx' } } });
  const s2 = noRuntime.status();
  assert.equal(s2.state, 'degraded');
  assert.match(s2.reason, /^local:/);
});

test('vector.status: api 配置齐全 -> on（不发请求）', () => {
  process.env.MNEMOS_TEST_KEY = 'sk-test';
  try {
    const v = createVector({ config: { vector: { provider: 'api', endpoint: 'http://127.0.0.1:9/v1', apiKeyEnv: 'MNEMOS_TEST_KEY' } } });
    assert.deepEqual(v.status(), { state: 'on' });
    const missingKey = createVector({ config: { vector: { provider: 'api', endpoint: 'http://127.0.0.1:9/v1', apiKeyEnv: 'MNEMOS_ABSENT_KEY' } } });
    assert.equal(missingKey.status().state, 'degraded');
    assert.match(missingKey.status().reason, /^api:no-api-key/);
    const missingEndpoint = createVector({ config: { vector: { provider: 'api', apiKeyEnv: 'MNEMOS_TEST_KEY' } } });
    assert.equal(missingEndpoint.status().reason, 'api:no-endpoint');
  } finally {
    delete process.env.MNEMOS_TEST_KEY;
  }
});

test('vector.embed: 降级时返回 null 而不是抛错', async () => {
  const logs = [];
  const v = createVector({ config: { vector: { provider: 'local' } }, log: (m) => logs.push(m) });
  assert.equal(await v.embed(['杭州下雨']), null);
  assert.equal(await v.embed([]).then((x) => (Array.isArray(x) ? x.length : -1)), 0);
  assert.ok(logs.some((m) => m.includes('vector unavailable')));
});

test('vector: cosineSearch 排序与 top-k', () => {
  const v = createVector({ config: { vector: { provider: 'none' } } });
  const vectors = new Map([
    ['a', [1, 0]],
    ['b', [0.6, 0.8]],
    ['c', [0, 1]],
  ]);
  const hits = v.cosineSearch([1, 0], vectors, 2);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].id, 'a');
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test('vector: import 阶段零副作用（子进程干净退出、无输出）', () => {
  const r = spawnSync(process.execPath, ['-e', "import('./src/retrieval/vector.mjs')"], {
    cwd: PKG,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '');
  assert.equal(r.stderr.trim(), '');
});

// ---------- 关键实现要求 5：融合与权重 ----------

function rec(id, text, extra = {}) {
  const now = Date.UTC(2025, 5, 1);
  return { id, text, meta: {}, createdAt: now, updatedAt: now, weight: 0.5, mentions: 1, ...extra };
}

test('hybrid: vectors=null 不抛错，0.15 向量权重按比例并入 bm25/meta', () => {
  const withV = effectiveWeights(undefined, true);
  assert.deepEqual(withV, DEFAULT_WEIGHTS);
  const sumOf = (w) => Object.values(w).reduce((s, x) => s + x, 0);
  assert.ok(Math.abs(sumOf(withV) - 1) < 1e-12);

  const noV = effectiveWeights(undefined, false);
  assert.equal(noV.vector, 0);
  assert.ok(Math.abs(sumOf(noV) - 1) < 1e-12, '归一后总和应为 1，实际 ' + sumOf(noV));
  // 并入按 bm25:meta 原比例，不改变两者相对关系
  assert.ok(noV.bm25 > withV.bm25 && noV.meta > withV.meta);
  assert.ok(Math.abs(noV.bm25 / noV.meta - withV.bm25 / withV.meta) < 1e-12);

  const bm = createBm25();
  const recs = [rec('a', '杭州下雨'), rec('b', '胶片相机')];
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  assert.doesNotThrow(() => rank({ query: '杭州 下雨', records: recs, bm25: bm, metaIndex: null, vectors: null }));
  // 语义刻意改变（候选门控引入）：两条记录对「无关查询」均无 bi-gram/ASCII 词命中，
  // 候选集为空。原断言是 2 条——那正是现在要消灭的"无词面也进榜"。
  assert.equal(rank({ query: '无关查询', records: recs, bm25: bm, vectors: null }).length, 0);
});

test('hybrid: score 等于归一分量与有效权重的加权和，按 score 降序', () => {
  const bm = createBm25();
  const recs = [rec('a', '杭州今天下雨了'), rec('b', '杭州天气晴朗'), rec('c', '胶片相机收藏')];
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const rows = rank({ query: '杭州 下雨', records: recs, bm25: bm, now: Date.UTC(2025, 5, 2) });
  const w = effectiveWeights(undefined, false);
  for (const row of rows) {
    assert.ok(row.score >= 0 && row.score <= 1);
    const expected =
      w.bm25 * row.partsNorm.bm25 +
      w.meta * row.partsNorm.meta +
      w.vector * row.partsNorm.vector +
      w.heat * row.partsNorm.heat;
    assert.ok(Math.abs(row.score - expected) < 1e-9, 'score 不一致: ' + row.score + ' vs ' + expected);
  }
  assert.equal(rows[0].record.id, 'a');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score);
});

test('hybrid: 最多返回 50 条，parts 给出四项原始分', () => {
  const bm = createBm25();
  const recs = [];
  for (let i = 0; i < 60; i++) recs.push(rec('id' + i, '杭州下雨的第' + i + '条记录'));
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const rows = rank({ query: '杭州 下雨', records: recs, bm25: bm });
  assert.equal(rows.length, MAX_RESULTS);
  assert.equal(rows.length, 50);
  for (const key of ['bm25', 'meta', 'vector', 'heat']) {
    assert.equal(typeof rows[0].parts[key], 'number');
  }
});

// ---------- 关键实现要求 6：跨词召回 ----------

function bigramVecOfFactory(texts) {
  const vocab = [...new Set(texts.flatMap((t) => tokenize(t)))];
  const idx = new Map(vocab.map((t, i) => [t, i]));
  return (text) => {
    const a = new Array(vocab.length).fill(0);
    for (const tok of tokenize(text)) a[idx.get(tok)] += 1;
    const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0)) || 1;
    return a.map((x) => x / norm);
  };
}

function crossWordFixture() {
  const now = Date.UTC(2025, 5, 1);
  const recs = [
    rec('film', '她买了胶片相机', { createdAt: now, updatedAt: now }),
    rec('machine', '那台机器是二手的，包装盒已经丢了，保修卡也找不到了，不过用起来还算正常。'),
    rec('trip', '周末去了西湖边散步'),
  ];
  const query = '那台拍胶片的机器';
  const bm = createBm25();
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const vecOf = bigramVecOfFactory([...recs.map((r) => r.text), query]);
  return { recs, query, bm, vectors: { query: vecOf(query), get: (id) => vecOf(recs.find((r) => r.id === id).text) } };
}

test('hybrid: 字符 bigram 向量让「她买了胶片相机」跨词召回并排第一', () => {
  const { recs, query, bm, vectors } = crossWordFixture();
  const rows = rank({ query, records: recs, bm25: bm, vectors, now: Date.UTC(2025, 5, 2) });
  assert.equal(rows[0].record.id, 'film');
  assert.ok(rows[0].parts.vector > 0, '向量项应参与打分');
  assert.ok(rows[0].partsNorm.vector > rows.find((r) => r.record.id === 'machine').partsNorm.vector);
  // 门控效应：'trip'（周末去了西湖边散步）对查询无任何 bi-gram 命中，已不具候选资格
  assert.ok(!rows.some((r) => r.record.id === 'trip'));
});

test('hybrid: 同一批记录在 vectors=null 时仍可排序（允许胶片那条不在第一）', () => {
  const { recs, query, bm } = crossWordFixture();
  const rows = rank({ query, records: recs, bm25: bm, vectors: null, now: Date.UTC(2025, 5, 2) });
  // 语义刻意改变（候选门控引入）：'trip' 无 bi-gram 命中被门控，候选 3 → 2
  assert.equal(rows.length, 2);
  const pos = rows.findIndex((r) => r.record.id === 'film');
  assert.ok(pos >= 0 && pos <= 1, '无向量时 film 允许排第二，实际第 ' + (pos + 1));
  for (const row of rows) assert.equal(row.parts.vector, 0);
});

test('hybrid: 只有部分记录带向量时，向量通道仍能改变名次', () => {
  const { recs, query, bm } = crossWordFixture();
  const onlyFilm = { query: [1, 0], get: (id) => (id === 'film' ? [1, 0] : null) };
  const base = rank({ query, records: recs, bm25: bm, vectors: null, now: Date.UTC(2025, 5, 2) });
  const boosted = rank({ query, records: recs, bm25: bm, vectors: onlyFilm, now: Date.UTC(2025, 5, 2) });
  assert.equal(boosted[0].record.id, 'film');
  assert.ok(boosted[0].partsNorm.vector > 0);
  const before = base.findIndex((r) => r.record.id === 'film');
  const after = boosted.findIndex((r) => r.record.id === 'film');
  assert.ok(after <= before, '向量通道不应让名次变差: ' + before + ' -> ' + after);
});

test('hybrid: 空查询/空记录不抛错', () => {
  assert.deepEqual(rank({ query: '', records: [] }), []);
  assert.deepEqual(rank({}), []);
  const rows = rank({ query: '', records: [rec('a', '杭州下雨'), rec('b', '胶片相机')] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parts.bm25, 0);
});

test('hybrid: 自定义 weights 会被归一并在向量缺席时重分配', () => {
  const w = effectiveWeights({ bm25: 2, meta: 1, vector: 1, heat: 0 }, false);
  const sum = w.bm25 + w.meta + w.vector + w.heat;
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.equal(w.vector, 0);
  assert.equal(w.heat, 0);
  assert.ok(Math.abs(w.bm25 / w.meta - 2 / 1) < 1e-12);
});

test('hybrid: metaIndex 参与打分（存储投影不带 meta 字段也能算亲和度）', () => {
  const now = Date.UTC(2025, 5, 1);
  // 恢复原意图：text 完全不含查询词，只有 meta.place 命中，靠候选规则②（narrow）进榜
  const full = [
    rec('a', '今天出门忘带伞', { meta: { place: '杭州' } }),
    rec('b', '今天出门忘带伞', { meta: { place: '上海' } }),
  ];
  const mi = createMetaIndex();
  mi.addAll(full);
  const projections = full.map((r) => ({ id: r.id, text: r.text }));
  const bm = createBm25();
  for (const r of projections) bm.add({ id: r.id, text: r.text });
  const rows = rank({ query: '杭州', records: projections, metaIndex: mi, bm25: bm, now });
  const a = rows.find((r) => r.record.id === 'a');
  assert.ok(a, '纯元数据记录应被召回');
  assert.ok(a.parts.meta > 0, '索引命中应给 meta 分');
  assert.equal(rows[0].record.id, 'a');
  // 门控仍在：b 词面 / 元数据 narrow / 向量三路都没有强信号
  assert.ok(!rows.some((r) => r.record.id === 'b'), '三路都无强信号的记录不应进候选');
});

test('hybrid: metaIndex 未收录该 id 时回落到 record.meta', () => {
  const mi = createMetaIndex();
  mi.add({ id: 'other', meta: { place: '上海' } });
  const rows = rank({ query: '杭州', records: [rec('stray', '杭州', { meta: { place: '杭州' } })], metaIndex: mi });
  assert.ok(rows[0].parts.meta > 0);
});

// ---------- 第 2 轮：候选门控（candidacy gating） ----------

function gatingFixture() {
  const may = Date.UTC(2025, 4, 12);
  const jun = Date.UTC(2025, 5, 3);
  const recs = [
    rec('quantum', '量子计算机的论文看到第三章了', { createdAt: jun, updatedAt: jun }),
    rec('plan', '杭州计划下周去看展览', { createdAt: may, updatedAt: may }),
    rec('camera', '她买了胶片相机', { createdAt: may, updatedAt: may }),
    rec('rain', '昨天杭州下雨，没带伞', { createdAt: may, updatedAt: may }),
  ];
  const bm = createBm25();
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  return { recs, bm };
}

test('门控：「量子计算机」不得召回只靠单字「计」命中的「杭州计划」', () => {
  const { recs, bm } = gatingFixture();
  const ids = rank({ query: '量子计算机', records: recs, bm25: bm }).map((r) => r.record.id);
  assert.ok(!ids.includes('plan'), '「杭州计划」只命中单字，不该进候选: ' + ids.join(','));
  assert.ok(ids.includes('quantum'));
});

test('门控：「胶片相机」仍召回她买相机那条并排第一', () => {
  const { recs, bm } = gatingFixture();
  const rows = rank({ query: '胶片相机', records: recs, bm25: bm });
  assert.equal(rows[0].record.id, 'camera');
  assert.ok(rows[0].parts.bm25 > 0);
});

test('门控：单字查询「雨」退回原行为，仍召回含「下雨」的记录', () => {
  const { recs, bm } = gatingFixture();
  const rows = rank({ query: '雨', records: recs, bm25: bm });
  assert.ok(rows.length > 1, '单字查询不门控，候选保留全部记录');
  assert.equal(rows[0].record.id, 'rain');
  assert.ok(rows[0].parts.bm25 > 0);
});

test('门控：单字命中按 0.35× 计分，低于全权重口径', () => {
  const { recs, bm } = gatingFixture();
  const toks = tokenize('量子计算机');
  const isUni = (t) => t.length === 1;
  const strong = bm.score(toks.filter((t) => !isUni(t))).get('quantum') ?? 0;
  const weak = bm.score(toks.filter(isUni)).get('quantum') ?? 0;
  const row = rank({ query: '量子计算机', records: recs, bm25: bm }).find((r) => r.record.id === 'quantum');
  assert.ok(strong > 0 && weak > 0);
  assert.ok(Math.abs(row.parts.bm25 - (strong + UNI_GRAM_WEIGHT * weak)) < 1e-12);
  assert.ok(row.parts.bm25 < bm.score(toks).get('quantum'), '应低于全权重口径');
});

// ---------- 第 3 轮：三通道候选资格（① 词面 ② 元数据 narrow ③ 向量） ----------

test('候选②：text 不含「杭州」但 meta.place 是杭州，查询「杭州」必须召回且 meta 分量 > 0', () => {
  const now = Date.UTC(2025, 5, 1);
  const recs = [
    rec('metaOnly', '今天出门忘带伞', { meta: { place: '杭州' } }),
    rec('noise', '今天出门忘带伞', { meta: { place: '上海' } }),
    rec('lexical', '杭州西湖骑行', {}),
  ];
  const mi = createMetaIndex();
  mi.addAll(recs);
  const bm = createBm25();
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const rows = rank({ query: '杭州', records: recs, metaIndex: mi, bm25: bm, now });
  const ids = rows.map((r) => r.record.id);
  assert.ok(ids.includes('metaOnly'), '元数据通道必须能召回: ' + ids.join(','));
  assert.ok(rows.find((r) => r.record.id === 'metaOnly').parts.meta > 0);
  assert.ok(!ids.includes('noise'), '三路都无强信号的记录仍应被门控');
});

test('候选③：词面零重叠但 cosine>=0.6 的记录必须召回；vectors=null 时不在且不崩', () => {
  const now = Date.UTC(2025, 5, 1);
  const recs = [rec('semanticOnly', '薛定谔的猫很有趣', {}), rec('lexical', '量子力学的论文', {})];
  const bm = createBm25();
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const vectors = { query: [1, 0], get: (id) => (id === 'semanticOnly' ? [0.8, 0.6] : [0, 1]) };
  const withVec = rank({ query: '量子计算机', records: recs, bm25: bm, vectors, now });
  const hit = withVec.find((r) => r.record.id === 'semanticOnly');
  assert.ok(hit, '余弦 0.8 应授予候选资格');
  assert.ok(Math.abs(hit.parts.vector - 0.8) < 1e-12);
  let without;
  assert.doesNotThrow(() => {
    without = rank({ query: '量子计算机', records: recs, bm25: bm, vectors: null, now });
  });
  assert.ok(!without.some((r) => r.record.id === 'semanticOnly'));
});

test('候选③：vectorFloor 边界 0.34 不进、0.36 进，weights.vectorFloor 可覆盖', () => {
  const now = Date.UTC(2025, 5, 1);
  const unit = (c) => [c, Math.sqrt(1 - c * c)];
  const recs = [
    rec('below', '薛定谔的猫很有趣', {}),
    rec('above', '薛定谔的猫很有趣', {}),
    rec('lexical', '量子力学的论文', {}),
  ];
  const bm = createBm25();
  for (const r of recs) bm.add({ id: r.id, text: r.text });
  const vectors = { query: [1, 0], get: (id) => (id === 'below' ? unit(0.34) : id === 'above' ? unit(0.36) : [0, 1]) };
  const ids = rank({ query: '量子计算机', records: recs, bm25: bm, vectors, now }).map((r) => r.record.id);
  assert.ok(ids.includes('above'), '0.36 >= 0.35 应进候选: ' + ids.join(','));
  assert.ok(!ids.includes('below'), '0.34 < 0.35 不应进候选');
  const lowered = rank({ query: '量子计算机', records: recs, bm25: bm, vectors, now, weights: { ...DEFAULT_WEIGHTS, vectorFloor: 0.3 } });
  assert.ok(lowered.map((r) => r.record.id).includes('below'), 'vectorFloor 应可通过 weights 覆盖');
});


