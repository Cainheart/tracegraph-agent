# Artifact 游标恢复与聊天工作台修复（2026-10-06）

## 修复内容

失败的项目问答中，`read_artifact` 的一页回执给出 `next_offset=7997`，模型随后同批提出 `7998`、`11998`、`15998`。`7998` 落在 UTF-8 多字节字符内部，分页抛出 `artifact_read_failed`，导致整轮终止。

Core 现在按 Ledger 中该 Run、该 Artifact 的成功回执顺序串行读取，并以真实 `next_offset` 作为下一页游标。与权威游标相差不超过 UTF-8 字符最大字节差的请求会从权威游标继续；更远的跳跃会返回带正确游标的可恢复诊断，不跳过内容、不重放写操作。读取状态恢复只依赖当前 Run 的回执。

聊天活动现在显示真实工具操作、状态和目标路径，执行中显示真实经过时间，终态显示回执结果。可打开的项目路径进入现有 Project Files 面板；Artifact ID 不伪装成路径。用户消息与回答的复制/反馈等操作位于气泡外。安装界面还修复了回答正文被 flex 压成窄列的问题：正文占满独立行，操作栏换到正文下方。字体栈和全局类型 token 统一使用适配 macOS、Windows 与中文的系统字体，代码继续使用等宽字体。

## 验证证据

- Core 回归：[`artifact-cursor-test.log`](checks/artifact-cursor-test.log)，5 项通过，覆盖顺序分页、UTF-8 游标偏差、远距离游标恢复以及同一 Run 的后续读取。
- Workbench 回归：[`workbench-unit.log`](checks/workbench-unit.log)，47 个测试文件、379 项通过。
- 全工作区构建：[`workspace-build.log`](checks/workspace-build.log)，退出码 0；产物包含 Web、Desktop renderer、Main 与 Preload 编译。构建仍报告一个大型 chunk 警告。
- 真实默认 Profile / DeepSeek 项目只读 Run：`run:40d301d3-6beb-4abd-a60b-8969d464ef6d`，Ledger 以 `run.completed` 结束。Run 中 `read_artifact` 连续读取 17 页，游标从 0 到 65,536；没有命令或文件写入。安装版界面显示为正常段落，操作栏在回答正文之外。
- 早先一次验证误在自由对话中发出项目文件读取请求：`run:b6858c51-1740-4337-90da-c04010143149` 没有关联项目，Host 因子代理预算限制以 `subagent_budget_ceiling_exceeded` 结束。该请求是验证上下文选错，不计作项目问答正向验收；它和 Ledger 原有分页失败记录均保留在默认 Profile 中。

定向 Core 与 Workbench 回归和真实模型 Run 已通过。本记录不声称已完成完整的三尺寸、明暗主题、所有页面或 Windows 原生验收矩阵。

## macOS 安装与发行边界

实际安装路径为 `/Users/cain/Applications/Outlive Agent.app`，版本 `0.1.0-alpha.0`，Product Build ID `d0f461a4e8c59d5466cfd4d6ed43c7d1f5b8d58e12809f8dd754fa7ba79530df`。当前 Host（PID `87584`）由该包自带的 Node 启动，使用原默认 Profile `/Users/cain/.outlive/profiles/default`；Profile ID `54b5faa9-13ca-4a7b-adf7-31b42e1cbf4b`、凭据、会话及历史记录保留。应用窗口仍保持打开。

新版 DMG 的 SHA256 为 `6df6ebb48486f87f21baef2558d7631ab284ed31531500dd4ac6459e1d611511`，ZIP 为 `4db2fbc7ac59dd2b73ef8787ed1b931b65786f39ede6e99e802810287a10ab5f`；清单位于 [`SHA256SUMS`](../../../_tmp_release/chat-cursor-recovery-2026-10-06-r2/artifacts/SHA256SUMS)。该包是本机可运行构建，未使用 Developer ID 签名或公证；`spctl --assess` 不接受它，因此不标记为正式 macOS 发行验收。Windows 原生安装/操作和独立用户验收仍待完成。

在确认旧包无活动进程后，移除了被 r2 替代的两份旧应用副本、旧构建目录以及 r2 已安装后的临时 staging tree。保留新版 r2 的 DMG/ZIP、校验清单、包清单、默认 Profile、Profile 备份以及先前验收报告。[清理回执](checks/cleanup.txt)记录了精确路径与字节数；文档目录检查在刷新生成目录后通过，记录见 [`docs-check.log`](checks/docs-check.log)。
