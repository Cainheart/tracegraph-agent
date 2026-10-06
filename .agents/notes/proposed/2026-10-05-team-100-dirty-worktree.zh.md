---
id: 2026-10-05-team-100-dirty-worktree
title: 已授权 dirty 基线上的可信可写子工作区
status: proposed
owners: [host, runtime, contracts]
created: 2026-10-05
last_reviewed: 2026-10-05
affects: [TEAM-100]
supersedes: []
---

# 已授权 dirty 基线上的可信可写子工作区

[English](2026-10-05-team-100-dirty-worktree.md)

## 决策与范围

可选的可信 Runtime 子工作区 resolver 独立于 Agent Loop，现有 readonly 默认角色保持不变。
标准 Host 暴露闭合编译目录 `readonly` 与 `isolated-coder`，可信明确 profile 选择仍兼容；
模型只选目录中的 role name/task/budget，不能提供工作区路径、凭据、工具或权限。
Plan 或只读父级明确拒绝写角色。具写权限的 child 必须有 resolver；工作区能力和
有效策略只能收紧已准入父级，共享 Goal 请求预算继续继承。

Host 从稳定且已授权的基线创建私有 detached Git worktree：核验 HEAD、源 index digest，
冻结有界普通 tracked/untracked 文件字节。创建不对源文件 stage/stash/reset/clean/checkout，
不合并结果；读取服从父级冻结 read policy。私有路径、symlink/hardlink、submodule、冲突 index、
不支持的 Git 状态、过大文件/树或源并发变化均 fail-closed。忽略的依赖/构建文件不属于基线，
不会复制，所需依赖须以后续明确支持的能力在隔离工作区安装。首个切片只支持已有 HEAD 的普通 Git 仓库。

模型可见 spawn schema 仅列出可信编译角色名称；空目录仍安全，executor 拒绝未知名字。
`isolated-coder` 仅支持实际暴露的 patch/test 和已有、经 discover 与 hash 绑定的项目命令。
每个 child 从父 snapshot 取得独立且不可变的模型配置/能力/凭据 lease，子终态只释放自己的引用；
已保存连接的 Key 旋转不会提前删除仍被已准入父/子 Run 使用的旧凭据，全部终态后才退役。

规范 Host command journal 记录准备回执与未知结果，安全基线标识/hash 冻结到父 delegation
和子创建/恢复 provenance；公开回执不含文件内容、绝对路径或凭据。Host 私有 manifest 映射
生成 binding/root。独立 child-workspace lease 使用现有 child permit 上限，不再获取父写锁或
占用会令父等待 child 死锁的 root-Run 名额。子终态 durable 后释放 lease；生成 worktree 保留
人工审阅，副作用后失败也保留，不自动清理或合并。

此切片可写 child 恢复 fail-closed，保留隔离 root/diff，不静默改回父工作区；父级账本对账继续
使用 child 终态事实。手动角色配置、非阻塞多轮调度、模型角色 registry、合并/CAS、review/UI
验收 Agent 与关系图不在此切片，不算全部 TEAM-100 完成。

## 验证要求

用实际源 HEAD/index/文件树证明创建和 child 写入前后源完全保留，包括 staged、unstaged、
untracked 字节；两 child root 必须不同且共用冻结预算而不写源。负例覆盖读取策略/父能力上限、
源漂移、缺 resolver、symlink/hardlink/私有/超限/冲突/不支持状态、准备失败保留与 command 幂等。
不使用默认 profile，不发送原生电脑输入；文档必须区分可信装配后端与三端普遍可用 Team 产品。


## 当前证据与延期范围

后端切片已在[当前模块 16](../../../docs/modules/16-Agent-Team.md)和[TEAM-100 实际状态报告](../../../docs/validation/team-100/backend-slice.md)记录。当前工作树的 Contracts 20、Core 31、Host 22 个 focused tests 通过。真实父级/两个 child provider fixture 先证明旧凭据过早删除，再以独立 immutable lease 通过，原始失败/成功回执均保留。原生 Git/Seatbelt 子补丁/项目命令 oracle 在 macOS 执行，不等于实际 GUI、最终安装包、Windows 原生或全部 TEAM-100 产品闭环。

Note 保持 proposed，等待最终联合构建、当前文档及明确范围的路线图闭环审查；双语配对仅机械登记为未审查。产品策略保留生成 worktree 与私有基线，fixture 清理属于独立测试所有权。
