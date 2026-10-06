# 固定 Desktop Skills / 视觉证据管理桥

2026-10-05 当前源码验证。沿用两份 owning Note：[Skills](../../../.agents/notes/proposed/2026-10-05-cap-103-skill-lifecycle.md)、[视觉证据保留](../../../.agents/notes/implemented/2026-10-05-data-104-visual-evidence-retention.md)。本切片只补齐固定运输桥；Host controller、真实磁盘与 HTTP/CLI 业务验收分别由 owning 模块记录，不据此宣称完整 CAP-103 / DATA-104 或实际 GUI 验收完成。

| 范围 | 固定方法 | Main 分类 |
|---|---|---|
| Skills | `listManagedSkills`、`readManagedSkill`、`validateManagedSkill`、`getManagedSkillCommandReceipt` | read；不升级 Replay 或重新派发效果 |
| Skills | `managedSkillCommand` | mutate；每次显式调用只派发一次 |
| 视觉证据 | `getVisualRetentionSettings`、`listVisualEvidence`、`getVisualEvidenceCommandReceipt` | read；只返回 metadata / scoped refs |
| 视觉证据 | `updateVisualRetentionSettings`、`pinVisualEvidence`、`cleanupVisualEvidence` | mutate；沿用 command ID / revision / canonical receipt |

请求与响应均由 Contracts 的闭合 schema 验证。[direct-routes](../../../apps/desktop/src/direct-routes.ts) / [Main](../../../apps/desktop/src/main.ts) / [preload](../../../apps/desktop/src/preload.cts) / [Desktop SDK](../../../apps/desktop/src/desktop-sdk.ts) 明确列出每个方法，没有开放任意 RPC、任意路径、原始像素或 credential reference。Skill 导入只接显式有界 Markdown 内容；视觉证据清理只接注册的 ID / scoped refs，未新增 Renderer 文件系统能力。

[7 个桥接测试](../../../apps/desktop/src/management-bridge.test.ts) 检查一次派发、schema 默认分页、conflict / unknown 回执原样保留，以及特权请求 / 私有响应字段拒绝。编译后 preload 的 11 个固定方法通过检查；仅已有固定通知事件可订阅，不开放通用 IPC listener。

| 已执行命令 | 结果 | 原始日志 |
|---|---|---|
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop build` | renderer → Main → preload 同一次顺序构建，exit 0 | [desktop-build.log](checks/desktop-build.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop typecheck` | exit 0 | [desktop-types.log](checks/desktop-types.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/desktop test:unit` | 13 files / 69 tests PASS，含桥接 7 个 | [desktop-unit.log](checks/desktop-unit.log) |

[旧 fixture 失败日志](checks/desktop-unit-before-fixture-fix.log) 保留 18 个实际失败：Main / preview 的测试替身缺少当前 WindowPresentation 必需的 bounds / minimum size / always-on-top / screen workArea 接口。仅补真实替身接口，未把生产调用改为 optional、未跳过测试。此前仅定向 preload build 期间发现 Main / IPC 产物不一致；上表整套 Desktop build 后产物已一致，不能用期间的混合 dist 作为 GUI 验收依据。

本次没有默认 profile 操作、真实密钥读取、付费模型请求或原生电脑输入。没有 Windows native、最终安装包、真实 OS 通知或维护者之外的用户验收结论。

## 独立原生菜单审查

后续只读审查 [native effects](../../../apps/desktop/src/native-background-electron.ts) 与 [WindowPresentation](../../../apps/desktop/src/window-presentation.ts)，未发现需要改生产源码的缺陷。新增 [4 个菜单测试](../../../apps/desktop/src/native-background-electron.test.ts) 证明按固定 ID 而非顺序/label 映射，未知 ID/同名 label 不触发 presentation 或后台停止，最新 callback 与 Tray/native checkbox 状态同步，缺 Window menu 时保留 Tray。另补 [旧窗口延迟 closed / 当前窗口 destroyed](../../../apps/desktop/src/window-presentation.test.ts) 负例，旧窗口不会 detach 新窗口，已销毁窗口不能继续输入窗口效果。

[定向 3 files / 14 tests](checks/native-presentation-review.log)、[Desktop 类型检查](checks/native-presentation-types.log) 和 [完整 14 files / 74 tests](checks/desktop-unit-with-native-review.log) 均通过。这些 oracle 检查固定回调、调用与程序状态，不代表真实 OS z-order、原生通知 delivery 或 Windows 原生验收。
