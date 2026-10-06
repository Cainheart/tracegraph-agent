# TEAM-100 隔离子工作区后端切片

2026-10-05 当前工作区验证；没有改默认 profile、用户凭据或源仓库数据，没有付费模型调用或原生电脑输入。测试使用独立临时目录、真实本机 Git/Seatbelt/Node 和 loopback 合成 provider。所有测试 fixture 在 finally 关闭 Runtime/HTTP provider 后删除自己的临时目录；产品自身保留生成的 child worktree，不自动清理。

当前范围是标准共享 Host 的 `readonly` / `isolated-coder` 编译目录与可信 Runtime resolver。模型已能看到目录、选择有界 role/task/budget；写角色不能从 Plan/readonly 父获得写权限。三端用户 child diff/合并、手动角色和关系图、非阻塞多轮调度、隔离依赖安装仍未实现。本报告不宣称 TEAM-100 全任务、最终安装包或实际 GUI 验收完成。

## 实际外部状态 oracle

[Host baseline 测试](../../../packages/host/src/subagent-worktrees.test.ts) 比较源 HEAD、index 原字节 hash、Git status 和源文件字节，包含 staged、unstaged、删除与 untracked。两生成 root 不同，child 修改与新增文件被私有相对路径/hash diff 检出，源完全不变。实际 Git smudge/hook fixture 未执行；`--no-checkout` 创建后只复制安全冻结字节。原始 source index 不被暂存，child private baseline 与公开 Git HEAD 的差异不自动合并。

[实际 Runtime 测试](../../../packages/host/src/subagent-worktree-runtime.test.ts) 经真实 provider JSON wire 选择 `isolated-coder`，两个 child 分别在独立 root 完成真实 Patch approval/commit 和 manifest/hash 绑定的已有 Node 项目命令。两个 `command-result.txt` 来自各自真实脚本断言。父已持有唯一 root Run 名额，child 能并发完成；一个 Goal 请求预算覆盖父子三个 Run 的 10 次实际请求，5050 合成 provider tokens 全部计入同一账单且没有遗留 reservation。父/子公开 ledger 保存对应 binding，子权限为 workspace-write。子 worktree 被保留、lease 释放；父文件树/HEAD/index 没有变更。

[Core 边界测试](../../../packages/core/src/domains/runtime/runtime.subagent-workspace.test.ts) 覆盖缺 resolver、execute-only 写工具分类、callback 权限放宽、父工具交集排除命令、空角色目录/未知名称以及已保存可写 child 的恢复拒绝。恢复 oracle 复制实际 pending ledger/session 快照到隔离 store，证明 resume 不会把 patch 派发回父 root；这是有界恢复快照测试，不能替代真实 owner crash 或安装包验收。

Host 14 个 baseline oracle 包含 policy deny、read-only/capability ceiling、取消、symlink/hardlink、大小边界、冲突 index、源复制期间漂移，以及五个实际敏感路径 `.ENV` / `.npmrc` / `.ssh/id_rsa` / `credentials.json` / `credential.pem`。拒绝时 0 child tree、源文件不变；副作用后的故障 retained tree + canonical unknown，同一 command 不自动重做。

## 凭据引用负例与修复

[实际 provider 回归](../../../packages/host/src/subagent-model-leases.test.ts) 使用 Host 的真实 saved connection/ConversationControl 与两个 readonly child。父和两个 child 请求被合成 provider 明确 hold；更换 saved connection 的 model/Key 后，A 完成，B 再执行读取并请求下一轮，最后仍 hold 父回答。测试只保存旧 credential 是否匹配的布尔值，不打印任何 Key。

- [before-fix 原始负例](checks/model-lease-before-fix.log)：A terminal 释放共享父 snapshot 的唯一引用，旧凭据 delete 1 次，B 后续实际请求以 `model_request_failed` 失败；wire 中只有 3 个已发生请求。该日志保留失败，没有改写成通过。
- [同一 fixture 修复后](checks/model-lease-after-fix.log)：父/child snapshot 各自 `forRun` 独立引用，5 个实际 provider 请求均使用准入 old model/Key；A 与 B 终态都不删除父仍使用的引用，父终态后旧引用只删除 1 次，新 Key 保留。
- [最终 Host focused](checks/host-focused.log) 还覆盖外部 config/capability 对象修改不影响 captured child snapshot，以及各 lease 的 idempotent release。已释放 snapshot 不允许再 fork。

修复源码为 [LeasedModelAdapter](../../../packages/host/src/composition/leased-model.ts)，冻结 config、capabilities 和 credential reference；没有修改 AgentLoop、预算上限或当前任务配置绑定。

## 可重现命令与已保存输出

下列原始 stdout/stderr 已保存；不从其他任务日志伪造输出。

| 当前命令/范围 | 结果 | 原始日志 |
|---|---|---|
| Contracts `subagent-workspace.test.ts` + `subagent-g07.test.ts`, `vitest run … --maxWorkers=1` | 2 files / 20 tests PASS | [contracts-focused.log](checks/contracts-focused.log) |
| Core workspace authority + write-child Runtime + existing subagent + shared budget, `vitest run … --maxWorkers=1` | 4 files / 31 tests PASS | [core-focused.log](checks/core-focused.log) |
| Host baseline + actual isolated Runtime + actual credential rotation + coordinator + lease, `vitest run … --maxWorkers=1` | 5 files / 22 tests PASS | [host-focused.log](checks/host-focused.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/core build` | exit 0 | [core-build.log](checks/core-build.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/core typecheck` | exit 0 | [core-types.log](checks/core-types.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host build` | exit 0；无全仓 clean | [host-build.log](checks/host-build.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck` | exit 0 | [host-types.log](checks/host-types.log) |

[初次 Host build 失败](checks/host-build-initial.log) 保留同期 Skills 未构建声明及 WIP 字段的实际诊断。后续 owning controller 修复、声明构建完成后，上表定向 Host build/typecheck 均通过；最终全仓联合构建仍由 root 收口。

测试生产源码通过公共 package exports 连接实际 Core/Host Runtime；新 contract/Core dist 已定向生成。临时 local provider 是确定性验收模型，没有验证真实供应商长期质量。

## 平台与产品边界

实际 baseline 与原生命令 oracle 在当前 macOS 执行，要求 `probeNativeSandbox` 的 full workspace-write enforcement。Linux/Windows 没有 full 后端时 fail closed；本次没有 Windows 原生执行、干净机器安装、GUI 选择角色、真实任务交付质量或自动 merge 验收。普通 Git `.git` 目录且已有 HEAD 才受支持，linked worktree、冲突/submodule/link/超限/私有路径基线拒绝。忽略的依赖不复制，命令若依赖它们会真实失败；不暗示任意软件子任务已经能安装依赖或执行任意 Shell。

公开 [binding contract](../../../packages/contracts/src/subagent-workspace.ts) 只含 opaque IDs/hash；Host [manifest/controller](../../../packages/host/src/subagent-worktrees.ts) 的路径/字节是私有可信装配数据。副作用未知时保留并人工审阅，不自动重试、合并或删除；可写 child 恢复以 `subagent_workspace_review_required` 拒绝。对应 [paired Note](../../../.agents/notes/proposed/2026-10-05-team-100-dirty-worktree.md) 保持 proposed，不假称人工翻译审查。
