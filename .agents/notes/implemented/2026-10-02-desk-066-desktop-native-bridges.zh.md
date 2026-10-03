---
id: 2026-10-02-desk-066-desktop-native-bridges
title: 为 Desktop 增加受限的原生项目、文件与凭据桥
status: implemented
owners: [desktop, desktop-host]
created: 2026-10-02
last_reviewed: 2026-10-02
affects: [apps/desktop, apps/desktop-host, packages/workbench, packages/core]
supersedes: []
---

# Agent Note：为 Desktop 增加受限的原生项目、文件与凭据桥

## 问题

DESK-065 已提供隔离 Electron 外壳和共享 Workbench，但 Desktop 尚无原生项目注册、项目内文件打开或凭据配置。Run/Session controller 已按注册项目做 scope 校验，共享 Workbench 也已有目录和模型设置入口。Desktop 需要接入这些 seam，同时禁止 Renderer 提交路径来授予权限或读取凭据值。

## 当前状态

- `apps/desktop/src/main.ts` 只开放五个固定 IPC 方法，并以空项目集合启动 `@tracegraph/desktop-host`。
- `apps/desktop-host/src/desktop-host.ts` 的 Run/Session controller 只绑定启动时传入的内存项目 map。
- `packages/workbench` 已调用 `openLocalProject`、`revealProject`、`removeProject`、`getModelConfig` 和 `configureModel`；Desktop adapter 尚未实现这些方法。
- Core 已提供 `WorkspaceHandle`、`ProjectSummary`、`ConfigurableModelAdapter`、`CredentialStore`、macOS Keychain 后端和严格权限的私有文件后端。

## 提议

原生权限由 Electron Main 与 Desktop Host 持有。Main 展示原生目录/文件选择器；Host 对选择目录做 canonicalization，在自己的私有数据目录持久化注册，并保存真实路径与 opaque Workspace handle。Renderer 只收到安全项目摘要和 ID。Run、Session、reveal、remove 与文件打开每次都按 Host 注册重新解析这些 ID。移除注册不会删除用户目录。

文件打开操作绑定到已注册项目。Main 通过私有 Host 控制通道获得项目根目录，再让 OS 选择该目录下的文件；随后解析符号链接，拒绝逃出规范根目录的路径及非普通文件，只打开通过校验的文件。

模型设置继续使用共享 Settings UI。API Key 只通过固定且经 schema 校验的 IPC 和 Main/Host 私有控制通道传递。Host 使用 Core 的平台 CredentialStore 保存值；配置文件只保存 `${secret:NAME}` 引用；Host 在 provider 请求前即时解析。公开响应只暴露 metadata 与 `has_key`，绝不返回明文。macOS 使用 Keychain；其他支持平台使用 Core 私有权限文件后端，后端错误时 fail closed。

## 考虑过的备选方案

- 接受 Renderer 传入的绝对路径：不采用，因为路径字符串不能证明 OS 用户已授权。
- 每次项目变更后重启 Host：不采用，因为会打断运行中的工作并增加恢复流程。
- 将 API Key 返回或保存到模型配置文件：不采用，因为现有 Core 凭据 seam 与安全 metadata contract 已支持只保存引用。

## 不变量与边界

- 原生对话框只在 Electron Main 展示；任何 IPC 都不接受 Renderer 提交的文件系统路径。
- Workspace handle 与规范根路径由 Host 持有。Renderer 的项目 ID 只是查找键，不是文件系统 capability。
- 每个项目级 Host 操作都检查当前注册和 Workspace capability profile。
- 打开文件需要显式选择；所选文件的规范真实路径必须仍位于已注册项目的规范根路径内。
- 凭据 API 对 secret 只写不读。响应、持久化配置、日志和错误消息均不包含凭据值。
- 凭据后端错误不得触发明文 fallback。非 macOS Core fallback 是受私有文件权限保护的存储，并非硬件密钥库。
- Web 现有 HTTP 项目和凭据 route 不变；本桥只供 Desktop 使用。

## 迁移与回滚

在 Desktop Host 私有数据目录中使用带版本和 schema 校验的文件保存项目注册。已有 Desktop 安装没有项目或模型配置，因此首次启动为空。原生桥启动数据无效时，Host fail closed，或以安全 warning 跳过无效项目，绝不扩大权限。移除项目只注销 metadata。模型配置仅存非 secret provider 设置与 secret 引用；回滚可删除这些配置记录，不触碰用户项目目录或 Keychain 项。

## 验收标准

- [x] 原生目录选择创建持久 Host 注册；Main/Renderer 可通过安全摘要列出和选择项目；移除项目不删除原文件。
- [x] Run/Session 项目 ID 由 Host-owned opaque Workspace registry 校验；未注册 ID 与失效根路径均被拒绝。
- [x] Workbench 可通过项目范围内显式原生选择器打开文件；路径穿越、符号链接逃逸、非文件目标均被拒绝。
- [x] 现有模型设置可配置 live Desktop Host，持久配置只含 secret 引用并使用平台 CredentialStore；API Key 不出现在读取响应或持久配置。
- [x] Contract tests 覆盖越权 ID、无效/移除根路径、文件逃逸、凭据后端错误、secret redaction 与重启持久性。
- [x] 双语 Note、Desktop/Host 文档、路线图、依赖策略、模块图与 V2 文档一致。

## 风险与未决问题

- Windows/Linux 现有 fallback 由私有文件权限保护，但不等价于 OS 密钥库；后续可在不改变 `CredentialStore` seam 的情况下替换成原生 secret service。
- 持久化本地路径可能因目录移动而失效；Host 必须将该注册标记为不可用并要求用户重新选择，不能悄悄更换权限目标。

## 证据

- 实现：`apps/desktop-host/src/project-registry.ts`、`model-configuration.ts`、`native-control.ts`、`worker.ts` 与 `desktop-host.ts`；`apps/desktop/src/main.ts`、`native-files.ts`、`bridge-contract.ts`、`ipc-channels.ts`、`preload.cts` 与 `desktop-sdk.ts`；`packages/workbench` 增加可选项目文件能力。
- 测试：Desktop Host 单测 6 项、真实 child-process E2E 4 项、Desktop 单测 8 项、Workbench 149 项、Web protocol fixture 1 项通过。真实 Electron 窗口中使用原生目录选择器注册临时目录，并通过系统默认应用打开项目内文本文件；之后注销了临时登记并清理测试目录。
- 验证：Desktop Host、Desktop、Workbench、Web 类型检查通过；Desktop Host、Desktop、Web、Workbench 构建通过。`verify:lockfile`、`verify:package-readmes`、`verify:boundaries`、`verify:invariants`、`graph:modules:check`、`verify:v2-docs` 与 `git diff --check` 通过。继承的 shell preload 指向缺失文件，因此门禁用 `env -u NODE_OPTIONS` 执行；未写入真实 API Key 或系统 Keychain。
