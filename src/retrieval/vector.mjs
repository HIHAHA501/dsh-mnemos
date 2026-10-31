// 可选向量增强。全程惰性：import 阶段不读模型、不发请求，只解析配置。
// 本地 ONNX 在零依赖前提下无法内置推理器，因此做成注入式 runtime 缝
// （globalThis.__dshMnemosOnnx）；拿不到就诚实地降级并给出具体原因。

import { statSync } from 'node:fs';

const CACHE_MAX = 512;
const DEFAULT_KEY_ENV = 'OPENAI_API_KEY';
const TIMEOUT_MS = 15000;

function toNumArray(v) {
  if (!v) return null;
  if (!Array.isArray(v) && !ArrayBuffer.isView(v)) return null;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const n = Number(v[i]);
    if (!Number.isFinite(n)) return null;
    out[i] = n;
  }
  return out.length ? out : null;
}

function toTextList(texts) {
  if (typeof texts === 'string') return [texts];
  if (!Array.isArray(texts)) return [];
  const out = [];
  for (const t of texts) out.push(typeof t === 'string' ? t : String(t ?? ''));
  return out;
}

// 支持稠密 number[] 与稀疏 Map/对象两种形态：假向量/稀疏特征不必补齐维度
export function cosine(a, b) {
  if (!a || !b) return 0;
  const dense = Array.isArray(a) && Array.isArray(b);
  if (dense) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      const y = b[i];
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
  const getA = (k) => (typeof a.get === 'function' ? a.get(k) : a[k]);
  const getB = (k) => (typeof b.get === 'function' ? b.get(k) : b[k]);
  const keysA = typeof a.keys === 'function' ? [...a.keys()] : Object.keys(a);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keysA) {
    const x = Number(getA(k)) || 0;
    na += x * x;
    const y = Number(getB(k)) || 0;
    dot += x * y;
  }
  const keysB = typeof b.keys === 'function' ? [...b.keys()] : Object.keys(b);
  for (const k of keysB) {
    const y = Number(getB(k)) || 0;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function pairsOf(vectors) {
  if (!vectors) return [];
  if (Array.isArray(vectors)) {
    const out = [];
    for (let i = 0; i < vectors.length; i++) {
      const item = vectors[i];
      if (Array.isArray(item) || ArrayBuffer.isView(item)) out.push([String(i), item]);
      else if (item && item.id != null) out.push([String(item.id), item.vector ?? item.embedding ?? item.vec ?? null]);
    }
    return out;
  }
  if (typeof vectors.get === 'function') return [...vectors.entries()];
  if (typeof vectors === 'object') return Object.entries(vectors);
  return [];
}

export function createVector({ config, log } = {}) {
  const raw = config && config.vector ? config.vector : config || {};
  const enabled = raw.enabled ?? 'auto';
  const provider = raw.provider ?? 'none';
  const model = raw.model;
  const endpoint = raw.endpoint;
  const apiKeyEnv = raw.apiKeyEnv || DEFAULT_KEY_ENV;

  const cache = new Map(); // 有界缓存：长会话里重复 embed 同一批文本是常态
  let said = '';

  function note(msg) {
    if (!msg || said === msg) return; // 同一原因只说一次，避免刷屏
    said = msg;
    try {
      log?.(msg);
    } catch {
      /* 日志器自身报错不能影响检索 */
    }
  }

  function apiKey() {
    const fromEnv = process.env?.[apiKeyEnv];
    return (fromEnv && String(fromEnv)) || raw.apiKey || '';
  }

  let localProbe = null;

  function probeLocal() {
    if (localProbe) return localProbe;
    if (!model) localProbe = { ok: false, reason: 'local:no-model-path' };
    else {
      const rt = globalThis.__dshMnemosOnnx;
      if (!rt || typeof rt.embed !== 'function') localProbe = { ok: false, reason: 'local:runtime-unavailable' };
      else {
        try {
          statSync(model);
          localProbe = { ok: true };
        } catch {
          localProbe = { ok: false, reason: 'local:model-not-found' };
        }
      }
    }
    return localProbe;
  }

  function status() {
    if (provider === 'none') return { state: 'off', reason: 'provider-none' };
    if (enabled === 'off') return { state: 'off', reason: 'disabled-by-config' };
    if (provider === 'local') {
      const p = probeLocal();
      // 'on' 不带 reason，便于调用方直接按 { state:'on' } 判等
      return p.ok ? { state: 'on' } : { state: 'degraded', reason: p.reason };
    }
    if (provider === 'api') {
      if (!endpoint) return { state: 'degraded', reason: 'api:no-endpoint' };
      if (!apiKey()) return { state: 'degraded', reason: 'api:no-api-key:' + apiKeyEnv };
      return { state: 'on' };
    }
    return { state: 'degraded', reason: 'unknown-provider:' + String(provider) };
  }

  function cachePut(text, vec) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(text, vec);
  }

  async function embedApi(batch) {
    if (typeof fetch !== 'function') return null;
    const base = String(endpoint).replace(/\/+$/, '');
    const url = /\/embeddings$/.test(base) ? base : base + '/embeddings';
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey() };
    const body = JSON.stringify(model ? { model, input: batch } : { input: batch });
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    const res = await fetch(url, { method: 'POST', headers, body, signal });
    if (!res || !res.ok) {
      note('vector api: http ' + (res ? res.status : 'no-response'));
      return null;
    }
    const json = await res.json();
    const data = Array.isArray(json?.data) ? json.data.slice() : null;
    if (!data || data.length !== batch.length) {
      note('vector api: unexpected payload');
      return null;
    }
    data.sort((x, y) => (x?.index ?? 0) - (y?.index ?? 0));
    const out = [];
    for (const d of data) {
      const v = toNumArray(d?.embedding);
      if (!v) {
        note('vector api: bad embedding');
        return null;
      }
      out.push(v);
    }
    return out;
  }

  async function embedLocal(batch) {
    const rt = globalThis.__dshMnemosOnnx;
    if (!rt || typeof rt.embed !== 'function') return null;
    const res = await rt.embed(batch, { model });
    if (!Array.isArray(res) || res.length !== batch.length) return null;
    const out = [];
    for (const item of res) {
      const v = toNumArray(item);
      if (!v) return null;
      out.push(v);
    }
    return out;
  }

  async function embed(texts) {
    const list = toTextList(texts);
    if (!list.length) return [];
    const st = status();
    if (st.state !== 'on') {
      note('vector unavailable: ' + st.reason);
      return null;
    }
    const out = new Array(list.length);
    const missing = [];
    for (let i = 0; i < list.length; i++) {
      const hit = cache.get(list[i]);
      if (hit) out[i] = hit;
      else missing.push(i);
    }
    if (!missing.length) return out;
    const batch = missing.map((i) => list[i]);
    let fresh = null;
    try {
      fresh = provider === 'api' ? await embedApi(batch) : await embedLocal(batch);
    } catch (err) {
      note('vector embed failed: ' + (err?.message || String(err)));
      return null;
    }
    if (!fresh) return null;
    for (let j = 0; j < missing.length; j++) {
      out[missing[j]] = fresh[j];
      cachePut(batch[j], fresh[j]);
    }
    return out;
  }

  function cosineSearch(vec, vectors, k = 10) {
    const q = toNumArray(vec);
    if (!q) return [];
    const limit = Number.isFinite(k) ? Math.max(0, Math.floor(k)) : 10;
    if (!limit) return [];
    const scored = [];
    for (const [id, v] of pairsOf(vectors)) {
      const s = cosine(q, v);
      if (s > 0) scored.push({ id, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  return { status, embed, cosineSearch };
}
