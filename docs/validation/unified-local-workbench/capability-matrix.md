# 三端操作与设置矩阵

本轮任务：HOST-087、PAR-088、CLI-089、SET-090、DEV-091、RUN-092、UX-086 二次验收。三端调用同一 Host 控制器；每项能力由 Host 返回状态和原因。下表描述操作入口，最终验证结果和冻结归档摘要见 [验收报告](README.md)。方法存在、HTTP 成功或模型配置保存成功都不算业务完成。

2026-10-03 当前连接/会话工作台增量以源码与[本轮窄验证](../current-workbench-recovery/host-connection-verification.md)为准；下面同步当前具名接口，不改写上一次归档或 GUI 验收事实。final8 [Web attempt 024](../current-workbench-recovery/attempt024-final8-web/report.json)
及外部 CLI/context 已通过；
[安装后 Desktop attempt 025](../current-workbench-recovery/attempt025-final8-installed-desktop/report.json)
也通过真实 SIGKILL 恢复、stop/Repair、fresh Main 和完整业务流程，130 PNG、11 断言、
[独立 4429 检查](../current-workbench-recovery/attempt025-final8-installed-desktop/independent-verification.json)、清理完成。历史 final7 的
attempt 021 恢复超时原因未知，attempt 023 实际生命周期子步骤通过但 CDP cleanup
失败，不能把这些子步骤或上次归档视为当前全旅程通过。

当前 Composer 左侧为加号、权限、Plan，右侧为模型/已选非默认推理强度、发送或停止。新增项目文件上下文以版本引用传递；源级 [UI 单测](../current-workbench-recovery/checks/workbench-file-context-unit-final.log)及[专用 capability 负例](../current-workbench-recovery/checks/workbench-file-context-capability-unit-final.log)已记录。[最新源码 Web024](../current-workbench-recovery/attempt024-final8-web/report.json)已通过 130 张截图 / 9 条断言及[独立 4314 检查](../current-workbench-recovery/attempt024-final8-web/independent-verification.json)，包括版本冲突、Provider/Artifact/Manifest 与 CLI；final8 安装后 Desktop025 也通过相应旅程。此前 v5/v6/v7 记录继续只证明对应归档。

| 能力 | Web / Desktop | CLI | 权威与边界 |
| --- | --- | --- | --- |
| 本机 Host | getConnectionStatus、修复连接、显式停止；Desktop 原生启动 | `host start/status/restart/stop`、`doctor`、`capabilities` | 单一 profile/Runtime；supervisor 绑定 owner generation；显式停止持久化，普通重连不复活；连接错误与 backend unavailable 分开 |
| 共享设置 | 头像菜单或快捷键进入，十类分类和搜索 | `config get/set` | revision/CAS；字段展示来源、作用范围和生效时机 |
| 模型与凭据 | 模型分类：保存、替换、清除、独立测试 | `model get/configure/test/clear-key` | Key 只写；CLI 通过 stdin；测试无项目/对话内容；Run 绑定原模型与凭据 |
| 保存的模型连接 | `getModelConnections/saveModelConnection/removeModelConnection/testModelConnection`；设置与会话选择 | `models list/save/test/remove` | revision/CAS 与 command ID；保存/测试/实际 Run 分别验收；新 Run 冻结连接/型号/凭据 lease |
| Session 下一 Run 选项 | `getSessionRunOptions/updateSessionRunOptions`；左侧权限/Plan，右侧模型/强度 | `sessions options-get/options-set`；chat/run start 的 connection/model/preset/mode/effort | Session revision/CAS，Host 校验并冻结于 admission；更改不热切换活动 Run |
| 本地 Full 授权资格 | `getPermissionGrant/setPermissionGrant`；明确确认 | `config permission grant-status/grant/revoke --confirm-full-access` | 本地默认/用户授权来源才可提升；管理员 ceiling 只读；活跃工作保留 pending，空闲安全重启后生效 |
| 权限与工作区 | 权限分类、项目选择与审批 | `config permission get/set`、`projects` | ceiling 和项目规则由 Host 执行；实际沙箱状态可见 |
| 会话与任务 | 新对话/任务、切换、继续、归档/恢复、后台列表 | `chat start`、`run start/get/input/cancel`、`sessions`、`resources` | 每会话串行；独立工作区并行；同工作区写操作 FIFO |
| 实时公开进度 | 一句公开说明和一条实际活动；内联展开和命令输出 | `run events/activity/model --jsonl` | 三种独立游标；私有推理过滤；停止订阅不取消任务 |
| 审批、Todo、Artifact | 待审批/计划控件、Todo、结果/制品入口 | `approval`、`run approve-plan`、`todo`、`artifact get` | 精确 locator 和 command ID；结果来自对应事实/回执 |
| 附件 | 加号选择/粘贴/拖入 PNG、JPEG、PDF；图片内联显式选择 | `attachments upload/content` | scope 与 hash；图片模型需显式声明，文本测试不证明图片能力；当前 30 MiB/份、8 份 |
| 项目文件上下文 | 项目 Composer 加号真实目录选择、路径/SHA chip 与移除；需 `files.context` + `files.read` + `files.list` | `run start --context <project-relative-file>` 可重复；CLI 先读取 SHA 再提交 `file_contexts` | 五份 UTF-8、64 KiB/份、128 KiB 总量；Host 用同轮策略重读并检查版本，私有可信快照进 Core；脱敏 `project_file_context` Artifact + `artifact.stored` + 不可信 Manifest；原文件 SHA 与制品 SHA 分开，恢复不重读，普通 chat 不接受 |
| 项目文件目录/编辑 | `listProjectFiles/readProjectFile/saveProjectFile/reconcileProjectFileSave`；三端固定 typed API | `files list/read/save/reconcile` | 相对路径/有界文本、symlink/containment、expected SHA/CAS、policy 与共享写 lease；approval/unknown 必须显式处理 |
| 本地回答反馈 | `getAnswerFeedback/setAnswerFeedback`；真实 answer Event 的 like/dislike/clear | `feedback get/set` | Run/answer 关系与 command ID；本地 Ledger 事实，不发给 provider |
| 回放与回滚 | 历史回放只读；审阅中显式回滚 | `replay`、`rollback` | 回滚仍受 Host policy、工作区、WAL 与当前文件校验；恢复不自动执行 |
| Memory / Experience | 记忆页面与设置中的 Recall/项目范围 | `memory`、`experience` | 默认 Recall 关闭；审核、来源、同意和版本规则仍有效 |
| Team / 子 Agent | 团队、子任务和真实运行轨迹 | `team`、Run/Session 查询 | 使用已有规范控制器，不建立另一套任务事实 |
| Skills / 扩展 | 来源、版本、冲突、诊断、启停/校验/可信重载 | `skills`、`extensions`、`config set` | 启停按声明的重启时机生效；重载不能绕过禁用 |
| MCP / LSP | typed 配置、实际状态、错误与重启 | `mcp`、`lsp`、`config set` | Host 校验配置和 credential reference；缺依赖显示真实错误 |
| 用量、遥测、诊断 | 项目/会话/时间筛选、脱敏导出 | `usage`、`telemetry`、`doctor` | 规范 Ledger 和 provider reported cost；无价格记录显示未知 |
| Git / worktree | 状态、三类差异、暂存、提交、分支、创建/选择/移除 | `git` 命令族 | 固定 argv、项目范围和共享工作区租约；丢弃先显示范围；活跃 worktree 拒绝移除 |
| 交互终端 | xterm 与真实 Host PTY；重连历史、显式关闭 | `terminal list/create/attach/input/resize/close` | 进程与工作区由 Host 管理；退出必须先确认所属进程停止 |
| 本地预览 | Web 受控 iframe；Desktop 隔离原生视图 | `preview list/start/register/stop` | 只注册的回环地址；视图关闭不结束服务；外部注册服务只能断开 |
| 定时任务 | 创建、修改、暂停、删除、立即运行、历史 | `schedule` 命令族 | 持久触发去重；时区保存；错过/重叠跳过；审批暂停 |
| 旧数据迁移 | Desktop 关于：原生选目录、元数据预览、来源选择、提交、回执 | `host migration preview/commit/result` | 原目录与备份保留；旧写入者/活跃资源先关闭；未知结果先查回执 |

设置的持久值保存在共享 profile。常规/外观按即时边界应用；默认模型推理强度和开发工作台设置影响新 Run 或新资源；Memory、工具和遥测配置显示重启要求，并在下一次 Host 装配真实生效。环境与 policy 只读值不能从客户端越过上限覆盖。进行中的任务保留原配置。

连接恢复丢弃旧 generation 的迟到读取，持久 ledger sequence 保留、瞬时活动游标重建。SDK live GET/HEAD 可刷新一次认证，所有 mutation 不自动重发；`host_write_outcome_unknown` 必须核对原 command receipt。Replay owner 变化仍保持原只读 authority，`host_replay_stale` 要求显式退出，不能偷偷换成 live token。Desktop `copyText` 仅是有界、显式、write-only 的原生复制动作，不开放剪贴板读取。

真实平台验收为 macOS arm64；Linux/Windows 的受限原生执行仍按既有规则 fail closed。本矩阵不声称已完成 Windows GUI、签名安装包、云同步、多人协作或真实非维护者发布验收。
