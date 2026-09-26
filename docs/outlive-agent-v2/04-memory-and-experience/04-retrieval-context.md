---
id: outlive-agent-v2-retrieval-context
title: 记忆检索与上下文注入设计
status: proposed
scope: memory-retrieval
language: zh-CN
parent: README.md
last_reviewed: 2026-09-26
---

# 记忆检索与上下文注入设计

## 1. 所在位置

```mermaid
flowchart LR
  Q[Current Task/Context] --> F[Hard Filters]
  I[Memory/Experience Index] --> F
  F --> R[Retrieved candidates]
  R --> K[Rank + Diversity]
  K --> P[Admission + current authority]
  P --> B[Context Budget]
  B --> C[Context Manifest]
  C --> D[Provider dispatch boundary]
  D --> U[Run MemoryUse Trace]
  U --> L[LLM Call]
  U --> V[Visible inspect clue]
```

检索结果不是 system instruction。它是带来源、scope、置信和状态的 context segment；Context Builder 决定如何呈现，Runtime/Policy 决定是否允许使用。三阶段不可混称：`retrieved` 是搜索命中，`selected` 是通过过滤和预算后进入待发请求，`adapter_invoked` 表示 Runtime 已把含该 segment 的请求交给 Provider Adapter。它不证明远端 Provider 接受或模型内部读取/使用了该内容。

## 2. 查询模型

查询由当前目标、workspace、代码实体、技术版本、用户显式关键词和时间条件组成。禁止把原始 secret、整段未清洗 prompt 或第三方私密内容发送给远程 embedding/provider。

Hard filters 必须先于相似度：actor visibility、workspace/project scope、status=`active|validated`、有效期、sensitivity、当前 authority。向量相似度不能把被过滤内容重新带回。

## 3. 召回与排序

```text
score = semantic_match
      + lexical/entity_match
      + condition_match
      + evidence_quality
      + recency_or_version_fit
      + verified_reuse_signal
      - conflict/staleness/risk penalties
```

公式只是可解释维度，实际权重需通过可复核的质量证据选择并版本化；开放域相关性可后续用外部 Langfuse 评估，安全过滤本身必须由本地确定性测试验证。事实查询偏证据/时效，偏好查询偏 actor/scope，Experience 偏条件匹配与验证结果；不能用一套权重处理所有 kind。

## 4. Context segment

```ts
type MemoryContextSegment = {
  sourceId: MemoryId | ExperienceCaseId;
  sourceVersion: number;
  kind: string;
  rendered: string;
  renderedDigest: string;
  evidenceRefs: EvidenceRef[];
  whyRetrieved: string[];
  scope: string;
  status: string;
  tokenCost: number;
  trust: "user_verified" | "evidence_supported" | "candidate";
};

type MemoryUse = {
  useId: MemoryUseId;
  runId: RunId;
  contextManifestId: ContextManifestId;
  memoryId: MemoryId;
  memoryVersion: number;
  evidenceRefs: EvidenceRef[];
  renderedDigest: string;
  tokenCost: number;
  requestState: "dispatch_intent" | "adapter_invoked" | "response_received" | "failed" | "unknown";
  observedAt: string;
};
```

`MemoryUse` 是 Run-scoped 执行事实，并与该轮 Context Manifest 同处当前执行事实域；`dispatch_intent` 在调用 Provider 前持久化，适配器调用/响应通过后续事件表达。崩溃或超时发生在边界附近时允许 `unknown`，不得臆断发送成功。Manifest 精确到 Runtime 提交给 adapter 的内容；Provider SDK 若另行变换 wire payload，除非 adapter 能给出证据，否则不声称日志等同远端收到的字节。不在长期 Memory stream 里累计一个可能失真的 `use_count`；计数与检索分析从已提交的 Run/MemoryUse 事件派生。模型侧明确标注“历史资料，可能过期，不覆盖当前用户命令与 policy”。冲突记录成组展示，不能只展示得分最高的一边。

## 5. 检索时序

```mermaid
sequenceDiagram
  participant C as Context Builder
  participant R as Retrieval Service
  participant P as Policy
  participant S as Memory State Projection / Retrieval Index
  participant D as Provider Dispatch Boundary
  participant L as Run Event Ledger
  participant UI as Client Memory Inspector
  C->>R: query + actor/scope + budget
  R->>P: resolve visibility filters
  P-->>R: allowed scope/sensitivity
  R->>S: hybrid search with hard filters
  S-->>R: candidates + refs
  R->>R: rank, diversify, conflict-group
  R-->>C: bounded segments + reasons
  C->>L: persist ContextManifest + dispatch_intent (exact versions/digests)
  C->>D: invoke Provider Adapter with request
  D-->>L: append adapter_invoked / response / failure / unknown outcome
  L-->>UI: L1 clue + inspect details
```

## 6. 关键参数

| 参数 | 推荐起点 |
|---|---|
| `memory_budget_ratio` | Context 总预算的一小部分，按任务类型设上限 |
| `top_k` | 先取较宽候选，再 hard cap 注入条数 |
| `diversity` | 同一 claim/version 聚类去重 |
| `minimum_score` | 按 kind 与版本化评估证据定，不用全局固定值 |
| `conflict_mode` | surface pair + require caution |
| `retrieval_trace` | 保存 IDs、分数维度和过滤理由，不默认保存 query secret |

用户可见层默认克制但可追溯：Provider Adapter 已被调用时，在 Desktop/Web UI 展示“本次请求包含 N 条记忆”，并区分响应成功、失败或状态未知；展开可见具体 claim、版本、来源、scope、有效状态及纠正/撤销入口。CLI 提供等价的 inspect/query 结果。完整管理以列表为主，关系图是高级视图。尚未提交的候选或搜索结果不得显示成“本次请求包含”。UI 不宣称“模型使用了/依据了它”或“它导致答案”。

## 7. 失败与降级

索引不可用时可从小规模结构化 store 做受限查询，或明确无 Memory 继续；不得因检索失败阻塞基本 Coding。远程 embedding 失败不切换到未经用户许可的 provider。结果过多先丢低价值/重复项，不裁掉 provenance。

## 8. 验收与开放问题

本地确定性测试必须覆盖 scope 泄漏、撤销/删除、恶意历史指令和过滤边界；还要覆盖 retrieved/selected/adapter_invoked 状态区分、dispatch 未发生时的状态、Manifest 与 Runtime 交给 Adapter 的内容一致、删除后历史回放显示 redacted 而不替换版本。后续 Langfuse 外部质量评估可覆盖过期/冲突记忆、同义词召回、预算压缩与 Experience 复用效果。UI 只能声称“该内容包含在本次 Runtime 请求中”，不能声称“模型依据它回答”或“它导致了回答”。待定：默认 embedding provider、本地 lexical-only 模式、用户是否能固定/排除某条 Memory。
