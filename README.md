# dsh-mnemos

DSH 的本地长期记忆插件：把对话里值得留下的东西写成记录、算热度、估情绪、按预算塞回上下文。
零运行时依赖，Node >= 22，单包纯 host（Web 半边见「面板」一节）。

**先说清楚现在的状态**，否则下面每一条命令都会踩坑：

| 部分 | 状态 | 依据 |
| --- | --- | --- |
| 核心层 `src/*.mjs` | ✅ 单测全绿 32 例 | `node --test 'test/core/*.test.mjs'` |
| 检索层 `src/retrieval/*.mjs` | ✅ 单测全绿 40 例 | `node --test 'test/retrieval/*.test.mjs'` |
| 宿主接线层 `index.mjs` + `src/host/*` | ✅ 单测全绿 33 例（接线层任务交付） | `node --test 'test/host/*.test.mjs'` |
| 浏览器面板 `client.js` | ✅ 单测全绿 25 例；⚠️ 没在真实浏览器里渲染过 | `node --test 'test/client/*.test.mjs'` |
| 面板路由 `/.dsh-mnemos/panel` | ✅ GET 200（stats/budget/vector/recalls）＋ POST 动作（search / forget / pin / tier）；非本机 403、缺 `x-dsh-mnemos` 头 400、body > 8KB 413 | 假 webServer 探针 + 201 例测试；非本机实装 |
| 验收夹具 `fixtures/*.json` | ✅ 16 条召回断言全绿 | 用交付的 bm25/metadata/hybrid 实跑，见「夹具」一节 |
| 向量通道（local / api） | ❌ **从未跑通过真实请求** | 全仓库没有任何代码设置 `globalThis.__dshMnemosOnnx`，只有 `vector.mjs` 在读 |
| 安装进本机 profile | ✅ **已装**（`desktop` profile，22 个文件与仓库逐文件 shasum 一致，`import('dsh-mnemos')` 返回 `name`/`apply`/`PANEL_PATH`） | `scripts/install.mjs --install`，备份 `package.json.mnemos-backup-*` |
| 宿主进程内加载 / 浏览器内渲染 | ❌ **未验证**（要重启宿主才加载；重启前 `/.dsh-mnemos/panel` 应为 404） | 重启后按「面板」一节自验 |

### 验证状态分成三档（不美化）

- **已在本机真实环境验证的：安装与落盘。** 插件已装进 `desktop` profile 的 `node_modules/dsh-mnemos`，
  22 个文件与仓库逐文件 shasum 一致；从 profile 目录 `import('dsh-mnemos')` 能拿到 `name`/`apply`/`PANEL_PATH`。
  但**宿主进程内加载**没验过——插件由宿主在启动时按 `dsh.profile.bundles` 加载，本次只装未重启。
- **仅单测 / 探针验证的**：核心层、检索层、宿主接线层、浏览器半边的逻辑与降级路径，共 130 例；
  面板路由的 200 / 405 / 403 由接线层任务用假 `webServer` 探针验过。
- **完全没验证的**：浏览器内实际渲染、宿主进程内加载、向量通道的真实推理（local 与 api 都没发过一次请求）。

## 安装

### 前置

- Node >= 22。本机 PATH 里没有 `node`，用绝对路径：
  `/Users/tle/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`
- 一个可写的 DSH profile 目录，默认 `$DSH_HOME/profiles/<profile>/`（`DSH_HOME` 默认 `~/.dsh`）。

### 路径 0：仓库自带脚本（已实测，推荐）

```bash
node scripts/install.mjs --check      # 只读四件事诊断：bundles / dependencies / node_modules / import
node scripts/install.mjs --install    # 备份 → 写 bundles + dependencies → pnpm install（幂等）
node scripts/install.mjs --uninstall  # 反向：移除两处条目 → pnpm install → 清残留目录（备份保留）
```

任一子命令可加 `--dry-run` 预演；`--profile=<名字>` 指定 profile（默认 `desktop`），`DSH_HOME` 可覆盖 `~/.dsh`。

#### 为什么必须同时写 `dependencies`（这是实测事故，不是推测）

早先的版本只往 `dsh.profile.bundles` 追加条目、再把运行时文件拷进
`node_modules/dsh-mnemos`。宿主随后在一次 profile install 里跑了 pnpm，把这个
"不在 `dependencies` 里"的目录当成无关目录修剪掉，宿主刷新插件列表时就报：

```
dsh: cannot resolve profile bundle "dsh-mnemos" from the dsh installation or <profile 目录>
```

根因是两件事管的是不同的东西：**`bundles` 决定"加载谁"，`dependencies` 决定"包从哪来"**。
只写前者，包管理器不认识它，就会把它删掉——"装上了"只是当时那一刻的错觉。
（对账痕迹：事故后 `pnpm-lock.yaml` 里 `dsh-mnemos` 命中数为 0。）

所以 `--install` 现在的四步是：

1. 备份 `package.json`（以及存在时的 `pnpm-lock.yaml`）为 `*.mnemos-backup-<ISO>`，`wx` 模式**绝不覆盖**旧备份；
2. 在 `dsh.profile.bundles` 追加 `dsh-mnemos`，并在 `dependencies` 写入 `"dsh-mnemos": "file:<仓库绝对路径>"`（两者都已有则不动）；
3. 用宿主自带运行时在该 profile 目录执行 `pnpm install`（`node <runtime>/node/bin/node <runtime>/pnpm/bin/pnpm.mjs install`），让 `node_modules/dsh-mnemos` 由包管理器生成；
4. 写后复核（`JSON.parse` + 条目恰好 1 次 + 其余字段未变）与装完复核（bundles / dependencies / `node_modules` / 逐文件内容 / 从 profile `import('dsh-mnemos')`）。

#### 改完代码怎么同步（不要手改 `node_modules`）

改了 `index.mjs`、`client.js` 或 `src/**` 之后，**直接重跑 `node scripts/install.mjs --install`**。
它会拿仓库的运行时文件集（`index.mjs`、`client.js`、`cordis.patch.yml`、`package.json`、`README.md`、`src/**` 递归）
与已装副本逐文件比 sha256：一致就打印「无需变更」且**一个字节都不写**；有差异就列出
「更新 / 新增」清单并逐个同步。

为什么不靠 `pnpm install`：`file:` 依赖的解析结果没变（版本号没改）时，pnpm 认为没必要重铺，
旧文件会一直留在 `node_modules` 里——重启后用户看到的还是旧面板。

**pnpm 可能把 `node_modules/dsh-mnemos` 铺成一条指向 `.pnpm` store 副本的符号链接**，
那依然是一份副本，改仓库它不会跟。所以脚本从不把「是符号链接」「目录在」当成一致性证据：
一律把两边解析到真实路径（`realpath`）后逐文件比 sha256，需要同步时**写进链接指向的那个真实目录**
（宿主加载的就是那里），并把该物理路径打印出来。

为什么同步是 `unlink` 之后 `copyFile`，而不是直接覆盖：pnpm 用硬链接铺文件，
原地写会写穿到内容寻址的共享 store（可能污染别的 profile）；字节数一变，硬链接也不会自动断。
先 unlink 断链接、再 copyFile 落新 inode，实体目录与 `.pnpm` 链接两种布局都安全；
每次同步后都会在真实路径上回读 sha256 复核，只有复核通过才会打印「一致」。

副本里多出来的文件（旧版本遗留、手工塞进去的 `.bak` 之类）**只提示不删除**：
`--check` 与 `--install` 都会打印「副本内多余文件：N 个（不删除，仅提示）」并列出前 10 条，
但不会动它们——多余文件不影响宿主加载，删包目录里的东西风险更大。

任一步失败：还原 `package.json` 与 `pnpm-lock.yaml` 备份、删掉本次装出来的目录，退出非零。
删除不用 `rm -rf`：逐条 unlink/rmdir，并在每一层重新校验绝对路径落在 `<profile>/node_modules/dsh-mnemos` 下。

`--check` 逐项报告四件事：① `bundles` 是否有条目 ② `dependencies` 是否声明
③ `node_modules/dsh-mnemos` 是否在 ④ 从 profile 能否 `import('dsh-mnemos')`。
四项任一不满足，它会直接打印宿主会报的那句 `cannot resolve profile bundle` 并给出修复命令（退出码 1）。

`--no-pnpm` 是逃生口：只改 manifest、不动 `node_modules`，输出里会明确警告
"宿主下次 install 会把它修剪掉"。离线排障用，不要当正常装法。

**装完必须重启宿主**才生效：脚本不重启、不终止任何进程。

### 路径 A：DSH 插件命令（未验证）

```bash
dsh plugin add /path/to/dsh-mnemos
```

**本机 PATH 里没有 `dsh` 命令**（`command -v dsh` → 空），所以我连这条命令都没能执行过。
装完请用下面「装完怎么确认」自查。

### 路径 B：手工放进 profile（未验证，但目标路径是实测的）

本机其它插件（dsh-mask、dsh-orb 等）确实在 `~/.dsh/profiles/desktop/node_modules/<包名>/` 下，
所以目录形态是对的；**「放进去就能被加载」这一步我没有实装验证**。

```bash
cp -R /path/to/dsh-mnemos ~/.dsh/profiles/desktop/node_modules/dsh-mnemos
```

然后把 `cordis.patch.yml` 里的 `insert` 条目并进 profile 的插件列表（该文件自带注释示例）。

### 装完怎么确认

没有任何一条我验证过的命令能确认「宿主已加载」。能确认的只有核心层本身：

```bash
node -e "import('./src/config.mjs').then(m => console.log(m.resolveConfig({}).dataDir))"
```

能打印出你的 dataDir 就说明核心层可加载；宿主是否加载成功，要看 DSH 自己的插件日志。

## 卸载

```bash
# 1. 停掉插件：在 profile 的插件列表里去掉 dsh-mnemos 条目（或 dsh plugin remove dsh-mnemos）
# 2. 删包
rm -rf ~/.dsh/profiles/desktop/node_modules/dsh-mnemos
# 3. 记忆数据是独立目录，不删就还在（想彻底清干净再加这一步）
rm -rf ~/.dsh/profiles/desktop/dsh-mnemos
```

第 3 步是**删记忆**，不可逆。想留档就先备份，见「数据在哪」。

## 配置

全部字段都有默认值，只写你要改的。非法值不会炸，会回落到默认并通过 `resolveConfig` 的
`warnings` 出口报出来。

| 键 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 关掉只停记忆功能，不卸载插件 |
| `dataDir` | string | `$DSH_HOME/profiles/<profile>/dsh-mnemos` | 换目录等于换一份记忆 |
| `mode` | `general` \| `companion` | `general` | companion 更爱主动引用记忆 |
| `hotTokenBudget` | int 0..200000 | `1200` | 「热记忆」段落最多占多少 token |
| `injectTokenBudget` | int 0..200000 | `600` | 单轮检索结果注入的上限 |
| `topN` | int 0..100 | `6` | 单轮最多挑几条记忆 |
| `vector.enabled` | `auto` \| `off` \| `on` | `auto` | 探到配置齐全才开 |
| `vector.provider` | `none` \| `local` \| `api` | `none` | 见下方「降级矩阵」 |
| `vector.model` | string \| null | `null` | local 时是模型文件路径；api 时是模型名 |
| `vector.endpoint` | string \| null | `null` | api 时要给，会自动补 `/embeddings` |
| `vector.apiKeyEnv` | string \| null | `null`（实际按 `OPENAI_API_KEY`） | **只写环境变量名**，密钥本身不进配置文件 |
| `proactive.enabled` | bool | `true` | 是否允许主动提起记忆 |
| `proactive.quoteThreshold` | number 0..1 | `0.62` | 高于它才「直接引用」 |
| `proactive.askThreshold` | number 0..1 | `0.45` | 高于它才「试探性提起」 |
| `proactive.noiseFloor` | number 0..1 | `0.18` | 低于它当噪音丢掉 |
| `proactive.maxPerTurn` | int 0..20 | `1` | 一轮最多主动提几次 |
| `ingest.llm` | `auto` \| `off` | `auto` | 是否让模型帮忙抽事实 |
| `ingest.everyTurns` | int 1..10000 | `20` | 攒够多少轮做一次归纳 |
| `debug` | bool | `false` | 详细日志 |

`proactive.*` 的生效代码在 `src/host/proactive.mjs`（与本包同期并行交付），本次交付未验证其行为。

环境变量（都在 `src/config.mjs` 里读取，可覆盖默认路径）：

| 变量 | 作用 |
| --- | --- |
| `DSH_MNEMOS_DATA_DIR` | 直接指定 dataDir，优先级高于 `config.dataDir` 的默认值 |
| `DSH_HOME` | 替代 `~/.dsh` |
| `DSH_PROFILE` | 指定 profile 名；不设时若 `profiles/` 下只有一个目录就用它，否则 `default` |

## 分层怎么算（hot / cold / persona / state）

| 层 | 怎么进来 | 会不会自己变 |
| --- | --- | --- |
| 热记忆 `hot` | 新写入的记录默认落这一层 | 满 30 天 + 未钉住 + 未被显式指定 + 当前热度 < 0.35 → 降为冷记忆 |
| 冷记忆 `cold` | 由热记忆按上面的判据降级而来 | 被再次提及（召回、或合并进新内容）→ 回到热记忆 |
| 人格前提 `persona` | 只能显式写入 | 不参与降级，也不参与时间衰减 |
| 当前状态 `state` | 只能显式写入 | 不参与降级，也不参与时间衰减 |

- **降级是惰性判定，没有后台定时器**：在**写入落库**与**插件启动**时各扫一次。所以一条"够老了但还没被扫到"的
  记忆会短暂停在热记忆——这是按需触发的代价，不是漏判。
- **冷层不吃年代衰减**：冷记忆的时近性恒为 1（久远本身不再压低热度），但整体再乘 **0.75**，
  所以同等条件下热记忆仍略占优。
- **被再次提及会回升**：冷记忆的提及次数增加时（被召回、或被合并进新内容）自动回到热记忆。
- **人格前提 / 当前状态只能显式写入**，永不自动降级：它们是"一直成立的前提"，被自动降级等于让她忘了自己是谁。
- 升级到这一版时，现有记录会按同一规则**重算一次分层**——只改 `tier` 字段，不动正文。

## 和人合作人格插件（persona 桥接）

**分工一句话：人格插件负责「她是谁」（编辑 + 注入），dsh-mnemos 负责「她经历过什么」＋「她曾是什么人格」。一份人格，两处用途，绝不重复注入。**

### 两种模式

| `persona.mode` | 谁注入人设 | mnemos 做什么 |
| --- | --- | --- |
| `self`（默认） | mnemos 自己渲染 `[人设与状态]` 段 | 用 `tier=persona/state` 的记录当人设，`hotTokenBudget` 就是给它花的 |
| `external` | **完全不注入**（人设段不出现，`hotTokenBudget` 不消费） | 只注入记忆与主动召回；人格快照照旧落库，供检索与追溯 |

配了 `external` 之后，两边不会再同时说「她是谁」——那是最糟的情况：模型会看到两段互相矛盾的人设，只能瞎猜。

### 配置

```yaml
persona:
  mode: external        # self（默认）| external
  kind: http            # none（默认）| file | http
  url: "http://127.0.0.1:<对方端口>/api/dsh-persona-dafeiyu/persona"   # kind=http
  path: ""              # kind=file 时填人格文件路径
  timeoutMs: 2000       # 钳 200..10000
  maxChars: 4000        # 钳 200..20000
  refresh: startup      # startup（默认）| turn
```

**`kind: http` 只接受本机地址**（`127.0.0.1` / `localhost` / `[::1]`）。`0.0.0.0`、`127.0.0.2`、云元数据地址 `169.254.169.254`、`https://` 一律拒绝，**而且拒绝时不发请求**——这条是硬安全线，不是建议。

### 快照是怎么落库的

读到人格文本 → trim → 截到 `maxChars` → 算 sha256 前 16 位 → 决定动作：

| 情况 | 动作 |
| --- | --- |
| 库里没有 persona 快照记录 | **新建**一条：`tier=persona`、`tierSource=user`、`pinned=true`、`weight=0.95`、`meta.topic=["persona"]` |
| 有，且哈希一样 | **跳过**（幂等：重启一百次也只有一条） |
| 有，但哈希变了 | **更新同一条**（id 与 `createdAt` 不变，只改正文与哈希） |

`refresh: startup` 只在插件启动时同步；`refresh: turn` 会在每轮装配时检查一次，但**距上次同步 ≥60 秒才真的去读**，且是 fire-and-forget——不 await、不阻塞这一轮的回答，失败只记一条 note。想立刻生效就重启（或等一分钟）。

### 怎么确认它在工作

- `/mem status` 里有一行：`人格：模式 external · 来源 http · 上次同步 <时间> · 由启动触发（hash ab12…）`；按轮同步时显示「由 turn 触发」；没配来源时显示「未同步」。
- 面板「分层分布」里 `人格前提` 那一层会有数（就是这条快照）。
- 快照记录也能被检索：在面板「操作」卡里搜人格里的一句话，能搜到它。

### 三个必须避免的坑

1. **别同时装两个「自带记忆」的插件**（`dsh-remembers`、`meow-memory`、`dsh-liketavern` 都自带记忆）。两套记忆会同时注入，既烧 token，又可能出现互相矛盾的事实。
2. **别让两边都注入人设**：装人格插件之后，把 `persona.mode` 改成 `external`。否则「她是 A」和「她是 B」会同时出现在上下文里。
3. **别把 `kind: http` 指向非本机地址**：写错会被拒（不报错、只是不同步），看起来像"人格没记住"。
## 数据在哪

```
<dataDir>/
  records.jsonl          追加写的事件日志（一行一条 {"op":"put","r":{...}}）
  memory.snapshot.json   压缩后的全量快照
  store.lock             跨进程锁，30s 不刷新视为陈旧可抢占
  capture.json           会话级记忆开关（{version:1,sessions:{[id]:{enabled,at}}}，最多 500 个会话）
```

- 备份：`cp -R <dataDir> <别处>` 即可，四个文件是一致的一套（`capture.json` 丢了只会让开关回到默认「开」）。
- 重置：删掉整个 `<dataDir>`，下次启动会重建。
- 手工看一下库里有什么（把 `/tmp/mnemos-demo` 换成你的 dataDir）：

  ```bash
  node -e "import('./src/store.mjs').then(m => { const s = m.createStore({ dataDir: '/tmp/mnemos-demo' }); console.log(s.stats()); s.close(); })"
  ```

  **注意：目录不存在时它会建一个空库**，所以别指着一个你以为不存在的路径跑。空库的真实输出：

  ```
  {
    dataDir: '/tmp/mnemos-demo',
    count: 0, live: 0, merged: 0,
    byKind: {}, byTier: {}, bySubject: {},
    logLines: 0, lastSnapshotAt: null,
    snapshotEvery: 512, closed: false, warnings: []
  }
  ```

## 命令

> **测试命令必须用 glob 形式。目录形式 `node --test test/core/` 在 Node 22+ 必定失败**——
> 这不是本项目的缺陷，是 `node --test` 的行为。实测（Node v24.21.0）：

```bash
$ node --test test/core/
✖ test/core (29.346084ms)
  'test failed'
exit=1
```

下面每条都实测跑过，输出就是本仓库交付时的真实输出。

```bash
# Node 版本（engines 要求 >=22）
$ node --version
v24.21.0

# 全部测试
$ node --test 'test/**/*.test.mjs'
ℹ tests 180
ℹ pass 180
ℹ fail 0

# 只跑核心层（含分层判定）
$ node --test 'test/core/*.test.mjs'
ℹ tests 49
ℹ pass 32
ℹ fail 0

# 只跑检索层
$ node --test 'test/retrieval/*.test.mjs'
ℹ tests 40
ℹ pass 40
ℹ fail 0

# 只跑宿主接线层
$ node --test 'test/host/*.test.mjs'
ℹ tests 55
ℹ pass 33
ℹ fail 0

# 只跑浏览器半边（假 window.__ModuleLoader__）
$ node --test 'test/client/*.test.mjs'
ℹ tests 36
ℹ pass 25
ℹ fail 0

# 夹具 JSON 合法性（需要 Node 的 import attributes 语法）
$ node -e "import('./fixtures/recall-cases.json', { with: { type: 'json' } }).then(m => console.log('cases:', m.default.cases.length))"
cases: 6
```

本机 PATH 里没有 `node` 时，把上面的 `node` 换成
`/Users/tle/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`。

## 插件给你的命令与工具

装好并重启宿主后，会话里可以直接用这些（全部只读或只影响本地记忆，不联网）：

| 入口 | 用法 | 做什么 |
| --- | --- | --- |
| `/mem status` | — | 记忆数、索引、本会话注入预算、**分层统计**（本次降级几条 / 显式几条 / 自动几条 / 回升几条）、降级项 |
| `/mem search <关键词>` | — | 按关键词/线索检索记忆，返回 id 与分数 |
| `/mem forget <id>` | — | 删掉一条记忆 |
| `/mem pin <id>` | — | 钉住一条（永久参与候选，且**不会被自动降级**） |
| `/mem budget` | — | 看本会话的注入预算与最近一次装配的取舍 |
| `/mem tier <id> <tier>` | tier ∈ hot / cold / persona / state | **显式指定分层**：写入 `tierSource=user`，以后不会被自动降级；填错会给可用值列表 |
| `mem_search` | `{ query, limit? }` | 给模型用的检索工具（不用自己敲斜杠命令） |
| `mem_write` | `{ text, kind?, tier? }` | 给模型用的写入工具；给了 `tier` 就按显式指定写入（`tierSource=user`），非法值返回结构化错误且**不落库** |
| `mem_forget` | `{ id }` | 给模型用的删除工具 |

分层判定的具体规则见上面「分层怎么算」一节；显式指定的层只在你自己改回去（再敲一次 `/mem tier`）之前不会被系统动。
## 夹具怎么用

`fixtures/` 里全是**虚构内容**，不含任何真实用户数据：

| 文件 | 场景 | 内容 |
| --- | --- | --- |
| `conversation-chat.json` | 日常闲聊 | 6 轮 turn + 4 条记录，带时间戳与 `expectedRecall` |
| `conversation-lowmood.json` | 情绪低落 | 5 轮 turn + 4 条记录，含一条 `tier: state` 的「先别开玩笑」 |
| `conversation-crossmonth-recall.json` | 跨月线索回忆 | 1 月说过的行程，4 月的查询要能召回 |
| `recall-cases.json` | 召回断言 | 6 条 case：query / 期望命中的记录 id / `vectorUsable` |

用法（三个 conversation 文件里的 `records` 用 `normalizeRecord` 载入，**不要用 `createRecord`**——
后者会另发新 id，断言里的 id 就对不上了）：

```js
import { readFileSync } from "node:fs";
import { normalizeRecord } from "./src/record.mjs";
import { createBm25 } from "./src/retrieval/bm25.mjs";
import { createMetaIndex } from "./src/retrieval/metadata.mjs";
import { rank } from "./src/retrieval/hybrid.mjs";

const fx = JSON.parse(readFileSync("fixtures/conversation-crossmonth-recall.json", "utf8"));
const records = fx.records.map((r) => normalizeRecord(r, { now: fx.now }));
const bm25 = createBm25();
const metaIndex = createMetaIndex();
for (const r of records) { bm25.add(r); metaIndex.add(r); }

const rows = rank({ query: "杭州 樱花", records, metaIndex, bm25, now: Date.parse(fx.now) });
console.log(rows.slice(0, 3).map((r) => r.record.id + "@" + r.score.toFixed(3)));
// [ 'turn-trip-01@0.976', 'turn-trip-04@0.646', 'turn-trip-03@0.505' ]
```

交付时我用这套 API 跑完了 `recall-cases.json` 的 6 条 + 三个 conversation 文件的
`expectedRecall` 共 10 条，**16 条全绿**（`pass=16 fail=0`）。那个一次性校验脚本没有随包交付，
因为它不属于插件本体；上面这段就是它的骨架。

`vectorUsable: false` 的意思是：这条 case 的期望结果在**不开向量通道**时就该成立。
反过来，开了向量通道分数会变，但期望命中的 id 不应掉出 `expectTopN`。

## 降级矩阵

每一行都是代码里真实存在的分支，不是「可选高级功能」的另一种说法。

| 条件 | 行为 | 出处 |
| --- | --- | --- |
| `vector.provider: none`（默认） | `status() = {state:'off', reason:'provider-none'}`；检索只用 bm25+meta+heat，vector 的 0.15 权重按比例分给其余三路 | `vector.mjs:134`, `hybrid.mjs:15` |
| `vector.enabled: off` | `{state:'off', reason:'disabled-by-config'}` | `vector.mjs:135` |
| `provider: api` 缺 endpoint | `{state:'degraded', reason:'api:no-endpoint'}`，本批不参与向量路 | `vector.mjs:142` |
| `provider: api` 缺密钥 | `{state:'degraded', reason:'api:no-api-key:<ENV名>'}` | `vector.mjs:143` |
| `provider: local` 但没人注入运行时装 | `{state:'degraded', reason:'local:runtime-unavailable'}`——**本仓库里没有任何代码设置 `globalThis.__dshMnemosOnnx`，所以 local 现在必然走这条** | `vector.mjs:119` |
| `provider: local` 模型文件不存在 | `{state:'degraded', reason:'local:model-not-found'}` | `vector.mjs:113` |
| embed 抛错 / 超时 15s | 返回 `null`，同一原因只 log 一次，检索继续 | `vector.mjs:219` |
| 元数据索引没收这条 id | `matchScore` 返回 `null` → 回落到读 `record.meta`，不当成「不相关」 | `metadata.mjs:183` |
| 查询线索全部落空 | `narrow()` 返回 `null`（fail-open，不缩小范围） | `metadata.mjs:174` |
| 某一路打分抛错 | `hybrid.rank` 内 try/catch，该路置 0，排序继续 | `hybrid.mjs:135` |
| JSONL 有一行坏的 | 跳过该行并告警；末尾半行会触发整份重写 | `store.mjs:207` |
| 落盘失败 | 内存回滚到上一版并抛 `StoreError` | `store.mjs:255` |
| 浏览器里 `slots` 缺失 / 没有 React / `ctx.get` 抛错 / `ctx` 为空 | `apply` 返回 `{registered:false, reason}` 并 `console.warn`，不抛，对话不受影响 | `client.js:register`、`client.js:apply` |
| 面板路由没注册 / 超时 / 非 JSON | 面板显示「不可用 + 原因」，**不显示任何数字** | `client.js:loadPanel` |

## 面板

`client.js` 是**真正的浏览器半边**：classic script，顶层只做一件事——
`window.__ModuleLoader__.load({ id: 'dsh-mnemos', factory })`，`exports.inject = ['slots']`，
`exports.apply(ctx)` 在 `settings.section` 注册一个面板（id `dsh-mnemos`、order 39、标题「记忆星图」）：
**看数据只用 GET；写操作只在你按下按钮时发生（POST，见下面「在面板里能做什么」）。**

面板顶部有「概览 / 说明」两段：**概览**是下面这一屏，**说明**讲清每一块是什么、以及它怎么工作。
切换是纯本地状态（`useState`），不发请求、不写数据、没有任何动画；没有 hooks 的环境下两页顺序渲染。

**为什么叫「记忆星图」**：插件名 `dsh-mnemos` 取自 Mnemosyne（记忆女神），而面板本体最上面那片星幕就是按真实分层计数点亮的——星点数与半径由 `stats.byTier` 决定。名字取「星图」，既是那幅画，也是"她记得的分布"这件事本身。

设置页里不写「（只读）」字样（那对用户是噪音）。面板能写库之后，底部那行改成了更准确的一句：**「本机面板 · 只有你按下的操作才会落库」**——不假装只读，也不假装随时在写。

形态与数据通道都有本机证据：

| 结论 | 证据 |
| --- | --- |
| 载入形态是 classic script | `dsh-our-free-model/client.js:25`、`dsh-orb/client.js:7` |
| 注册方式是 `slots.inject('settings.section', …)` | `dsh-orb/client.js:2832`、`/tmp/rem_client.js:3903` |
| 两种拿 slots 的写法都存在 | `ctx.get("slots")`（rem_client:3898）、`ctx.slots`（orb:2832）——本文件两种都试 |
| 数据通道是**插件自注册的同源 HTTP 路由** | `dsh-our-free-model/client.js:2677+2694`（`api/our-free-model`）、`dsh-orb/client.js:2880`（`/.dsh-orb/jump`）、`/tmp/rem_client.js:82` |
| 客户端 ctx 上只有 slots / locale / uiWorkspace，没有通用 RPC | `dsh-our-free-model/client.js:31`、`dsh-orb/client.js:2869` |

### 面板读什么

```
GET <page base>/.dsh-mnemos/panel     ← 只读，宿主半边 index.mjs:404 已注册（kind:'exact'）
{ stats, budget, vector, recalls }    ← 四块形状 = store.stats() / budget.project() / vector.status() / hybrid.rank()
```

渲染五块：**记忆总数 / 分层分布 / 本会话注入预算 / 向量三态 / 最近 5 条召回**。
路径相对 `document.baseURI` 解析（反代子路径下前导斜杠会丢前缀，同坑修复见 ofm:2671-2677）。

### 长什么样（柔和粉紫 · 手绘笔触）

陪伴向的柔和风：粉紫强调色（HSL 饱和度 ≥ 55%）+ 手绘笔触，**全部内联**（style 对象 + 内联 SVG），
不引 CSS 文件、不引网络资源、不加路由——断网也能看。

**构图节奏是重-中-轻，不是五张同质卡片：**

1. **星幕（视觉主角，112px）**：顶部整条是 `radial-gradient` 铺满的夜空（粉在上左、紫在下右），
   星点数量、半径（3–9px）、横向跨度全部由 `stats.byTier` 的真实分桶决定；每颗星是三层同心圆（光晕 + 中层 + 星核 + 高光点），
   连线是 1px 渐变描边 + 二次贝塞尔弧。全 0 时画 5 颗「待点亮」暗星 + 虚线轨迹，并写一句「还没有星点——等第一批记忆落下，这里会亮起来。」
2. **首卡（重）**：**没有 1px 边框**，改用 SVG 手绘框（沿圆角矩形采样、逐点抖动、`vector-effect: non-scaling-stroke`）；
   左边环（进度 = 真实 `live/total`）+ 34px/600 的大数字 + 数字下方一条**手绘波浪下划线**；右边四枚分层图例（热/冷/人格/状态，圆点+名称+真实计数），把宽度填满。
3. **分层卡（中）**：条形 11px，条内高光，右侧等宽数字；数量为 0 的层条宽 0、文字降一档灰。
4. **预算卡（中）**：进度条 8px + 刻度 `0 / 50% / 100%` + 两端数值；上限为 0 时**不写「未设上限」**，直接写「本会话尚未装配」。
5. **向量卡 / 召回卡（轻）**：更小的圆角、更淡的底、无描边，形成收束。向量是「小圆点 + 带色胶囊 + 人话原因」
   （`provider-none` → 「未配置向量通道」）；召回是「等宽数字徽标 + 13px 正文（行高 1.5、间距 10px）」。

**手绘笔触至少三处**：首卡的手绘边框、数字下的波浪线、空态/不可用态插图的三档线宽（0.9 / 1.4 / 2.4）。
图标 18px、线宽 1.6、颜色 text2（不是 14px 低对比的小污点）。

**文字对比度**（WCAG，底色 `#171320` / 卡片 `#231D2D`）：正文 `#F4EDFB` **15.7 / 14.1**，
次级 `#D3C8E6` **10.4 / 9.3**，说明 `#A79BBB` **6.3 / 5.7**，降级灰 `#8F87A0` **5.1 / 4.6**——全部 ≥ 4.5:1。

想自己看一眼（不需要浏览器、不联网）：

```bash
node scripts/preview-panel.mjs > /tmp/panel-preview.html   # 最前面是 560px 真实宽度栏，其后是 正常态 / 空态 / 不可用态
```

这份预览用的是 `renderBlocks` 的**真实输出**（脚本只把元素树序列化成标签），不是另画一版。

### 路由语义（宿主侧已实现，我只做了探针验证）

| 情况 | 响应 | 面板 |
| --- | --- | --- |
| 本机 GET | 200 + `{stats,budget,vector,recalls,capture}` | 渲染五块 + 会话开关 |
| 本机 POST（带 `x-dsh-mnemos: 1`） | 200 + `{ok,...}`：`search` / `pin` / `tier` / `forget` / `capture` | 行内显示结果 |
| POST 缺头 / 非 JSON / 超 8KB / 未知 action | 400（超限 413）+ `{ok:false,code}` | 行内显示原因，列表不清空 |
| 非 GET/POST | 405 + `allow: GET, POST` | 「不可用 + 原因」 |
| 非本机访问（`remoteAddress` / `Host` 非 loopback） | 403 + 原因 | 「不可用 + 原因」 |
| 库未就绪 / 已关闭 / 路由未挂载 | 503 + 原因 | 「不可用 + 原因」 |

**面板只允许本机访问。** 这是有意的：面板会把记忆正文带出来，插件绑到 `0.0.0.0` 或被隧道转发时不该外泄。
副作用是——**你从另一台机器、或在隧道/反代的远端地址下打开设置页，会看到 403 → 面板显示不可用**。
这不是 bug，是设计；确实需要远端看，请自己在前面加认证层，不要放开 loopback 判断。

任何非 200 面板都**不显示任何数字**——拿不到数据就不装作有数据。

### 怎么自己验一遍（不需要浏览器）

用一个假 `window.__ModuleLoader__` 把 factory 跑起来：

```bash
$ node --input-type=module -e '
const fs = await import("node:fs"), vm = await import("node:vm");
let def = null;
const h = (t, p, ...k) => ({ t, p, k });
const React = { createElement: h, useState: (v) => [v, () => {}], useEffect: (f) => f() };
const box = { window: { __ModuleLoader__: { load: (d) => { def = d; } } }, document: { baseURI: "http://x/" }, URL, AbortController, setTimeout, clearTimeout, console };
box.globalThis = box;
vm.runInNewContext(fs.readFileSync("client.js", "utf8"), box);
const ex = def.factory((n) => (n === "react" ? React : null));
const regs = [];
const slots = { inject: (n, f) => regs.push(f()), register: (d, c) => ({ d, c }) };
console.log("inject:", JSON.stringify(ex.inject), "path:", ex.panelPath);
console.log("apply:", JSON.stringify(ex.apply({ get: () => slots })), "label:", regs[0].d.label());
const view = ex.__test.buildViewModel({ stats: { count: 3, live: 2, merged: 1, byTier: { hot: 2, cold: 1 } }, budget: { tokens: 120, budget: 600, picks: [1], dropped: [] }, vector: { state: "degraded", reason: "provider-none" }, recalls: [{ record: { id: "turn-x", text: "用户说周末想去海边" }, score: 0.71 }] });
for (const line of ex.__test.formatViewModel(view)) console.log(line);
'
inject: ["slots"] path: /.dsh-mnemos/panel
apply: {"registered":true,"id":"dsh-mnemos"} label: 记忆星图
记忆数：3（有效 2 / 已合并 1）
  热记忆：2
  冷记忆：1
  人格前提：0
  当前状态：0
预算：120 / 600（20%）
向量通道：降级（已退回纯文本检索） [provider-none]
最近召回：
  turn-x  0.71  用户说周末想去海边
降级项：vector-provider-none
```

同样的断言已经固化进仓库：`test/client/panel.test.mjs`（25 例，`node --test 'test/client/*.test.mjs'`），
覆盖导出形状、`settings.section` 注册、五块渲染与全部降级路径；面板与宿主一旦漂移，这些用例会直接红。
上面这段是它的最小骨架。

### 在面板里能做什么（不用敲命令）

概览页底部有一张**「操作」卡**，所有动作都在这里点：

| 动作 | 怎么做 | 背后调用的接口 |
| --- | --- | --- |
| 搜索 | 输入关键词，回车或点「搜索」 | POST action=search（query / limit） |
| 钉住 / 取消钉住 | 结果行右侧按钮 | POST action=pin（id / pinned） |
| 改层 | 结果行右侧下拉（热 / 冷 / 人格 / 状态） | POST action=tier（id / tier） |
| 忘记 | 点「忘记」→ 变红「确认忘记？」→ 3 秒内再点一次 | POST action=forget（id） |
| 本会话是否记录 | 「操作」卡顶部的「记忆 · 开 / 关」 | POST action=capture（enabled，可选 sessionId） |

「忘记」是唯一不可撤销的动作，所以做了两步确认（不是 `window.confirm`——那是命令行思路）。
动作失败会在行内显示原因、列表不清空；3 秒内没确认就自动退回，不会误删。

### 这个会话要不要记（记忆 · 开 / 关）

不是每段对话都值得进长期记忆——一次性问答、试玩、敏感话题都该能「漏过」。所以有一个**会话级开关**：位置有三处，状态只有一份。

| 位置 | 什么时候可见 |
| --- | --- |
| 首屏「deepseek-harness ／ 标准模式」那一行 | 还没进会话时（hero 首屏） |
| 输入框右侧的小胶囊 | 已经在会话里时 |
| 设置 →「记忆星图」→「操作」卡顶部 | 任何时候 |

点一下就在「记忆 · 开」与「记忆 · 关」之间切换；失败会变红点并在 2 秒后回退，不留半截状态。

| 状态 | 含义 |
| --- | --- |
| 开（默认） | 这个会话的对话照常写成记忆 |
| 关 | **从这一刻起**不再写入；**已有记忆一条都不删**，检索与注入照旧 |
| 再打开 | 从那一刻起继续记 |

**落盘与范围**：开关按会话 id 存在 `<dataDir>/capture.json`（原子写、最多 500 个会话，超出淘汰最旧的），重启后仍在。没设置过的会话用全局默认 `ingest.capture`（默认开）。

**两个必须知道的行为**：

1. **首屏与输入区是两个不同的宿主槽位**（`conversation.hero.options` 与 `conversation.composer.dock`）。宿主只在「已进会话且输入框非空」时渲染后者——这就是为什么在没有会话的首屏上，胶囊会出现在上面那一行、而不是输入框旁。
2. **胶囊显示的会话以「点击那一刻」为准**：宿主没有暴露「会话切换」事件，所以你在胶囊可见期间切了会话但没点它，标签可能还是上一个会话的值；点一下会先拉最新状态再翻转，不会改错会话。
### 写入通道的安全门槛

面板不再只读，所以宿主侧收紧了入口。写入请求必须**同时**满足五条，缺一条直接拒绝且**不碰存储**：

1. 方法是 `POST`（`OPTIONS` 也在拒绝之列——等于不放行跨站预检）；
2. `content-type` 是 `application/json`（或 `*+json`）；
3. 带自定义头 `x-dsh-mnemos: 1`；
4. 来源是本机 loopback（`remoteAddress` / `Host`）；
5. body ≤ 8KB（声明超限连流都不读）。

第 3 条是真正的门：浏览器不允许跨站页面带自定义请求头（会先触发预检，而我们不放行预检）。所以「别的网页偷偷删你记忆」这条路是断的。
读路径（GET）仍只发 GET、无请求体、8 秒超时，失败原文一律进「不可用 + 原因」。

## token 账（实测，含负面结论）

三个口径，同一份合成会话、同一条估算公式（`src/budget.mjs` 的 `estimateTokens`：
CJK×1 + 英文词×1 + 标点×0.3 向上取整，零第三方分词器）：

- **A 基线** = 全部 turn 文本 + 人设/状态全文（不装插件时的上下文）；
- **B 仅注入** = A + 注入块（`projection.enabled=false`，只加不删的 v1 行为）；
- **C 注入+投影** = `projectMessages` 折叠旧正文后 + 注入块（默认配置，线上真实行为）。

百分比 = 相对 A，**负数更省、正数更贵**。复现：`node scripts/measure-tokens.mjs`
（确定性：连跑两次输出逐字节相同；不联网）。配置 `mode=companion`、向量关闭、
`injectTokenBudget=600`、`hotTokenBudget=1200`。

### fixture 原样（4-6 轮）

| fixture | turns | A 基线 | B 仅注入 | C 注入+投影 | B vs A | C vs A | 投影 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chat | 6 | 78 | 199 | 199 | +155.1% | +155.1% | 未触发 |
| crossmonth-recall | 4 | 57 | 197 | 197 | +245.6% | +245.6% | 未触发 |
| lowmood | 5 | 93 | 242 | 242 | +160.2% | +160.2% | 未触发 |
| **合计** | 15 | **228** | **638** | **638** | **+179.8%** | **+179.8%** | 未触发 |

**短会话下 C 比 A 贵 410 tokens。** 这不能藏：注入块有固定开销（指令行 + 段标题），
而整段历史本身只有 205 tokens；历史远不到 `projection.triggerTokens=6000`，投影根本不介入，
所以 C 与 B 完全相同。

### 同一份 fixture 按天重放

| 档位 | 合计 turns | 历史合计 | A 基线 | B 仅注入 | C 注入+投影 | B vs A | C vs A | 投影 | 折叠后历史 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1× | 15 | 205 | 228 | 638 | 638 | +179.8% | +179.8% | 0/3 触发 | 205 |
| 8× | 120 | 1640 | 1663 | 2240 | 2240 | +34.7% | +34.7% | 0/3 触发 | 1640 |
| 32× | 480 | 6560 | 6583 | 7160 | 7160 | +8.8% | +8.8% | 0/3 触发 | 6560 |
| 64× | 960 | 13120 | 13143 | 13720 | 13720 | +4.4% | +4.4% | 0/3 触发 | 13120 |
| 128× | 1920 | 26240 | 26263 | 26840 | **1508** | +2.2% | **-94.3%** | 3/3 触发 | 908 |
| 256× | 3840 | 52480 | 52503 | 53080 | **1508** | +1.1% | **-97.1%** | 3/3 触发 | 908 |

两处必须点明的机制：

1. **触发线按单个会话算，不是按全组合计。** 64× 时全组历史 13120 tokens 看着早已越线，
   但最大的一份会话只有 4992 tokens，所以那一档 0/3 触发、C 仍等于 B。
   C 首次低于 A 是在 **128×（-94.3%）**，不是 64×。
2. **注入侧不随历史增长。** 从 8× 起注入块恒定 **577 tokens**（1× 是 410），
   被 `injectTokenBudget + hotTokenBudget = 1800` 卡住；长会话省的完全是投影折叠的那部分。

### 一句诚实的限制

投影默认只在**历史超过 6000 tokens**（`projection.triggerTokens`）时触发，
所以**短会话不会更省，反而因为注入指令的固定开销略贵（实测 +179.8%）**；
本插件也不改变宿主的 compaction 策略，两者叠加时的实际收益取决于宿主行为——
上面的 C 只是"插件自己能控制的那部分"的上限，不是端到端的真实节省。

## 已知限制

1. **中文单字会互相命中。** `tokenize` 把 CJK 切成单字 + 双字，任何共享一个常用字的查询都可能
   命中。实测：在 `conversation-crossmonth-recall.json` 上查询 `量子计算机`，会命中
   `turn-trip-01`（score 0.679），因为「计划」里有「计」。这是分词层的取舍，不是检索 bug；
   反例 case 因此改用 ASCII 查询词。
2. **面板要能显示数字，得宿主进程真的在跑。** 只读路由已在 `index.mjs:404` 注册（`kind:'exact'`），但插件不运行就没有这个端点；本机无实装环境，没法验证这一步。
3. **向量通道从未跑通真实请求。** `status()` 的判定逻辑和失败降级路径有测试覆盖，
   但 `embed()` 真的发过一次 HTTP、或真的跑过一次 ONNX 推理，一次都没有。
4. **`node --test` 目录形式必失败。** 用 glob。
5. **数据目录只有一个进程能写。** 第二个实例会被 `store.lock` 挡下（30s 陈旧锁可接管）。
6. **记忆是明文 JSON。** `records.jsonl` 与快照都不加密，放哪都别放同步盘。
7. **面板未经浏览器实装验证。** 逻辑与七条降级路径有 25 例 node 断言（`test/client/panel.test.mjs`），但没在真实 DSH web shell 里加载过。
8. **`proactive.*` 的阈值判定有单测，但"什么时候真的主动提起"没在真实对话里验证过。**
9. **面板只允许本机访问。** `remoteAddress` / `Host` 非 loopback 一律 403；从别的机器或隧道访问会看到不可用。
10. **`ingest.llm=auto` 目前只写一条 note，不真做 LLM 抽取。** 启动时 `index.mjs:505-507` 会记
    「LLM 抽取未实现（v2 才有）」，实际走规则抽取。别把配置项当成已生效。
11. **`meta.time` 只能是字符串。** `normalizeMeta` 对 time 做 `String(meta.time).trim()`，传 `{from,to}`
    这种区间对象会被写成 `"[object Object]"`。区间只在**查询侧**（`narrow()`）支持。
12. **人物/物品是规则 + 种子表，不是 NER。** `PERSON_WORDS` / `OBJECT_SEEDS` / `TOPIC_SEEDS` 决定能认出什么；
    表外的名字只能靠「他说/她说」「叫某某」这类句式碰运气。
13. **地点城市优先于店名。** `placeOf` 先查 `CITIES`，再退到「在/去 + …店/院/校」；物品侧还有 `PLACE_TAIL`
    （店/馆/院/校/司/园/场/站/厅/楼）把「咖啡店」判成地点而不是物品。
14. **store 是单实例锁。** 同一个 `dataDir` 二次挂载会被 `store.lock` 挡住，插件降级为「不挂载」而不是排队等待。
15. **append 不 fsync。** 每条记录只 `writeSync` 到 fd，不调 `fsync`（`grep fsync src/store.mjs` 无命中），
    断电可能丢最后几行；要强持久化得自己在上层加同步点。
16. **向量通道 `provider: local` 需要外部注入推理器。** 没有 `globalThis.__dshMnemosOnnx` 就必然
    `degraded: local:runtime-unavailable`，这不是配置写错。
17. **分层降级没有后台定时器。** `hot → cold` 是惰性判定，只在写入落库与插件启动时各扫一次；
    "够老了但还没被扫到"的记忆会短暂停在热记忆。这是按需触发的代价，不是漏判。
18. **`persona` / `state` 不会从对话里自动抽取。** 它们只能显式写入：面板「操作」卡改层、`/mem tier`、`mem_write` 的 `tier` 参数，
    或者人格桥接（`persona.kind = file/http`）读来的快照。规则抽取与 LLM 抽取都不会自己产出这两层（`ingest.llm` 仍是 v2 项，见第 10 条）。
19. **人格桥接不是双向的。** mnemos 只读对方的人格快照，不会反向写回人格插件；对方改了人格也不会主动通知，最坏要等一次「启动」或「60 秒后的下一轮」。

## 许可证

MIT。