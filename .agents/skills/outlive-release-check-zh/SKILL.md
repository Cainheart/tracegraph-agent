---
name: outlive-release-check-zh
description: TraceGraph 或 Outlive 的版本、包入口、锁文件或私有构建产物变化时，检查现有发布一致性与产物边界；中文流程。
---

# 发布检查

当前仓库只生成校验和覆盖的**私有 workspace bundle**，不是 npm 发布、签名证明或 V2 产品演示。英文等价入口见 [outlive-release-check-en](../outlive-release-check-en/SKILL.md)。先读[发布模块说明](../../../docs/modules/13-工程化与发布.md)及 [package.json](../../../package.json)。

1. 确认确实要检查的版本、tag、包入口和变更范围；检查 CHANGELOG、包版本、exports/bin、README 中的边界表述。不要从本地构建成功推断用户可安装或远端发布成功。
2. 在仓库根目录按范围执行 pnpm verify:lockfile、pnpm build、pnpm release:check；发布规则/脚本变化还要运行 pnpm test:engineering，文档变化运行[文档同步](../outlive-doc-sync-zh/SKILL.md)。pnpm release:check 需要已构建的 dist，但只检查、不生成 bundle。
3. pnpm release:bundle 会写 _tmp_release/ 并生成私有 bundle；只有用户请求生成发布产物时才运行。执行前检查该目录已有内容，避免覆盖用户产物。不要自动 tag、上传、推送或发布。
4. 报告版本、精确命令、检查结果、产物位置（若生成）、仍未覆盖的安装/恢复/取消/证据演示。若外部发布状态未知，明确写 unknown，不能用本地成功替代。
