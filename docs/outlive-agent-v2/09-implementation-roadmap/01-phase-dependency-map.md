---
id: outlive-agent-v2-phase-dependency-map
title: 阶段依赖与并行路线
status: proposed
scope: roadmap-phases
language: zh-CN
parent: README.md
last_reviewed: 2026-10-03
---

# 阶段依赖与并行路线

## 1. 总体 DAG

```mermaid
flowchart TB
  P0[P0 决策/基线] --> P1[P1 门禁/治理]
  P1 --> P2[P2 Core 内逻辑分层]
  P2 --> P3[P3 稳定 Family 升包]
  P2 --> P4[P4 Memory/Experience Slice]
  P2 --> P5[P5 Runtime Reliability]
  P3 --> P6[P6 Shared Protocol/Desktop]
  P4 --> P7[P7 Snapshot/Benchmark/Langfuse opt-in/i18n]
  P5 --> P7
  P6 --> P7
  P7 --> P8[P8 Public Proof/Release]
```

该图表示最早安全开始点，不要求一个 Phase 所有任务串行完成。机器级 task 依赖以 `../roadmap.yaml` 为准。

## 2. 每阶段出口

| Phase | 主要产出 | 退出证据 | 不在本阶段做 |
|---|---|---|---|
| P0 | 接受的公理、术语、现状基线 | reviewed docs + baseline runs | 改 Runtime 行为 |
| P1 | AGENTS/Notes/Skills、架构/文档门禁 | CI failure fixtures | 大拆包 |
| P2 | core 内 Evidence/Session/Runtime/Tool/Context 边界 | import rules + behavior parity | 发布大量新 package |
| P3 | 满足门槛的 family packages | move-only diff + conformance/perf | 为目录美观抽包 |
| P4 | 一个可见、可纠正、可遗忘的 Memory 纵切 | 本地端到端与安全反例通过；Langfuse 质量评估可后续独立运行 | 人格/云同步 |
| P5 | cancel/recovery/reconcile/no-progress | failure injection snapshots | 分布式 scheduler |
| P6 | 共享协议、Desktop Host/bridge | multi-transport conformance/security | 独立业务语义 |
| P7 | snapshots/benchmarks、可选 Langfuse 接入、docs/i18n | 回归报告；外部质量评估独立报告且不阻塞本地门禁 | 只建空目录 |
| P8 | Codex-inspired 工作台与 install→task→evidence→resume→export 公开路径 | Web/Desktop 核心旅程与 UI 状态验收；更新后的归档 clean-install/release evidence | 未证明的营销能力、Outlive 范围外的云/账号/多人能力 |

## 3. 并行 lanes

```mermaid
flowchart LR
  A[Architecture/Governance] --> D[Domain Extraction]
  Q[Quality Infrastructure] --> D
  D --> M[Memory Slice]
  D --> R[Runtime Reliability]
  D --> C[Clients/Desktop]
  M --> REL[Release Slice]
  R --> REL
  C --> REL
```

- Governance lane 可先建 Note、规则和 docs consistency gate；
- Quality lane 可先固定当前 fixtures/baselines；
- Domain extraction 必须先完成相关 logical seam 才允许相应 feature lane；
- Memory、Runtime reliability、Client 可并行，但共享协议/schema 由单 owner 合并。

## 4. 临界路径

当前最可能临界路径：现状基线 → Runtime/Evidence 逻辑分层 → shared protocol → Desktop；以及 Session/Evidence → Memory lifecycle → retrieval/context → 本地纵向验证。Langfuse 外部质量评估可在 P7 后按需补入，不阻塞该路径。

## 5. WIP 与切片参数

| 参数 | 推荐 |
|---|---|
| active architecture migrations | 每个 owning family 同时 1 个 |
| task diff | 非机械目标 <500 行，通常不超过 800 |
| behavior + move | 默认分开 PR/task |
| phase overlap | 仅在依赖 gate 通过后，不按日期强开 |
| rollback | 每个切片保持旧入口 shim 或单向数据迁移回退说明 |

## 6. 重新排期触发器

架构基线不成立、性能回归超过预算、迁移产生双真源、安全边界需改变、关键 API 无法形成窄端口时，停止后续抽包并回到设计 gate。任务“做完很多文件”不能作为忽略触发器的理由。

## 7. 验收标准

每个 roadmap task 只依赖已存在节点且图无环；任一 Phase 的出口可由证据判断而非主观进度；并行 lanes 不同时争用同一 canonical owner；删除任一前置时，下游任务能被机器或评审明确阻塞。

## 8. 当前 P8 验收边界

UX-086 首轮基础与 Web/Desktop 核心旅程已通过[当前验收](../../validation/ui-086-workbench-ux/README.md)。HOST-087 自动管理运行时 → PAR-088 → CLI-089/SET-090 → DEV-091 → RUN-092；BRAND-093/MEDIA-094 → UX-086 安装即用验收 → DIST-095 → REL-083/084 构成本轮闭环路径。REL-083/084 必须引用新归档摘要与对应安装/窗口回执；历史摘要不证明新 UI。当前 REL-084 接受明确的维护者 Agent 模拟，P8 的真实外部用户从零安装条件仍需独立人员证据。

安装即用范围要求应用携带运行时并自动恢复，用户无需开发工具或手动启动服务。BRAND-093 的兼容标识保持可读；MEDIA-094 必须产出真实文件和工具回执；DIST-095 的 macOS/Windows 干净环境验收、签名状态与外部参与者分别记录，不以维护者源码测试代替。
