---
id: delivery-human-continuation
status: current
language: zh-CN
---

# 有限软件 Run：显式人工继续

[English](README.md)

本次已验证的 FLOW-097 切片允许显式现有 Session resume 命令继续同一个中断普通软件 Run，恢复原有限预算与不可变准入绑定，不再一律拒绝交付恢复。它不复活已完成/失败的 Run，不自动重放工具，也不制造 Goal 额度。最终用户验收与完整软件质量仍需分别确认。

## 当前边界

Canonical `run.created` 绑定可信规范工作区根路径的摘要、类型/能力与准入模型配置/凭据引用。Resume 在取得工作租约前核验同一注册范围、当前会话授权、Extension/Skill 快照、精确交付策略、已结算模型预留和 Action WAL。替代目录、路径别名、工作区扩权、策略/提供商/模型/Key 修订变化、预留丢失和未知副作用均在新提供商请求或文件变更前拒绝。没有可验证事实的旧交付 Run 保持不可继续。Goal 工作必须使用原 Goal 控制器，普通 Session resume 返回 `goal_resume_required`。

重建保留同一预算身份、Token/时间上限、累计消耗、包括离线时段的保守耗时、已知失败计数与审阅轮次。待批准补丁取得新 ID/期限，但保留精确 base/patch 哈希栅栏；显式批准前不写文件。没有待批准动作的恢复从新的模型观察边界继续。相同命令重试返回 canonical 回执，不重复派发。

旧验证回执不能证明更新后的源码。只有后续 canonical 已验证补丁的完整范围与 verified WAL 一致、当前源码 SHA 等于最新保留写入时，才能明确作废旧验证。仍必须执行新的成功验证与独立审阅。外部文件修改、检查点缺失、未知写入或未验证范围均拒绝且新增派发为零。两个多补丁 fixture 分别证明新验证成功，以及省略验证时 `delivery_verification_missing`。

## 完整审阅证据

只读审阅者收到有范围、不可变的 `outlive.delivery-requirements.v1` Artifact：完整脱敏初始任务/上下文、全部已消费公开指导、每条 canonical 验证回执引用，以及可信预算提供的已批准 Goal 目标/完成条件。需求包受 20 KiB 与明确契约数量约束，超限失败而不截断需求。审阅者必须通过有范围 `read_artifact` 真实回执读完每个字节，全部页面保留在其精确最终模型 Context Manifest：`kept`、正数 included tokens、没有截断/遮罩/外置。这证明公开证据确实可访问，不证明语义理解或付费模型质量。

仅命令产生的文件清单仍沿用既有较窄边界：审阅覆盖声明补丁路径与实际命令/测试清单范围，不覆盖任意生成文件的完整集合。这些 POSIX 确定性 fixture 不证明 Windows 进程组静止，也不证明真实付费提供商的软件质量。

## 已验证回执

[Core 聚焦日志](checks/core-focused.log)通过四文件 / 56 项：13 个真实进程继续场景、12 个预算/需求包/窗口安全用例、23 个交付审阅用例与八个共享预算用例。[新证明导出](checks/core-proof.log)在增加 Artifact 导出后复跑真实 owner 正例：实际 SIGKILL 且确认退出后，新 Runtime 继续同一 Run；排队的公开指导在第一条恢复模型请求前消费。真实审批、文件补丁、外部 Node 构建/测试、只读子 Agent 和精确重试在原 200,000 Token / 15 分钟额度内完成。受控提供商每请求报告 1,000 输入加五输出 Token：原首笔 1,005 保留；父/子五请求合计 5,025。这些数值是确定性提供商协议单位。

[Host 聚焦日志](checks/host-focused.log)通过两文件 / 九项。五项使用真实监听 HTTP 验证启动/继续/批准/重试、不可变已存连接恢复与模型/策略/Key 变更拒绝；四项保留既有恢复权限覆盖。[API 证明](api-proof/report.json)使用关闭前的持久私有 profile 副本与新 composition，不宣称实际 SIGKILL。真实路径返回 200，源码 SHA 等于构建 SHA，五个受控 15 Token 请求合计 75。[Core 定向构建](checks/core-build.log)、[Host 构建](checks/host-build.log)和 [Core 类型检查](checks/core-types.log)通过。

[独立验证器](verify-proof.mjs)只读 canonical 哈希链、已导出的真实命令/Context Artifact、完整需求包字节、子 Run 实际终态关联、聚合消耗与 HTTP 回执。[报告](verification.json)通过 656 项，不调用模型、命令或 Runtime。[Core 回执](core-proof/report.json)、[canonical 事实](core-proof/events.json)、[范围 Artifact 字节](core-proof/artifacts.json)、[交付文件字节](core-proof/delivered.json)和 [API canonical 事实](api-proof/events.json)保留可复验证据。通过的测试生命周期清理了测试 Runtime、真实子进程和 HTTP 服务；未使用默认 profile、真实凭据或付费提供商。

保留的 [fixture 诊断](checks/fixture-diagnostics.json)区分了测试专用错误 `steer` 类型与等待已退出子进程的清理问题。随后仅报告十 Token 的 fixture 在模型窗口遮掉短历史项；最终正例采用非零合理上下文消耗，并保留严格首请求指导 oracle。两类问题均没有通过延长期限掩盖。本切片回执不替代根任务最终全仓与安装客户端检查。
