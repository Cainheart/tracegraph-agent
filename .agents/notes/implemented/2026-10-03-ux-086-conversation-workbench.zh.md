---
id: 2026-10-03-ux-086-conversation-workbench
title: 以对话为中心的工作台与 Desktop 命令
status: implemented
language: zh-CN
owners: [workbench, desktop]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/workbench, packages/api, packages/sdk, apps/web, apps/desktop, apps/desktop-host]
supersedes: []
---

# Agent Note：以对话为中心的工作台与 Desktop 命令

## 问题

UX-086 要求共享工作台发生可见改造，并让 Desktop 操作真实可用。DESK-065 提取了原 Web UI，没有交付新的交互设计。

## 改造前状态

[App](../../../packages/workbench/src/App.tsx) 原本默认打开轨迹。[Desktop 适配器](../../../apps/desktop/src/desktop-sdk.ts) 仅暴露部分命令；审批、Todo 与 Artifact 操作不能经该适配器调用。

## 决定

共享界面默认打开对话，固定输入区，持续展示项目与会话导航，并以明确入口按需打开活动、变更和详情。固定会话是可丢弃的本机视图偏好。1024x768 保留可操作工作区；模型 effort 显示可读标签，保留既有主题偏好。

参考的是[官方功能](https://learn.chatgpt.com/docs/features)与[官方工程流程](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)描述的通用交互。布局是 Outlive 的设计判断。本机 Codex 的 CUA 读取被拒绝，没有绕过限制，也没有复制私有应用数据或品牌素材。[旅程对照](../../../docs/validation/ui-086-workbench-ux/reference-and-journeys.md)记录映射与边界。

[RunInteractionController](../../../packages/api/src/run-interaction-controller.ts) 从 canonical Run 解析已注册项目，校验请求权限与响应身份，之后调用既有 Runtime 的审批、计划、输入、Todo 与 Artifact 端口。Desktop 经封闭且 schema 校验的 Main/preload/私有 Host 消息消费该 controller；Web 保留既有 Runtime ingress。协议 v2 保持不变：保留原有 16 条位置固定的 fixture，追加 14 条。显式恢复 Session 的进程内精确重试返回同一回执。

Desktop 普通对话使用 Host 管理的隔离目录，关闭文件系统与工具权限。现有路由覆盖对话、Session 重命名/删除/恢复、补丁与计划决策、Todo 读写、输入、取消/停止和 Artifact 读取。失败操作均可见。真实投影每 500 ms 轮询；Preview 持续标记，使用确定性合成数据且不启动 Host/模型。

Desktop Main 在可信组合层解析独立 Node 可执行文件，取得绝对 realpath，用最小环境探测支持的版本、非 Electron Runtime 与可执行文件身份。私有 Host 显式使用该已验证可执行文件 fork，并且不继承 exec 参数；Node 缺失或不支持时返回 typed setup_unavailable。由此避免沙箱中的 Node 测试错误使用 Electron 可执行文件；环境白名单与 Seatbelt 目录范围保持不变。

## 考虑过的备选方案

仅改 CSS 会留下命令与旅程缺口。单独开发 Desktop UI 会重复界面状态，并违背共享 Workbench 边界。

## 不变量与边界

保持 renderer 隔离、固定 IPC、封闭 schema、权限/审批真源和 Memory/export consent。不引入通用 renderer invoke、文件系统访问、新 Desktop 网络监听、客户端编造 canonical 事件或私有模型推理展示。进度仅来自公开计划和真实工具回执。

Desktop bridge 仍不支持附件、瞬时模型输出流、replay/rollback 和可选 Team/扩展设置。云执行、账号同步、协作、签名与自动更新不在 UX-086 范围内；不声称 Codex 全功能对等。

## 迁移与回滚

无需持久格式迁移。保留 Ledger、Session 与已保存视图偏好。共享界面与新增 Desktop 消息一同回退，然后重新构建配套 Main/preload/Host。不得自动重放副作用。

## 验收标准

- [x] Web/Desktop 真实旅程与 schema/权限负例测试。
- [x] 空态、加载、不可用、失败、取消与 Session 恢复场景。
- [x] 1440x900、1280x800、1024x768 有状态证据。
- [x] owning docs、路线图、新归档证据与本双语 Note 同步。

## 风险与剩余证据

模型 fixture 为合成数据；Runtime、client、Host、Ledger、文件/测试 oracle 与进程恢复均执行真实代码。这证明工程行为，不证明 Provider 质量。维护者 Agent 安装模拟不满足独立外部用户证明或签名公开发布。

## 证据

- [验收报告](../../../docs/validation/ui-086-workbench-ux/README.md)。
- [旅程回执](../../../docs/validation/ui-086-workbench-ux/evidence/report.json)。
- [新归档安装证据](../../../docs/validation/ui-086-workbench-ux/release/README.md)。
- [工作台旅程测试](../../../packages/workbench/src/ux-086-journey.test.tsx)。
- [交互边界测试](../../../packages/api/src/run-interaction-controller.test.ts)。
- [真实私有 Host 旅程](../../../apps/desktop-host/src/desktop-journey.test.ts)。
