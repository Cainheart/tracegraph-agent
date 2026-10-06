# DATA-104：真实且限定范围的截图保留

[English](README.md)

已实现的切片默认将新登记的 Browser/Computer 截图保留 30 天，支持 1–365 天、每小时自动清理、有界单条固定保留及显式清理/核对。这不代表 DATA-104 整体完成，也不证明原生截图权限、安装版界面验收或 Windows 原生行为。

可信截图流程登记私有原图；Browser/Computer 工具适配器在真实发布字节后，登记准确的 Run Artifact 副本。清理删除同一观察的原图及所有登记副本，保留生成图片、附件、辅助功能/DOM 文本、消息、项目文件、Artifact 元数据及 Ledger 事实。限定单个 Run 的清理不能删除被其它 Run 共用的观察。未登记的旧截图继续保留，不按 MIME 扫描猜测来源。

配置和固定保留使用命令 ID/版本检查。每个有界清理都有标准 WorkbenchJournal SessionEvent 回执。标准清单检查点保存投影哈希/版本，恢复旧私有投影不能撤销后续固定保留或 TTL。不一致或缺失检查点会停用此可选服务，而普通 Host/Plan 仍可使用；不会自动回退或修复清单。部分删除及回执丢失保持 unknown；核对只检查字节，不删除或改写，新清理不会重试未确定的观察。

限制：10,000 条观察、500 条固定保留、每条 16 个 Run 副本、每批最多 100 条结果/清理候选、8 MiB 投影、10,000 个标准清单检查点及 16 MiB 检查点查询上限。容量耗尽保守拒绝并需要维护，没有自动压缩 Ledger。Browser 原图最大 8 MiB，Computer/Run PNG 副本最大 16 MiB。清理验证来源、元数据、哈希、长度、属主及非链接文件身份。Node 按路径 unlink 不是按 inode 条件删除的原子操作；同用户恶意进程在最后核验/unlink 窗口替换文件或父路径，超出此私有存储安全边界。不承诺安全擦除备份。

## 产品路径与客户端

- [契约](../../../packages/contracts/src/visual-evidence.ts)、[控制器](../../../packages/host/src/visual-evidence-control.ts)、[固定 HTTP 路由](../../../packages/host/src/visual-evidence-routes.ts)、[可信字节删除](../../../packages/evidence/src/artifact-store.ts)。
- [Browser 截图](../../../packages/host/src/browser-control.ts)/[工具适配器](../../../packages/host/src/browser-tools.ts)；[Computer 截图](../../../packages/host/src/computer-control.ts)/[工具适配器](../../../packages/host/src/computer-tools.ts)。
- [SDK](../../../packages/sdk/src/index.ts)、[CLI](../../../apps/cli/src/workbench-command.ts)；根 Agent 独立接入固定 Desktop 桥及共享设置能力。

六个类型化方法是 `getVisualRetentionSettings`、`updateVisualRetentionSettings`、`listVisualEvidence`、`pinVisualEvidence`、`cleanupVisualEvidence`、`getVisualEvidenceCommandReceipt`，仅返回元数据/回执，不返回像素或绝对路径。鉴权网关在控制器准入前拒绝 Replay。CLI 用法：

```bash
outlive evidence settings --json
outlive evidence settings-set --input-file retention.json --command-id settings:retention
outlive evidence list --project-id PROJECT --run-id RUN --limit 50 --json
outlive evidence pin EVIDENCE --state pinned --expected-revision REVISION --command-id pin:observation
outlive evidence cleanup --project-id PROJECT --command-id cleanup:expired --json
outlive evidence receipt cleanup:expired --json
```

`retention.json` 包含 `expected_revision` 与 `values: {retention_days: 30, automatic_cleanup: true}`。未知清理或未知命令回执退出码为 3，保留人工核对要求。

## 窄范围验证

以下最终原始日志在当前工作区实际产生；数量仅覆盖所列范围，指明时包含既有测试。

- [Host 控制器/采集/本机 owner](checks/host-final.log)：真实字节删除、固定/未过期保留、原图及 Run 副本、元数据/辅助功能文本/项目字节不变、共用 Run 范围、链接替换、回执丢失、CAS/重启、旧投影恢复、检查点缺失、自动清理持久回执。实际运行隔离 Chromium PNG 截图；Computer 使用明确标注的确定性原生边界，但控制器/Artifact/Ledger 副作用真实。
- [真实 HTTP/SDK/CLI](checks/cli-final.log)：真实鉴权本机 HTTP Host、持久 Runtime/Session、确定性直接回答适配器；CLI 固定/设置/清理实际落盘、固定字节保留、Run Ledger 不变、Replay 403 且无清理回执；额外 CLI 命令测试覆盖类型化参数及 unknown 退出码。
- [契约](checks/contracts-final.log)、[SDK](checks/sdk-final.log)、[Evidence](checks/evidence-final.log)、[类型/边界检查](checks/types-final.log)。

可选服务故障测试使用真实临时 LocalHost/UDS owner、本机确定性 HTTP 提供方，恢复旧或损坏的保留投影。普通 Plan Run 完成、六个视觉能力均 unavailable、截图字节保留、没有生成清理命令；凭据只使用 private-file 虚拟值。测试没有访问默认 profile、用户凭据、付费提供方、操作系统鼠标/键盘或安装版界面。

第一次真实 HTTP 运行发现新增 SDK 方法缺 JSON 命令头，已统一使用既有类型化命令传输。独立源码审查发现旧投影可回退新固定/TTL，标准检查点及实际恢复反例闭环该缺陷。更广的界面/安装验收由对应流程记录，不能从这些窄测试推断。
