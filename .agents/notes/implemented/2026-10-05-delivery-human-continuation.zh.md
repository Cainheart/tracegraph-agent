---
id: 2026-10-05-delivery-human-continuation
title: 中断的有限软件 Run 人工继续
status: implemented
owners: [runtime, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: zh-CN
affects: [FLOW-097, GOAL-099, TEAM-100]
supersedes: []
---

# Agent Note：中断的有限软件 Run 人工继续

[English](2026-10-05-delivery-human-continuation.md)

## 当前状态与已接受实施阶段

用户已授权在原有限软件预算内人工继续。此前普通软件恢复拒绝 `delivery_resume_requires_review`；审阅者仅接收任务前缀和最后十个命令引用。本阶段已修复这两个缺口，不自动重放任务，不增加消费授权，也不切换凭据。

## 已实施决策

显式现有 Session resume 命令仅在核验 canonical 范围、授权、Extension/Skill 代际、模型/凭据身份、已结算模型预留、Action 对账、源码哈希与交付策略后恢复同一个中断普通 Run。可信工作区规范根摘要/类型/能力也必须一致，替代目录、别名与扩权均安全拒绝。可信 Host resolver 绑定原准入模型配置；配置变化或绑定缺失在派发前拒绝。预算重建保留相同身份、上限、全部已消费 token、耗时、失败计数与审阅轮次。丢失预留或未知副作用阻止继续。Goal 工作继续由其已批准 Goal 预算拥有，普通 Session resume 不得制造替代预算。

旧工具调用、待写入和审阅者均不自动重放。已有补丁审批按原哈希栅栏重新发出；运行阶段仅在显式人工继续后从新的模型观察边界恢复。只有完整范围 WAL/当前 SHA 绑定的后续 canonical 已验证补丁可以明确作废旧验证；必须补新验证与审阅。外部修改、未知写入或绑定缺失均拒绝且不派发。已完成或失败的终态 Run 不复活。

审阅接收不可变、有范围的需求包，包含完整脱敏初始任务、公开会话上下文与已消费人工指导、精确 canonical 验证引用，以及适用时可信已批准 Goal 条件。编译的只读子 Agent 必须通过有范围 `read_artifact` 真实回执读取需求包每个字节，全部页面在其精确最终模型 Context Manifest 以正数 Token 无截断保留，结构化结论才可接受。需求包有明确有限尺寸/窗口边界，超限显式失败而不静默截断。回执核验只能证明证据访问，不证明模型理解、语义完整或真实付费提供商质量。

## 真相、安全与验证

复用 Run Budget 检查点、SessionEvent、范围 Artifact、会话租约、权限校验与子 Runtime，不建立平行编排或事件日志。未知写入、策略/凭据变更、陈旧验证、预算耗尽/未结算/未知、缺包、未读完和 Replay 必须产生零新增外部派发。真实临时项目/API fixture 应证明人工继续前后预算保留及真实文件/构建/测试结果；旧失败证据保持历史。完整产品、Windows 和付费模型质量不属于本切片声明。

## 已验证证据

[范围报告](../../../docs/validation/delivery-human-continuation/README.zh.md)记录 Core 四文件 / 56 项、Host 两文件 / 九项、实际 SIGKILL/新 owner 与 HTTP 继续/批准证明，以及独立 656 项 canonical 字节/预算/需求包核验。确定性协议 fixture 证明真实构建/测试与零派发负例，不证明付费模型质量、任意生成文件完整集合或整个产品完成。

## 回退

关闭可信软件交付选项可保持 legacy 嵌入。不得删除 canonical 预算、审阅或未知副作用回执。无法验证模型/工作区恢复身份的旧交付 Run 保持不可继续。
