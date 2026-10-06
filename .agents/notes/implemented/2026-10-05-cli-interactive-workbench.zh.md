---
id: 2026-10-05-cli-interactive-workbench
title: 共享本机工作台的交互 CLI
status: implemented
owners: [cli, host]
created: 2026-10-05
last_reviewed: 2026-10-05
language: zh-CN
affects: [CLI-089, FLOW-097, HELP-106]
supersedes: []
---

# 共享本机工作台的交互 CLI

[English](2026-10-05-cli-interactive-workbench.md)

## 当前状态与已接受目标

共享 CLI 现已在认证的命名操作及 JSON 回执之外提供交互对话与斜杠指令。薄终端展示层复用现有命令解析、SDK 公开活动流与 Host 控制器；不新建业务循环、事件账本、权限解析器或 Shell 求值器。

显式 `outlive chat interactive` 和 `outlive chat` 进入交互入口。命名 `chat start` 与原默认 `serve` 保持兼容。普通消息创建或继续选定的共享会话；Run 执行期间输入进入已有的持久用户消息队列。`/guide` 明确向该 Run 发送消息，不能批准操作。`/new` 只切换查看的对话。项目/会话切换先校验服务端身份。已有会话时，模型、模式和推理强度变更通过共享会话选项控制器及 CAS 保存，影响后续准入；打开历史继承其已保存选项。更换后台可能重置临时序号，界面按规范来源事件 ID 去重，保留新事实。

斜杠指令采用字面 argv、引号及反斜杠解析；`$()`、反引号和分号都是数据，不经 Shell 执行。`//` 用于发送以 `/` 开头的普通任务。消费终端 stdin 或接管原始终端输入的操作需单独使用已有非交互 CLI。审批仍要求精确版本和 action ID。只显示受校验公开活动及规范终态回答，不把模型草稿当成交付成功。

EOF、`/quit` 与 Ctrl+C 关闭订阅及客户端连接，不取消 Run 或停止 Host。`/stop` 显式调用规范取消操作。JSONL 是展示格式，不是持久事件模型；活动保留原事件和序号。

## 验收与边界

十二项窄测试验证任务字面值、只选择不恢复的范围切换、当前/后续选项、显式消息指导、精确审批转发、私有内容过滤、后台序号重置及退出不取消。真实进程旅程使用自建临时 Profile 读取六条受校验活动与规范完成的 Plan 回答，以退出码 0 结束；同一 Host PID/nonce 仍在运行。终端展示不证明模型质量或 Windows 原生行为。

## 已验证来源

- [交互入口](../../../apps/cli/src/interactive-chat.ts)、[窄测试](../../../apps/cli/src/interactive-chat.test.ts)与 [CLI 模块](../../../docs/modules/11-CLI-与装配.md)。
- [实际进程证据](../../../docs/validation/product-workbench-2026-10-05/checks/cli-interactive-process-proof.json)与[使用手册](../../../docs/user-guide/README.zh.md#topic-cli)。
