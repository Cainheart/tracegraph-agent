# EVAL-074：公开 Memory / Experience 基准

本次按用户授权，使用两个公开数据集完成配对评估。结果用于探索当前实现，不代表线上真实用户分布。逐题指标、模型版本、输入摘要与重采样区间由机器可读[报告](report.json)记录；逐项结果在 `longmemeval-items.jsonl` 和 `longmemeval-v2-items.jsonl`，并带有 canonical event 引用。

## 数据集

- [LongMemEval](https://arxiv.org/abs/2410.10813) 是 ICLR 2025 的长期对话 Memory 基准，覆盖跨会话、多跳、时间推理、知识更新和拒答；使用 [MIT 清理版](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)的 500 个问题。原始问答文件 SHA-256：`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`。同一问题内重复的 13 个 session 引用经内容一致性验证后合并，日期变体保留；剩余 23,854 个按问题计的 session-candidate 条目无截断，拆为 75,242 个可召回 Memory 片段。
- [LongMemEval-V2](https://arxiv.org/abs/2605.12493) 是 2026 年提交、页面标为 work in progress 的预印本；其 [Apache-2.0 数据卡](https://huggingface.co/datasets/xiaowu0162/longmemeval-v2)描述了 451 个问题和 web/enterprise agent 经验轨迹。使用官方 small haystack 映射中的 200 条轨迹；去除依赖图片的 29 道题后，对 422 道纯文本题计分。抽样轨迹保留 goal/outcome 与最多 8 个等距 action/thought 快照，不注入截图或 accessibility tree；无截断。

输入哈希、上游仓库 commit、预处理文件哈希和许可均记录在 [report.json](report.json)。原始数据和模型回答只在本机临时目录中处理，完成后删除；此处只保留问题级分数、检索 ID 与回答指纹，不保留对话文本或模型回答。

## 配对方案和指标

每个问题各跑 control 和 treatment，问题内顺序以固定 seed 随机。Control 不给召回内容；treatment 只加入 Memory 或 Experience 上下文。模型固定为本机 Ollama `qwen3:4b-instruct`（digest 记录在机器报告中）、temperature 0、seed `20261003`，Memory top-8、Experience top-5、各自上下文预算 4,096 tokens；全部模型与裁判请求仅访问 loopback Ollama。QA 输出上限为 512 tokens；评测脚本遇到 Ollama `done_reason=length` 会拒绝该回答，避免截断文本进入评分。早期尝试曾在少数长题触发 256、512、1,024 和 4,096-token 上限；这些截断项未评分。V2 随后统一加入多选题只输出选项的格式规则，并从干净缓存重跑整条 lane。

Memory 的召回资格与排序使用生产代码 `evaluateMemoryRecallEligibility` / `rankEligibleV2Memory`，主要结果为 NFKC/标点归一后的 exact match；另报告 answer-session recall@8、hit rate 和 MRR。补充分数使用 LongMemEval 上游 [`evaluate_qa.py`](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py) 的任务提示与标签口径，但由本机 instruct 模型代替上游 GPT-4o 裁判，因此不等同于官方 leaderboard 成绩。Experience 案例由生产 `ExperienceCaseService` 创建、经 harness 的确定性模拟 reviewer 标记 validated，再进入真实 recall 路径；问答按上游 LongMemEval-V2 `eval_function` 计分。需要 LLM rubric 的 V2 项使用本机 instruct 模型按上游 judge prompt 与 parse function 评分，同样不可直接对比托管模型裁判成绩。

结果提供 treatment-control 配对 wins/ties/losses、平均差和 10,000 次 task-family-stratified paired bootstrap 95% CI。Memory retrieval 单臂均值的区间也按 task family 分层重采样。每题只运行一次，结果应视为探索性点估计。

## 结果

| Lane / 指标 | Control | Treatment | 配对差值与 95% 区间 | Wins / ties / losses |
| --- | ---: | ---: | ---: | ---: |
| Memory normalized exact match（主指标） | 0/500（0.0%） | 42/500（8.4%） | +8.4 pp `[+6.4, +10.6]` | 42 / 458 / 0 |
| Memory 上游答案评分提示 + 本地 judge（补充） | 33/500（6.6%） | 185/500（37.0%） | +30.4 pp `[+27.2, +33.6]` | 155 / 342 / 3 |
| Experience 上游 `eval_function` / rubric | 43/422（10.19%） | 69/422（16.35%） | +6.16 pp `[+3.32, +9.00]` | 34 / 380 / 8 |

Memory answer-session recall@8 为 `0.6763`（95% CI `[0.6460, 0.7060]`），hit rate@8 为 `0.836`（`[0.804, 0.866]`），MRR@8 为 `0.7634`。逐 task-family 分项、逐题分数和来源 event ID 见机器可读[报告](report.json)与两份 item JSONL。三个 paired CI 均按 task family 分层做 10,000 次重采样；Memory 补充 judge 指标使用 seed `20261007`。

LongMemEval 的补充分数使用上游 [`evaluate_qa.py:get_anscheck_prompt`](https://github.com/xiaowu0162/LongMemEval/blob/9e0b455f4ef0e2ab8f2e582289761153549043fc/src/evaluation/evaluate_qa.py) 提示模板，但由本机 `qwen3:4b-instruct` 作 yes/no 裁判，不是上游 GPT-4o 判分，也不能直接比较 leaderboard。Exact match 保留为透明主指标。V2 的 rubric judge 同样在本机运行。

本次生成答案 1,844 次，本地 judge 1,256 次（合计 3,100 次 Ollama 请求），远端模型请求为 0。可读到的本地 judge token 合计 352,247；本地回答 token 按报告中的 Ollama 用量字段记录。模型调用累计运行时为 1,653,065 ms；judge 累计评分延迟为 434,745 ms。最终恢复进程耗时 822,581 ms 只覆盖最后一轮 V2 恢复，不是端到端总时长。Ollama 未提供可核验的计费成本。

## 安全门与限制

本次另跑 6 个相关测试文件，共 40 项通过：Memory governance/lifecycle、V2 Memory recall、Experience lifecycle、Runtime Memory/Experience recall、Context provenance。覆盖 stale/out-of-scope/revoked 排除、冲突与非法状态阻断、review 状态、Runtime feature gate 和 provenance。它们是本机工程负例门，不替代质量分数，也不证明任意 prompt-injection 攻击下的安全性。

此评估使用公开基准而非经授权采集的线上用户样本；不测真实用户分布、长期新鲜度漂移、人类 Experience 准入质量、跨 Run 复用、完整 Runtime 上下文注入或实际任务完成率。V1 补充 judge 虽采用上游答案评分提示，仍由本机模型代替托管裁判；V2 的 rubric judge 也在本机执行。每题仅运行一次，结果不能证明普遍收益或无伤害。

逐题评分事件位于 canonical trace `run:ccb861a365e6` 的序号 29–950；评估闭环事件为 `evt:run:ccb861a365e6:000951`。原始基准文本、回答与裁判缓存及本轮下载的本地模型均已清理，报告和逐题聚合指标保留。
