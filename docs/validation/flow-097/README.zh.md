# FLOW-097 内核切片：Plan 意图与既有项目命令

这份回执只覆盖 2026-10-05 实现的内核切片。FLOW-097 仍是部分完成：端到端软件开发、完整 Goal 流程、原生验证和最终用户验收属于后续义务；已实现的共享总预算与人类续接切片见 [GOAL-099 回执](../goal-099/README.zh.md)。这里的进程证明使用受控临时项目和确定性模型适配器，不声明付费模型质量已验收。

普通 Plan 回答现在以真实 `run.completed` 事件完成。`Decision.finish_intent=submit_plan` 才要求真实 Todo 并产生 `plan.ready`，保留精确版本批准边界。兼容缺省意图为回答；即便旧回答带未完成 Todo，也不会执行或标记完成它们。排队输入和取消仍优先。执行模式提交计划会失败，Plan 中的写入和命令 Tool 仍被拒绝。

`discover_project_commands` 读取既有 `package.json` scripts 或严格的 `outlive.commands.json`。发现分页、manifest 上限 64 KiB、不执行，只返回命令名和精确 hash。`run_project_command` 只接受相对来源路径、命令名、预期 hash 和 100..120000 ms 超时。manifest 变化、symlink/hardlink、cwd 越界、运行时缺失或命令不存在均拒绝。模型不能提供 shell/env/argv。声明中的 executable 为封闭名单；Node 使用实际 Runtime 可执行文件，其他运行时必须已存在于项目外的 Host PATH。

实际 stdout/stderr 和退出结果形成有界脱敏 JSON Artifact，并由真实 Receipt 和 Observation 关联。非零退出、超时、取消和输出限制均失败；派发后的 runner 异常保留 unknown，并停止后续模型和命令尝试。后续[有限交付审阅切片](../delivery-review/README.zh.md)允许可信、受总预算约束的软件根 Run 在已确认 POSIX 进程组静止的非零验证失败后观察和修复，但不自动重试命令。其他失败、子 Run 和兼容嵌入仍停止。既有 sandbox 不放宽。执行器之前先写含 `operation_id` 的 `tool.started`；它本身不证明子进程启动。任意命令副作用没有自动回滚：私有 Patch WAL 仍专用于 before/after image。只读回放不执行命令。

受控外部 oracle 覆盖 Node 写入字节、真实 npm pre/post hooks、非零退出的部分效果、超时/取消输出、输出上界、manifest 缺失/变化、范围、sandbox 不可用、真实 Run/Artifact 范围和 unknown 不重试。见[Core 原始检查](focused-core.log)和[contracts/Tool 检查](focused-contracts-tool.log)。所属测试为 `project-commands.test.ts`、`runtime.project-commands.test.ts`、`runtime.plan-mode.test.ts`、`run-state-machine.test.ts`、`runtime.steering.test.ts`、`runtime.extension.test.ts` 和 `runtime-feature-drivers.test.ts`。

显式项目配置示例：

```json
{"version":1,"commands":{"build":{"executable":"node","args":["scripts/build.mjs"],"cwd":"."}}}
```

声明是不可信项目内容，不是权限批准。命令退出成功只证明该命令结果，不证明用户需求全部完成。Package manager 是否可用、受限操作系统 sandbox 是否支持仍是平台前提；本地证明不覆盖干净 Windows 安装，也不证明 Windows 无限制进程模式的后代隔离。
