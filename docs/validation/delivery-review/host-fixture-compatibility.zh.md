# 生产预算兼容：测试 fixture 与恢复

[English](host-fixture-compatibility.md)

本补充保留生产 `deliveryReview` 准入。旧进程内测试适配器现使用[仅测试的预留适配器](../../../packages/host/test-support/budgeted-fixture-model.ts)：先预留再调用决定产生器，序列化输出受实际预留上界约束，明确结算合成 fixture 消耗；结果丢失时保守计入未知消耗。序列化单位仅用于协议 fixture，不是付费提供商 Token 或质量证据。真实 `ConfigurableModelAdapter` 不包装或重复计费。

[最终串行回执](checks/host-budget-fixtures-final2.log)记录五文件 / 26 项通过：`project-file-context`、`readonly-preview`、`subagent-worktree-runtime`、`composition/recovery-policy` 及新增适配器负例。生产源码、有限默认值和未知处理均未放宽。额度不足时决定产生器零调用；已知合成结果产生真实预留/结算事实；丢失结果保留原预留消耗。

只读预览 oracle 仍实际验证批准 `patch.applied`、源码字节变化、HTTP 服务同 PID 存活与 Run writer 租约释放。但其 fake writer 未提出验证命令，当前正确终态为 `failed / delivery_verification_missing`，不是成功软件交付。此前[预览证明](../dev-readonly-preview/README.md)保留为文件/进程边界的历史证据。

恢复权限仍由实际显式执行 Plan 覆盖：创建 Todo、提交计划、不派发恢复、续接同一待批准计划，然后改变项目规则，以 `resume_policy_changed` 拒绝精确计划批准。旧测试不支持预算的适配器和隐式软件成功恢复不绕新策略。此前回执早于普通有限交付续接，其 legacy 适配器没有不可变恢复身份；该负例现要求 `delivery_model_binding_missing`，保留原预留/源码字节，新增派发为零。实际同预算软件继续由[人工继续切片](../delivery-human-continuation/README.zh.md)单独验证，本历史 fixture 回执不证明后续功能。

[首次串行回执](checks/host-budget-fixtures-final.log)保留一个仅 fixture 的路由错误（`/approve-plan` 返回 404）。真实路径为 `/plan/approve`，第二份回执才是已验证结果。根任务更广并行检查失败保留在原日志。这些聚焦结果不替代最终全仓或原生安装验收。
