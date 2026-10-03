---
id: 2026-10-03-public-proofs-preview-artifacts
title: 可执行公开证明与可安装 preview 产物
status: implemented
owners: [release]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [DEMO-080, DEMO-081, DEMO-082, REL-083]
supersedes: []
---

# 可执行公开证明与可安装 preview 产物

## 问题与决定

录制快照验证确定性语义，不能单独证明真实进程死亡、安装包解析或后代
进程回收。增加离线可执行演示：使用产品包的 public exports、受控模型
决策、真实文件/子进程与 canonical Ledger。生成证据不写进源码；任何
oracle 失败均不能输出成功报告。重复对账不能重复执行变更。

## 边界

用户创建 Memory candidate 可显式传入 `allow_export`，省略默认 false。
同意只针对这份精确版本，仍需激活及通过 Capsule 资格门，不能绕过项目
scope 或 secret 限制。纠正默认无导出同意，可单独显式 opt-in，不能静默
继承旧同意；演示导出 active 原版和单独获同意的纠正版，再展示纠正
lineage/召回和撤销排除、后续导出拒绝。已导出的外部副本不能
远程撤回。CLI 与 Workbench 提供明确 opt-in。

Preview 是依赖固定的私有、未签名 workspace 分发产物，包含 dist、包清单、
lock/config、说明、局限、校验和与依赖 SBOM。它不是 npm 发布、notarized
应用或生产安装器。维护者本机新目录安装明确不等于 clean-machine 验收，
也不等于 REL-084 要求的非维护者独立验证。

Workbench CSS 出口指向构建复制的 dist 文件，产物不依赖源码出口。
release gate 校验 Desktop main/preload/renderer，staging 重新核对构建
hash；安装器在执行任何依赖命令前拒绝被篡改文件。
清单是封闭集合：初次安装拒绝所有未登记文件/目录；安装后只额外允许已声明
package 根的真实 node_modules。禁用 pnpm lifecycle 与 pnpmfile hooks。
tar 创建时关闭 macOS AppleDouble 元数据，不为未登记文件增加豁免。
Host/Runtime 的全部资源清理成功后才能提交 passed 冒烟报告。

Desktop `--preview` 完全跳过 Host 启动及 Host user-data 路径。Main startup
测试加载真实 composition 模块，仅替换 Electron 外部边界，证明 Preview
不启动 Host/访问其数据，而正常启动仍创建私有 Host。这修正了文档声称
synthetic Preview 与此前无条件 Host boot 之间的不一致。

## 验证与回退

演示保留 crash/restart/reconcile 事实、Memory lineage/模型请求证据、撤销后
召回排除、导出 Capsule 校验，以及 durable cancel 后的真实 PID/进程组不存在
检查。Preview 在 checkout 外的新目录安装，不依赖源码或 checkout 的
node_modules。删除工具和临时产物即可回退，不改变用户数据或 Runtime 语义。

## 证据

- 实现：[公开证明](../../../demos/proofs.mjs)、
  [preview builder](../../../scripts/create-preview-release.mjs)、
  [inventory verifier](../../../scripts/verify-preview-integrity.mjs)、
  [installer](../../../scripts/preview-install.mjs)、
  [安装冒烟](../../../scripts/preview-smoke.mjs)。
- Consent：[契约](../../../packages/contracts/src/memory-control.ts)、
  [Memory control](../../../packages/core/src/domains/memory/memory-control.ts)、
  [CLI](../../../apps/cli/src/memory-command.ts)、
  [Workbench](../../../packages/workbench/src/components/MemoryControlPanel.tsx)。
- 测试：[release gates](../../../scripts/verify-release.test.mjs)、
  [preview 反例](../../../scripts/create-preview-release.test.mjs)、
  [Memory consent 测试](../../../packages/core/src/domains/memory/memory-control.test.ts)。
  [Preview startup 边界](../../../apps/desktop/src/preview-startup.test.ts)
  验证真实 Main composition 分支。
- 当次验证：三条可执行证明的真实进程/WAL/Memory oracle 全部通过；Memory
  control 7 tests、CLI 3 tests 通过。macOS arm64 / Node 24.21.0 新目录解包
  安装（含显式 Electron）和 installed CLI/Desktop Host headless smoke 通过。
  clean environment 与可见 GUI 证据由验证方另行记录；非维护者独立验收是
  外部结果，本 Note 不代为宣布通过。
- 当前文档：[发布说明](../../../docs/releases/README.md)、
  [工程化模块](../../../docs/modules/13-工程化与发布.md)。
