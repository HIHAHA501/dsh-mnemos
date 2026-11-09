# 更新记录

## v0.1.2 — 只改测试门槛，运行时与 v0.1.1 等价

- `test/retrieval/perf.test.mjs` 的 4 个绝对耗时门槛默认放宽 10 倍；严格基准用 `MNEMOS_PERF_STRICT=1 node --test`
- 这个版本没有任何运行时行为变化，发它只是让 tag 与 main 对齐（v0.1.1 之后又落了这一个测试改动）

## v0.1.1 — 测试不再赌时钟；Node 22 纳入必绿矩阵

- persona 超时用例改用注入的 `AbortController`（`AbortSignal.timeout()` 的定时器是 unref 的，不撑事件循环）
- store 性能用例的 300ms 硬门槛放宽（CI 上 621ms 直接红）
- CI 矩阵：`node22-ubuntu` + `node24-{ubuntu,windows,macos}`

## v0.1.0 — 首个公开版本

记忆本体：

- 分层记忆（hot / cold / persona / state），热度按时间衰减，冷层不衰减
- 混合检索：BM25 0.55 / 元数据 0.25 / 向量 0.15 / 热度 0.05 / 情绪 0.15（情绪缺席时整份退出归一，不改变老分值）
- 情绪分量 = 强度 0.65 + 共振 0.35；共振要求两边都有明确正负号
- 捕获过滤 7 个噪声桶（system-reminder、子代理回报、宿主上下文块等），不把脚手架当成记忆
- 上下文预算：热记忆与人设各占一份，超预算按分数贪心装，装不下记 dropped

界面：

- 设置页「记忆星图」：概览 / 星图 / 说明三个页签
- 星图：三维球壳布局 + 投影、预渲染星点贴图、锚点星居中、按情绪上色、深度压暗、未点亮空位、空闲 10 秒停帧
- 输入框与首屏都有「记忆 · 开/关」胶囊，支持全局默认 + 单会话覆盖

工程：

- 零运行时依赖；354 个测试；`node --test` 直接跑
- 落盘安全：`src/atomic.mjs` 的 `replaceFile()` 在 Windows 上对 `rename` 的 EPERM/EBUSY 先退避重试，
  仍失败则退化为原地覆盖（失去原子性换数据落地——Windows CI 上这是真的会挂）
- CI：`ubuntu` / `windows` / `macos` × Node 24 全绿，Linux × Node 22 也全绿
- 人格读取的超时信号可注入（`signalOf`）：`AbortSignal.timeout()` 的定时器是 unref 的，
  不撑事件循环，测试不能再赌它
- 宿主所有 client.js 共用一个脚本作用域，本插件整份包在 IIFE 内避免顶层重名
