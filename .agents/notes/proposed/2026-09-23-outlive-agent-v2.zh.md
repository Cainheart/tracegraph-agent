---
id: 2026-09-23-outlive-agent-v2
title: 将 Outlive Agent V2 作为提议中的产品与架构方向
status: proposed
owners: [product, architecture]
created: 2026-09-23
last_reviewed: 2026-09-26
affects: [identity, runtime, memory, packages, clients, repository-governance, quality]
supersedes: []
language: zh-CN
translation_of: 2026-09-23-outlive-agent-v2.md
---

# Agent Note：将 Outlive Agent V2 作为提议中的方向

[English](2026-09-23-outlive-agent-v2.md) · 中文

## 问题

TraceGraph 已具备有用的证据、回放、Memory、Web、CLI 和离线质量检查基础，但产品叙事仍以追踪为主，主 Runtime 也累积了过多职责。仓库还缺少一个简明的治理入口，用来管理架构决策、可复用流程、包晋升、录制会话回归以及未来的 Desktop 工作。

## 当前状态

当前行为仍由以下内容定义：

- [`README.md`](../../../README.md)
- [`docs/modules/`](../../../docs/modules/)
- 各负责模块链接的源码与可执行测试。

有价值的 TraceGraph 能力清单、尚未解决的边界和迁移规则，集中在 [TraceGraph → Outlive 迁移基线](../../../docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)中。

## 提案

将 **Outlive Agent** 确定为产品与底层 Agent Runtime/技术内核的统一名称，并定位为可处理多类型真实任务的完整通用 Agent；编码是重要场景，不是产品边界。**TraceGraph Agent** 仅用于指代迁移前的项目、当前仓库和历史实现。最终 package scope 为 `@outlive/*`；当前 `@tracegraph/*` 仅迁移期保留，改名须走独立、兼容且无行为变化的迁移。[Outlive Agent V2](../../../docs/outlive-agent-v2.md)仍是提议中的目标架构，名称核查已由维护者确认完成。

当前产品入口限定为 **Desktop、Web UI、CLI**；独立 API、对外 SDK、ACP 暂不纳入产品范围，内部协议/client 仅服务这三种入口。LSP（Language Server Protocol，语言服务器协议）采用 DSH 式可选只读代码导航接入：共享 `lsp` 契约、配置型 stdio Provider 和模型可见的 `lsp` 工具，操作限于 definition、references、implementation、hover；语言服务器由部署方提供，DSH 不随包分发服务端。TraceGraph 当前的 diagnostics 不自动进入目标。CodeGraph 不作为 Outlive Agent 的内建 V2 能力，也不安排现有实现迁移。

多人团队共享 Workspace/Memory 不进入 V2，留待后续版本单独评审；此决定仅针对人类多用户共享，不影响 V2 内部 Subagent/Agent Team 协作。

设计围绕一个承诺：一次工作会话留下的不应只是答案，还应有证据、可审查的记忆和可复用的经验。知识可以跨越会话；权限必须在当下重新确立。

实现顺序遵循机器可读的 [`roadmap.yaml`](../../../docs/outlive-agent-v2/roadmap.yaml)：先建立基线和架构门禁，再扩展实体包。

质量验证采用明确分工：本地保留确定性测试、CI/架构门禁、性能 Benchmark 与 Session Snapshot；模型、检索、Memory/Experience 和任务质量评估计划后续使用外部 Langfuse 项目，不建设仓库内 `evals/` 评测套件。Langfuse 不可用或未授权时，不得阻塞本地门禁；权限、scope、撤销和删除等不变量必须由本地测试证明。

## 考虑过的备选方案

- 继续用 **TraceGraph Agent** 作为新产品及技术内核名：否决；仅保留为迁移前项目与历史实现名称。
- **Time Agent** 或 **Time Memory Agent**：容易被误认为调度工具，作为产品名也不自然。
- **MEN/Man Agent**：含义不明，还会带来可避免的歧义。
- 立即照搬其他项目的目录和包数量：表面上推进很快，却会固化本仓库尚未稳定的边界。

## 不变量与边界

- 在各个 V2 切片真正交付前，当前文档仍具有权威性。
- 原始 Event/Receipt 与派生的 Episode、Memory、Experience 投影保持分离。
- Memory 绝不携带过期的权限、凭据或审批授权。
- 包提取依据稳定的接缝和测试，而不是目标目录数量。
- Desktop 在安全范围内共用领域协议与 UI，但渲染器代码不能直接获得 Node 或凭据权限。

## 迁移与回滚

V2 在维持当前公开行为的前提下渐进引入。产品与底层技术内核统一称为 Outlive Agent；最终包 scope 使用 `@outlive/*`，现有 `@tracegraph/*` 与持久化格式保持兼容，直到独立的版本化迁移获批。TraceGraph Agent 作为仓库和迁移历史名称保留，不再代表另一套技术内核品牌。

## 验收标准

- [x] 确认 Outlive Agent 同时作为产品与底层 Agent Runtime/技术内核的统一名称。
- [x] 确认产品入口仅为 Desktop、Web UI、CLI；独立 API、对外 SDK、ACP 延后。
- [x] 确认最终 package scope 为 `@outlive/*`，名称核查已完成；`@tracegraph/*` 只作迁移期兼容，实际改名另走迁移方案。
- [x] 确认多人团队共享 Workspace/Memory 不进入 V2，留待后续版本；与内部 Agent Team 协作区分。
- [x] 确认 LSP 采用 DSH 式可选只读代码导航接缝（definition/references/implementation/hover），不内置语言服务器，Current diagnostics 不自动进入目标；CodeGraph 不进入内建 V2 能力/迁移目标。
- [ ] 评审 Memory 权限模型、包晋升门槛和 Desktop 外壳选型。
- [ ] 完成 P0 基线与 P1 架构门禁。
- [ ] 展示恢复、取消，以及从证据到纠正/导出的、保留来源链的 Memory 生命周期。
- [ ] 每个纵向切片验证并交付后，才更新当前文档。

## 风险与未决问题

- 多人团队共享进入后续版本前，需单独定义成员权限、共享 scope、纠错仲裁、撤销和数据隔离。
- 将个人历史经验导出为可继承内容，公开定位之前需要威胁模型、隐私评审和明确的同意语义。
- Desktop 技术方案仍待决策，并非已经锁定的实现选择。

## 证据

- 设计文档集：[`docs/outlive-agent-v2.md`](../../../docs/outlive-agent-v2.md)
- 实现：待完成
- 测试：待完成
- 验证：待完成
