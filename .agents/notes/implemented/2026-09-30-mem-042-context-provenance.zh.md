---
id: 2026-09-30-mem-042-context-provenance
title: 绑定 Context 来源与 Run 级 MemoryUse 证据
status: implemented
owners: [context, memory, contracts]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [context-manifest, memory-recall, memory-use, runtime-ledger]
supersedes: []
---

# Agent Note：绑定 Context 来源与 Run 级 MemoryUse 证据

## 问题

MEM-040 与 MEM-041 建立了 V2 Memory record/lifecycle 契约，同时保持 G-21 Runtime 使用 V1 canonical JSONL store。G-21 检索可以追到索引 hit、路径和行区间，但没有把 canonical Memory hit 绑定到确切 record version 和 evidence refs。ContextManifest 能描述可见条目及 token 数，却没有记录实际交给模型 Adapter 的渲染字符串 digest，因此容易把检索命中、选入 Context 与实际交付混为一谈。

## 当前状态

- `MemoryManager` 仍从 `records.jsonl` 读取 admitted V1 records；本任务不读取 MEM-040 sidecar 或 MEM-041 lifecycle stream。
- 对 canonical `memory/<encoded-memory-id>.md` 索引路径，Core 会核对对应 admitted record。其 retrieval attribution 带 V1 schema version、record ID/version/content hash 和限长的 evidence ref identity。普通非 Memory 索引来源仍只保留路径/chunk/行号，不会伪造 Memory version。
- 新 Context builder 将最终 `modelContext` 字符串的 SHA-256 写入 `rendered_context_digest`，并保存同一次 build 的 `token_estimate`。旧 Manifest 仍可在没有新 digest 的情况下读取。
- Core 在 Run Event Ledger 追加 `memory.use_status`，并导出 `replayMemoryUseStatus()`；没有创建第二套 journal，也没有更换 V1 Memory 持久化。

## 决策

在已有 canonical Run Event Ledger 中分开记录检索、选择和 Adapter hand-off：

1. `memory.recalled` 表示检索阶段产生了命中，不表示命中已交给模型。
2. Context 构建完成后、调用模型 Adapter 前，先追加 `dispatch_intent`，其中包括 manifest ID、精确渲染内容 digest、token estimate 和最终选入的 canonical Memory 项。每项关联 retrieval attribution、准确的 Memory version/evidence refs、所选内容 digest 和 token 数。
3. Runtime 调用 `ModelAdapter.decide()` 后追加 `adapter_invoked`，只记录经过边界清理的 Adapter identity。
4. 随后追加一个实际观察到的终态：`response`、`failed` 或 `unknown`。状态事件不保存响应正文或 Memory claim 正文。

dispatch intent 必须先于 Adapter 调用持久化。若进程中断而没有终态，调用方必须把记录视为未解决/unknown，不能当作成功使用。`adapter_invoked` 只表示 Runtime 用该请求对象调用了 Adapter 方法，不证明远端 Provider 接受请求或模型内部关注了记忆。`response` 只表示 Runtime 收到并验证了 Adapter 响应，不表示任何记忆导致了回答内容。

`ContextManifest.rendered_context_digest` 将按 Manifest 条目稳定重建的字符串绑定到 `ModelInput.context`；token estimate 也是对同一请求内容的估计。Provider 报告的 usage 仍作为后续事实记录，不回写 Manifest。

## 考虑过的备选方案

- 将 `memory.recalled` 当作 Memory 使用：不采用，因为命中可能被过滤、未选入或没有发起模型请求。
- 把 MemoryUse 写入 Memory lifecycle stream：不采用，因为使用事实属于单次 Run/request，不属于长期 Memory aggregate。
- 在 MemoryUse 事件中保存完整 Provider 请求或响应：不采用，因为身份、证据引用、hash 和有限状态已足够描述请求边界，也可避免在 append-only 事件中复制 claim 正文。
- 将 G-21 Runtime 切换至 V2 lifecycle record：延期；MEM-042 不能隐式迁移或双写 canonical store。

## 不变量

- `memory/` canonical retrieval 路径没有对应 Memory ID 时无法通过 schema；编码后的路径必须匹配 record identity。
- 准确的 Memory record version/hash 和 evidence refs 从 recall 保留到 Context 与 `dispatch_intent`。
- 新 ContextManifest 把模型可见输入 digest 绑定到 token estimate；Runtime 原样传入重建出的字符串。
- 唯一合法 MemoryUse 状态顺序是 `dispatch_intent -> adapter_invoked -> response|failed|unknown`；Adapter 调用前中断时允许 `dispatch_intent -> unknown`。
- 所有状态事件由 Run、turn、model call 和 Context manifest 限定；replay 会拒绝缺少 intent、identity 漂移、重复 intent 和非法状态转移。
- MemoryUse 事件不包含 claim、选入 Context 的正文、原始 Adapter 响应或自由文本错误详情。
- 检索不等于选择，选择不等于 Provider 接受或模型内部使用。
- 不迁移或改写 G-21 V1 record、自动召回策略、既有 SessionEvent 历史或 MEM-041 独立 aggregate stream。

## 迁移与回滚

无需数据迁移。为兼容旧数据，旧 Context artifact 可在没有 rendered digest 时读取；新 writer 总会生成 digest。V1 records 仍按原路径读取，只有能精确匹配 canonical record 的 retrieval 才会携带版本引用。回滚时可以停止追加 `memory.use_status` 并从后续 Context build 移除新增元数据；已提交的 Run events 和旧 Manifest 均保持不可变。不得通过回滚擦除或重写现有 Run 历史。

## 验收标准

- [x] canonical Memory retrieval 将准确 record version、record content hash 和有界 evidence refs 传入 `ContextManifest`。
- [x] Manifest 可重建准确的模型可见字符串，并将其 SHA-256 绑定到同一 token estimate。
- [x] Run Ledger 在 Adapter 调用前追加 dispatch intent，并追加 adapter invocation、response/failure/unknown 状态。
- [x] Replay 校验 MemoryUse identity 与合法状态转移；状态事件不保存 Memory claim 或 Adapter 正文。
- [x] 当前 Memory/Context/迁移文档区分已交付 Run 级记录与尚未交付的 V2 store、UI 和 Provider 接受证明。

## 风险与未决问题

- dispatch intent 后、终态事件前发生进程崩溃时会留下未解决状态。后续恢复/UI 可将其投影为 unknown；自动重试不得把它静默变成已确认 Provider 调用。
- 当前 V1 store 是 append-only，且版本模型不同于未来 V2 canonical store。正式切换仍需评审兼容和保留方案。
- MemoryUse 当前只在 Run stream 中记录状态；尚无用户管理/检查 UI、删除脱敏流程或跨进程并发协议。

## 证据

- 实现：`packages/contracts/src/{context,memory,memory-use,event}.ts`、`packages/context/src/context.ts`、`packages/core/src/domains/{memory/memory,memory/memory-use,runtime/agent-loop}.ts`。
- 聚焦测试：`packages/contracts/src/memory-use.test.ts`、Context builder digest 断言、G-21 Runtime 集成测试覆盖精确版本/evidence 传递、Adapter 前持久化、成功/失败/中断状态和 replay 校验。
- 验证：`pnpm typecheck` 通过全部 18 个可构建 workspace 项目及 eval typecheck；`pnpm -r --if-present test:unit` 通过全仓 1,027 项 unit tests；`pnpm test:engineering` 通过 48 项 Node 检查和 8 项 Vitest 检查；implementation-consistency eval 通过 6 项测试；重生成模块图和当前基线后，`pnpm verify:boundaries`、`pnpm verify:package-readmes`、`pnpm verify:invariants`、`pnpm verify:v2-docs`、`pnpm graph:modules:check`、`pnpm baseline:current:check` 与 `git diff --check` 均通过。
