# 模块 08：Memory 记忆子系统

> 定位：把有来源、可审计的候选事实准入为 canonical Memory，并通过有界检索把相关内容作为不可信 Context 注入模型。  
> 代码：`packages/core/src/domains/memory/memory.ts`、`memory-lifecycle.ts`、`memory-migration.ts`、`memory-governance.ts`、`memory-control.ts`、`packages/retrieval/src/`、`apps/retrieval-service/src/`、`apps/cli/src/memory-command.ts`、`apps/cli/src/retrieval-config.ts`、`packages/core/src/domains/runtime/runtime.ts`<br>
> 契约：`packages/contracts/src/memory.ts`、`memory-use.ts`、`memory-governance.ts`、`memory-control.ts`、`event.ts`、`context.ts`<br>
> 最后核对：2026-09-30
> 实现状态：**G-21 已实现**；默认生产路径是本地 JSONL 索引 + BM25，不是向量 RAG

> **V2 边界：**这里同时记录 G-21 Memory 当前行为和已交付的 V2 lifecycle / Context provenance / governance / control-plane API。MEM-041～045 未切换 G-21 Runtime 的 V1 JSONL 真源；MEM-046 增加独立 V2 candidate seed store、统一控制服务、Host/SDK、CLI 与 Web 面板。仓库目前没有 Desktop client；V2 recall 也未接入 G-21。MemoryUse 只记录 Runtime Adapter hand-off 与可观察阶段，不能据此声称模型实际使用了记忆。

> **MEM-040 已交付：**Contracts 同时公开兼容的 `MemoryRecordV1Schema` 与 strict `MemoryRecordV2Schema`；Core 提供显式 `migrateMemoryJsonlAdjacent()`，把 V1 rows 写到同目录的 `records.v2.jsonl` review sidecar。G-21 Runtime 仍只读写 `records.jsonl` V1；sidecar 不会自动成为 canonical store、不会参与 recall，也不会改写现有数据。

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
| Context | `memory/retrieved` item + node | 带 hit/hash/score/path/line/heading/token provenance；canonical Memory 路径另绑定 record version/evidence refs；始终视为 untrusted |

canonical Memory 与检索索引不是同一份事实。record 成功落盘后，即使索引 ingest 失败，记忆仍然存在；此时不会伪造 `retrieval.index_updated`，索引可稍后重建。反过来，检索命中也不能绕过 canonical record 的 scope、trust、status、expiry 和 superseded 校验。

### 1.1 V1 契约、V2 契约与相邻迁移

`MemoryRecordSchema` 继续是 `MemoryRecordV1Schema` 的兼容别名，因此现有 G-21 store、`remember()` 与 `recall()` 在 MEM-040 中不切换格式。V2 用独立的 `MemoryRecordV2Schema` 表达 owner scope、status、provenance、assessment、validity、governance 与 lineage；owner identity 必须由迁移调用者显式提供，Memory 所有权边界是 `ownerId + memoryId`，不依附于来源 Session/Run。

迁移 API 要求显式调用，并先验证整个 JSONL，再通过同目录独占 hard link 发布 `records.v2.jsonl`。原 `records.jsonl` 字节保持不变；已有目标会拒绝覆盖，不支持 hard link 的文件系统会 fail closed；迁移错误包含行号但不回显记忆正文。每个 envelope 保存完整 V1 record；V2 映射保留 project/run scope，并把旧记录标为 `candidate`、kind/sensitivity/verification 未分类、consent 为 none、模型使用和导出均关闭。只有后续经用户审核、补齐分类与 governance，并完成生命周期转换后，V2 record 才可能进入后续产品行为。

这个 sidecar 是可审查的迁移产物，不是 G-21 Runtime 的运行时真相源。删掉生成的 sidecar 可回滚；MEM-040 不迁移旧 Session Events、不写 Memory aggregate stream、不双写 Ledger，也不触碰真实 dataDir。MEM-041 在 canonical Evidence Event Ledger 内新增独立 V2 Memory aggregate stream，但不将 migration sidecar 或 Runtime 自动接入它。

### 1.2 V2 lifecycle service（MEM-041）

Core 导出 `MemoryLifecycleService` 和 `replayMemoryLifecycle()`；`JsonlEventLedger` 通过 `listMemoryLifecycle()` / `appendMemoryLifecycle()` 提供 owner-scoped stream。调用方显式提供一个 immutable V2 `candidate` seed 与 canonical Evidence Ledger；服务对当前状态执行转移并把状态投影重建为 `MemoryRecordV2`。每次状态变化在 `memory.lifecycle.transitioned` 中记录 owner/memory identity、精确 record version、aggregate sequence、action、from/to status、actor、reason code、可选关联 Memory ID、时间和前一 Event hash。Event 不保存 claim 或自由文本理由。

状态边界是：

| 当前状态 | 命令 | 结果 |
|---|---|---|
| `candidate` | 用户 `review_activate` / `review_reject` | `active` / `revoked` |
| `active` | `dispute` / `supersede` / `revoke` / `expire` | `disputed` / `superseded` / `revoked` / `expired` |
| `disputed` | 用户 `resolve_active` / `resolve_superseded` / `revoke` | `active` / `superseded` / `revoked` |
| `superseded` | `revoke` | `revoked` |
| `expired` | 用户 `revalidate` / `revoke` | `candidate` / `revoked` |
| `revoked` | 任意命令 | 拒绝；终态 |

`review` 是需要可信 user actor 的明确命令，而非可被自动流程略过的状态。合法 Event 使用有限的 reason code，不记录 prompt、私有 claim 或用户自由文本。候选激活还要求可用的分类、非 `none` consent 和当前 validity；迁移来的 `legacy_unclassified` 只能继续待审或被拒绝/撤销。激活不自动打开模型使用或导出。

Evidence Ledger 在现有 Ledger root 下按 owner+memory 建立独立的 append-only aggregate stream，使用 owner/memory hash 路径；它与 Run 的 `SessionEvent` sequence、hash chain、Projection 分开保存，但复用同一个 Ledger writer、durable replace 与校验边界。服务通过 sequence CAS、idempotency key、hash chain、strict schema 和 status-chain replay 拒绝脏写/损坏。writer 锁覆盖一个 `JsonlEventLedger` 实例；多个 Ledger 实例/Host/进程共享目录仍不支持。Supersede Event 会关联另一 Memory ID，但不会跨两个 aggregate 做原子提交。

该 API 当前不接入 `AgentRuntime.remember()` / `recall()`、V1 JSONL store 或 retrieval index。MEM-042 与 MEM-045 在此基础上分别增加 Run-scoped MemoryUse 和 V2 召回资格/反馈 API；MEM-046 增加 V2 record canonical storage 与 CLI/Web 控制面，但尚无 Desktop client。实现决策见 [MEM-041 Note](../../.agents/notes/implemented/2026-09-30-mem-041-memory-lifecycle.md)。

### 1.3 V2 conflict、expiry 与 use feedback（MEM-045）

Core 导出 `detectMemoryConflicts()`、`evaluateMemoryRecallEligibility()`、`MemoryFeedbackService` 与 `replayMemoryFeedback()`；Contracts 提供对应 strict schemas；`JsonlEventLedger` 将反馈写入既有 Evidence Ledger 中按 owner + Memory ID + version 隔离的追加流。该能力由调用方显式传入一份完整、单 owner、每个 Memory 仅一个当前版本的快照，不读取或改变 G-21 V1 canonical JSONL。

- **冲突：**仅比较显式 `normalizedKey`（NFKC、trim、大小写与空白规范化），同 owner、scope 重叠、claim digest 不同的 active/disputed 记录才组成冲突组；不做语义或模型推断。组内所有仍有效的参与者都被 V2 召回门阻断，输出只含 ID/version 与 key digest，不含 claim。
- **有效期与召回资格：**`validFrom` 在未来或 `validUntil <= now` 会立即阻断；还要求 active、请求 scope 匹配、允许模型使用、consent 非 none、敏感级别可用且来源可信。它是后续 V2 caller 可使用的纯决策 API，尚未接入 G-21 `recall()`。
- **反馈：**只能针对 Run Ledger 中已到 `response` 的 V2 MemoryUse，并精确匹配 schema、Memory ID/version/content digest、MemoryUse 与 ContextManifest。同一用户对同一 MemoryUse/version 只能评价一次；相同评价以幂等键重试时返回原事件。`helpful` / `irrelevant` 只累计计数；`incorrect` / `stale` 生成待复核项并阻断该版本召回。用户显式关闭待复核项只清除该 review gate，不会修改 claim、状态、置信度或来源；纠正/撤销由后续控制面命令负责。Actor schema 不执行身份认证或 owner 授权，调用方须在调用前完成授权。
- **持久化：**反馈 Event 不复制 Memory claim、Context 正文或 Provider 响应；owner/version stream 使用 sequence CAS、幂等键、hash chain 和 durable replace。反馈历史是追加事实，投影从事件重放。

实现细节与验证见 [MEM-045 Note](../../.agents/notes/implemented/2026-09-30-mem-045-memory-conflict-feedback.md)。

### 1.4 V2 Memory 控制面（MEM-046）

`MemoryControlService` 是 CLI、Host/SDK 与 Web 共用的唯一领域 command/query seam。`AgentRuntime` 持有该服务；Host 的 `/api/memory` 路由负责认证、strict request parse，并把当前可见 project IDs 转成 `allowedScopeIds`，owner 与 user actor 不由浏览器/CLI 请求体指定。CLI 通过 SDK 调用 Host；Web 面板也只经 SDK 进入同一 Host 路由。仓库当前没有 Desktop client，未来 Desktop 可复用同一 SDK/Host 契约。

- **Inspect：**列表从 V2 immutable candidate seeds + lifecycle replay 得出当前状态，并聚合 provenance、冲突参与者、反馈计数/待复核项和精确版本的 Run-scoped MemoryUse 请求阶段。冲突只展示 record IDs/status 与 normalized-key digest；MemoryUse 阶段不代表 Provider 接受或模型因果使用。
- **Candidate / review：**用户录入先写 `memory-v2/<owner-hash>/records.jsonl`，随后追加内容无关的 `memory.control.commanded` 创建事实；审核状态只追加 `memory.lifecycle.transitioned`。模型使用默认关闭，只有审核前用户明确选择 `allow_model_use` 后且成功审核才保留开启。
- **Correct：**创建新的不可变 candidate、记录 lineage 与用户来源，再通过旧/新 Memory ID 的 lifecycle 事件连接修订。对两个 aggregate 的写入不是跨流原子事务；控制服务按命令协调，重试可识别已提交 correction。并发仅在单个 Runtime/Core 服务实例内串行；多 Host 共享一个 dataDir 不受支持。
- **Revoke：**只追加 lifecycle transition，不擦除正文；V1 与 V2 的召回链路仍相互独立。
- **Delete：**先对更正 lineage 全家族追加内容无关 tombstone（包括 family IDs 与 scope IDs），再用 fsync + rename 原子重写 V2 owner record file 移除正文。授权在每次操作重新验证；不可见/跨 scope 的记录以 404 隐藏。已删身份不能由重试创建复活，删除重试返回原 family。此能力只覆盖本机 V2 canonical payload 文件：不清除 G-21 V1 `records.jsonl`、Run/feedback/lifecycle/control 审计事件、备份、快照、外部 Artifact 或文件系统取证残留；因此不能称为 crypto-erase 或全域遗忘。

所有写命令都经过 Host command ID 校验，再追加到现有 Evidence Ledger；控制事件不包含 claim/正文。实现与限制见 [MEM-046 Note](../../.agents/notes/implemented/2026-09-30-mem-046-memory-control-plane.md)。

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

MEM-042 为命中 `memory/<encoded-memory-id>.md` 的 canonical V1 record 追加 `memory_ref`，精确绑定 record schema、`memory_id`、`version`、完整 record content hash 和精简后的 `evidence_refs`。非 canonical Memory 的普通检索文档仍只凭 chunk hash、path 与行区间追溯，不会伪造 Memory version。新的 `ContextManifest` 记录最终模型可见字符串的 SHA-256 和同一内容的 token estimate；`ModelInput.context` 必须与该 Manifest 重建结果一致。

对于最终选入 Context 的 canonical Memory 项，Runtime 在外部 Adapter 调用之前向该 Run 的 Evidence Ledger 追加 `memory.use_status: dispatch_intent`；进入 `ModelAdapter.decide()` 后追加 `adapter_invoked`，结束时追加 `response`、`failed` 或 `unknown`。`memory.recalled` 只表示 retrieved，dispatch intent 表示 selected。事件只保存 Memory/evidence identities、版本、digest/hash、token estimate 与有限状态，不复制 claim 正文，也不证明 Provider 接受请求或模型内部实际使用。

自动 recall 使用原始 Run task，而不是持续拼接全部对话作为 query；当前实现因此是稳定、可哈希、可复现的任务级检索，不是 agent 自主生成多跳 query 的检索规划器。

---

## 6. 默认本地检索与可选 HTTP 服务

`@tracegraph/retrieval` 提供默认生产 backend：Markdown 分块、内容 hash、按项目隔离的 JSONL store、BM25 排名、幂等 ingest 和 `readChunk()`。它导出 backend/provider seam，但仓库当前没有 embedding 模型、向量数据库或 reranker 实现。

远端 URL 只改变可重建的 retrieval index/search 调用，不迁移 canonical Memory：`<dataDir>/memory/records.jsonl` 仍是本机事实源。远端 ingest 会发送 `project_id`、`source_path` 和内容，search 会发送 `project_id` 与 query；响应的 project/query/hash 由 Client 和 Core 校验。`project_id` 只提供逻辑分区，不是租户授权；可选 bearer token 是整个 retrieval service 共用的服务级凭据，不提供逐项目 ACL。内置服务默认只监听 loopback；若 CLI 被配置为访问外部服务，接收端会看到相应的检索内容和查询。

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

G-21 当时把 Event 总数增至 68；它只追加事件枚举和 strict payload，没有改变 canonical Event 信封或当时的 Projection 字段语义，所以 projector 当时仍是 v5。后续 G-07 追加 5 种 `subagent.*` Event 并增加 `RunProjection.subagents`，G-18 再追加 3 种 `attachment.*` Event 与 `RunProjection.attachments`，G-17 再追加 `extension.error`，G-08 最后追加 13 种 `team.*` Event 与可选 `RunProjection.team`，G-10/G-11/G-12 又追加 Skill/MCP/LSP 事件，G-20 再追加两个 `code.*` Event 与可选 `RunProjection.code_intel`，MEM-042 追加 `memory.use_status`，因此当前总数为 103，`SCHEMA_VERSION` 仍是 `tracegraph.session-event.v1`，`PROJECTOR_VERSION` 已是 `tracegraph.projector.v9`。Memory 当前没有独立 Projection 列表；事实主要从 Ledger timeline、canonical JSONL 与 Context Manifest 检查。

---

## 8. 评测与可验证证据

- `packages/contracts/src/memory-g21.test.ts`：strict candidate、事件 payload、query hash、预算与 provenance 交叉约束。
- `packages/core/src/domains/memory/memory-g21.test.ts`：remember 幂等/崩溃窗、store/index 边界、scope/global 合并、degraded recall、Runtime 每轮注入与 Manifest 一致性。
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

- 模块 01：Memory/Retrieval strict contracts、G-21 当时的 68 种事件与当前 103 种全集
- 模块 02：Runtime `remember/recall` 与每轮自动检索时序
- 模块 03：`memory/retrieved` Context surface、预算与 provenance
- 模块 11：CLI 本地 backend、远端 client 与安全降级
- 模块 12：production retrieval quality eval 与指标边界
