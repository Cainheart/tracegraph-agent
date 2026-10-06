# FLOW/TEAM 有限预算交付审阅：已验证后端切片

[English](README.md)

这是受控的软件交付协议回执，不表示 FLOW-097、GOAL-099 或 TEAM-100 全部完成。模型为本机确定性 HTTP 提供商。真实 Node 进程修改、构建并测试临时 clamp 库；独立只读子 Run 实际读取源码，发现缺少反向边界处理并要求修复。不使用付费模型、默认 profile，也不提交、合并或推送 Git。

## 当前行为

本目录证明的是有限预算策略下的软件交付恢复切片；其中 200,000 Token / 15 分钟预算只由测试夹具显式配置，用于覆盖历史 Run 的安全恢复，不代表当前生产 Host 默认值。当前普通 Run 不设置累计 Token、总时长或固定轮数上限；Goal 仍使用用户明确设置的预算。有限预算的预留、超限前拒绝派发与恢复行为仍由这些历史/兼容性测试覆盖。

内部回合阈值在可信总额度内转为 `delivery.turn_checkpoint`，不重置无进展闸门、凭据、权限或消耗。应用补丁后必须有新成功 `run_test` 或 `run_project_command` 回执才能审阅。连续两次 finish 未补齐验证会停止；Runtime 不自行选择或运行新命令。

只有已确认 POSIX 进程组静止的非零退出验证回执，才能进入正常观察/修复阶段。超时、取消、截断、未知写入、策略拒绝和模型失败不能续接。第三次已知验证失败停止 Run。没有新 canonical 读取或 verified 补丁时重复同一范围命令，在派发前拒绝。新真实成功回执逐条核对该命令此前已知失败；新补丁或文字 finish 不能掩盖未决失败。Windows、子 Run 和旧嵌入保留原失败行为。

审阅是独立子 Run/Session，使用独立冻结模型 lease、Plan mode、只读策略和与父上限相交的只读工具。结构化 `review_result` 仅从实际子终态及父回执精确 terminal-id/hash 接受。声明路径必须有真实成功 canonical `read_file` 回执。审阅前后受限、策略核验的源码 hash 防止期间变化。阻断问题进入 canonical Observation，交给现有 AgentLoop；失败、证据不足、伪造或取消的审阅不能宣称成功交付。Plan 普通知识回答直接完成；执行计划仅在精确 Todo 版本批准后准入有限策略。交付准入持久记录禁止隐藏后台抽取，Plan 批准后的重启恢复也遵守该事实。

## 实际证据

[当前证明](controlled-known-failure-proof/proof.json)、[canonical 事件](controlled-known-failure-proof/canonical-events.json)、[实际交付文件](controlled-known-failure-proof/delivered/src/clamp.mjs)和[独立读取器结果](controlled-known-failure-proof/verification.json)记录：15 次真实本机 HTTP 请求，一个父任务与两个只读审阅任务，实际命令按 **通过 → 失败 → 通过** 返回，审阅先阻断再通过，并在原额度内产生第 3、6、9 回合检查点。独立外部断言也实际证明修复前构建产物失败。最终测试在重建模块上验证反向边界要求。

[只读核验器](verify-proof.mjs)核对 692 项事实，包括事件 hash 链、精确子终态回执、范围绑定命令 Artifact 字节、实际非零 stderr、修复源码 hash 和全部 15 次预留/结算。核验器不执行进程或模型。重现命令：`node docs/validation/delivery-review/verify-proof.mjs`。

本轮源码实际检查：

- [Core 最终聚焦检查](checks/core-final-focused.log)：6 文件 / 70 项；[Team 兼容检查](checks/core-team-final.log)：2 文件 / 18 项。其中包括 23 项交付用例、受限读取增长、旧 Plan 行为、共享预算、未知磁盘效果、取消、伪造审阅、缺少验证和无进展续接。
- [Goal 检查](checks/goal-final-focused.log)：17 项，包括真实不支持预算的 Core 适配器零派发、明确失败回执，而不是 `launch_unknown`。
- [生产 Host 准入](checks/host-production-admission-final2.log)：typed Host 不支持准入与 production-composed Runtime 实际绑定适配器拒绝，均保留源码并释放所属准入资源。
- [fixture/恢复检查](checks/fixture-and-recovery-final.log)：3 文件 / 30 项；旧文件上下文 Plan fixture 现显式提交计划，取消就绪信号放在实际 stdout flush 后。
- [契约](checks/contracts-focused.log)：2 文件 / 6 项。[Core 类型](checks/core-types.log)、[Host 类型](checks/host-types.log)和[边界](checks/boundaries.log)均退出零。

此前 [61 项回执](checks/core-focused.log)与 [13 请求证明](controlled-proof/proof.json)发生在已知失败续接之前，作为历史证据保留。根任务首次并行全库运行保留七项失败，包括五项 5 秒超时、旧 Plan fixture 与 stdout 就绪竞态。上述聚焦串行检查已通过，根任务负责更广检查。本轮没有放宽 timeout 获得通过。初始本地 harness 错误（20 ms 非法 timeout、错误 Plan 状态、错误 Host fixture ID/绑定假设）已更正；保留的 Host 失败日志不是成功回执。

## 范围与限制

本轮证明受控 Runtime 行为和外部字节，不证明真实开发/审阅模型质量或测试覆盖。审阅必读范围包括 verified 补丁路径与成功命令 manifest（旧测试工具另含 `test/run.mjs`）。脚本生成的任意文件**尚无完整变更清单**，命令型审阅不能表述为审阅了全部生成文件。必读文件限单文件 64 KiB、32 文件，拒绝敏感路径/硬链接，准入读取必须为 `allow`；不支持的证据会停止交付。hash 核验降低外部变更竞态，但不是防同用户攻击者的原子文件系统快照。

本历史证明使用的审阅 packet 含初始公开 task 前 4,000 字符和最近十条已完成验证命令 ID，有界 provenance 未覆盖所有后续 steering 或 Goal 条件。后续[人工继续切片](../delivery-human-continuation/README.zh.md)已替换为完整有界公开需求，并加入真实全页面/最终窗口核验；本旧证明与数值保持原样。独立 peer 已检查最终权限/已知失败闸门，并在内存移除可选报告写入后运行同一核验器：692 项通过，零派发与文件写入。

普通交付恢复需要新的明确批准 Run，保留消耗/未知事实，不制造新额度。未知命令效果保留实际字节，不自动重试或回滚。本报告不宣称原生 UI、Windows 进程组静止、付费质量、非阻塞 Team 调度、完整用户审阅控制或最终用户验收。成功软件 Run 仍须由用户完成 Goal 最终验收。
