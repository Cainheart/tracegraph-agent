---
id: outlive-agent-v2-evidence-episode-pipeline
title: Evidence 到 Episode 的经历派生管线
status: proposed
scope: memory-episode
language: zh-CN
parent: README.md
last_reviewed: 2026-10-03
---

# Evidence 到 Episode 的经历派生管线

## 1. 位置

```mermaid
flowchart LR
  L[Canonical Event Ledger]
  L --> S[Session / Run Stream]
  S --> B[Settlement + Boundary Detector]
  B --> EP[Episode Projection]
  EP --> MC[Memory Candidate]
  EP --> EC[Experience Candidate]
  MC --> R[Inspect / Edit / Accept / Reject]
  EC --> R
  R --> MS[Scoped Memory Aggregate Stream]
  S --> CM[Context Manifest + MemoryUse]
  EP -.refs only.-> A[Artifacts / Receipts]
```

Episode 是从已提交历史得到的**可重建经历派生物**，用来给学习和评审建立边界。它不等于 Session/Run 页面查询读模型，也不等于供 LLM 使用的模型消息历史或跨 Session Memory 状态投影。它不修改原始 Session，也不能凭摘要新增事实。Episode 默认属于其源 Session/Run 的证据范围；跨 Session 经验通过显式 EvidenceRef 连接多个 Episode，不把来源执行流改造成长期 Memory 的所有者。候选必须到可查看/修改/接受/拒绝的控制面后，才可进入独立的 Memory aggregate stream。

**当前实现切片（MEM-043，focused/runtime 验证通过）：**Core 对一个完整 terminal Run 生成一个确定性 Episode projection，不另存 canonical Episode；校验单 Run scope、连续 sequence、成功/失败/放弃结果、唯一 terminal event 与整条 hash chain。后台 sidecar 在 owner 级 lease 下串行扫描/恢复 terminal Runs，v2 状态文件只保留 run ID、source digest、attempt、next retry、白名单错误码和无正文的 consolidation result refs。可选提取器只收到 allowlist + redaction 后的有界 JSON，输出候选必须引用模型实际收到且仍匹配 Ledger 的事件。Focused 和 Runtime 测试覆盖恢复、重试/幂等、跨进程与过期 lease、来源不匹配/删除、取消 fail-closed、review-gated 候选及 V2 Recall 关闭。候选进入 MEM-046 控制面并保持 candidate。2026-10-03 补齐同 owner/project 内跨 Run 的确定性去重/候选差异：验证历史来源，精确相同 kind/key/claim 为 unchanged，同 key 异文只生成带对照 lineage 的候选；不会改写 active Memory。用户纠正后的模型 Memory 必须沿已提交 correction/lifecycle 链验证回原始 Run 才参与归并。共享 Web/Desktop 面板通过 memory.list 查看持久后台任务与来源/差异；请求只读每项目最近 100 条的可回放投影，合并最多 100 条。后台恢复重建、成功写入更新；历史未恢复完整时显式标记 loading，旧 v1 任务明确无差异明细。语义跨 Run 综合、跨 Run Episode 边界和独立 canonical Episode store 仍是后续设计。MEM-049 已单独实现显式 opt-in V2 Recall。

## 2. Episode 数据模型

```ts
type Episode = {
  episodeId: EpisodeId;
  sessionId: SessionId;
  runId?: RunId;
  branchId: BranchId;
  sourceRange: { from: Cursor; to: Cursor };
  goalRefs: GoalId[];
  evidenceRefs: EvidenceRef[];
  outcome: "succeeded" | "failed" | "partial" | "abandoned" | "unknown";
  summary: DerivedText;
  boundaryReason: string[];
  projectorVersion: string;
};
```

`summary` 带模型/算法版本和 source refs；删除它可以重建。`outcome` 来自 Receipt、测试、用户裁决或明确终态，不能从乐观措辞猜测。Context manifest 和 MemoryUse 也是执行流中的事实：Manifest 说明 Runtime 交给 Provider Adapter 的确切上下文版本，MemoryUse 说明请求进入了哪个提交/响应状态，不证明远端接受，也不证明记忆改变了模型答案。

## 3. 边界信号

| 信号 | 强度 | 例子 |
|---|---:|---|
| 明确 Goal/Run terminal | 强 | task completed/failed/cancelled |
| 用户切换目标或创建分支 | 强 | “接下来处理另一个问题” |
| 验证结果与提交点 | 中 | 测试通过、PR/patch artifact |
| 长时间空档或上下文压缩 | 弱 | 仅作候选，不能单独决定语义边界 |
| 模型话题分类 | 弱 | 必须保留 confidence 和解释 |

目标模型允许边界按证据重叠引用，但当前 MEM-043 只按单个 Run terminal 生成一个 Episode；跨 Episode 的公共证据通过 ref 复用仍属后续扩展。

## 4. Episode 生成与重建流程

```mermaid
sequenceDiagram
  participant P as Episode Projector
  participant L as Ledger
  participant A as Artifact/Receipt View
  participant E as Episode Projection
  participant C as Candidate Queue
  participant R as Review Surface
  participant M as Memory Aggregate Stream
  P->>L: read after source cursor
  P->>A: resolve outcome evidence
  P->>P: detect boundaries + summarize refs
  P->>E: upsert projection(version, range)
  E-->>P: projected cursor
  P->>C: emit candidate + evidence refs
  C->>R: display provenance, uncertainty, proposed scope
  R->>M: accepted versioned command/event
```

投影失败只推进到最后完整 Episode；恢复时从 source cursor 重跑。旧 projector 结果可保留用于对比，但 active view 只指向一个版本。

当前实现以整个 Run 的 `sourceDigest` 作为重建身份，source stream 改变或 Evidence 引用不匹配时 fail closed；任务 sidecar 使用有界重试/租约恢复，不持久化模型摘要或候选正文。

## 5. 关键参数

| 参数 | 推荐起点 | 风险 |
|---|---|---|
| `max_episode_events` | 由 benchmark 决定硬上限，超限按安全锚点切分 | 无界上下文/摘要成本 |
| `idle_gap` | 仅弱信号，不单独闭合 | 把长思考误判成新任务 |
| `boundary_confidence` | strong 自动；weak 需后续信号确认 | 过早切分 |
| `summary_budget` | 独立于 Runtime context budget | 摘要吞掉关键证据 |
| `projector_version` | 每次语义改变必须升级 | 结果不可解释 |

## 6. 不变量与隐私

- Episode 只能引用当前 actor 可见的 Evidence；
- secret/redacted segment 不进入派生文本；
- Session 分支改变不会重写已发布的 Episode，只创建新投影版本；
- 用户可调整边界，调整本身成为带 actor 的治理事件；用户对候选的接受/拒绝/编辑也必须记录为治理事实；
- 删除源内容后 Episode 必须变为 degraded/revoked 或重建，不能保留泄漏摘要。

## 7. 验收与待决策

用固定 Session fixture 验证边界稳定、失败恢复、版本重建、Context 可回放和人工调整；Outcome 必须能点回业务证据。另测候选拒绝后不得进入 active index、重放不重复创建候选、删除源 Artifact 后派生摘要不泄漏。待定：是否允许单个 Episode 跨 Session、弱信号阈值、用户 UI 采用时间线还是任务卡片。
