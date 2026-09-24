---
id: 2026-09-23-outlive-agent-v2
title: 将 Outlive Agent V2 作为提议中的产品与架构方向
status: proposed
owners: [product, architecture]
created: 2026-09-23
last_reviewed: 2026-09-23
affects: [identity, runtime, memory, packages, clients, repository-governance]
supersedes: []
language: zh-CN
translation_of: 2026-09-23-outlive-agent-v2.md
---

# Agent Note：将 Outlive Agent V2 作为提议中的方向

[English](2026-09-23-outlive-agent-v2.md) · 中文

## 问题

TraceGraph 已具备有用的证据、回放、Memory、Web、CLI 和评测基础，但产品叙事仍以追踪为主，主 Runtime 也累积了过多职责。仓库还缺少一个简明的治理入口，用来管理架构决策、可复用流程、包晋升、录制会话回归以及未来的 Desktop 工作。

## 当前状态

当前行为仍由以下内容定义：

- [`README.md`](../../../README.md)
- [`docs/modules/`](../../../docs/modules/)
- 各负责模块链接的源码与可执行测试。

有价值的 TraceGraph 能力清单、尚未解决的边界和迁移规则，集中在 [TraceGraph → Outlive 迁移基线](../../../docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)中。

## 提案

将 [Outlive Agent V2](../../../docs/outlive-agent-v2.md) 作为提议中的目标架构，将 **Outlive Agent** 作为产品工作名；迁移期间继续保留 **TraceGraph Engine** 和 `@tracegraph/*` 作用域。

设计围绕一个承诺：一次工作会话留下的不应只是答案，还应有证据、可审查的记忆和可复用的经验。知识可以跨越会话；权限必须在当下重新确立。

实现顺序遵循机器可读的 [`roadmap.yaml`](../../../docs/outlive-agent-v2/roadmap.yaml)：先建立基线和架构门禁，再扩展实体包。

## 考虑过的备选方案

- 继续用 **TraceGraph Agent** 作产品名：适合技术内核，但不足以表达记忆与经验的产品承诺。
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

V2 在维持当前公开行为的前提下渐进引入。包名与持久化格式保持兼容，直到获接受的 Note 规定了版本化迁移。即使否决产品工作名，也不必重命名技术内核或包作用域。

## 验收标准

- [ ] 评审并接受或否决产品名称、Memory 权限模型、包晋升门槛和 Desktop 外壳选型。
- [ ] 完成 P0 基线与 P1 架构门禁。
- [ ] 展示恢复、取消，以及从证据到纠正/导出的、保留来源链的 Memory 生命周期。
- [ ] 每个纵向切片验证并交付后，才更新当前文档。

## 风险与未决问题

- Outlive Agent 的最终商标、域名和包名核查仍未完成。
- 将个人历史经验导出为可继承内容，公开定位之前需要威胁模型、隐私评审和明确的同意语义。
- Desktop 技术方案仍待决策，并非已经锁定的实现选择。

## 证据

- 设计文档集：[`docs/outlive-agent-v2.md`](../../../docs/outlive-agent-v2.md)
- 实现：待完成
- 测试：待完成
- 验证：待完成
