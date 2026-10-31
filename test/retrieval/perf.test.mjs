import test from 'node:test';
import assert from 'node:assert/strict';

import { createBm25 } from '../../src/retrieval/bm25.mjs';
import { createMetaIndex } from '../../src/retrieval/metadata.mjs';
import { tokenize } from '../../src/retrieval/tokenize.mjs';
import { rank } from '../../src/retrieval/hybrid.mjs';

// 固定词表 + 线性同余，保证每次跑的语料一致；不读任何外部文件
const VOCAB =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可也你说年过发后里道行所然家种事方多经去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机民第公此已工使情明性知全三关点正业外将两高间由问很最重并物手应战向头文体相见被利什二产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海'.split('');

function makeCorpus(n) {
  let seed = 20240601;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const places = ['杭州', '上海', '北京', '成都', '深圳'];
  const topics = ['天气', '工作', '旅行', '摄影', '读书'];
  const out = [];
  const base = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const len = 18 + (next() % 14);
    let text = '';
    for (let j = 0; j < len; j++) text += VOCAB[next() % VOCAB.length];
    const at = base + (next() % 300) * 86400000;
    out.push({
      id: 'mem-' + i,
      kind: 'fact',
      tier: 'cold',
      text,
      meta: { time: at, place: places[next() % places.length], topic: [topics[next() % topics.length]] },
      createdAt: at,
      updatedAt: at,
      emotion: { valence: 0, arousal: 0 },
      weight: 0.3 + (next() % 70) / 100,
      mentions: next() % 12,
      subject: 'self',
      sourceRefs: [],
      pinned: false,
    });
  }
  return out;
}

const CORPUS = makeCorpus(5000);
const NOW = Date.UTC(2025, 5, 1);

function buildIndex() {
  const bm25 = createBm25();
  const metaIndex = createMetaIndex();
  const t0 = process.hrtime.bigint();
  for (const r of CORPUS) bm25.add({ id: r.id, text: r.text });
  metaIndex.addAll(CORPUS);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { bm25, metaIndex, ms };
}

test('perf: 5000 条中文记录建索引 < 400ms', () => {
  const { bm25, metaIndex, ms } = buildIndex();
  const s = bm25.stats();
  assert.equal(s.docs, 5000);
  assert.ok(s.terms > 100);
  assert.equal(metaIndex.size(), 5000);
  console.log('    [perf] build 5000 docs: ' + ms.toFixed(1) + 'ms (limit 400ms), terms=' + s.terms);
  assert.ok(ms < 400, '建索引耗时 ' + ms.toFixed(1) + 'ms 超过 400ms');
});

test('perf: 5000 条记录上一次 rank < 25ms', () => {
  const { bm25, metaIndex } = buildIndex();
  const query = '杭州的天气怎么样，那台拍胶片的机器还记得吗';
  // 预热一次，排除首次 JIT 的影响；断言取三次中的最小值
  rank({ query, records: CORPUS, bm25, metaIndex, vectors: null, now: NOW });
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    const rows = rank({ query, records: CORPUS, bm25, metaIndex, vectors: null, now: NOW });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
    // 门控后候选数由词面命中决定（随机语料下远少于 50），这里只断言上限生效；
    // "凑满 50 条"由功能用例「最多返回 50 条」覆盖
    assert.ok(rows.length > 0 && rows.length <= 50, 'rows=' + rows.length);
  }
  console.log('    [perf] rank over 5000 records (gated): ' + best.toFixed(2) + 'ms (limit 25ms)');
  assert.ok(best < 25, 'rank 耗时 ' + best.toFixed(2) + 'ms 超过 25ms');

  // 门控会把大部分记录挡在候选外，所以还要测最坏路径：
  // 单字查询触发的"不门控"分支，5000 条全部走完 meta/heat 并参与排序
  let worst = Infinity;
  for (let i = 0; i < 3; i++) {
    const t1 = process.hrtime.bigint();
    const rows = rank({ query: '的 了 是 在 有 和', records: CORPUS, bm25, metaIndex, vectors: null, now: NOW });
    const ms = Number(process.hrtime.bigint() - t1) / 1e6;
    if (ms < worst) worst = ms;
    assert.equal(rows.length, 50, '不门控时应能凑满上限');
  }
  console.log('    [perf] rank over 5000 records (ungated worst case): ' + worst.toFixed(2) + 'ms (limit 25ms)');
  assert.ok(worst < 25, '不门控路径 rank 耗时 ' + worst.toFixed(2) + 'ms 超过 25ms');
});

test('perf: tokenize 吞吐作为回归护栏', () => {
  const text = CORPUS[0].text + CORPUS[1].text + CORPUS[2].text;
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < 2000; i++) n += tokenize(text).length;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(n > 0);
  console.log('    [perf] 2000 tokenize calls: ' + ms.toFixed(1) + 'ms');
  assert.ok(ms < 1000, 'tokenize 吞吐异常: ' + ms.toFixed(1) + 'ms');
});
