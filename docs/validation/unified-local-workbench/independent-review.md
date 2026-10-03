# 共享本机工作台独立验收审查

记录日期：2026-10-03。审查者独立读取最终报告、业务回执、截图、当前源码及归档清单；没有重新运行应用、测试、构建或修改产品源码。本文只记录本次检查的事实，完整任务状态由 [主验收报告](README.md)登记。

结论：未发现本轮 HOST-087、PAR-088、CLI-089、SET-090、DEV-091、RUN-092 与 UX-086 二次验收尚未处理的重大实现缺口。最终 Web 和新目录安装后的真实 Electron/CLI 旅程均通过，实际业务结果和清理状态可复核。该结论限于维护者 macOS arm64 环境与声明的合成 Provider。

## 最终报告与真实结果

| 范围 | 实际证据 | 本次独立核对 |
| --- | --- | --- |
| 当前 Web 构建 | [最终报告](evidence/ui/report.json)、[渲染产物哈希](evidence/ui/renderer-build-hashes.json) | `passed`，14 项断言、102 张 PNG；全部文件存在、PNG 尺寸与三种 CSS 视口一致；99 个 JS/CSS/HTML 哈希全部匹配当前 `apps/web/dist`；错误为空、清理完成 |
| 新目录安装后的 Desktop / CLI | [最终安装报告](evidence/installed-desktop/report.json)、[业务投影](evidence/installed-desktop/completed-projection.json)、[测试 Artifact](evidence/installed-desktop/test-artifact.json) | `artifact_mode=installed`、`passed`，21 项断言、134 张 PNG；浅色/深色及三种视口覆盖核心状态、十类设置和六类开发资源；全部截图 SHA-256 正确，物理像素为 CSS 的 2 倍 Retina 比例，无记录的横向溢出 |
| 安装版真实业务结果 | [测试输出](evidence/installed-desktop/desktop-test-output.txt)、[回滚文件哈希](evidence/installed-desktop/rollback-file-hashes.json)、[规范回滚投影](evidence/installed-desktop/rollback-projection.json) | `test.completed` 回执是 `business_status=success / code=tests_passed`；UI 输出与同 Run 的 Artifact 精确一致，Artifact hash 正确，实际测试为 `2/2 fixture assertions passed`；默认策略对同 Action 拒绝回滚，显式授权后同 Action 的原文件 hash 恢复且不同于 patch 后 hash |
| 三端共享及生命周期 | [公开流](evidence/installed-desktop/public-streams.json)、[CLI 回执](evidence/installed-desktop/cli-receipts.json)、[迁移回执](evidence/installed-desktop/migration-receipt.json) | 三条真实流分别有 37 / 17 / 3 条公开事实，没有 `thinking_snapshot`；22 个 CLI 子进程回执含预期的输入拒绝、排队取消及规范取消终态退出语义；原生迁移返回来源 ID 和备份事实；报告列出的三个 owner PID 均已退出，`cleanup.completed=true`、失败与错误为空 |

同时读取了旅程脚本的实际断言：关闭 Electron 后观察者核对相同 PID、boot nonce 和活动 Run；重新连接后该 Run 完成。显式停止 Host 后先确认 PID 消失及 Main `offline`，再由原生启动接回相同 profile 和原 loopback 端口。停止订阅没有被当作取消任务。

Web 的 [回滚证明](evidence/ui/rollback-proof.json)同样包含真实 `tests_passed`、同 Action 的单条回滚事实和 `before_hash == restored_hash != applied_hash`。其 [资源证明](evidence/ui/resource-proof.json)显示活动 Run 为零、终端关闭、非自建预览停止连接、暂停的定时任务有完成回执；通知 ID 等于对应 canonical event ID。已直接查看窄视口的审阅、设置、开发资源、通知及中文未知成本截图，未发现重大可见布局问题。

## 构建与归档边界

最终归档为 `_tmp_release/unified-local-workbench-20261003-complete/outlive-agent-0.1.0-alpha.0-preview.tar.gz`：

```text
SHA-256: 33147dfea9230ad877627946d5117bd1eb96bc27289435528bd60b067f87c615
archive bytes: 5762736
manifest listed files: 1489
closed artifact files including SHA256SUMS: 1490
```

本次逐一读取 [最终 manifest](evidence/release-manifest.json)中 1,489 个文件：归档 staging 树与 `complete-install` 树的字节长度、SHA-256 均匹配。耐久 manifest 副本与归档目录中的原件完全一致。排除 manifest 声明的安装依赖目录后，两棵树均无额外文件或不安全 symlink。安装后 Desktop 报告的 24 个产品哈希同时匹配安装树、最终 manifest 和当前构建；其 7 个固定示例资源哈希也全部匹配 manifest。

首个安装尝试因归档缺少示例源码而失败，保留在 [原失败回执](evidence/attempts/installed-001-missing-fixture-source/report.json)，没有重标为通过。最终归档加入固定白名单的 `examples/failing-typescript-repo` 七个资源；安装旅程预先校验同一安装树的资源，禁止使用源码目录 fallback。旧 Desktop source 报告在最后遥测文案重建前完成，不能替代最终安装报告；Web 的文案更新前报告亦单独保留在 [历史尝试](evidence/ui-attempts/009-passed-before-telemetry-copy/report.json)。

读取 [安装日志](evidence/checks/outlive-unified-complete-install.log)与 [smoke 日志](evidence/checks/outlive-unified-complete-smoke.log)：新安装目录包含 Electron/native PTY 依赖；smoke 为 `passed`，真实 CLI 使用认证共享 Host，Web gateway 与其读取相同 Session；旧 framed 子进程仅作为额外兼容 seam。smoke 自身明确不覆盖 GUI，GUI 由上面的安装版完整报告补足。

## 权限、设置与恢复审查

- [共享装配根](../../../packages/host/src/composition/host-composition.ts)持有 profile、Runtime、凭据、权限与工具配置；[本机 Host](../../../packages/host/src/local-host.ts)使用同一 owner 的私有 HTTP 和回环网关。客户端退出仅 detach，显式停止才关闭后台资源；不默认安装开机启动。
- [恢复守卫](../../../packages/host/src/composition/resume-policy.ts)在 [Session admission](../../../packages/api/src/run-session-controller.ts)执行之前比较当前 Host/project/extension policy digest。变更时拒绝旧权限继续执行、要求新 Run；它只重新检查 recovered/interrupted Run，当前进程中的活动 Run 保留原配置。历史加载与进程恢复不自动执行旧任务。
- [能力投影](../../../packages/host/src/workbench-control.ts)按实际 native sandbox probe 决定可用状态；只读预设禁用开发写操作，缺失 backend 为不可用。回滚默认策略为 `policy-denied`；linked workspace 仍需 Host force policy 和显式确认。
- 保存模型配置与独立连接测试为两个操作，设置显示来源、scope、生效时机及 CAS revision。测试有 15 秒预算，不携带项目或对话；进行中的 Run 保留已绑定的模型、凭据和权限。工具、Memory、遥测的 restart 字段由下一次装配实际应用；Recall 默认关闭及项目/审核约束保留。
- 通知从已注册项目的规范投影及真实 event ID 派生，未另写运行 Ledger。完成 Run 退出后台列表后通知仍可读取；[客户端通知消费](../../../packages/workbench/src/notifications.ts)首次连接只显示历史、不重复发系统通知，后续按稳定 ID 去重并遵守用户开关及系统权限。
- 迁移保留源数据、目标备份及原配置格式，选择一个 active source，其他来源隔离。活跃 writer、Run、PTY、自建预览先拒绝；未知结果有 operation ID，先查询耐久回执。此处“回退”指提交失败时恢复备份及保留旧来源，没有宣称提供成功迁移后的一键历史恢复命令。
- [PTY / 开发资源](../../../packages/host/src/dev-workbench.ts)与 [定时任务](../../../packages/host/src/scheduler.ts)共用工作区协调；进程退出未知时不声称资源已释放。定时触发先持久记录，错过、重叠及审批有明确状态，恢复不重放既有副作用。

## 已有工程日志

这里只读取已有结果，没有重跑命令或制造 stdout：

- [统一单元日志](evidence/checks/outlive-unified-units-complete.log)：21 个 workspace 结果摘要，合计 1,367 tests passed、零失败；包括 Core 475、Host 98、旧 Desktop Host 18、Desktop 33。此计数不是所有平台或所有端到端用例数量。
- [类型检查](evidence/checks/outlive-unified-typecheck-complete.log)、[Eval 类型检查](evidence/checks/outlive-unified-eval-types-complete.log)：读取完成状态，无类型错误。
- [工程检查](evidence/checks/outlive-unified-engineering-complete.log)：94 个 Node 工程测试和 8 个 Vitest 用例通过。
- [包装窄回归](evidence/checks/outlive-unified-packaging-final-test.log)：11 项通过；[当前 baseline 检查](evidence/checks/outlive-unified-baseline-check-complete.log)结构数据匹配；[归档 checksum 日志](evidence/checks/outlive-unified-complete-checksum.log)为 OK。

Git HEAD 为 `53214e172095d67bf470edefbf9d8b24a9cf104c`，审查时工作树有未提交变更，因此 HEAD 不能单独标识本轮实现。本次还逐一核对 [源码 inventory](evidence/source-inventory.json)中 647 个文件的当前 SHA-256，均匹配；[最终汇总回执](evidence/acceptance.json)的范围、数量、归档 hash 和外部验收边界与上述实际结果一致。以下为关键源码的 SHA-256 切片，安装事实以最终归档 manifest 为准。

```text
e335755f72aa9a70171ccfa11e3a46f62e4b451700a42eebd41bd91b2f93cf59  packages/host/src/local-host.ts
49ce00f2211c251da4825abdb929d6b963608427830c0bd84e1a63f30dbad502  packages/host/src/workbench-control.ts
6f5378ccff775c34ba3acc8589717168da7ef0d210630b44734cad05a64f1f13  packages/host/src/composition/host-composition.ts
cd91f601041a3bf851fa1c753937742e7600cb47b5e65c50596e77cbccec8b95  packages/host/src/composition/resume-policy.ts
03076cfbb3c60c8af431a369c5ac64122c4985111873ba2e865e5a544234b897  packages/api/src/run-session-controller.ts
eeda3e6924835f99b914c058fad5aa531f4e28e0398b56b56ebb507576ff5d76  packages/host/src/dev-workbench.ts
d8e0ca42c74ac3bda35923ae12a58a5d0c440e05a7cb25c5a02030276177331e  packages/host/src/scheduler.ts
38a8176459065722247beeaa25695673063b00acf38fc559d53ad90294fb6b57  packages/workbench/src/components/UnifiedSettings.tsx
26afe839f0ad3d70de6f80f3336ebb2f0c761119d72244d4e4a724abb9368c1e  packages/workbench/src/notifications.ts
c5b2aa52982684ad346cbcb7a471cff64077c3391bea7026c7e215839c80bb1b  apps/desktop/src/main.ts
a5c1505a2ba8edf8d3946a01024d6b95c4aaeded73c58c2b0b5e8696daa37499  apps/desktop/src/desktop-sdk.ts
e529b24530c86f2424c450ae84fc89a26cc606de42750f88cadc45dafc9a6a81  apps/cli/src/workbench-command.ts
9f3d8a0d746d71da38e22713ebbff9d361e090850186fced18132d88cd41141f  scripts/create-preview-release.mjs
c50bbc65ab6e9552f65f8d3ca62c1ba4f6e375d72df5b4577eb547938db3be99  scripts/preview-smoke.mjs
```

## 未审与未验范围

本审查没有重测所有源码路径，也没有读取真实用户凭据或迁移真实用户目录。真实供应商响应质量与真实 Key 的有效性，不能由合成 loopback Provider 推导。此次安装与 GUI 为维护者 macOS arm64 环境；不是全新机器、Linux/Windows GUI 或独立非维护者验收。签名安装器、`.dmg`、公开发布、云同步及多人协作没有被计入本轮实现完成。

REL-083 可准确表述为当前 unsigned Preview 已重建且本机新目录安装与真实 GUI 验收完成；REL-084 的模拟验收仍按原边界成立，真实独立非维护者外部验收尚未完成。发布阶段的外部退出条件不能由这些本机结果替代。
