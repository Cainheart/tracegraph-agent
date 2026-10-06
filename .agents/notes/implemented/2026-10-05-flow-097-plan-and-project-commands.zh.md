---
id: 2026-10-05-flow-097-plan-and-project-commands
status: implemented
date: 2026-10-05
language: zh-CN
canonical: 2026-10-05-flow-097-plan-and-project-commands.md
---

# FLOW-097：显式 Plan 完成语义与有界项目命令

## Context

这是[已接受的产品工作台计划](../proposed/2026-10-05-complete-product-workbench.zh.md)中的一个窄实现切片，不代表 FLOW-097 完成。此切片前，所有 Plan finish 都要求 Todo，普通知识回答也不例外。现有可执行内置工具只通过 `run_test({suite:"fixture"})` 运行 `test/run.mjs`。

## Decision

为模型 Decision 增加类型化 `finish_intent`：兼容缺省值为 `answer`；`submit_plan` 显式请求 Plan 批准边界。回答可以终结 Plan Run，但不会执行操作。显式执行计划仍需真实 Todo，并记录 `plan.ready`；批准仍绑定这个精确事件。旧模型带 Todo 的 finish 不会获得执行授权。排队输入和取消继续优先于过期 finish。

从有界公开 manifest 发现既有项目命令，通过类型化 Tool、既有工作区能力、权限策略、SandboxRunner 和规范的派发前 Event 执行所选且绑定 manifest 的条目。模型不能传 shell 字符串、环境变量、绝对可执行路径、提权参数或未登记命令。既有 package scripts 和显式声明的 argv 命令仍是不可信项目内容；发现不会授予权限或安装依赖。manifest 变化后必须重新发现。进程输出、退出、取消、超时和 sandbox 不可用均为真实事实；未知外部结果不能自动重试。

## Scope and compatibility

保留 fixture `run_test` 和既有 patch/Plan 策略。增加公开项目命令工具，不把产品执行放进 scripts 或 apps。保留配置的操作系统隔离；受限 sandbox 模式下，无法证明隔离的平台应拒绝执行。退出成功只表示命令结果，不证明用户的软件任务已完成。更广泛 FLOW 功能、原生电脑操作、UI 设计及最终用户验收属于其他切片。

## Validation

验收无 Todo 和带旧 Todo 的 Plan 直接回答、无 Todo 的显式提交计划、精确批准版本、Plan 内写入与命令拒绝、排队输入、取消和终态一致性。项目命令测试必须使用真实临时项目 manifest 与外部文件效果，并覆盖 manifest 变化、范围及 symlink 拒绝、非零退出、超时、取消、输出限制，以及真实 Run Receipt/Observation/派发前 Event 证据。集中 Core 验证为 9 文件 / 119 测试；合约为 4 文件 / 28 测试。新增私有目录拒绝与目录分页后，供应商兼容及项目命令验证为 3 文件 / 64 测试。见[可复现证据](../../../docs/validation/flow-097/README.zh.md)。私有 Patch WAL 仍只用于 patch，任意命令副作用没有自动回滚。整个 FLOW 任务仍为 partial。
