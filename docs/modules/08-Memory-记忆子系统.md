# 模块 08：Memory 记忆子系统

> 定位：把有来源、可审计的候选事实准入为 canonical Memory，并通过有界检索把相关内容作为不可信 Context 注入模型。  
> 代码：`packages/core/src/memory.ts`、`packages/retrieval/src/`、`apps/retrieval-service/src/`、`apps/cli/src/retrieval-config.ts`、`packages/core/src/runtime.ts`  
> 契约：`packages/contracts/src/memory.ts`、`event.ts`、`context.ts`  
> 最后核对：2026-09-19  
> 实现状态：**G-21 已实现**；默认生产路径是本地 JSONL 索引 + BM25，不是向量 RAG

---

## 1. 当前链路与事实源

Memory 不是一段直接塞进 prompt 的字符串，而是准入、持久化、索引、召回和 Context provenance 五个相互校验的层次：

| 层 | 当前实现 | 边界 |
|---|---|---|
| 候选 | strict `MemoryCandidate` | scope、来源、trust、过期时间等先经过契约校验 |
| 准入 | `evaluateMemoryCandidate()` + committed `memory.candidate_evaluated` | 接纳、拒绝、隔离或过期决定可审计；Event 拥有最终 admission identity |
| canonical store | `<dataDir>/memory/records.jsonl` | admitted `MemoryRecord` 的事实源；append-only、单进程串行写入 |
| 检索投影 | `@tracegraph/retrieval` | 按项目隔离的 JSONL 文档/分块索引与 BM25 排名，可由 canonical Memory 重建 |
| 可选服务 | `@tracegraph/retrieval-service` | strict JSON `/health`、`/ingest`、`/search`；CLI 可远端调用并安全降级到本地 |
| Runtime | `remember()` / `recall()`，每轮自动 recall | 先做 scope、状态、来源与预算校验，再交给 Context builder |
| Context | `memory/retrieved` item + node | 带 hit/hash/score/path/line/heading/token provenance，始终视为 untrusted |

canonical Memory 与检索索引不是同一份事实。record 成功落盘后，即使索引 ingest 失败，记忆仍然存在；此时不会伪造 `retrieval.index_updated`，索引可稍后重建。反过来，检索命中也不能绕过 canonical record 的 scope、trust、status、expiry 和 superseded 校验。

---

## 2. `remember()`：候选准入、幂等与崩溃窗

调用 `AgentRuntime.remember(runId, candidate)` 时，Runtime 先绑定当前 Run 的 `project_id/run_id/session_id`，然后交给 `MemoryManager` 的单进程队列：

1. strict parse `MemoryCandidate` 并验证 scope；跨项目或跨 Run 候选在写 Event 前 fail-closed。
2. 计算稳定 `candidate_hash`，检查同一 `candidate_id` 是否曾以不同内容使用；冲突直接失败。
3. 对合法候选做语义准入：无来源、已过期、不可信、或与同 scope 内容重复时，仍写 `memory.candidate_evaluated {accepted:false,...}`，但不产生 record。
4. 对 confirmed 候选提交 `memory.candidate_evaluated`，从**实际 committed Event**读取 canonical admission id、结果 memory id 与决定时间。
5. materialize 并 append canonical `MemoryRecord`，再尝试写检索索引。
6. 写 `memory.written`；索引成功时再写由它因果关联的 `retrieval.index_updated`。

第 4 步是崩溃恢复的关键：如果进程在 candidate Event 已提交、record 尚未写入之间退出，重试同一 candidate 会命中相同 idempotency key，并复用 committed Event 中的 admission id、memory id 与决定时间，不会用新的进程内时间或随机 id 造出第二条身份。若 record 已写而后续索引/Event 失败，重试同样复用原 admission/record；同一 candidate id 换内容则始终拒绝。

`JsonlMemoryStore` 会重新 strict parse 全文件。损坏、memory id 冲突或写失败都 fail-closed，不能从可重建索引倒推出一条 canonical Memory。当前队列和去重保证是**单进程**边界；多个 Host 不应并发写同一个 `dataDir`。

---

## 3. scope 与索引隔离

Memory scope 有三种：

| scope | 可见范围 | 索引位置 |
|---|---|---|
| `run` | 仅同一 `project_id + run_id` | 当前项目索引 |
| `project` | 同一项目的 Run | 当前项目索引 |
| `global` | 所有项目，但仍需 canonical record 校验 | 专用 `tracegraph:global-memory` 索引 |

global 记忆不能写入“创建它的项目索引”后再假装全局。当前实现把它写到专用 `tracegraph:global-memory` 项目；召回时同时搜索当前项目与 global 索引，按 score/chunk id 合并去重并重新排名，最后仍以 canonical record 做 scope、trust、status、expiry 与 superseded 过滤。这样跨项目可见性来自明确的 global scope，而不是放松项目隔离。

非 Memory 文档的普通检索命中仍受 retrieval project 隔离和 response scope/hash 校验；Memory 路径固定为 `memory/<encoded-id>.md`，不能靠伪造路径获得 global 身份。

---

## 4. `recall()`：预算、验证与 degraded 语义

显式 `AgentRuntime.recall(runId, query, budget?)` 接受 1–8,000 字符 query，默认预算为：

```json
{ "max_tokens": 4096, "max_hits": 8 }
```

召回过程：

1. 对当前项目（存在 global record 时再加 global 索引）发起搜索，`top_k` 不超过 `max_hits`。
2. strict parse `tracegraph.retrieval.v1` response，并验证每份 response 的 `project_id` 与 `query_hash = sha256(query)`。
3. 将 `memory/*.md` 命中回查 canonical store，拦截 record 缺失、非 confirmed、superseded、过期、无来源、不可信、跨项目或跨 Run 的结果。
4. 合并去重后按 `score desc, chunk_id asc` 确定顺序；在 `max_hits/max_tokens` 内截断正文与行区间。
5. 先提交 `memory.recalled`，再由调用方把通过的 hit 交给 Context builder。

Ledger 不保存 raw query，也不保存命中正文，只保存 query hash、有界 attribution、blocked reason、预算与 token 合计。失败分为 `retriever_unavailable`、`retriever_invalid_response`、`retriever_failed`：显式 recall 都写 `status:"degraded"` 与空 hits，绝不能把未审计文本注入模型。若 Runtime 根本没有装配 retriever，普通自动 turn 保持旧行为——不调用检索，也不追加没有意义的 recall Event。

---

## 5. Runtime 每轮自动 recall 与 Context provenance

标准 Runtime 已装配 retriever 时，每轮在 `ContextBuilder.buildWithStrategies()` 之前以 `state.task.slice(0, 8_000)` 查询，使用默认 8 hits / 4,096 tokens 预算。召回结果形成：

- `ContextManifestItem {section:"memory", action:"retrieved", retrieval}`；
- `ContextNode {section:"memory", kind:"retrieved", retrieval}`；
- 最终模型输入中的 `[memory]` section。

每条 `retrieval` attribution 都包含 rank、hit/chunk id、content hash、BM25 score、source path、start/end line、heading path 与最终 `injected_tokens`。Context builder 若因本轮总预算再次截短正文，会同步缩小行区间和 token；契约强制 item/node 的 hit id、hash 与 token 一致。来源始终是 `untrusted`，BM25 排名不会把仓库文本或记忆内容提升为 system instruction。

自动 recall 使用原始 Run task，而不是持续拼接全部对话作为 query；当前实现因此是稳定、可哈希、可复现的任务级检索，不是 agent 自主生成多跳 query 的检索规划器。

---

## 6. 默认本地检索与可选 HTTP 服务

`@tracegraph/retrieval` 提供默认生产 backend：Markdown 分块、内容 hash、按项目隔离的 JSONL store、BM25 排名、幂等 ingest 和 `readChunk()`。它导出 backend/provider seam，但仓库当前没有 embedding 模型、向量数据库或 reranker 实现。

`apps/retrieval-service` 可把同一 backend 暴露为独立 Node HTTP 服务：

| route | 方法 | 成功响应 |
|---|---|---|
| `/health` | `GET` | schema/status/backend |
| `/ingest` | `POST` | document hash、generation、chunk 统计与 updated/unchanged |
| `/search` | `POST` | query hash、项目 chunk 总数与有 provenance 的 hits |

服务严格限制 JSON、请求大小、超时、project/source path 和 data directory 安全，可选 bearer token；错误使用明确 HTTP status 与 strict error envelope。服务 client 只把网络错误、timeout、502–504 分类为 unavailable；4xx、认证、scope 或 contract 错误不会被调用方静默吞掉。

CLI 的本地/远端组合与安全降级详见模块 11。

---

## 7. durable 事件

G-21 使用四种相关事件，其中后三种是本阶段新增 Event type：

| Event | 含义 |
|---|---|
| `memory.candidate_evaluated` | admission identity、candidate hash 与 accepted/decision/reason；语义拒绝同样留证 |
| `memory.written` | canonical record 已写入，包含 memory/content/scope/source 证据 |
| `memory.recalled` | completed/degraded、query hash、预算、visible/blocked attribution 与 token 总量 |
| `retrieval.index_updated` | 可重建索引已完成一次 ingest；缺少该事件意味着不能声称索引已同步 |

G-21 当时把 Event 总数增至 68；它只追加事件枚举和 strict payload，没有改变 canonical Event 信封或当时的 Projection 字段语义，所以 projector 当时仍是 v5。后续 G-07 追加 5 种 `subagent.*` Event 并增加 `RunProjection.subagents`，G-18 再追加 3 种 `attachment.*` Event 与 `RunProjection.attachments`，G-17 再追加 `extension.error`，G-08 最后追加 13 种 `team.*` Event 与可选 `RunProjection.team`，G-10/G-11/G-12 又追加 Skill/MCP/LSP 事件，G-20 再追加两个 `code.*` Event 与可选 `RunProjection.code_intel`，因此当前总数为 102，`SCHEMA_VERSION` 仍是 `tracegraph.session-event.v1`，`PROJECTOR_VERSION` 已是 `tracegraph.projector.v9`。Memory 当前没有独立 Projection 列表；事实主要从 Ledger timeline、canonical JSONL 与 Context Manifest 检查。

---

## 8. 评测与可验证证据

- `packages/contracts/src/memory-g21.test.ts`：strict candidate、事件 payload、query hash、预算与 provenance 交叉约束。
- `packages/core/src/memory-g21.test.ts`：remember 幂等/崩溃窗、store/index 边界、scope/global 合并、degraded recall、Runtime 每轮注入与 Manifest 一致性。
- `packages/retrieval/tests/`：分块、JSONL store、BM25、项目隔离、路径与损坏边界。
- `apps/retrieval-service/tests/`：HTTP route、认证、大小/超时、错误映射、client unavailable 分类。
- `apps/cli/src/retrieval-config.test.ts`：本地默认、远端 write-through、availability fallback 与 4xx fail-closed。
- `evals/quality/retrieval-rag-quality.eval.ts`：对 3 个受控任务运行真实本地 ingest/search/readChunk，记录 task success 与 citation accuracy 的 without/with 对比。

旧 `memory-context-quality.eval.ts` 仍是 fixture seam 的历史回归证据；它不能代替新的 production retrieval chain，也不证明真实语料、LLM 或向量检索的泛化质量。

---

## 9. 明确边界

1. **默认是 JSONL + BM25，不是向量 RAG。** 没有 embedding provider、Qdrant/pgvector、hybrid reranking 或语义向量质量声明。
2. **没有自动全仓爬取。** 只有显式 ingest/remember 的内容进入索引；CLI 的每轮 recall 不会替用户创建候选。
3. **没有 Host/SDK/Web 的 Memory 管理面。** 目前 Core API 与 CLI composition 已接通，浏览器没有浏览、确认、隔离、删除或重建索引 UI。
4. **没有“遗忘即物理擦除”实现。** status/superseded/expiry 会在召回时拦截，但 canonical JSONL 是 append-only 审计记录。
5. **HTTP 服务生命周期独立。** CLI 不会自动启动或监管远端 retrieval-service；不可用时仅按严格分类回退本地。
6. **评测是小型确定性代理。** 三个文档任务证明真实链路和 citation 校验不会退化，不等于开放域 RAG 成功率或外部服务 SLA。

---

## 10. 相关文档

- 模块 01：Memory/Retrieval strict contracts、G-21 当时的 68 种事件与当前 102 种全集
- 模块 02：Runtime `remember/recall` 与每轮自动检索时序
- 模块 03：`memory/retrieved` Context surface、预算与 provenance
- 模块 11：CLI 本地 backend、远端 client 与安全降级
- 模块 12：production retrieval quality eval 与指标边界
