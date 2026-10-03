---
id: 2026-10-03-unified-local-workbench
title: 单一本机 Host、共享设置与完整交付端
status: implemented
language: zh-CN
owners: [host, sdk, desktop, cli, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/host, packages/api, packages/contracts, packages/sdk, packages/workbench, apps/cli, apps/desktop, apps/desktop-host]
supersedes: []
---

# Agent Note：统一本地工作台

## 问题与当前状态

用户于 2026-10-03 授权实施完整本地工作台计划。本轮实施前 Web 与 Desktop 具有独立的 Runtime 和配置所有者；Desktop 缺少可选操作，CLI 无法完成需要审批的完整旅程。保留原 UX-086 较窄范围的历史验收。

## 已接受目标

单一、经认证的本机 Host 持有版本化 profile、Runtime、配置、凭据、项目、会话及后台资源。Desktop Main 与 CLI 经本机私有通道接入，Web 回环网关使用同一所有者。关闭客户端不取消任务或停止服务；显式停止 Host 负责资源退出，默认不安装开机启动。

三端复用控制器语义以及安全能力、设置投影。Desktop 保留固定、schema 校验的桥接及 Renderer 隔离。配置保存与受控模型连接测试分别确认；已有操作、制品、公开流和工具设置均提供等价入口。

对话界面移除重复设置、置顶及常驻运行导航；默认只显示一句公开说明与一条真实操作，主动点击才展开历史。禁止展示私有推理。设置显示来源、范围、限制及生效时机。

增加本地 Git/worktree、Host 所有的 PTY、受控预览服务、归档/搜索/通知及耐久定时任务。会话写入串行；各类任务与资源按规范工作区协调写入。定时触发拥有耐久标识，跳过错过或重叠触发，恢复不静默重放副作用。

## 不变量与边界

- Ledger 与业务回执保持权威；连接、进程退出或保存凭据均不能冒充业务成功。
- Host 持有权限与密钥，Renderer 仅接收有界安全投影和范围化 ID，不增加任意文件系统或通用特权 RPC。
- 保留权限上限、精确审批、Memory consent 与默认关闭 Recall；恢复不自动继承执行权限。
- 复用现有包的公共导出，并登记依赖方向。
- 配置按明确边界生效；每个 Run 绑定已解析模型与旧凭据租约，直到该 Run 结束。

## 迁移与回退

先扫描、预览和备份旧来源，停止旧写入者后原子提交共享 profile。保留旧目录及 Ledger 身份；不拼接不兼容会话，不自动授权导入路径。冲突可检查并选择来源。失败时旧 profile 可继续使用；回退不得重写已发生的事实。

## 验收

- [x] 并发启动客户端只发现一个经认证的 Host 所有者。
- [x] 三端配置及完整任务旅程共享规范状态与业务结果。
- [x] 真实传输验收 Desktop/CLI 能力、公开订阅与设置错误。
- [x] 客户端关闭、工作区并发、Host 恢复和定时去重均有测试。
- [x] 终端、预览及 Git 生命周期和权限失败有外部状态校验。
- [x] 三种窗口尺寸、当前模块文档、任务表及重建归档与行为一致。

## 证据

HOST-087、PAR-088、CLI-089、SET-090、DEV-091、RUN-092 及 UX-086 二次验收已实现并验证。见[验收报告](../../../docs/validation/unified-local-workbench/README.md)、[能力矩阵](../../../docs/validation/unified-local-workbench/capability-matrix.md)与[机器回执](../../../docs/validation/unified-local-workbench/evidence/acceptance.json)。1367 项单元测试、32 项离线评估及五条录制快照通过；最新 Web 为 102 张核验截图，新目录安装的 Electron 为 134 张截图/21 条真实旅程和 22 次 CLI，资源清理通过。冻结 unsigned 归档 SHA-256：`33147dfea9230ad877627946d5117bd1eb96bc27289435528bd60b067f87c615`。失败尝试保留原状态；模型响应为合成端点，实际文件/进程/回执经过校验。签名分发、独立外部用户验收与非 Mac GUI 不由这些本地证据证明。系统通知要求客户端连接且明确获准，重连后仍可查看规范通知事实。
