# GOAL-099：已验证的控制器与累计请求预算切片

此记录覆盖 2026-10-05 实施的 Core/Host 控制器切片。完整客户端流程、自主推进和最终用户验收尚未闭环，GOAL-099 与 FLOW-097 仍为部分完成。这里使用隔离本地 HTTP 供应商和临时项目，证明真实传输、进程及持久化行为，不证明付费供应商质量或计费准确度。

## Current behavior

Goal 必须包含目标、互不重复且用户可见的完成条件，以及至少一项有限 token 或时间上限。创建或批准提案不派发 Run；批准绑定精确提案版本，启动和继续需分别显式提交命令。真实 Run 成功只进入 `awaiting_final_acceptance`，用户显式接受全部当前条件后才将 Goal 标为 `completed`。

Goal 快照、命令事实、Run 引用与预算检查点均使用既有 SessionEvent Ledger。相同命令 ID 幂等，复用 ID 表达不同意图会冲突。只读命令核对只检查精确 Goal 的命令，不同步、恢复或执行。创建核对只命中 `goal.create`；只有已完成、严格验证且作用域正确的快照才返回 Goal 定位。失败、缺失和未知创建均不声称已取得定位，不重放操作。

首次接受 Run 后，将实际 `session_id` 绑定为 `execution_session_id`，即使提案没有指定会话。后续批准执行和人为继续复用该 Session。续接只读取此 Goal 已引用的 Run timeline，验证项目、Run 和 Session 身份，只选择 canonical 公开任务和已完成结果；其它终态仍明确为未成功。历史限定最近 40 个 Run、80 条消息、每条 8,000 字符、总计 64,000 字符；不复制原始 Tool 正文、Artifact、供应商私有推理或临时答案快照。接受 Run 后绑定回执丢失时保持未知，禁止新执行。

整个 Goal Run 树继承同一个可信 `ModelRequestBudget`。每次真实 initial、repair、summary HTTP 请求以及传输重试前，模型适配器先持久预留，再计算保守序列化文本输入额度并约束供应商实际输出字段，保护并发预留。已验证用量结算额度；缺失、非法或未知用量消耗全部预留，并阻止后续派发。只有可信传输证明尚未发出的请求，才能释放其派发前预留。真实期限中止活跃工作并拒绝新请求；没有该接缝的适配器和未校准图像输入预算在请求前拒绝。

暂停会中止并收敛真实 Run。人为继续保留已消耗 token、时间和保守未知费用；承认未知用量是显式操作。恢复保留所有未结算预留，要求人为续接，不重建未知启动或写入。Goal Run 禁用可选后台模型衍生；不能通过修改提案清除未知外部进程效果，也不能静默重试。

## Reproducible evidence

| 证据 | 真实验收判据 |
| --- | --- |
| [最终 Core 检查](focused-core-final.log)：9 文件、108 测试 | 预算拒绝前 HTTP 为零；真实 OpenAI/Anthropic 输出字段；独立修复与摘要预留；父子三次 HTTP 共用额度；真实期限、检查点持久失败、Plan 与项目进程边界 |
| [最终 Host 续接检查](focused-host-continuation-final.log)：1 文件、16 测试 | 精确批准与最终接受；核对不派发不写入；未知创建；第二次真实请求复用 canonical Session 和公开历史；无私有推理；外会话历史拒绝；绑定回执丢失保持未知；真实暂停继续、未知磁盘效果与重启预留保留 |
| [最终契约检查](focused-contracts-continuation-final.log)：2 文件、8 测试 | 有限额度、显式条件与版本、拒绝客户端 Runtime 权威、无法虚构创建定位、Plan finish intent |
| [Core 类型检查](core-typecheck-final.log)、[Host 类型检查](host-typecheck-final.log) | 当前源码类型通过，不以声明完成代替运行验证 |

[修复前暂停负例](pause-unknown-before-fix.log)证明：实际文件写入后，在暂停时丢失回执，旧 Goal 错误地保持可继续。最终测试核对收敛后的 canonical Run，把未知效果标为 blocked，不派发重试。此前日志作为中间记录保留。上表计数属于明确命名的最终检查，不累加重复执行的测试。[FLOW-097 记录](../flow-097/README.zh.md)包含真实作用域 Node/npm 效果、取消、超时、Sandbox 与未知不重试。全部检查未使用默认 profile、真实凭据或付费端点。

可在仓库中复现：

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/goal.test.ts src/finish-intent.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/goal-controller.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/core exec vitest run src/domains/runtime/shared-run-budget.test.ts src/domains/model/model-budget.test.ts src/domains/runtime/runtime.shared-budget.test.ts src/domains/runtime/runtime.plan-mode.test.ts src/domains/runtime/run-state-machine.test.ts src/domains/runtime/runtime.subagent.test.ts src/domains/runtime/runtime.steering.test.ts src/domains/runtime/runtime.project-commands.test.ts src/domains/tools/project-commands.test.ts --maxWorkers=1
```

## Limits

该切片一次执行一个已批准 Run，支持显式人为续接；尚未证明独立自主循环、自动完成条件判断或已安装 Native GUI 验收。历史是有界公开结果视图，不复制全部私有执行状态；重启不授予自动继续权。

token 上限约束文本模型请求预留与报告用量；任意兼容供应商仍可能报告超额，系统如实记录并阻止后续请求。本地中止不能证明远端供应商停止计费。金额、外部 Tool 服务费用和未校准图像输入费用均不作为已执行上限。预算 Goal 可调用本地图形工具，外部图像生成不进入其工具权限。时间记录活跃执行租约和保守中断期间，不计等待批准或人为暂停的时间。
