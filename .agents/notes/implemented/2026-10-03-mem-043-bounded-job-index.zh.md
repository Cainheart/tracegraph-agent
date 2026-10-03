---
id: 2026-10-03-mem-043-bounded-job-index
title: 限制 Memory 任务查询成本并验证模型记忆纠正链
status: implemented
owners: [memory, workbench]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [memory-background-pipeline, memory-control, workbench]
supersedes: []
---

# 限制 Memory 任务查询成本并验证模型记忆纠正链

## 问题

审查发现两点：用户纠正的模型记忆保留 model origin 并追加用户证据，被原先仅允许 derived 的检查排除；任务查询虽然只返回 100 条，却每次读取全部 Run 两遍。

## 当前状态

确定性归并和持久任务可检查已实现。纠正后的模型 Memory 现可沿可信用户修订链参与；任务 GET 只读按项目限制为最近 100 条的可回放索引，冷启动恢复过程对 UI 可见。

## 决策

沿最多 64 层 canonical correction links 验证到原始模型派生 seed。每次纠正均绑定用户 actor、不可变 claim digest、精确 scope、version、supersession 和预期追加的用户证据；最初 Run 来源仍须通过校验。

已增加按 canonical project scope 分桶的只读内存任务投影，每项目最多保留最近 100 个。后台恢复用 canonical Run identity 和 operational job state 重建；本 worker 成功持久化状态后更新。查询只读允许项目的桶，合并后最多返回 100 个；空 scope 零读取。已增加可选 `backgroundJobsLoading` 字段标明冷启动历史尚不完整，UI 不能把此时空列表称为没有任务。

## 替代方案

独立权威 job 数据库会重复 canonical 事实；每次刷新扫描全 Run 则请求成本无界，均不采用。

## 不变量

cache 可丢弃，不授予 scope 或 Memory 权威。project scope 来自 canonical Run 事件。纠正 ancestry 不允许缺失、已删除、未提交或越界来源绕过校验。历史 warmup/rescan 是后台工作，不成为查询等待条件。

## 迁移与回滚

无需迁移 Memory 或 job payload。可选 history-loading 字段兼容旧响应。移除 cache 可回到旧扫描路径，canonical 记录保持不变。

## 验收

- [x] 派生→用户纠正→激活→新 Run 支持 exact 和 changed-key 对照。
- [x] 坏纠正链与已删除祖先 Run 不能绕过检查。
- [x] 多项目大历史下查询读取有界，空 scope 零读取，冷启动可见 loading。
- [x] 窄测试、Runtime 集成和当前文档一致。

## 风险

cache 反映最近后台刷新及当前 worker 的成功写入；多个 Host 共享 Memory 控制数据仍不受支持。来源删除在后台刷新时同步。每项目超过 100 个的更早任务明确省略。

## 证据

- 实现：[纠正链验证](../../../packages/core/src/domains/memory/memory-control.ts)、[任务恢复与有界查询](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)、[Runtime loading](../../../packages/core/src/domains/runtime/runtime.ts)、[可选响应字段](../../../packages/contracts/src/memory-control.ts)、[共享 UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.tsx)。
- 测试：[任务与链校验](../../../packages/core/src/domains/memory/memory-background-pipeline.test.ts)、[Runtime](../../../packages/core/src/domains/runtime/runtime.memory-episode.test.ts)、[协议](../../../packages/contracts/src/memory-background-jobs.test.ts)、[UI](../../../packages/workbench/src/components/MemoryBackgroundJobs.test.tsx)、[真实 Desktop Host](../../../apps/desktop-host/src/desktop-host.e2e.test.ts)。
- 当前文档：[Memory 模块](../../../docs/modules/08-Memory-记忆子系统.md)、[Memory V2](../../../docs/outlive-agent-v2/04-memory-and-experience/README.md)、[Episode](../../../docs/outlive-agent-v2/04-memory-and-experience/01-evidence-episode-pipeline.md)。
- 2026-10-03 验证（仅进程内 `env -u NODE_OPTIONS`）：Core typecheck/build、pipeline 17 + Runtime 1、contracts 2、Workbench typecheck/UI 4、built Desktop Host 真 e2e 4 通过。350 Run、两项目 fixture 恢复读取 350 次，此后反复单/多/空 scope GET 读取 Ledger 次数均为 0。独立只读复验 pipeline 17 通过；最终 Core 全包 56 files / 468 tests 通过。
- 失败证据：缺失纠正父记录、伪造追加用户 ref 或删除祖先 Run 均不得去重/继承 lineage。竞争 worker 原本在读到 terminal prior 时提前返回，导致本地已缓存 running 永久不更新；现先按 canonical 项目更新投影，再跳过提取，两 worker 同 Run 回归验证一次提取且两边最终 complete。早期测试在文件 rename 后、directory fsync 与索引更新前读取投影，造成重启快照对照失配；测试改等待索引持久化完成，未提前发布未完成 fsync 的状态。
