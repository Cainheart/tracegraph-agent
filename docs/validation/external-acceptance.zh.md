# 外部验收交接

[English source](external-acceptance.md) · 本中文稿待人工审校。

本页区分用户授权的本地验收范围与更强的外部主张。LongMemEval 公开基准评估和
REL-084 维护者模拟均已完成用户要求的本地范围。公开基准和维护者模拟都不能证明
线上真实用户分布质量或真实非维护者独立跑通。

## EVAL-074：公开基准与真实分布边界

本次要求的公开基准评估使用 [LongMemEval 与 LongMemEval-V2](2026-10-03-eval074-public-benchmarks/README.md)，
配对协议、逐项分数、置信区间、模型/资源记录和限制均已记入该报告。
2026-10-01 的合成 pilot 保留为不可改写的探索性、不确定结果。
Langfuse 仍在普通本地测试和 CI 之外。

公开数据集不等于真实用户分布样本。授权线上总体、新鲜度漂移、人工 Experience
准入和独立验证的 Experience 复用仍未知。若需要更强的真实分布主张，应使用[现有配对研究方案](../outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/05-memory-experience-paired-evaluation.md)，
另行取得授权并最小化 holdout。

取得最终得分前，在外部研究中登记以下信息：

- 精确授权、最小化后的数据范围、冻结 digest、采样总体、holdout/development
  隔离与保留/删除策略。
- 应用 commit 与工作树 digest、模型/Provider 版本、提示词/配置 hash、评分器与
  rubric 版本、两臂随机顺序、重复数及随机种子；两臂只改变相应 Recall 开关。
- 主要结果、有意义的收益/伤害阈值、样本量计划、排除规则和盲态评分程序。
  必须在查看最终结果前确定，不能把合成 pilot 的效应当成质量承诺。
- 带明确分母的 Memory 相关性、新鲜度、来源支持指标，以及 Experience
  适用性和独立验证的复用结果；两条 lane 都记录伤害和失败。

最终报告须包含逐项配对 run/trace/score 引用、数据集读回验证、wins/ties/losses、
效应与 95% 配对 cluster bootstrap 区间、实际观测的资源成本、排除项与限制。
本地 scope/revoked/deleted/injection 负例门禁证据单独引用。
未观测字段保持 unknown，不确定的结果保持 inconclusive。

用户授权的公开基准验收无需访问私有用户数据，已由完整逐项报告闭环。另行开展的
真实分布研究仍需要授权 holdout、独立评分和可审计报告；2026-10-03 实施时没有
提供这类总体数据，因此该总体的质量仍为 **unknown**。这项后续研究不阻塞本地 CI。

## REL-084：独立安装

2026-10-03 用户授权的模拟已通过。归档、安装/smoke 回执、公开证明、失败记录和
身份/环境边界见[模拟验收记录](2026-10-03-rel084-simulation/README.md)。这闭环了
本次要求的模拟路径，**不能证明真实非维护者曾独立跑通**；这项更强主张仍未验证。

将精确 preview archive、checksum、SBOM 和包内安装说明交给一位非维护者，
在尝试前冻结产物。参与者从新目录开始，不借用仓库的 `node_modules`、
workspace symlinks 或既有数据。隔离容器 smoke 可作为发布证据，但不是人类参与者。

参与者独立按随包文档核验 checksum、安装前置条件与依赖、启动 CLI/Host、打开
Desktop preview，并复现三条证据演示。逐项记录失败步骤及实际输出，不提交凭据或
私有项目内容。若说明修改，记录前后版本，并从声明的初始状态重跑失败步骤。

本轮模拟回执如下；未来真实独立尝试也请完整保留这些字段。空字段不代表成功：

```yaml
task: REL-084
status: simulated-pass
participant_pseudonym: Codex-assisted maintainer simulation
participant_confirms_not_maintainer: false
date_and_platform: 2026-10-03, macOS arm64, Node 24.21.0
archive_sha256: 79a06960f699339c0c5136497f535bf0e0e515d17fc6b5415d18595ed7534827
instructions_revision: INSTALL.txt sha256 1d72053c3bf48ddef6dfadf7b296b6fc229c42926be28c3b79dbb4037d658bf4
initial_environment_and_prerequisites: 维护者工作站的新解压目录；复用宿主 pnpm 内容缓存
checksum_verification: SHA256SUMS 中归档与 manifest 均通过
install_command_and_exit_code: node scripts/preview-install.mjs --desktop; 0
cli_host_observation: preview-smoke 通过；CLI 退出码 0；Host 身份匹配且正常退出
desktop_preview_observation: 同摘要 CUA 回执观察到 preview=1、“演示预览”及零 Host worker；本轮重拍遇到 CUA -10005 超时
recovery_memory_cancel_evidence_refs: [public-proofs.json；DEMO-080/081/082 全部通过]
failed_steps_and_documentation_fixes: [污染解压目录因存在未列入清单的 node_modules 被拒；重新解压后未改代码即通过]
rerun_evidence_refs: [2026-10-03-rel084-simulation/README.md]
participant_conclusion: 授权的维护者模拟通过；没有执行独立非维护者尝试
```

路线图任务中用户授权的模拟验收范围已完成。若要声称真实独立用户验收，仍需
一位真实非维护者完成全部流程并保留失败/修正文档记录；维护者和 Agent 测试必须
如实标注。本轮没有联系参与者，也没有构造外部结果。
