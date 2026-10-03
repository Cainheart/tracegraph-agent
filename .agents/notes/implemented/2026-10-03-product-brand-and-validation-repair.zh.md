---
id: 2026-10-03-product-brand-and-validation-repair
title: Outlive 产品名称与有界工具参数纠正
status: implemented
owners: [product, runtime]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/core, packages/host, packages/sdk, apps/cli, docs/brand]
supersedes: []
---

# Outlive 产品名称与有界工具参数纠正

用户已确认产品名称 Outlive Agent 和安装即用的本地产品方向。当前界面残留旧名称、Todo 参数错误直接终止运行，影响使用体验。

产品文案、命令帮助与应用图形统一为 Outlive Agent。`@tracegraph/*` 包作用域、已有 wire schema 标识、旧环境变量和历史 Ledger 保持兼容；这些技术标识的迁移另行处理。候选标志使用自然色、收细端部的 SVG 曲线路径，不使用圆点端点，最终商业标志由用户选择。

模型工具参数错误仍在整批执行前拒绝，允许连续两次在后续模型轮次纠正；第三次用可理解的失败信息结束。策略和 capability 拒绝仍直接停止。不会静默改写参数，也不会将拒绝动作记为已执行。校验失败回执和观察附在现有 `action.rejected` Ledger 事件中，反馈下一模型请求；不构成 Todo 完成证据。取消和总轮次上限继续生效。

回退只需还原展示资源和有界纠正分支，原始 Ledger 与 Todo 规则不变。验收覆盖成功纠正、pending 规则、整批无副作用、持续错误及策略拒绝不重试。

实现与验证：

- [整批参数拒绝与纠正](../../../packages/core/src/domains/runtime/agent-loop.ts)、[Todo/模型规则](../../../packages/core/src/domains/tools/registry.ts)和 [12 项计划模式测试](../../../packages/core/src/domains/runtime/runtime.plan-mode.test.ts)，保留策略拒绝和完成证据约束。
- [模型凭据租约](../../../packages/host/src/composition/leased-model.ts)、[连接测试控制器](../../../packages/host/src/workbench-control.ts)和[替换 Key 测试](../../../packages/host/src/workbench-control.test.ts)，保证旧测试不标记新配置已通过。
- [原创 SVG 候选](../../../docs/brand/README.md)、ICNS/ICO 应用图标、`outlive` 命令别名、产品文案和首次引导已实现；A 仍是临时预览，不代表已选定最终商业标志。
- [本轮验证与保留失败](../../../docs/validation/installable-product/root-verification.md)区分源码、macOS 安装、外部图片质量、Windows 原生和签名证据。

连接测试在命令账本让出执行前，绑定与 Run 相同的模型和凭据快照。测试进行中替换或清除 Key 不会提前删除该凭据，旧配置的成功结果不能将替换后的配置标为已测试。
