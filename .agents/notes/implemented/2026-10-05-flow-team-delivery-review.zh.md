---
id: 2026-10-05-flow-team-delivery-review
title: 软件交付前有限预算独立审阅
status: implemented
owners: [runtime, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: zh-CN
affects: [FLOW-097, GOAL-099, TEAM-100]
supersedes: []
---

# Agent Note：软件交付前有限预算独立审阅

[English](2026-10-05-flow-team-delivery-review.md)

## 当前状态与已批准实施阶段

用户已授权完整软件交付和独立受限审阅。现有 canonical 子 Run、可信角色解析、只读工具上限和共享 Goal 请求预留，现承载受限交付审阅流程。生产 Host 启用有限策略，兼容 Core 嵌入不传该选项。含 verified 补丁/命令范围的软件 finish 在提交 `run.completed` 前先被核验。

已批准的实施阶段是一个真实临时软件需求，外部文件/构建/测试效果、独立只读审阅、一次修复和再次审阅。确定性提供商证明受控协议与 Runtime 效果，不能证明真实付费模型的开发或审阅质量。整个 FLOW/TEAM 和原生 UI 验收仍是独立义务。

## 已实施边界

可信 Runtime 交付审阅选项选择编译的独立只读角色。含 verified 补丁路径或成功验证命令范围的根 execute Run，在成功终态前通过 canonical 子审阅。Plan 回答、没有工作区效果的普通聊天、子 Run 和专用媒体操作排除。审阅不授予权限，不合并、提交或推送 Git 结果。

闭合结构化审阅结果仅从实际子终态和 hash-linked 父回执接受。阻断发现成为持久父 Observation，现有循环可据此修复并重测。轮数有限。审阅失败、非法结果、预算耗尽、取消或未知副作用不能成为交付成功。审阅在父 control lock 外运行，终态在锁内重新核对排队输入和实际终态。

根 owner 已接受有限默认值：生产 Host 启用两次审阅，普通软件 Run 使用 200,000 Token 与 15 分钟；旧 Core 嵌入不传选项。内部回合阈值转为同一总额度内的 canonical 阶段检查点。每次已应用补丁后必须有新成功验证回执；连续两次未补齐会停止交付。另一通用失败续接接缝最多接受三次已知 POSIX 进程组静止的验证失败，仅限确定非零退出、无超时/取消/截断的 settled 回执。模型可经正常闸门观察和修复，Runtime 不重新运行失败命令。没有新 canonical 读取或源码变更证据时重复相同命令会被拒绝。Windows、子 Run 与兼容模式保留原有 fail-closed 行为。

整个树复用已准入 Goal lease，普通软件 Run 则使用 Runtime 自有有限 Token/时间 lease。预留先于提供商派发，审阅、修复和重试全部计入。启用模式下不支持预算的适配器须在派发前拒绝。重启不制造新预算，不自动重复审阅或写入。

## 真相来源、安全与兼容

- 复用当前 AgentLoop、SubagentRegistry、canonical SessionEvents 和 scoped Artifacts，不创建第二编排循环或日志。
- 审阅工具与工作区权限只读，并与父准入上限相交。仓库文本、测试输出和模型发现仍是非可信证据。
- 审阅有独立子 Run/Session 和提供商 lease，只共享公开需求与真实效果引用；私有推理不作为审阅证据。
- 新增 Decision 字段保留旧读取；自由文本回答不能替代审阅结果。
- Goal 的 `run.completed` 仍表示等待用户最终验收，不自动满足 done 条件。
- 已批准默认值已装配到 Host。关闭模式保留现有嵌入行为，但不能声称自动审阅。Plan 批准也持久记录禁止后台抽取的事实，防止后续账单逃出准入额度。

## 验证与回退

受控软件 fixture 修改真实源码、构建模块、获得实际阻断审阅；新增回归真实非零退出，修复源码并重新构建/测试，通过第二轮独立审阅。负例覆盖不支持预算绑定、假/文字审阅、读写拒绝、外部变更、缺失/未知/超时验证、重复闸门、取消、阶段/无进展续接、Goal 共享计费、回放与普通交付自动恢复拒绝。关闭可信选项恢复旧 finish 行为，但不删除审阅、预算或未决回执。不使用付费凭据或默认 profile。

## 证据

[受限报告](../../../docs/validation/delivery-review/README.zh.md)链接实际命令 Artifact、交付源码/构建字节、三个 canonical Run 与 15 次真实本机 HTTP 请求。独立只读核验器通过 692 项检查。Core 聚焦检查 8 文件 / 88 项通过；Goal 17 项、生产 Host 准入 2 项、fixture/恢复 30 项与契约 6 项通过。早期失败/阶段回执保留。所属接缝为 [Runtime](../../../packages/core/src/domains/runtime/runtime.ts)、[交付审阅](../../../packages/core/src/domains/runtime/delivery-review.ts)、[子角色](../../../packages/core/src/domains/subagent/subagent.ts)和[共享预算](../../../packages/core/src/domains/runtime/shared-run-budget.ts)。

## 剩余范围

implemented 仅适用于已验证后端切片，不表示完整 FLOW/TEAM/Goal 验收。必读清单覆盖 verified 补丁路径和命令 manifest，不含脚本生成任意文件的完整清单，该清单仍待实施。新成功测试是实际执行回执，不证明测试覆盖。必读文件受限且经过策略校验，但前后 hash 不能原子防御同用户文件系统篡改。真实付费开发/审阅质量、Windows 已知失败进程静止、完整 UI 审阅控制和最终用户验收未验证。Goal 完成仍是独立用户决定。
