---
id: 2026-10-01-mem-048-langfuse-paired-evaluation
title: Memory 与 Experience 配对评估协议
status: implemented
owners: [langfuse-integration, memory, experience]
created: 2026-10-01
last_reviewed: 2026-10-01
affects: [external-evaluation, memory-quality, experience-quality, privacy]
supersedes: []
---

# Agent Note：Memory 与 Experience 配对评估

## 问题

路线图要求 Memory 和 Experience 分别具备可追溯数据集/run 的配对报告，并报告收益、伤害与置信区间。MEM-048 还依赖 V2 Memory 资格消费者、已验证 Experience 生命周期/检索消费者和可用的 Langfuse 环境。确定性测试不能单独推出质量结论。

## 已实现前置条件

- MEM-049 将 V2 资格门接入 Runtime 消费者；Host 必须显式开启，默认关闭，G-21 V1 路径保持独立。见 [MEM-049 Note](2026-10-01-mem-049-v2-memory-recall-runtime.zh.md)。
- MEM-050 提供 owner-scoped Experience 生命周期持久化/回放，以及 validated-only Runtime 检索、scope/applicability/counterexample 检查和 Context provenance。见 [MEM-050 Note](2026-10-01-mem-050-experience-lifecycle-consumer.zh.md)。
- 已搭建仅 loopback 可访问的 self-hosted Langfuse 4.48.0 项目和本地 Ollama `qwen3:4b`。本次只评估审核过的合成 fixture，没有向托管服务发送用户、生产或仓库内容。

## 决策与实现

Memory 与 Experience 分为两项 paired study，各自使用相同的冻结 48 项数据集运行 control/treatment；预期唯一差别是相应 Runtime recall 开关。主要指标为 `verified_task_completion_rate`，Oracle 使用 expected output 精确 token 匹配。保留逐项 trace/score、run-level score、配对差、伤害检查、延迟，并使用按任务族分层、10,000 次重采样的双侧 95% paired bootstrap。Langfuse 不进入本地 CI，也不能替代确定性安全门禁。

首轮本机合成 pilot 于 2026-10-01 完成，四个 run 均为 48/48：

| Lane | 数据集 | Control run | Treatment run | 配对结果 |
|---|---|---|---|---|
| Memory | `mem048-memory-synthetic-holdout-20261001062250-6305985b`，SHA-256 `d69a25841c97678bf69c1431969574a3c2ec3358a41744784270b5c73289da22` | [2342a18248967a5b](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5dnui005vp406dv91i9kh/runs/2342a18248967a5b) | [306fe8d467b6d916](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5dnui005vp406dv91i9kh/runs/306fe8d467b6d916) | 24 wins / 24 ties / 0 losses；`+50.0 pp`；95% CI `[+50.0, +50.0] pp`；0 项 treatment 退化 |
| Experience | `mem048-experience-synthetic-holdout-20261001062250-6305985b`，SHA-256 `729941b54f0756fc3734f5ca52e444167a9c03b4a9c79cd54fc1456018c3a3a1` | [d0986e3d146f1199](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5do64007ap406a3nmph4q/runs/d0986e3d146f1199) | [8872fbd2051218e4](http://127.0.0.1:3000/project/mem048-synthetic/datasets/cmup5do64007ap406a3nmph4q/runs/8872fbd2051218e4) | 32 wins / 16 ties / 0 losses；`+66.7 pp`；95% CI `[+66.7, +66.7] pp`；0 项 treatment 退化 |

本次 Langfuse v4 dataset API 没有返回 version 字段，因此报告记录 `version: null`，通过 dataset 名称、冻结 SHA-256、item 数和 Langfuse run refs 锁定精确输入，不伪造时间戳版本。正式 case ID 为 `mem-101..148` 和 `exp-101..148`，未用于之前的 Runtime 诊断；此前与 `mem-001/002` 重叠的完整 run 已保留并排除。V3 Scores API 读回确认每臂有 1 个聚合分数和 48 个逐项分数；聚合分数 Memory 为 `0.5/1.0`，Experience 为 `0.3333/1.0`。每条 lane 抽查一条 treatment trace，均能解析出已存储 observation。完整报告含全部配对项、score/trace ID、模型/配置 digest 和验证记录。

模型为本地 Ollama `qwen3:4b`，digest `359d7dd4bcdab3d86b87d73ac27966f4dbb9f5efdfcc75d34a8764a09474fae7`，Ollama `0.35.0`，temperature `0`，seed `20261001`；结构化答案 schema 与 evaluator 均在报告中标注版本。平均延迟 Memory `380.7/425.0 ms`、Experience `393.4/462.9 ms`（control/treatment）。本地 Ollama 无可核验的计费成本。

## 解释边界与后续工作

状态为 `completed / exploratory-inconclusive`：本次合成 pilot 证明两个配对消费者、Langfuse 数据集/run、trace ingestion、score 和报告计算链路均已接通；它不证明真实独立任务分布上的质量、通用收益、发布阈值或一般性无伤害。每个任务项仅运行一个样本，且本轮各任务族结果一致，因此分层 bootstrap 区间退化为点区间。真实分布评测归 EVAL-074，应另行审核、最小化数据并预注册方案。Memory × Experience 交互研究继续延期。

## 不变量与回滚

- Langfuse 得分不能证明隐私、授权、scope 隔离、撤销、删除、注入或副作用安全；这些由本地确定性门禁证明。
- 本次没有向托管服务发送原始用户/Session 数据、生产 Memory、源码、凭据或稳定标识。
- 无效 run 保留原因并从指标排除；修正后的研究使用新的 dataset/run ID，不覆盖历史 Langfuse 记录。
- Langfuse 不可用或缺少授权时，不阻塞本地测试和 CI。

## 验收标准

- [x] 已规定配对臂、主要指标、伤害分类、隐私规则和报告字段。
- [x] V2 Memory 资格消费者与 validated Experience 消费链已实现并经本地验证。
- [x] 两份 48 项配对报告包含数据集 digest、模型/配置/evaluator 版本、收益、伤害、置信区间和 Langfuse dataset/run refs。
- [x] 已从本地实例读回 Langfuse run-level/item-level scores 和代表性 trace。
- [x] 外部评估与本地 CI、安全门禁保持独立。

## 证据

- 本机完整报告（mode `0600`）：`/Users/cain/.local/share/tracegraph-mem048-langfuse/reports/mem048-20261001062250-6305985b.json`。
- 无效/排除 run 记录（mode `0600`）：`/Users/cain/.local/share/tracegraph-mem048-langfuse/reports/invalid-attempt-20261001.json`；无效写入、单条历史版本错误和与 Runtime 诊断重叠的完整试跑均未纳入最终指标。
- 本地实现与工程验证：root typecheck、Contracts/Evidence/Context/Core focused suites、Runtime 测试、`pnpm test:engineering`、边界/文档/包 README/module graph 检查及 `git diff --check`。
