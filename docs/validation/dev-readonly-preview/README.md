# DEV-091 常驻只读预览切片

2026-10-05 当前源码与定向产物验收。已先记录 [paired Note](../../../.agents/notes/proposed/2026-10-05-dev-readonly-preview.md)，保持 proposed / mechanically unreviewed；未执行默认 profile、用户凭据、付费模型或原生电脑输入操作。

`preview.start` 使用 [独立可信 execution factory](../../../packages/host/src/preview-sandbox.ts)：源码始终只读，当前 Host 即使选择完全访问也不能放宽。只能写固定的每预览私有 cache/temp；`TMPDIR` / `TMP` / `TEMP` / `XDG_CACHE_HOME` 仅在该进程环境里指向它。只授权指定 loopback 服务端口和 loopback outbound。cache 目录不能是 symlink、不能落在源码内，路径通过 sandbox 参数传递，不进入公开 snapshot/receipt。private profile 其余内容不授权给预览。可信 bundled Node 的实际 executable 可作为预览入口，无需外部 Node 路径权限。

[DevWorkbench](../../../packages/host/src/dev-workbench.ts) 仍验证项目 ID / read capability 和当前 read policy。受限 per-file read policy 无法被此进程沙箱精确表达时 fail closed，不忽略其限制。使用只读 workspace lease，常驻服务不占 writer；交互终端保留原 writer 协调。外部 `preview.register` 标为 `external-unmanaged`，HTTP 健康观察和停止登记不改变该外部进程权限或生命周期。停止 Host 不会自动重启旧预览命令。

关闭资源现在尝试全部 owned terminal/preview，并汇总失败。某一组停止状态 unknown 时保留该组租约，仍关闭其他组；不会宣称全部已停止。

## 真实状态与负例

[实际 HTTP / Runtime 测试](../../../packages/host/src/readonly-preview.test.ts) 包含以下 oracle：

- 修前 [before-fix.log](checks/before-fix.log) 明确观察 `sourceDenied=false`、`profileDenied=false`，cache/temp 没有隔离。原始失败保留。
- 修后 full-access / read-only 预设与 read-only registration 均拒绝源码写、允许私有 cache 写、拒绝读取 profile 的合成私有文件；真实源码 `marker.txt` 不被 preview 修改。
- 同一 workspace 的真实 Host Run 经 `preview_patch` / 审批流程完成 `patch.applied`，真实文件变为 `REAL RUN WRITE`，此前 HTTP service 保持同 PID；Run writer 无需等预览关闭。
- 两个真实 owned process groups 中第一项验证注入 `EPERM`，关闭仍结束第二组；第一组为 failed / unknown 且保留自己的 lease。fixture 随后仅清理自己的进程和目录。
- 读能力/foreign scope/policy deny/受限逐文件规则、缺 native backend、cache symlink 和源码内 `..private-profile` 拒绝。后者也保留 [初版边界负例](checks/cache-boundary-before-fix.log)，修后使用实际路径 segment 边界，未把合法 `..name` 当成父目录。
- 真实 owned stderr 打印 cache path，公开 snapshot 只出现固定 redaction marker；没有 cache/profile 绝对路径。外部服务独立性与旧 snapshot 兼容由相应回归覆盖。

## 已执行命令

| 命令 | 结果 | 原始日志 |
|---|---|---|
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts build` | exit 0，无全仓 clean | [contracts-build.log](checks/contracts-build.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/local-workbench.test.ts --maxWorkers=1` | 1 file / 4 tests PASS | [contracts-focused.log](checks/contracts-focused.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host build` | exit 0，无全仓 clean | [host-build.log](checks/host-build.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck` | exit 0 | [host-types.log](checks/host-types.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/readonly-preview.test.ts src/workbench-control.test.ts src/workspace-coordinator.test.ts --maxWorkers=1` | 3 files / 33 tests PASS，含 9 个新实际预览测试 | [focused.log](checks/focused.log) |

保留 [初次 fixture 同步失败](checks/focused-initial-fixture-failures.log)、[单次 stderr 被正常健康状态覆盖](checks/focused-stderr-fixture-failure.log) 和 [已有公共 redactor marker 的断言差异](checks/focused-redaction-marker-fixture-failure.log)。修正测试装配/观测同步与接受现有固定 redaction marker，没有调大测试时间或隐去失败。

## 验证边界

2026-10-05 后续交付门禁启用后，[当前 Host fixture 增量](../delivery-review/host-fixture-compatibility.zh.md)保持原预览权限和磁盘 oracle。该最小 Run 真实应用补丁且预览保持同 PID，但没有执行项目验证，因此规范终态为 `failed / delivery_verification_missing`。这证明开发写入不被只读预览阻塞，不能把补丁成功扩大为完整软件交付成功。先前日志保留当时装配范围。

真实 Seatbelt / HTTP / scoped Run / process-group oracle 只在当前 macOS 执行。Linux / Windows 尚无能表达此 private-cache 例外的 full sandbox backend，`preview.start` fail closed；不能把完全访问预设当成绕过。坚持向源码写 cache/build 的工具会明确失败，需其已有配置支持进程私有 cache；未新增自动依赖安装、通用构建系统迁移、缓存配额/保留期限或对抗性 double-fork 进程隔离。最终安装包、实际三端 GUI 和 Windows native 验收另由主任务闭环，不由本测试报告代替。
