---
id: 2026-10-05-dev-readonly-preview
title: 源码只读与私有缓存可写的常驻预览
status: proposed
owners: [host, contracts]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [DEV-091]
supersedes: []
---

# 源码只读与私有缓存可写的常驻预览

[English](2026-10-05-dev-readonly-preview.md)

## 决策

已授权的开发工作台整改将 owned preview 与交互终端权限分开。`preview.start` 始终执行源码只读沙箱，即使 Host 当前选择完全访问，也只授权固定的每预览私有缓存/临时目录与 loopback 服务网络。仍要求注册项目的读 capability 和当前项目读策略。客户端不能传缓存路径、沙箱 profile 或源码写授权；不能执行此边界的后端 fail closed，并提供可操作的能力原因。

沿用现有工作区协调器的只读预览租约，因此常驻预览不会阻塞后续写源码的 Run。owned process 仍仅在明确停止或 Host 关闭时结束；关闭视图只断开。交互终端保留原独占写租约。外部注册服务标为 unmanaged：观察健康不限制该进程，也不保证其源码只读。

私有缓存路径不进入公开 snapshot/receipt。现有 preview snapshot 新增可选源码访问/缓存可写 metadata，旧 snapshot 仍可解析。进程所有权和 canonical command receipt 继续作为事实来源。关闭资源时，即使一项 cleanup unknown 也应尝试其他全部 owned resources，汇总错误并保留不确定租约，不能宣称全部停止。

## 边界与恢复

预览依赖须已存在。坚持写源码目录的工具会明确失败；本切片不偷偷迁移任意构建系统、安装依赖或扩大沙箱。缓存授权是独立可信目录；预览代码可写其中，但不能读其他私有 profile 内容。full native enforcement 当前仅在已验证平台可用；外部注册服务及对抗性进程逃逸不在保证内。缓存保留期限和配额暂缓。

Host 重启不自动重新运行旧预览命令，安全 metadata 保留为 stopped/interrupted。unknown cleanup 不能释放对应资源租约，不自动重新提交任务或写操作。

## 验证

用真实常驻 HTTP 进程证明源码写拒绝、私有缓存写成功、私有 profile 读拒绝，同工作区后续 Run 获得写租约而不排队。覆盖 readonly/full-access 选择、后端不可用、项目读策略拒绝、外部服务独立、真实进程组关闭，以及一次 cleanup 失败后其他资源仍被关闭。保留修复前负例。本 Note 在定向源码/测试/当前文档一致前仍为 proposed，不意味着最终安装或 Windows native 验收完成。

## 当前证据

[当前源码与原始验证](../../../docs/validation/dev-readonly-preview/README.md) 记录真实修前源码写/profile 读负例、源码内 `..name` 缓存边界负例，以及修后的进程/Run/cleanup oracle。Host 3 files / 33 tests、Contracts 1 file / 4 tests、定向 Host build/typecheck 通过。真实准入 Run 提交源码 patch 时，相同 preview PID 持续提供 HTTP；一个进程组 cleanup unknown 没有跳过另一组。模块 09/10 已描述只读租约。联合构建、最终安装 GUI 与 Windows native 仍是独立未验证门槛；本 proposed pair 机械登记为 unreviewed。
