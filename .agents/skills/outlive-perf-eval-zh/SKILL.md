---
name: outlive-perf-eval-zh
description: TraceGraph 或 Outlive 改动可能影响 Context、模型调用、工具延迟或 SSE 首字节时，运行并解释现有 G16 离线性能评估；中文流程。
---

# 离线性能评估

本仓库已有 [G16 用例](../../../evals/perf/performance.eval.ts)及[基线](../../../evals/baselines/performance.json)，但尚无 V2 全场景 benchmark harness。英文等价入口见 [outlive-perf-eval-en](../outlive-perf-eval-en/SKILL.md)。

1. 明确待比较的场景、改动前后版本、机器/系统/Node 版本与负载。G16 的 Context token 数、模型调用数是确定性约束；工具 P95 与 SSE 首字节受本机调度影响。不要把单次抖动当作产品性能结论。
2. 在仓库根目录先运行 pnpm build，再运行：

       pnpm exec vitest run --config vitest.evals.config.ts evals/perf/performance.eval.ts

   它是离线 fixture，不消耗真实模型 API。执行前查看 _tmp_evals/ 是否有需保留的旧结果：运行会截断已有的 metrics/*.json，并更新被忽略的报告与指标。查看实际测量值、阈值、测试数量，以及是否有功能正确性失败。
3. 如需修改阈值或录入新基线，先解释预算变化和同环境对照，再由维护者审阅 [baseline](../../../evals/baselines/performance.json) 的 diff。TRACEGRAPH_EVAL_UPDATE=1 会写基线，不能用来让失败自动变绿。
4. 报告场景、环境、前后数据、通过/失败以及噪声限制。该结果只覆盖 G16 代表路径；不能推断 V2 Snapshot、桌面端或真实提供商性能。
