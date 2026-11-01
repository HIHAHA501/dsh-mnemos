# dsh-mnemos 架构

> 本文只写**读过的代码**里成立的事。每个模块名都与 `ls` 的实际输出一一对应（见文末「核对」）。
> **范围**：核心层 `src/*.mjs`（7）、检索层 `src/retrieval/*.mjs`（5）、宿主接线层
> `index.mjs` + `src/host/*.mjs`（6）、Web 半边 `client.js`（1）——共 19 个文件，全部读过再写。

## 1. 分层

```
                 ┌──────────────────────────────────────────┐
   未就绪        │ index.mjs   宿主接线（agent/pre-step、     │
   （另一任务）  │              systemPrompt.section、tool）  │
                 └───────────────┬──────────────────────────┘
                                 │ 只依赖下面这些纯函数 / 类型
      ┌──────────────────────────┴───────────────────────────┐
      │            检索层 src/retrieval/                      │
      │  tokenize → bm25 ┐                                    │
      │                  ├→ hybrid.rank → budget.project       │
      │  metadata ───────┤                                    │
      │  vector ─────────┘                                    │
      └──────────────────────────┬───────────────────────────┘
                                 │
      ┌──────────────────────────┴───────────────────────────┐
      │            核心层 src/                                │
      │  record（形状）  store（持久化）  heat（热度）          │
      │  emotion（情绪） consolidate（合并） config（配置）     │
      └──────────────────────────┬───────────────────────────┘
                                 │
                    磁盘：<dataDir>/records.jsonl
                          <dataDir>/memory.snapshot.json
                          <dataDir>/store.lock

      Web 半边（浏览器）：client.js —— 只读记忆面板，见 §9
```

检索层不认识 store：`hybrid.rank` 只吃「记录数组 + 索引」，所以它可以在纯数据上跑测试。
核心层不认识检索：`store` 只做形状校验、落盘和锁，不排序。

## 2. 模块清单（与 `ls src src/retrieval` 逐字对应）

核心层 `src/`：

| 文件 | 导出的公共面 | 职责 |
| --- | --- | --- |
| `config.mjs` | `MODES` `VECTOR_ENABLED` `VECTOR_PROVIDERS` `INGEST_LLM` `CONFIG_DEFAULTS` `defaultDataDir` `resolveConfig` | 唯一配置入口：宿主的原始 config 不可信，逐字段收敛到固定形状并 `deepFreeze`；不合法值回落到默认并写进 `options.warnings` |
| `record.mjs` | `KINDS` `TIERS` `SUBJECTS` `recordError` `clamp` `createId` `normalizeRecord` `createRecord` `cloneRecord` `isMerged` `unionMeta` `normalizeMeta` `normalizeEmotion` | 记录形状的唯一真相：6 种 kind、4 种 tier、3 种 subject；id 形如 `<kind>-<timestamp36>-<6字符>` |
| `store.mjs` | `StoreError` `createStore` | 持久化：JSONL 追加写（`records.jsonl`）+ 快照压缩（`memory.snapshot.json`）+ 跨进程锁（`store.lock`）；返回 `{insert, upsert, get, all, recent, candidates, setPinned, forget, merge, stats, close}` |
| `heat.mjs` | `heatOf` | 热度 = 时近性 0.45 + 提及次数 0.25 + 权重 0.3；半衰期 14 天；`persona`/`state`/`cold` 不随时间衰减。**冷层语义**：`cold` 的 recency 恒为 1（久远本身不再压低热度），但整体再乘 `coldWeight`（默认 0.75），所以同等条件下 `hot` 仍略占优 |
| `emotion.mjs` | `estimateEmotion` | 中英词典 + 程度副词放大 → `{valence, arousal, cues}`；无命中时 `arousal` 取 0.3 中性基线 |
| `consolidate.mjs` | `bigramSimilarity` `planMerge` | 相似记录归并**方案**：阈值 0.82、权重上限 0.75、每组最多 3 条；只产出 `{keep, drop, groups, patchById}`，不写库 |
| `tiering.mjs` | `TIER_DEFAULTS` `applyTiering` `reviveOnMentionPatch` | `hot` → `cold` 的**惰性**降级：写入落库与插件启动时各扫一次（无后台定时器）；判据 = 记录是 `hot`、未 pinned、`tierSource !== "user"`、年龄 ≥ 30 天、且当前热度 < 0.35；冷层被再次提及（提及次数增加）时回升为 `hot`；启动时对存量记录按同一规则重算一次 `tier`（只改字段，不动正文） |
| `capture.mjs` | `CAPTURE_FILE` `CAPTURE_MAX_SESSIONS` `createCaptureStore` | 会话级记忆开关的落盘：`{version:1,sessions:{[id]:{enabled,at}}}`，临时文件 + rename 原子写，最多 500 个会话（按 `at` 淘汰最旧），坏文件/超 200KB 按空表处理；只影响**新写入**，不删既有记录 |
| `budget.mjs` | `tokenParts` `estimateTokens` `project` | token 估算（CJK 1 / 词 1 / 标点 0.3）与上下文裁剪：`persona`/`state` 无条件保留，其余按 `budget`/`topN` 贪心裁，产出 `{picks, tokens, dropped}` |

检索层 `src/retrieval/`：

| 文件 | 导出的公共面 | 职责 |
| --- | --- | --- |
| `tokenize.mjs` | `tokenize` | CJK 单字 + 邻接双字 + ASCII 词；输入上限 10000 字符、单 token 上限 32 |
| `bm25.mjs` | `createBm25` | 倒排索引 + BM25（k1=1.2, b=0.75）；`{add, remove, score, stats, has}` |
| `metadata.mjs` | `createMetaIndex` | 元数据索引：`time` 展开成闭区间（支持 `2025`/`2025-04`/`2025-04-05`/ISO/区间对象），`place`/`person`/`object`/`topic` 做子串匹配 + 主题同义词扩展；`{add, remove, addAll, narrow, matchScore, size}` |
| `vector.mjs` | `cosine` `createVector` | 向量通道：`status()` 三态探测（`on`/`off`/`degraded`）、`embed()`（512 条有界缓存、15s 超时、失败返回 `null`）、`cosineSearch()` |
| `hybrid.mjs` | `DEFAULT_WEIGHTS` `MAX_RESULTS` `effectiveWeights` `rank` | 四路归一化加权融合（bm25 0.55 / meta 0.25 / vector 0.15 / heat 0.05），无向量通道时把 vector 的权重按比例分给其余三路；返回 `[{record, score, parts, partsNorm}]`，最多 50 条 |

## 3. 数据流 · 写入

```
宿主 turn 文本
   → estimateEmotion(text)                情绪线索，写进 record.emotion
   → normalizeRecord({kind, tier, text, meta, emotion, ...})
        · text 为空 → 抛 recordError('invalid-record')
        · 非法 kind/tier/subject → 回落 turn/hot/world（不抛）
        · 无 id → createId(kind, createdAt)
   → store.insert(record)  ← 同 id 已存在会抛 StoreError('duplicate-id')
        或 store.upsert(record)  ← 保留原 createdAt / pinned
   → commit(): 先改内存 Map，再 append 一行 {op:"put", r:record} 到 records.jsonl
        落盘失败 → 内存回滚到上一版（存储与内存不许分叉）
        累计 512 次写 → writeSnapshot()：写 memory.snapshot.json 再清空 JSONL
```

快照与日志的顺序是「先落快照、再清日志」：反过来在两步之间崩溃就会真丢一段数据，
当前顺序最坏只是把幂等的 put 重放一次。

## 4. 数据流 · 召回

```
查询串 / 当前对话上下文
   → tokenize(query)                                 单字 + 双字 + ASCII 词
   → bm25.score(tokens)                              → Map<id, score>
   → metaIndex.matchScore(id, terms)                 → 0..1（id 不在索引里返回 null，回落读 record.meta）
   → vector.status().state === 'on'
        ? vector.embed([query]) → cosineSearch / cosine(queryVec, docVec) → 0..1
        : 该路恒为 0，且 effectiveWeights 把 0.15 按比例分给其余三路
   → heatOf(record, now)                             → 0..1
   → hybrid.rank({query, records, metaIndex, bm25, vectors, now})
        每一路各自除以本批最大值归一化，再乘权重求和，clamp 到 0..1，按分数降序
   → budget.project(rows.map(r => r.record), {budget: injectTokenBudget, topN})
        persona/state 无条件进 picks；其余按分数顺序贪心装，装不下记 dropped('budget'|'topN'|'dup')
   → index.mjs 拼成 systemPrompt 段落（未就绪，见 §8）
```

## 5. 数据流 · 归并

```
store.all() 里未合并的记录
   → planMerge(records, {threshold, maxWeight, maxGroupSize})
        · 跳过 mergedInto 与 pinned
        · 同一 kind 内按 bigram 相似度 ≥ 0.82 成组，每组最多 3 条
        · 组内 keep 的挑选顺序：权重高 → 正文长 → 创建早
        · patch.text 取组内最长正文，patch.meta 取 unionMeta
   → 对每组调 store.merge(keepId, dropIds, patch)
        · keep 的 mentions 求和、weight 取最大后 +0.05（封顶 1）、sourceRefs 取并集
        · 被合并的记录不删除，只是打上 mergedInto，仍可追溯
```

## 6. 磁盘布局与恢复

```
<dataDir>/
  records.jsonl          追加写的事件日志，一行一条 {"op":"put","r":{...record}}
  memory.snapshot.json   {version, savedAt, count, records:[...]}，每次压缩时整体重写
  store.lock             {owner, pid, at, version}；30s 未刷新视为陈旧锁，可抢占
```

- 启动：`acquireLock` → `loadSnapshot` → `loadLog`（重放快照之后的增量）→ `releaseLock`。
- 坏行容忍：JSONL 某行 JSON 解析失败只告警并跳过；若末尾是半行（无换行符）则整份重写，
  否则下一次 append 会粘在坏行后面，把坏行养成坏库。
- `process.on('exit')` 里写快照并释放锁；`close()` 幂等。

## 7. 降级面（这一层的失败必须可解释）

| 触发条件 | 现象 | 代码位置 |
| --- | --- | --- |
| `vector.provider === 'none'` | `status() = {state:'off', reason:'provider-none'}`，检索只剩三路 | `vector.mjs:134` |
| `vector.enabled === 'off'` | `{state:'off', reason:'disabled-by-config'}` | `vector.mjs:135` |
| `provider: 'api'` 缺 endpoint / 缺密钥 | `{state:'degraded', reason:'api:no-endpoint' / 'api:no-api-key:<ENV>'} ` | `vector.mjs:142-143` |
| `provider: 'local'` 缺 runtime 或模型文件不存在 | `{state:'degraded', reason:'local:runtime-unavailable' / 'local:model-not-found'}` | `vector.mjs:104-118` |
| embed 抛错或超时（15s） | 返回 `null`，本批不参与向量路，原因只 log 一次 | `vector.mjs:219-227` |
| 元数据索引未收录该 id | `matchScore` 返回 `null` → 回落读 `record.meta`，不当成 0 分 | `metadata.mjs:183-185` |
| 线索全部落空 | `narrow()` 返回 `null`（不缩小范围），fail-open | `metadata.mjs:174` |
| 任何一路抛错 | `hybrid.rank` 内 try/catch 后该路置 0，排序继续 | `hybrid.mjs:135-141` |
| store 落盘失败 | 内存回滚并抛 `StoreError`，调用方决定是否重试 | `store.mjs:255-268` |
| 库打不开（dataDir 不可写 / 锁被别人持有） | `mount` 返回 `{store:null}` 的降级句柄，`apply` 不抛 | `index.mjs:489-496` |
| `enabled: false` | 不注册任何宿主面，只返回 `{disabled:true}` | `index.mjs:484-487` |
| `webServer` 缺失 / 没有 `register()` | 面板路由不挂载 → 面板显示「不可用」，其余面照常 | `index.mjs:404-423` |
| `systemPrompt` 缺失 | 主注入面退回 `agent/pre-step` 追加一条消息 | `index.mjs:161-184` |
| `commands` 缺失 | `/mem` 不可用 | `index.mjs:244-264` |
| `tools` 缺失 | `mem_search` / `mem_write` / `mem_forget` 不可用 | `index.mjs:293-316` |
| 面板被非本机访问 | 403 + 原因（`remoteAddress` 或 `Host` 非 loopback） | `index.mjs:338-349` |
| 面板非 GET 请求 | 405 + `allow: GET` | `index.mjs:361-364` |
| 库未就绪 / 已关闭 / 路由未挂载 | 503 + 原因 | `index.mjs:370-381` |

## 8. 宿主接线层：index.mjs + src/host/*

`index.mjs`（581 行）是插件唯一的宿主入口，导出 `name` / `SECTION_NAME` / `SECTION_ORDER` /
`PANEL_PATH` / `mount` / `createPanelHandler` / `apply`。文件头写着三条硬规矩（`index.mjs:4-9`）：
只走 `ctx.get` + 能力探测、**不声明 `inject`**（硬依赖会让插件在 bare profile 上一直 pending）；
任何失败都不抛给宿主；无常驻定时器。

| 文件 | 导出的公共面 | 职责 |
| --- | --- | --- |
| `index.mjs` 581 行 | `name` `SECTION_NAME` `SECTION_ORDER` `PANEL_PATH` `mount` `createPanelHandler` `apply` | 读配置 → 开库 → 建索引 → 挂 7 个宿主面 → 卸载时 flush + close |
| `src/host/ingest.mjs` 443 行 | `BATCH_LIMIT` `extractMeta` `messageText` `ingestKey` `recordIdFor` `createIngest` | 会话事件 → 记录：规则抽取、幂等键、攒批 flush、满 `ingest.everyTurns` 轮跑一次合并 |
| `src/host/inject.mjs` 452 行 | `INJECT_CHAR_CAP` `INSTRUCTION` `createRetrievalIndex` `rankRecords` `renderInjection` `createLedger` `latestUserText` `sessionEvents` | 检索索引 + 每轮装配 + 双预算渲染 + 面板用的计账簿 |
| `src/host/proactive.mjs` 92 行 | `STATES` `HINT_CHAR_CAP` `hasRecallConstraint` `decide` `renderReference` `renderHint` | 主动召回三态（`quote` / `ask` / `silence`）判定与提示渲染 |
| `src/host/commands.mjs` 162 行 | `COMMAND_NAME`（`mem`）`USAGE` `createMemCommand` | `/mem status\|budget\|search\|forget\|pin` |
| `src/host/tools.mjs` 220 行 | `TOOL_SEARCH` `TOOL_WRITE` `TOOL_FORGET` `TOOL_NAMES` `createMemoryTools` | `mem_search` / `mem_write` / `mem_forget` 三个工具定义 |

### 8.1 挂了哪些宿主面

| 宿主面 | 挂法 | 位置 |
| --- | --- | --- |
| `systemPrompt.section` | `{name:'dsh-mnemos:memory', order:3050, text: ctx => renderForContext(...)}`；3050 落在工具段（1000-3000）之后、MCP 段（3100）之前 | `index.mjs:161-184`、常量 `:23-26` |
| `agent/pre-step` | `ctx.on('agent/pre-step', async (payload, next) => …)`，段已挂上时**原样返回下游 decision**；追加的消息带 `source.kind='dsh-mnemos'`，不会自食其果 | `index.mjs:190-216` |
| `session/event` | `ctx.on('session/event', listener, {global:true})`；注册失败退化为非 global | `index.mjs:219-241` |
| `commands.register` | `service.register(createMemCommand({store, config, index, ledger, ingest, notes, now}))` | `index.mjs:244-264` |
| `tools.register` ×3 | 每个定义过 `guardTool`（execute 与 render 各自 try/catch），再逐个 `service.register` | `index.mjs:266-316` |
| `webServer.register` | `{kind:'exact', path:'/.dsh-mnemos/panel', handler}`：GET 返回 `{stats,budget,vector,recalls,capture}`；POST 动作 `search / pin / tier / forget / capture`（五道门槛：POST + JSON + `x-dsh-mnemos: 1` + loopback + ≤8KB） | `index.mjs`（`createPanelHandler` / `panelWriteGate` / `panelAction`） |
| `ctx.effect`（dispose） | `ctx.effect(() => () => cleanup(), 'dsh-mnemos.dispose')`，退化为 `ctx.on('dispose', cleanup)`；先撤注册、再 flush、最后 close | `index.mjs:426-463` |

七个面统一走 `whenService`（`index.mjs:83-110`）：现在就绪 → 立刻接线并返回 `ready`；
否则 `ctx.inject` 软注入并返回 `deferred`；两者都不行 → `missing` 并记一条 note。

### 8.2 数据流 ①：会话事件 → 记忆库

```
ctx.on('session/event')                                  index.mjs:233
  → ingest.handleEvent(session, event)                   ingest.mjs
       · messageText(event) 取正文；无正文直接丢
       · ingestKey(sessionId, event, text) → 幂等键       ingest.mjs:271
       · seen 里已有该键 → counters.duplicates++ 后丢弃（SEEN_LIMIT 有界，只丢最老的键）
       · recordIdFor(key, createdAt) = "turn-" + base36(ts) + "-" + fnv1a(key)   ingest.mjs:281-283
             ↑ id 由内容决定，同一事件重放两次得到同一条记录
       · extractMeta(text) 抽 time/place/person/object/topic     ingest.mjs:230
       · estimateEmotion(text) → normalizeRecord(...) → push 进 pending（BATCH_LIMIT = 8）
  → flush()：对批内每条 store.upsert(record)（没有 upsert 才退 insert），并 index.add(record)
       · 单条写失败只记账跳过，不影响整批
       · 累计写入轮数达到 config.ingest.everyTurns（默认 20）→ 同步 runMerge()
  → runMerge()：store.all() → planMerge(records) → 每组 store.merge(keepId, dropIds, patch)
       · 合并改了正文与 mergedInto，所以随后 index.reload(store.all()) 重建索引
       · 合并失败只 counters.mergeErrors++，不打断写入
```

### 8.3 数据流 ②：每轮装配 → 三段注入

```
renderForContext(runtime, {agent})                       index.mjs:133-158
  → store.candidates({limit: 200})                       index.mjs:29 CANDIDATE_LIMIT
  → query = latestUserText(session)                      inject.mjs:441
  → renderInjection({query, records, index, config, now})  inject.mjs:265
       · rankRecords → hybrid.rank（bm25 + meta + vector + heat）
       · decide({score, config, text}) → quote / ask / silence   proactive.mjs:38
       · 双预算各花各的：hotTokenBudget 只给人设/状态段（且仅 mode=companion 才渲染）；
         injectTokenBudget 给召回 + 主动提示，并且先扣掉 INSTRUCTION 的 token 成本
       · 三段固定顺序：人设/状态 → 相关记忆 → 主动召回提示（hint 或 reference）
       · 逐段记 dropped 及原因：hot-budget / noise / budget
       · 返回 {text, tokens, hotTokens, injectTokens, blocks, picks, decision, rows, dropped, recalls}
  → ledger.record(sessionId, {…rendered, budget: hotTokenBudget + injectTokenBudget})
  → 段文本交给 systemPrompt.section；段没挂上时由 pre-step 追加一条消息
```

### 8.4 数据流 ③：面板路由 → 五块

```
GET /.dsh-mnemos/panel                                   index.mjs:357-401
  → 非 GET → 405 + allow:GET
  → nonLoopbackReason(req)：remoteAddress / Host 非 loopback → 403
  → runtime.store 缺失 / state.closed / panelState.mounted===false → 503 + 原因
  → 200 { stats: store.stats(),
          budget: {tokens, budget, picks, dropped} ← ledger.last,
          vector: index.vectorStatus()（即 vector.status()，探测失败回落 {state:'off', reason}）,
          recalls: ledger.last.recalls }
  → client.js: buildViewModel → renderBlocks → 五块
```

注：面板的 `recalls` 是**扁平** `{id, text, score}`（`index.mjs:288-292` 的投影），
`budget.picks` 是**条数**而不是数组（`:390`）。客户端两种形状都认。

## 9. Web 半边：client.js（classic script，只读面板）

### 9.1 形态（本机实测）

宿主加载浏览器半边的唯一真实形态是 **classic script + `window.__ModuleLoader__.load`**：

- `dsh-our-free-model/client.js:25`：`window.__ModuleLoader__.load({ id: 'dsh-our-free-model', factory: require => { ... } })`
- `dsh-orb/client.js:7`：`const React = require('react')`（React 由 loader 注入，不打包）
- `dsh-orb/client.js:2832`：`ctx.slots.inject('settings.section', () => ctx.slots.register({...}))`
- `/tmp/rem_client.js:3898`：`const slots = ctx.get("slots")`；`:3903` `slots.inject("settings.section", () => slots.register({name, id, order, label}, Component))`；`:3973` `exports.inject = ["slots"]`

因此 `client.js` 里没有 `import`/`export` 语句（classic script 里出现顶层 `export` 就是 SyntaxError）。

### 9.2 数据通道（本机实测：同源 HTTP 路由，插件自注册）

三个已装插件拿宿主数据的方式完全一致，没有一个走"通用宿主 RPC"：

- `dsh-our-free-model/client.js:2677`：`const API = new URL('api/our-free-model', document.baseURI).pathname`
  → `:2694` `await fetch(`${API}${path}`, { redirect: 'error', signal })`
- `dsh-orb/client.js:2880`：`await request('/.dsh-orb/jump', { method: 'POST', ... })`
- `/tmp/rem_client.js:82`：`const res = await fetch(serviceUrl() + path)`

客户端 ctx 上出现过的服务只有 `slots`（三者）、`locale`（ofm:31 的 `inject` 列表）、
`uiWorkspace`（orb:2869 `ctx.get('uiWorkspace')`）。**没有任何"读 store"的桥**——数据只可能在宿主侧。

### 9.3 本插件的面板

```
GET <page base>/.dsh-mnemos/panel        ← 只读，由宿主半边 index.mjs 注册
  { stats, budget, vector, recalls }     ← 四块形状 = store.stats() / budget.project() / vector.status() / hybrid.rank()
    ↓ buildViewModel(payload)            纯函数
    ↓ renderBlocks(view, h)              纯函数，h 由调用方注入 → node 里可断言
  五块：记忆总数 / 分层分布 / 本会话注入预算 / 向量三态 / 最近 5 条召回
```

路由相对 `document.baseURI` 解析（反代子路径下前导斜杠会丢前缀，同一坑的注释见
`dsh-our-free-model/client.js:2671-2677`）。

**路由已由宿主侧注册**：`index.mjs:404-423` 用 `webServer.register({kind:'exact', path:'/.dsh-mnemos/panel', handler})`
挂上 `createPanelHandler`（`:357`）。响应语义：本机 GET → 200 + `{stats,budget,vector,recalls}`；
非 GET → 405 + `allow:GET`；非本机（`remoteAddress`/`Host` 非 loopback）→ 403；
库未就绪或已关闭或路由未挂载 → 503。
面板在任何非 200 情况下都渲染「不可用 + 原因」，**不显示任何数字**——拿不到数据就不装作有数据。

### 9.4 只读与失败边界（32 条 node 断言覆盖）

| 情况 | 行为 |
| --- | --- |
| 正常 | GET → JSON → `buildViewModel` → 五块 |
| HTTP 非 2xx | 「不可用：宿主未注册 …（HTTP 404）」 |
| 响应不是 JSON | 「不可用：响应不是 JSON（前 80 字符…）」 |
| 网络异常 / 8s 超时 | 「不可用：请求 … 失败：<原文>」 |
| 没有 `fetch` | 「不可用：当前环境没有 fetch」 |
| `slots` 缺失 / 无 React / `ctx.get` 抛错 | `apply` 返回 `{registered:false, reason}` + `console.warn`，不抛 |
| 没有 `window.__ModuleLoader__` | 整份文件什么都不做（node 里可直接 eval） |

只发 `GET`，不带请求体；不写记忆、不改配置。

## 10. 核对

```
$ ls index.mjs client.js src/*.mjs src/retrieval/*.mjs src/host/*.mjs
client.js
index.mjs
src/budget.mjs
src/capture.mjs
src/config.mjs
src/consolidate.mjs
src/emotion.mjs
src/heat.mjs
src/host/commands.mjs
src/host/ingest.mjs
src/host/inject.mjs
src/host/proactive.mjs
src/host/project.mjs
src/host/tools.mjs
src/record.mjs
src/retrieval/bm25.mjs
src/retrieval/hybrid.mjs
src/retrieval/metadata.mjs
src/retrieval/tokenize.mjs
src/retrieval/vector.mjs
src/store.mjs
src/tiering.mjs
```

（逐字复制这条命令的输出：`ls` 把所有参数一起按字母序排，所以 client.js 与 index.mjs 打头，`src/host/*` 出现在 `src/heat` 与 `src/record` 之间。）

本文出现过的模块名：`config record store heat emotion consolidate budget tiering`、
`tokenize bm25 metadata vector hybrid`、`ingest inject proactive commands tools project`，
加 `index.mjs` 与 `client.js`——共 21 个，与上面 ls 的 21 个文件一一对应。

## 11. 测试对应

| 测试文件 | 覆盖 |
| --- | --- |
| `test/core/core.test.mjs` | config / record / heat / emotion / consolidate / budget |
| `test/core/store.test.mjs` | 落盘、快照压缩、锁、坏行容忍 |
| `test/retrieval/retrieval.test.mjs` | tokenize / bm25 / metadata / vector / hybrid |
| `test/retrieval/perf.test.mjs` | 5000 条中文记录的建索引（< 400ms）与单次 rank（< 25ms）耗时护栏，外加 tokenize 吞吐 |
| `test/host/host.test.mjs` | 宿主接线层：ingest 幂等与合并、双预算渲染、命令与工具定义、面板 handler（含 403/405/503） |
| `test/client/panel.test.mjs` | 浏览器半边：`window.__ModuleLoader__` 定义形状、`settings.section` 注册、五块渲染、全部降级路径、classic-script 约束 |

当前计数（`node --test 'test/**/*.test.mjs'` 实跑）：**130 例全绿** = core 32 + retrieval 40 + host 33 + client 25。

跑法见 README「命令」一节（必须用 glob 形式；目录形式在 Node 22+ 会失败）。