---
name: outlive-doc-sync-zh
description: TraceGraph 或 Outlive 的当前模块文档、V2 设计文档、索引或 Agent Note 改动后，同步真源并检查链接、状态与现有文档评估；中文流程。
---

# 文档同步

先区分[当前模块说明](../../../docs/modules/)与[提案中的 V2 设计](../../../docs/outlive-agent-v2.md)。源码和测试决定当前能力；V2 文档不能反向证明功能已实现。英文等价入口见 [outlive-doc-sync-en](../outlive-doc-sync-en/SKILL.md)。在仓库根目录执行命令。

1. 找出改动文档的 owner 与入站链接。当前实现变化时更新对应模块文档，再检查 docs/README.md、README.md、README.en.md、DIRECTORY.md 是否需要改；V2 模块迁移时同步 docs/outlive-agent-v2/README.md、manifest.yaml、roadmap.yaml 与旧路径引用。不要用一个目标状态段落覆盖当前事实。
2. 对新增/移动文件，逐个核对相对链接和锚点、frontmatter 的 id/status/parent、manifest 收录与 roadmap task ID/依赖。若改动 DAG，检查依赖都存在、没有重复 ID 与循环；本仓库还没有自动化全量链接/YAML/DAG 检查器，未检查项目必须如实列为未验证。
3. 运行现有的文档一致性评估：

       pnpm exec vitest run --config vitest.evals.config.ts evals/docs
       git diff --check

   执行前先查看 _tmp_evals/ 是否有需要保留的旧结果：评估会截断其中已有的 metrics/*.json，并写入被忽略的报告与指标。它覆盖指定文档/实现映射和发布一致性，**不**等于所有链接、YAML 或翻译语义已通过。检查实际选中测试数与失败信息；不要静默改写评估基线。
4. 输出修改的真源/索引、检查结果、人工检查范围及残余风险。断链、状态冲突或旧版事实无法证实时，停止“文档已同步”的结论。
