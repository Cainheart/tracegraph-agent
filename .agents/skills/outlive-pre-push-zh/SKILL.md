---
name: outlive-pre-push-zh
description: 在 TraceGraph 或 Outlive 仓库准备推送、提交评审或声称验证通过时，按实际改动选择并运行最小可信门禁；中文流程。
---

# 推送前验证

本 Skill 只选择、执行和报告验证，不授权提交、推送、改写历史或绕过失败门禁。请先读[仓库规则](../../../AGENTS.md)；英文等价入口见 [outlive-pre-push-en](../outlive-pre-push-en/SKILL.md)。在仓库根目录执行命令。

## 识别改动

1. 运行 git status --short --branch 和 git diff --check；同时查看 staged、unstaged、untracked。若有远端评审，先确认真实 base，再看相对 base 的完整差异；不要猜 base，也不要覆盖其他人的改动。
2. 按 behavior、protocol、storage、tooling、docs、tests 分类，找出受影响的 owner、消费者和失败路径。当前行为以源码、测试、[模块文档](../../../docs/modules/)为准；[V2 总纲](../../../docs/outlive-agent-v2.md)仍是提案。

## 选择门禁

只运行能否定这次改动的最窄检查，跨边界时再扩大：

- 包内行为：先运行拥有者包的 test/typecheck；契约或生成声明变更时先构建，再运行 pnpm typecheck 和相邻消费者测试。
- 仓库脚本：运行相应脚本测试；工程脚本可运行 pnpm test:engineering。
- 文档和 Note：使用本仓库现有 docs eval，并手工核对改动的本地链接、frontmatter、V2 manifest/roadmap；详见 [文档同步](../outlive-doc-sync-zh/SKILL.md)。
- 依赖/锁文件：运行 pnpm verify:lockfile；安全审计需要网络，不把它当作离线已验证。
- 广泛运行时变更：按影响扩大到 pnpm test、pnpm evals 或 pnpm test:e2e；E2E 可能需要服务和凭据。
- 发布产物变更：按[发布检查](../outlive-release-check-zh/SKILL.md)检查；release:bundle 会写文件，不能拿来做默认只读门禁。

不要只因“推送前”就无条件跑全套，也不要因已有绿灯而重复同一命令。记录准确命令、通过/失败/未运行、所覆盖的范围；检查 selected test count，零测试不算通过。失败时停止“已可推送”的判断并报告阻塞，不静默更新基线或跳过门禁。

## 输出

交付改动范围、选中门禁及原因、每条命令结果、未覆盖风险。若用户另外授权推送，推送后远端 CI 仍需单独核实；本 Skill 的本地成功不是远端成功。
