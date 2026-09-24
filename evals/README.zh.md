# TraceGraph 评测

[English](README.md) · 中文

G16 评测套件有意与单元/集成测试分开：

- `pnpm test` 仍只运行各包的测试。
- `pnpm evals` 构建 workspace、运行离线评测、校验已提交的基线，并将有界的机器可读报告写入 `_tmp_evals/reports/latest.json`。
- 只有 `pnpm evals:update`（或 `pnpm evals -- --update`）这一模式可以改写已提交的基线。必须审查每一处基线差异，并在 PR 描述中解释被接受的回归。

评测 worker 会删除常见的模型供应商 API Key / Token 环境变量，并阻止非 loopback 的 `fetch`、TCP 和 TLS 连接。仅真实 Host/SSE 路径允许 loopback。因此套件应能在没有网络或供应商凭据的情况下通过。

## 性能基线

`evals/baselines/performance.json` 覆盖一条确定性的代表路径，记录四个可以独立审查的门禁：

| 指标 | 场景 | 门禁含义 |
| --- | --- | --- |
| `context.built.input_tokens` | 必须压缩的长对话 | 确定性的 token 数；增加即失败 |
| `run.model_calls` | 直接回答的 Runtime Run | 确定性的调用次数；增加即失败 |
| `tool.call.p95_ms` | 20 次有界的本地 `read_file` 调用 | 墙钟时间 P95，CI 上限为 500 ms |
| `sse.first_byte_ms` | 真实 loopback Host Ledger 流 | 墙钟时间首字节延迟，CI 上限为 1,500 ms |

延迟上限刻意留出较大的调度和启动余量；它们是回归告警，不是产品性能声明。性能评测还会构造低得不合理的 token 与延迟基线，证明两道门禁都会安全地判为失败。

生成的报告最大 256 KiB、最多包含 512 条测试记录和 64 个指标观测值，并排除断言内容和堆栈追踪。它只是诊断输出；已提交的基线 JSON 才是评审和批准边界。

## 生产检索质量

`evals/quality/retrieval-rag-quality.eval.ts` 测试 G21 的生产 `@tracegraph/retrieval` 包，而非旧的受控 Memory fixture。它通过真正的分块器和原子 JSONL 存储摄入三份 Markdown 文档，搜索生成的 BM25 倒排索引，再按 ID 读回每个胜出分块，并核验来源路径和行号范围。

报告记录四个比率指标：

| 指标 | 此固定场景中的含义 |
| --- | --- |
| `retrieval.task_success_rate.without` | 不使用检索时，通用回答是否包含仓库专属命令 |
| `retrieval.task_success_rate.with` | 排名第一的生产检索命中是否包含该命令 |
| `retrieval.citation_accuracy.without` | 不使用检索时，是否能引用预期的源码行 |
| `retrieval.citation_accuracy.with` | 能否读回命中内容，且其行号范围包含预期的源码行 |

门禁要求检索在任务成功率和引用准确率两个维度均带来提升；在当前已提交的场景中，两者都从 `0` 提升至 `1`。这是确定性的集成质量检查，不是通用 RAG 基准、真实模型成功率、线上 A/B 结果，也不能证明语义检索能力。当前引擎是在本地 JSONL 上进行词法 BM25 检索，不使用 embedding、向量数据库、Qdrant 或 reranker。

`evals/quality/memory-context-quality.eval.ts` 仍可用作受控的 Context 选择测试，但它不再是唯一的 Memory 证据，也不能被描述成生产检索实现。

## Trace 回放确定性

`evals/replay/time-travel.eval.ts` 是 G23 时间回溯的回归用例。它在 Run 内每个 sequence 上记录规范化快照，使用同一磁盘 JSONL Ledger 创建新的 Runtime，并逐点验证投影、锚点和快照 hash 的稳定性。它还检查结构化的正向差异，并证明回放不会向 Ledger 追加事件；反向和相同位置的差异语义仍由 Core 单元测试覆盖。

这个评测只覆盖从规范化 Ledger 到 `RunProjection` 的回放。不宣称 Web `WorkbenchSnapshot` 的 hash 稳定性，也不支持暂停后台 Agent、撤销其他客户端的实时 capability、从历史分叉、合并多个 Run，或持久保存浏览器回放游标。浏览器交互仍由 Web 单元测试覆盖；目前尚无真正浏览器的 Playwright E2E 套件。
