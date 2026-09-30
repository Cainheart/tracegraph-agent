---
id: 2026-09-30-pkg-035-boot-profile-gate
title: 在 Boot/Profile 契约稳定前保留 CLI 内部组合边界
status: implemented
owners: [composition, cli]
created: 2026-09-30
last_reviewed: 2026-09-30
affects: [cli-boot, resolved-profile, package-topology]
supersedes: []
---

# Agent Note：在 Boot/Profile 契约稳定前保留 CLI 内部组合边界

## 问题

PKG-035 将 `packages/boot` 列为候选输出，但明确要求先通过升包门槛。当前仓库只有一个应用组合根 `apps/cli/src/index.ts`；Web 消费 Host/SDK，并不负责装配 providers；Desktop 尚不存在。V2 Profile/Bundle resolver 与 wire shape 仍是目标设计，不是当前实现。

## 当前状态

- CLI 在 `apps/cli/src/*-config.ts` 解析 feature-specific 配置，再由 `apps/cli/src/index.ts` 装配 Core、Host、Session、MCP、LSP、Retrieval、Telemetry、CodeGraph 与可信 subagents。
- 现有 `subagent` profiles 是 Host 拥有的委派目录，不是应用 Profile 或 Bundle。
- 没有被第二个应用消费的共享 Boot/Profile loader API 或 profile 文件。未来的 Web/Desktop 入口不能算作消费者。

## 提案

PKG-035 本轮不创建物理 `@tracegraph/boot` 包。通用 Profile 边界尚未稳定，且目前只有一个真实应用消费者，因此未满足升包硬门槛。在 `apps/cli/src/profiles/` 与 `apps/cli/src/boot/` 保留范围小的 CLI 内部 profile 定义和 resolver。

Resolver 从 CLI 已解析的安全启动选项生成确定性的 `tracegraph.resolved-cli-profile.v1` descriptor，并提供 JSON dump 与 SHA-256 fingerprint helper。该 fingerprint 只覆盖明确列出的非秘密投影；它不是完整 composition digest、授权证明、持久化 Run manifest，也不参与 Runtime policy。

Profile 投影排除 credential 值/引用、model base URL、文件系统路径、进程 command/arguments/environment、远端 endpoint URL、原始 prompt、extension errors、stderr 和 timestamps。它可以包含经过验证的公开标识、模式、限制、协议/model labels 和已有 prompt hashes。不改变启动策略或 provider 行为。

只有当可复用契约稳定，并且有两个独立真实消费者或另行记录的硬隔离理由，再加上包根 contract tests 时，才重新考虑物理升包。

## 考虑过的备选方案

- 根据计划中的 Web/Desktop 消费者现在就升成 `@tracegraph/boot`：不选，因为计划中的消费者不是证据，共享 profile 契约仍处于 proposed。
- 将完整 CLI `runServer` 函数搬入 package：不选，因为它混合 CLI 专属 flags、本地路径、credential resolution、平台服务与交付行为，会提前冻结不稳定的 app composition API。
- 将 subagent profile catalog 当成应用 Profile 复用：不选，因为它属于另一个 Host-owned delegation contract。

## 不变量与边界

- 当前应用装配仍由 `apps/cli` 独占；feature configuration 和 authority 仍由现有 owner 管理。
- Resolved profile 是信息性安全投影，不能授权、实例化 provider、改变 Runtime 设置，也不声称绑定了全部 secret 或本地进程细节。
- 纳入字段相同则 dump/digest 确定；具有语义的列表顺序保持不变。
- 不新增 Boot package inventory 项或依赖策略豁免。

## 迁移与回滚

添加内部 profile descriptor/resolver 与 focused tests，将 CLI 已解析的启动输入映射到 allowlist 字段，并更新当前 CLI/module/roadmap 文档。回滚时删除两个内部 profile 文件、调用点与测试并恢复文档；无需迁移持久数据或修改 package manifests。

## 验收标准

- [x] 明确裁决物理包门槛，不把计划中的消费者计入；Profile 边界未稳定前不创建 package。
- [x] 当前 CLI profile 从已解析启动值构造，支持确定性 JSON dump 和 SHA-256 digest。
- [x] Profile tests 证明输出稳定、安全输入变化会改变 digest、有序选择保持顺序，并排除 secret/path/command。
- [x] CLI Runtime 组合行为不变；typecheck、focused CLI tests、CLI E2E、boundary、docs 和生成文件检查通过。
- [x] 当前 CLI 模块文档和 roadmap 区分已交付的 descriptor 与 proposed 的跨应用 Profile/Bundle 系统。

## 风险与未决问题

- 此 descriptor 有意不作为不透明 subprocess 配置或实时 remote provider catalog 的完整身份。未来的 `composition_digest` 契约需先明确敏感字段分类，才能声称表达完整 composition identity。
- 第二个应用消费者未来可能推动共享 package，但升包仍须有稳定 schema、负向边界测试和回滚证据。

## 证据

- 实现：未创建物理 `@tracegraph/boot` 包；跨应用 Profile 契约尚未稳定且目前只有一个真实应用消费者，因此未通过升包门槛。`apps/cli/src/profiles/cli.ts` 声明 `tracegraph.cli@1`；`apps/cli/src/boot/profile.ts` 生成不可变 allowlist projection、确定性 JSON dump 与经校验的 SHA-256 digest。CLI Runtime 从该 resolved snapshot 读取 max turns、sandbox mode 和 rollback policy。当前行为文档与 roadmap 已说明更广泛的 Profile/Bundle 系统仍是 target-state。
- 测试：profile contract 文件通过（5 项）；CLI 单测通过（14 个文件、62 项）；CLI E2E 通过（4 项）；文档一致性 eval 通过（6 项检查）。
- 验证：workspace `pnpm typecheck` 通过；`pnpm test:engineering` 通过（48 项 Node 测试和 8 项 coverage-gate 测试）；boundary 检查通过（18 个包、34 条 workspace dependencies、1,442 条 import references、0 个 legacy findings）；package README、V2 docs（11 份文档/62 个任务）、lockfile（19 份 manifests）、module graph freshness、current-baseline freshness 和 `git diff --check` 均通过。
