# 2026-10-03 路线图任务验收记录

本报告保留 UX-086 之前的历史任务数量、基线、归档摘要与观察回执。新增任务后的当前进度见[71 项任务表](../outlive-agent-v2/09-implementation-roadmap/README.md)，首轮工作台改造见[UX-086 历史报告](ui-086-workbench-ux/README.md)，三端共享 Host、全页面二次验收与新归档见[当前工作台报告](unified-local-workbench/README.md)；旧摘要不证明新界面或新 Desktop 命令。

本轮按 `roadmap.yaml` 的验收范围实施，并修正进度页与当前能力文档。工作树原有未提交实现全部保留；本轮没有 commit、push、tag、npm 发布或站点部署。代码版本仍是 `0.1.0-alpha.0`，这是一份本地工作树验收记录，不是远端发布证明。

当前状态：此前 9 项工程验收保持完成；EVAL-074 公开基准与 REL-084 用户授权模拟均已完成各自验收范围。真实分布质量与真实非维护者独立验收仍是尚未取得的更强外部证据；P0 四项记录已按当前实现核对。

canonical trace `run:ccb861a365e6` 保留 922 条逐题评分事件（序号 29–950）、EVAL-074 完成事件 `evt:run:ccb861a365e6:000951` 与 REL-084 回执更新事件 `evt:run:ccb861a365e6:000952`；最终 workflow terminal event 在验收链完成后追加。

## 任务状态与证据入口

| Task | 当前结果 | 可检查的交付物 |
| --- | --- | --- |
| MEM-043 | 已完成 | 跨 Run 精确去重、变化候选 lineage、纠正来源链验证、可恢复后台任务状态与共享 UI；[实现 Note](../../.agents/notes/implemented/2026-10-03-mem-043-cross-run-job-control.md)、[查询与纠正链复审](../../.agents/notes/implemented/2026-10-03-mem-043-bounded-job-index.md) |
| EVAL-074 | **公开基准已完成：exploratory** | [LongMemEval / LongMemEval-V2 配对报告](2026-10-03-eval074-public-benchmarks/README.md)：922 对、逐题评分、task-family bootstrap CI 与本地评分边界；线上真实分布仍未知 |
| I18N-075 | 已完成 | [共享 locale 与术语](../i18n/README.md)；Web/Desktop/现有 CLI 适配器一致，fallback 可测；没有完整 TUI |
| DOC-076 | 已完成 | [双语配对登记](../i18n/pairs.yaml)、漂移/链接/YAML/漏登记门；历史译文明确未人工审校 |
| DOC-077 | 已完成 | [生成目录](../generated/README.md)、来源指纹与 `--check` 门 |
| DEMO-080 | 已完成 | [脚本](../../demos/proofs.mjs)：真实 SIGKILL、Runtime 恢复、WAL 对账与重复操作零变更 |
| DEMO-081 | 已完成 | 同脚本：真实请求 Manifest/MemoryUse、原版与纠正版 Capsule 校验、撤销后排除；每一版必须单独同意导出 |
| DEMO-082 | 已完成 | 同脚本：真实进程树、durable cancel、PID 与 POSIX 进程组全部消失 |
| REL-083 | 本地预览归档与隔离安装已验收 | [安装说明](../releases/README.md)、checksum/SBOM/版本/限制；隔离 Linux 安装和真实 macOS Preview 窗口分别验证 |
| REL-084 | **模拟验收已完成** | [模拟验收报告](2026-10-03-rel084-simulation/README.md)；明确标注维护者 Agent 模拟、复用本机 pnpm 缓存和同摘要既有 GUI 回执，不声称真实非维护者通过 |
| SITE-085 | 本地站点已完成 | [站点说明](../site/README.md)：只投影32页 canonical `docs/`，本地搜索/状态/版本/源码可核验；无部署、无未审译文发布 |

## P0 记录对齐

- **GOV-001**：根 AGENTS 保留父级规则优先级，Notes/Skills 的入口、生命周期和事实源可定位；源文件存在本身未被用作完成证明。
- **DOC-002**：`verify:v2-docs` 验证 11 个 manifest 文档与 64 个 DAG 任务；5 个 checker tests 包含缺文件、非法状态、重复 ID、循环依赖以及 CLI 非零退出反例。
- **BASE-003**：已从最终源码重生 [当前基线](../generated/current-baseline.md)：22包、192个test/eval文件、104事件类型；`pnpm baseline:current:check` 通过。
- **BOUND-004**：根 README、Memory/客户端/发布 owning docs 与迁移基线已对齐；V2 总设计继续为 `proposed`，不因局部实现完成就整体宣称 shipped。

## 最终预览归档与 REL-084 模拟回执

冻结预览归档 SHA-256 为 `79a06960f699339c0c5136497f535bf0e0e515d17fc6b5415d18595ed7534827`，release manifest SHA-256 为 `337c9331a9002af4fcb3e388234dba1c86b8eb6905ef35f744698b43eba96b75`，CycloneDX SBOM SHA-256 为 `914832f9e02f26f7547785aea5c1d232f583fa2160cb44ae9e590cc1536b12dc`；归档内 `SHA256SUMS` 对 tar 与 manifest 的校验均通过。

REL-084 的用户授权模拟从新解压的 macOS arm64 目录执行 `node scripts/preview-install.mjs --desktop`、`node scripts/preview-smoke.mjs` 和 `node demos/proofs.mjs`；安装、CLI/Host smoke 以及 DEMO-080/081/082 全部通过。可检查[模拟说明](2026-10-03-rel084-simulation/README.md)、[机器回执](2026-10-03-rel084-simulation/report.json)、[smoke 报告](2026-10-03-rel084-simulation/installed-smoke.json)和[证明报告](2026-10-03-rel084-simulation/public-proofs.json)。Desktop GUI 的同摘要可见窗口回执来自此前 canonical event `evt:run:48af35a3438c:000008`，见[观察记录](2026-10-03-rel084-simulation/desktop-preview-event.json)。本次模拟由维护者工作区中的 Agent 执行，复用了宿主 pnpm 内容缓存；不构成真实非维护者或无缓存机器验收。

用户要求清理临时文件；报告和事件记录冻结后，已删除本轮 7 个 `_tmp_release/2026-10-03-*` 目录、两组 `/tmp` 数据/归档缓存、JSONL 探针、两组安装 smoke 临时目录、4 个 Python bytecode 文件，以及本轮下载的 `qwen3:4b-instruct` 模型。清理后逐路径确认目标不存在；原有 `qwen3:4b`、正式报告、实现脚本和 canonical trace ledger 均保留。

## 复审中修正的具体问题

1. 历史 Run 文件名将 `run:UUID` 转成 `run_UUID`，恢复现从 canonical 首事件恢复身份，不再以文件别名查询任务。
2. waiting 状态落盘与旧 worker 退出之间有丢失唤醒窗口；配置恢复现在先等待活动任务结清再入队。
3. 模型派生 Memory 经用户纠正后增加用户来源引用，旧检查将其永久排除；现在沿有界 canonical correction/lifecycle 链回到原 Run 验证。坏链、删除原始证据和跨 scope 均拒绝。
4. Job GET 曾逐次扫描所有历史 Ledger；现在后台恢复构建每项目最近 100 条的可丢弃投影。350 个 Run/两个项目的测试验证重复 GET 和空 scope 都零 Ledger 读取；冷启动显示历史未恢复完毕。同 Run 两个 worker 竞争时，后者读取 durable terminal 状态后刷新本地投影。
5. Preview 依赖的 Workbench CSS 原来只在 source；构建现在复制到 dist 并通过正式 exports 提供。
6. Preview 曾无条件启动 Desktop Host；真实 Main 测试与原生窗口观察确认 preview 跳过 Host 和 Host user-data 路径，正常启动仍创建 Host。
7. 安装归档使用封闭清单，拒绝额外 pnpm hook/config/workspace/脚本，并禁用 pnpmfile。macOS tar 生成时排除 AppleDouble；所有 Host/Runtime 清理成功后才提交 passed smoke 回执。

## 验证边界

公开证明使用合成公开内容和可控模型决策，但 Runtime、文件修改、SIGKILL、WAL、Ledger、MemoryUse、Capsule 校验与进程回收均执行真实实现。因此它们证明工程语义，不证明真实 Provider 质量。

Linux 安装验收使用官方 `node:22.19.0-bookworm-slim` 的隔离容器，只挂载只读发布归档目录，容器内安装精确 pnpm，解压后执行 frozen install、CLI/Host smoke 和三条证明。没有挂载仓库源码、宿主 node_modules 或用户数据。容器使用 init 回收孤儿进程；这不是签名平台安装器或裸机系统兼容性证明。

macOS 验收在独立新目录安装 Electron，通过实际原生窗口看到“演示预览”，同时检查该应用没有 Desktop Host worker。维护者/Agent 的以上验证不能替代 REL-084 的真实人员。

## 已完成的本地检查

- `pnpm build`：22 个 workspace 项目构建通过；随后 `pnpm -r --if-present typecheck` 与 `pnpm typecheck:evals` 通过。
- Coverage：161 个测试文件、1242 项测试通过；全局行覆盖率 77.02%，contracts/context/policy 各子门槛全部通过。MEM-043 独立 Core 整包 56 文件、468 项通过，pipeline 双实例回归另经独立复审 17 项通过。
- Offline evaluations：17 文件、32 项通过；全部 5 个 recorded snapshots 和 CLI Host E2E 4 项在本轮通过。
- `pnpm verify:boundaries`：22 包、49 workspace 依赖、1968 import references，0 legacy findings；`pnpm verify:invariants` 检查 271 个源文件。`pnpm verify:v2-docs` 验证 11 文档、64 路线任务及 5 项负例测试。
- `pnpm verify:lockfile`：23 manifests，精确 pnpm 11.19.0、lockfile v9；`pnpm audit --audit-level=high` 通过高危门，报告 1 个 low severity。`git diff --check` 通过。
- `pnpm verify:i18n` 验证55组配对零漏登记；`pnpm docs:check`、`pnpm site:check`、`pnpm site:build` 与 `pnpm baseline:current:check` 均在站点收尾后通过。最终 `pnpm test:engineering` 通过94项 Node测试与8项 Vitest测试。

## SITE-085 本地站点证据与范围

`pnpm site:check` 对选中的32页检查526条本地引用、5块 Mermaid 的实际语法，并报告488条 repo-only 引用没有验证远端可达性。真实构建 `pnpm site:build` 通过；独立审查核对32页原文与SHA-256、搜索索引420节/32路由以及构建产物1768条内部链接和锚点，均在允许范围内且零断链。站点/预览门 12/12 负例通过；Safari 看到 CURRENT/PROPOSED、真实版本、中文原文、可读图和搜索跳转。预览服务实际 socket 只监听 `127.0.0.1`，对路径越界/软链接/错误版本的请求返回404。CI 已接入站点构建，工程门包括投影负例。

[站点源说明](../site/README.md)、[页面清单](../site-pages.json)、[本地构建产物](/Users/cain/Downloads/ai-job-search-master/tracegraph-agent/docs/.vitepress/dist/index.html)供继续核查。本地预览地址是 `http://127.0.0.1:4173/0.1.0-alpha.0/`，只在当前机器上可访问。52组历史配对保留 `legacy-unreviewed`、3组仍为 draft；55组配对的机械检查通过，`--require-reviewed` 按设计拒绝未经人工审校的内容。站点明确排除60页，包括这些译文和内部来源分析；网站没有对外部署。

## 仍缺的外部输入

- EVAL-074 更强的真实分布证据：本次公开 benchmark 已完成；若要声明线上真实分布质量，仍需单独授权、最小化并冻结真实 holdout，按预注册 rubric 独立评分并交付可审计报告。具体输入见 [交接说明](external-acceptance.md)。这一更强研究不阻塞本地 CI。
- P8 更强的外部信任证据：当前 REL-084 的用户授权模拟范围可独立完成；若要声称真实用户独立验收并满足 P8 外部退出条件，仍需至少一位真实非维护者按归档内文档完成安装、CLI/GUI 与证明复现，并提交环境、归档摘要、失败点、修正文档后的重跑和结论。

本轮没有收到真实分布 holdout，也没有真实非维护者参与。两项更强外部主张继续保持 unknown/unverified；用户要求的公开 benchmark 与维护者模拟验收则已完成。
