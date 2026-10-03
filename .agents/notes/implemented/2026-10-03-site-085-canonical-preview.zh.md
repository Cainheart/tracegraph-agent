---
id: 2026-10-03-site-085-canonical-preview
title: 将规范文档投影为有界的本地 VitePress 预览
status: implemented
owners: [docs, repository-governance]
created: 2026-10-03
last_reviewed: 2026-10-03
language: zh-CN
affects: [docs, scripts, package.json, pnpm-lock.yaml, ci]
supersedes: []
---

# 将规范文档投影为有界的本地 VitePress 预览

## 问题

SITE-085 要求在 P1–P7 和发布前置条件满足后提供可复现的文档投影。仓库已有 locale、翻译新鲜度和参考目录生成门禁，现在需要保留这些边界的站点。文档混合了当前行为、提案设计、内部来源材料和未审校译文；直接发布整个目录会抹平这些边界。

## 当前状态与已验证前置条件

协调任务确认 Memory 修复与独立审查后才开始实现：Core 56 个文件 / 468 个测试、同 Run 竞争 worker 回归和纠正记忆/缓存检查均通过。发布归档的干净安装/证明场景与 Desktop 预览边界也已验证。可选外部质量评估仍未评测，非维护者验收仍待执行；本地站点不声称它们已经完成。

## 已实现的投影

锁文件安装精确版本 VitePress 2.0.0-alpha.20、Vue 3.5.43 和 jsdom 26.1.0，并使用既有精确 Mermaid 12.0.0 catalog。VitePress 使用仓库的 Vite 8 依赖族。安装后的冻结锁文件验证和高危依赖审计均通过。这些属于源码 checkout 的开发依赖；运行时预览归档不包含站点源码。

直接读取仓库文档目录中的规范 Markdown。显式页面清单选择文档索引、当前模块参考、生成的事件/工具/模块/profile 目录、发布/安装/限制说明、locale 治理，以及 Runtime/Session 和 Command/Query/Event 两篇提案设计。内部 reference-lineage、Agent Notes、未审校译文、历史诊断基线和大型生成模块图不进入站点。这是范围有限的首次投影，不代表全部仓库文档或全部设计 Mermaid 块均已发布或验证。

每个选定页面展示源路径及精确摘要、真实包版本、源语言和 current/proposed 状态。本地全文搜索只索引选定的规范页面。不虚构 stable 发布、历史版本或已审校译文；不可用的版本/语言切换不显示或明确标为不可用。源链接重写区分已选站内页面、仅仓库参考与被排除译文。构建输出提供 UTF-8 源文件查看页与字节不变的 Markdown 下载产物；不存在单独维护的 Markdown 正文。

## 考虑过的替代方案

将文档复制到站点源码树：拒绝，因为会产生漂移。发布全部 Markdown：拒绝，因为内部资料与未审校译文会成为公开内容。采用第二个 CMS 或托管服务：不在范围内。VitePress 1.6.4 是已发布的 stable 替代方案，但使用独立的较旧 Vite 依赖族；预览选定版本必须记录在锁文件与真实验证证据中。

## 不变量与失败策略

选定页面未知或缺失、版本不匹配、状态元数据缺失/矛盾、页面清单包含未审校译文、本地文件/锚点断链或选定 Mermaid 语法错误，均使构建失败。Mermaid 校验必须在受控 DOM 环境调用真实解析器；统计代码块不足以验收。未选择页面明确报告为投影范围之外，不得悄悄称为已检查。VitePress token 决定真实 Mermaid 围栏与标题锚点。include/snippet 指令、非规范路径和 symlink 别名均直接失败。不引入网络部署、遥测、凭据或托管搜索服务。本地静态预览只绑定 127.0.0.1 并拒绝路径穿越；不使用已安装版本会忽略 host 参数的上游 preview 命令。

## 迁移与回滚

文档文件继续作为真源。回滚时移除站点配置、渲染器和仅站点使用的依赖/脚本接线；不改变领域状态或用户持久数据。构建缓存和生成的静态输出保持忽略。未来公开部署或扩展到已审校译文，必须有独立审校证据与范围决定。

## 验收标准

- 从当前规范文档完成真实本地构建，具备源/版本/状态标识与可用本地搜索。
- 确定性的选择清单与构建清单；路由和搜索均无内部来源材料或未审校译文。
- 已通过本地断链、标点锚点错误、过期/未知版本、全部支持 Mermaid 围栏、include/snippet 导入及未授权发布别名的负例。
- 浏览器检查当前页面、提案页面、搜索、源文件访问和至少一个已渲染 Mermaid 图。
- 前置条件与检查通过后更新当前归属文档，并将本双语 Note 移入 implemented。

## 风险与限制

产物是本地规范文档预览，不是已部署的公开站点或人工认证的双语发布。外部仓库链接与外链可用性不等于强制本地链接门禁。新增站点依赖可能改变预览发布清单，需要父任务在整合后重新生成发布产物。

## 来源与证据

仓库依据：[SITE-085 路线图](../../../docs/outlive-agent-v2/roadmap.yaml)、[DEC-10 治理](../../../docs/outlive-agent-v2/02-repository-governance/02-docs-generation-i18n.md) 与 [站点设计](../../../docs/outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/04-docs-i18n-website.md)。官方技术参考：[VitePress 配置](https://vitepress.dev/reference/site-config)、[路由](https://vitepress.dev/guide/routing) 与 [本地搜索](https://vitepress.dev/reference/default-theme-search)。实现：[投影与门禁](../../../scripts/site-projection.mjs)、[VitePress 配置](../../../docs/.vitepress/config.mjs)、[本地预览服务](../../../scripts/preview-site.mjs) 与 [归属指南](../../../docs/site/README.md)。站点/投影测试 12/12 通过，站点/翻译/目录合并测试 27/27 通过。真实本地构建通过，包含 32 个选定页面、526 处本地引用和五个 Mermaid 图。独立只读审查重放解析/范围负例，并确认构建搜索索引仅包含 32 个选定路由。Safari 核验了 current/proposed 标识、read_artifact 搜索结果打开真实章节、已渲染架构图，以及 SHA-256 匹配且标为未提交快照的 UTF-8 精确源文件查看页。未执行外部部署。
