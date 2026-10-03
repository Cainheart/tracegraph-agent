# 共享 Host 设计与窄验证记录

记录日期：2026-10-03。本文对应源码冻结至 14:10 的 HOST-087 装配、权限恢复、迁移和 PTY 修复。本文只报告源码事实与已执行的工程验证；本轮最终 GUI、安装归档及外部独立验收状态由主验证报告单独记录。

## 1. 一个 profile、一个写入所有者

[`local-profile.ts`](../../../packages/host/src/local-profile.ts) 以稳定 profile ID 绑定 canonical data/session 根；默认是 `~/.tracegraph/profiles/default`，隔离测试使用临时目录。显式 `profileRoot` / CLI `--profile-root` 优先于 `OUTLIVE_PROFILE_ROOT`。每个 profile 的配置、注册表、事件、Session、WAL、Memory、附件与资源状态由同一个 Runtime 使用。

[`owner-lease.ts`](../../../packages/host/src/owner-lease.ts) 在创建 Runtime 前取得 profile 和 canonical data/session 根的跨进程写租约。另一个 profile 也不能通过选择同一个数据根绕过互斥。租约、私有 discovery、PID、boot nonce 和路径身份共同约束连接与释放；客户端不直接打开 JSONL。

[`local-host.ts`](../../../packages/host/src/local-host.ts) 的 `ensureLocalHost()` 发现已运行 owner，或启动长期独立 Node worker；`connectLocalHost()` 只连接。Main 与 CLI 使用认证私有 UDS/Windows pipe HTTP adapter，Web loopback gateway 进入相同 Fastify routes、Controller 和 Runtime。私有 socket token 每个请求验证，之后仍经过 bearer、Origin、replay 和 command ID 校验；原生项目路径、迁移、stop 路由拒绝 TCP 调用。公开 SDK DTO 不包含 discovery token。

`ConnectedLocalHost.close()` 仅 detach。关闭窗口或 CLI 结束不停止后台 Run。显式 Host stop 拒绝 queued admission，停止资源与 Run/held provider，关闭私有及 TCP SSE，最后释放根写租约。启动失败按已初始化资源逆序清理 MCP/LSP/Runtime 和租约。不默认安装开机启动。

真实运行 oracle 位于 [`local-host.test.ts`](../../../packages/host/src/local-host.test.ts)：同 UDS/TCP 的注册与模型配置、并发 ensure 单 owner、共 data-root 的第二 writer 拒绝、同工作区 queued→started、独立工作区并行、detach 后 Run 继续、TCP 原生调用拒绝、busy 迁移和 owner stop 关闭三条 SSE/held provider。本文不把其中未在本次窄命令内执行的所有 case 重新标为最新全量通过。

## 2. 共享配置与 Run 绑定

[`host-composition.ts`](../../../packages/host/src/composition/host-composition.ts) 是当前公共装配根。它读取 profile 的配置，连接 platform CredentialStore、model、permission、MCP/LSP、extensions、skills、telemetry、Session 与 Runtime；CLI 原配置 helper 保留为公共 Host 导出的薄指针。

[`workbench-control.ts`](../../../packages/host/src/workbench-control.ts) 保存 version/revision 和字段 source/scope/effective 元数据。tools/telemetry/Memory 设置在 restart 生效；重启 composition 必须实际应用 disabled tools、MCP/LSP 与 scoped Recall，再清除 `pending_restart`。Memory/Experience Recall 默认关闭，启用还需明确 project IDs，不能从恢复状态推导新授权。

[`LeasedModelAdapter`](../../../packages/host/src/composition/leased-model.ts) 为每个 Run 捕获模型配置和 credential 引用；轮换或清除 Key 不改变进行中 Run 的后续轮次。旧引用在相关 Run/请求 lease 释放后退休。clear-key 移除 active credential/configuration，但保留非秘密 provider/protocol/base_url/model draft；重启后可以重新添加 Key。读取配置与测试结果不返回 Key。

共享 owner 仅继承白名单 OS/PATH 环境，并保留三个可信启动策略键：`TRACEGRAPH_PERMISSION_PRESET`、`TRACEGRAPH_ROLLBACK_ENABLED`、`TRACEGRAPH_ROLLBACK_ALLOW_FORCE`。不转发 `NODE_OPTIONS`、provider secrets 或任意环境。模型凭据来自 profile。默认 rollback 关闭，`rollback.write` 投影为 `policy-denied`；开启后 linked workspace 仍受 force policy 与显式确认约束。

## 3. 恢复前重新评估权限

[`RunSessionController.beforeResume`](../../../packages/api/src/run-session-controller.ts) 在取得 workspace admission 后、调用持久 Session resume 前执行 Host 守卫。拒绝时释放 claim，不能产生 durable resume 或执行旧审批。

[`RecoveredRunPolicyGuard`](../../../packages/host/src/composition/resume-policy.ts) 使用当前 Host permission ceiling/选择预设、当前项目 ask/deny 规则，以及当前 trusted extension 工具与 policy rules，按 Runtime 相同规范重建 digest。恢复 projection 无 permission 或 digest 不同返回 `resume_policy_changed`，要求新 Run。该策略保守地拒绝任何差异，包括变宽，避免重用旧批准。

共享 Host 记录已恢复 Run ID；其后 Approval/Plan approval 再检查当前 policy。正常在本进程启动的活动 Run 保持原权限绑定，设置页切换预设只影响新 Run。旧 Core G-06 冻结 policy 的恢复兼容语义没有被全局更改。scope mismatch 也在执行前拒绝。

[`recovery-policy.test.ts`](../../../packages/host/src/composition/recovery-policy.test.ts) 使用真实 Runtime、持久 Session/ledger/recovery 与 isolated deterministic model。恢复 fixture 捕获关停前的 durable snapshot，不复制临时 owner lock；它验证恢复逻辑，不冒充完整 OS 崩溃旅程：

- 活动 Run 进入 patch approval 后切换 read-only，仍按原绑定提交 patch。
- 同样旧写 policy 的持久 snapshot 在更低 Host ceiling 下恢复被拒绝，projection 保持 interrupted，源文件未修改，workspace claim 释放。
- trusted extension-aware policy 不变可以恢复 pending approval；之后新增项目 deny，审批返回 409，文件未修改。

真实 Host kill/relaunch 与 GUI 重新绑定的证据应以独立旅程报告为准。

## 4. 显式迁移、原格式备份与结果核对

[`profile-migration.ts`](../../../packages/host/src/profile-migration.ts) 先扫描并预览 hash/bytes/conflicts，拒绝 live writer 和 symlink；多 source 时必须显式选择一个 active source。提交保留原 source，备份目标与各 source 原格式，其他 source/conflicts 隔离。导入的 linked registration 和 managed project 副本不自动授予新的 Workspace 执行权。

[`model-config.ts`](../../../packages/host/src/composition/model-config.ts) 规范读取旧 CLI camelCase 与 Desktop `base_url` / `credential_ref` 格式。shared Host 默认 platform CredentialStore，可解析既有同 service Keychain reference；隔离测试显式 PrivateFileCredentialStore。验证只确认引用可解析与元数据，不输出密钥。原 JSON 字节保留在 source 和备份，不能以仅 copy 文件声称配置可用。

认证 private migration routes 拒绝 active/queued Run、PTY、owned preview，要求用户先显式停止资源。允许后持久化 operation receipt，停 owner→提交→重启新 nonce；旧 client 不自动悄悄变成新 owner client，Main/CLI 明确 reconnect。`migration_failed` / `migration_outcome_unknown` 错误携带安全 `operation_id`，供查询 receipt；未知结果不能直接重提。错误不附绝对路径、配置或凭据。

对应测试：[`profile-migration.test.ts`](../../../packages/host/src/profile-migration.test.ts)、[`local-migration-error.test.ts`](../../../packages/host/src/local-migration-error.test.ts)、[`local-host.test.ts`](../../../packages/host/src/local-host.test.ts)。profile migration 测试覆盖单源/冲突隔离、source 保留、live writer/symlink、custom roots、Desktop 引用读取与原格式 backup；camelCase 已由原持久配置 parser 测试覆盖，不能据此宣称用户真实 Keychain 已被读取。

## 5. PTY job control 与 owner 死亡清理

[`dev-workbench.ts`](../../../packages/host/src/dev-workbench.ts) 为 PTY 取得 canonical workspace write claim。macOS Seatbelt 仅对固定 TTY 设备授予 file-ioctl，并允许 same-sandbox signal，支持 Ctrl-Z/jobs/fg/Ctrl-C；工作区外写入仍被拒绝。

[`terminal-processes.ts`](../../../packages/host/src/terminal-processes.ts) 用固定 `/bin/ps`、1 秒 timeout 和 2 MiB 上限检查 UID、TTY、PID/birth、parent 与 process group。观察到的后代和同 owned TTY jobs 可覆盖 shell job control 分出的 group；Host/guardian group 受保护，不接 renderer 提交的 PID。

[`terminal-guardian.ts`](../../../packages/host/src/terminal-guardian.ts) 是 Host 创建的独立 Node guardian，通过 owner 生命周期 stdin 管道得知退出，定时观察只有一个进行中的 bounded probe。关闭或 owner SIGKILL 后按观察到的身份 TERM/KILL，确认可运行 owned jobs 消失后才完成；[`terminal-owner.ts`](../../../packages/host/src/terminal-owner.ts) 将该完成结果连接到 Host 资源与 lease。cleanup unknown 时资源保持 interrupted，工作区仍保留，不将未知当作清理成功。

[`terminal-job-control.test.ts`](../../../packages/host/src/terminal-job-control.test.ts) 从真实 built artifact 导入，macOS 3 个 case 已通过：完整 job-control 和 workspace/outside write oracle；正常关闭后独立 background PID 消失再释放 claim；真实 Node owner SIGKILL 后 guardian EOF 清理 background PID；以及 PID/birth/TTY identity 拒绝负例。实现不承诺双重 fork/setsid 脱离终端的所有进程隔离，也不把 macOS 结果推广为 Linux/Windows 原生 Sandbox 验收。

## 6. 能力状态与规范通知

当前 read-only 预设令 Git 写操作、terminal.create 和 preview.start 投影为 `policy-denied`。其他 native 执行能力使用实际 `probeNativeSandbox` 的结果，5 秒内每 mode 单飞复用；缺失或失败的 backend 为 `unavailable`，不按 OS 名称推测成功。git.status/diff 也真实依赖 native backend；settings/resources read 与资源 close/stop 不因写权限受限被禁用。用户明确选择 danger-full-access 时按关闭 sandbox 的实际模式呈现，不能把 enforcement none 一概误判为 backend 失败。注册为 read-only 的具体项目仍由执行前 WorkspaceHandle 检查保护。

developer.editor、preview_open 和 review_scope 的 metadata 为 immediate；shell/worktree_directory 使用现有 new-run 枚举，并在 reason 中说明只影响新建资源，已有终端/worktree 保持配置。max_parallel_runs 影响新 Run admission。

resources 的活动 Run 列表不再承担结束通知。`notifications` 直接读取现有 last-256 inventory 对应的 public projection，从 completed、failed、interrupted、awaiting_approval、awaiting_plan_approval 的最新对应 canonical timeline event 派生安全字段，以真实 event_id 为稳定 notification ID，按 occurred_at 保留最新 128 项。不写第二份运行 Ledger，不复制 event data 或私有推理；移除注册的项目不重新取得读取 scope。

Host 按 general 的三类通知开关过滤。客户端重新打开仍可查询真实最近事件；消费者负责稳定 ID 去重与系统通知权限。resource Run ID 使用 projection 的 canonical run_id；inventory 文件名经过规范化，可作为查找 locator，不能替代业务 ID。

新通知 tests 使用实际 JsonlEventLedger 和 projectRun，验证五种状态、事件身份、重连、开关关闭的持久效果、移除项目排除、private payload 不复制、130 项按真实时间截 128，以及缺 receipt 不伪造通知。此阶段未 build；测试使用临时 Vitest resolver 将 contracts 指到新 schema 源码，保持正在运行的 GUI dist 不变。最终普通 build/artifact 测试仍须主任务复验。

新 profile 默认 gateway 端口被占用时，启动仍有 20 秒界限与 supported Node/loopback 指导。没有添加新的启动失败文件协议，也没有自动改用另一端口；Main 重新启动保留可信旧 Host 端口的修复由客户端测试单独证明。

## 7. 已执行命令与计数

以下命令在本次收尾已执行并返回成功。窄命令 stdout 只留在工具历史，未另存 raw stdout 文件；本表为结果记录，不能作为原始日志冒充。主任务的最终统一递归测试和 gates 日志将作为新版本的 durable 工程证据。构建由主任务统一执行；本文记录之后没有重复全量 build 或 clean。

| 命令（仓库根执行） | 已执行结果 |
|---|---|
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/api build` | exit 0 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host build` | exit 0；13:56 的 target build |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck` | exit 0 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/api exec vitest run src/run-session-controller.test.ts` | 7 passed；13:54 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/composition/recovery-policy.test.ts` | 3 passed；13:55 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/local-policy.test.ts` | 1 passed；13:57，private UDS 真实配置/capability |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/terminal-job-control.test.ts` | 3 passed；13:46。13:56 与 local-policy 联合运行时 PTY 仍 3 passed；联合命令因测试中的错误 SDK 方法名未整体通过，修正 local-policy 后单独 1 passed |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/local-migration-error.test.ts` | 2 passed；13:33 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/workbench-control.test.ts --config /tmp/outlive-notification-vitest.config.mjs -t 'projects stable recent notifications\|bounds notifications\|projects read-only\|uses the actual native probe\|describes developer settings'` | 5 passed / 13 skipped；14:10，临时 config 仅将 contracts alias 指向新源码，未 build GUI dist |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/api exec vitest run src/run-session-controller.test.ts src/run-interaction-controller.test.ts src/memory-experience-controller.test.ts` | 较早收尾 15 passed；在新增 beforeResume case 前，不能与当前 7 再相加 |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/cli test:e2e` | 较早收尾 4 passed；当前新增 CLI 能力由其专属命令/旅程另验 |
| `env -u NODE_OPTIONS pnpm verify:v2-docs` | exit 0；11 manifest docs、71 roadmap tasks |
| scoped `git diff --check` 和 6 个架构文档 local link/fence 检查 | exit 0 / passed |

测试初始化时遇到的复制 owner lock、重复 recovery 调用和错误 SDK getter 名称均已修正为 fixture/命令错误；没有据此改变生产 lease 安全检查或增加权限。

当前支持 Node 22.19+ 的 22.x 或 Node 24+；真实进程验证运行在 macOS 和受支持独立 Node。源码边界、维护者/Agent fake-provider 旅程、跨平台归档 smoke、签名/更新、真实外部用户安装与 Provider 质量需要分别陈述。

## 最终统一回执

早期 source-only 窄测试的无 raw stdout 边界保持原样。最终普通构建后的完整 workspace 单测退出 0，共 1367 passed；本文件的 workbench control 为 18 passed，所有源配置摘要见 [source inventory](evidence/source-inventory.json)。最终 Web 14/102 与安装版 Desktop 21/134 均通过，安装版以自身包/模板和闭合清单验收。详见[最终报告](README.md)与[机器回执](evidence/acceptance.json)，不能将上述窄测试 alone 当成完整安装证明。
