// Okapi BM25：k1=1.2 / b=0.75 / IDF=ln(1+(N-df+0.5)/(df+0.5))。
// 用倒排表而不是每次扫全库：5000 条记录下单次查询仍是「只碰命中文档」。

import { tokenize } from './tokenize.mjs';

const K1 = 1.2;
const B = 0.75;

export function createBm25() {
  const docs = new Map(); // id -> { len, tf: Map<term, count> }
  const postings = new Map(); // term -> Map<id, tf>
  let totalLen = 0;

  function add(doc) {
    if (!doc || doc.id == null) return;
    const id = doc.id;
    remove(id);
    const tokens = tokenize(doc.text ?? '');
    const tf = new Map();
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    docs.set(id, { len: tokens.length, tf });
    totalLen += tokens.length;
    for (const [term, n] of tf) {
      let p = postings.get(term);
      if (!p) {
        p = new Map();
        postings.set(term, p);
      }
      p.set(id, n);
    }
  }

  function remove(id) {
    const d = docs.get(id);
    if (!d) return false;
    docs.delete(id);
    totalLen -= d.len;
    for (const term of d.tf.keys()) {
      const p = postings.get(term);
      if (!p) continue;
      p.delete(id);
      if (p.size === 0) postings.delete(term);
    }
    return true;
  }

  function score(queryTokens) {
    const hits = new Map();
    const N = docs.size;
    if (!N || !queryTokens || !queryTokens.length) return hits;
    const avgLen = totalLen / N;
    const seen = new Set(); // 同一词重复出现只算一次，否则单侧查询会被人为放大
    for (let i = 0; i < queryTokens.length; i++) {
      const term = queryTokens[i];
      if (seen.has(term)) continue;
      seen.add(term);
      const p = postings.get(term);
      if (!p || p.size === 0) continue;
      const df = p.size;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const [id, tf] of p) {
        const d = docs.get(id);
        if (!d) continue;
        const norm = avgLen > 0 ? d.len / avgLen : 0;
        const denom = tf + K1 * (1 - B + B * norm);
        const gain = (idf * tf * (K1 + 1)) / denom;
        hits.set(id, (hits.get(id) ?? 0) + gain);
      }
    }
    return hits;
  }

  function stats() {
    const n = docs.size;
    return { docs: n, avgLen: n ? totalLen / n : 0, terms: postings.size };
  }

  function has(id) {
    return docs.has(id);
  }

  return { add, remove, score, stats, has };
}
