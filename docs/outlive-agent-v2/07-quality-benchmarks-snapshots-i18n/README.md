---
id: outlive-agent-v2-quality-system
title: Outlive Agent V2 质量、回归、文档与国际化
status: proposed
scope: quality
language: zh-CN
parent: ../../outlive-agent-v2.md
last_reviewed: 2026-09-23
---

# 07 · 质量、回归、文档与国际化

## 子模块导航

```mermaid
flowchart LR
  T[Tests & Evals] --> G[Change Gate]
  B[Benchmarks] --> G
  S[Recorded Snapshots] --> G
  D[Docs · i18n · Website] --> G
  G --> E[Release Evidence]
```

| 子模块 | 评审焦点 |
|---|---|
| [测试与 Eval 策略](01-test-eval-strategy.md) | 哪一类问题由哪一层证据回答 |
| [Benchmark 系统](02-benchmark-system.md) | 场景、度量、基线、噪声与回归门槛 |
| [录制会话 Snapshot](03-recorded-session-snapshots.md) | 录制、脱敏、回放、断言和更新审查 |
| [Docs、i18n 与 Website](04-docs-i18n-website.md) | 文档真源、翻译、生成站点和发布边界 |

## 1. 六层证据，不用一个 `test` 包打天下

| 层 | 目的 | 放置位置 | 是否允许网络/真实模型 |
|---|---|---|---:|
| Unit | 局部算法与边界 | owning package `tests/` | 否 |
| Contract/Conformance | Provider 是否满足 seam | owning family/test-support | 否 |
| Integration | 多包真实组合 | app/package integration tests | 默认否 |
| Snapshot | 模型/用户可见行为与 Session 回放 | `snapshots/` | 回放否；录制显式允许 |
| Eval | 行为、检索、记忆质量对比 | `evals/` | 默认否；可有单独 real lane |
| Benchmark | 性能和资源回归 | `benchmarks/` | 否 |

E2E 是部署路径维度，可跨上述层；它不等于“所有测试都跑一遍”。

## 2. Benchmarks

### 2.1 为什么从 `evals/perf` 独立

Eval 回答“效果是否更好”；Benchmark 回答“同一用户路径是否变慢/变大”。二者更新口径、机器噪声和失败解释不同。迁移期间可以保留现有 `evals/perf`，但新跨包性能门进入 `benchmarks/`。

### 2.2 按用户路径组织

```text
benchmarks/
├── AGENTS.md
├── session-open/
├── ledger-append-replay/
├── context-assembly/
├── memory-recall/
├── tool-roundtrip/
├── cancellation-quiescence/
├── recovery/
├── client-hydration/
└── support/
```

不按 package 镜像，因为一次可感知路径通常跨越多个 owner。

### 2.3 首批预算

| 路径 | 主要指标 | 备注 |
|---|---|---|
| cold start | ready time、RSS | CLI/Web/Desktop 分开 |
| ledger append | p50/p95、fsync bytes | 单事件与 atomic batch |
| replay | events/s、peak memory | 1k/10k/100k events |
| context assembly | latency、allocated bytes、token estimate drift | 含 0/10/100 memory hits |
| memory recall | p95、index size、quality fixture score | 性能与效果报告分开 |
| tool roundtrip | runtime overhead，不含工具实际工作 | no-op/fake provider |
| cancel | cancel request→quiescent | 含 process group |
| recovery | damaged tail + pending action | 不允许网络 |
| client hydration | snapshot→interactive | Web/Desktop 分开 |

预算必须写在受评审源码中，环境变量不能静默放宽。报告保留 raw samples、聚合方式、机器信息和基线 commit。

### 2.4 测量纪律

- 固定、合成、脱敏输入；
- 新进程和私有临时根，结束后清理；
- CPU timing 与内存 endpoint 分开；
- 首次运行/warmup 明确；
- 使用 production entrypoint，不复制产品算法到 benchmark；
- CI 使用足够方差余量，reference machine 保存更严格趋势；
- 只有显式 `benchmark:update` 可以改 baseline。

## 3. Recorded-session Snapshots

### 3.1 负责什么

Snapshot 保存真实 Agent Session 的规范化输入和预期输出，用于无 API key 回放：

- model-visible request；
- tool schema；
- canonical events；
- 用户可见 stdout/UI projection；
- workspace 最终状态；
- parent/child Session 关系；
- format migration。

普通组件 DOM、纯函数 golden file 或 CLI help 不属于顶层 snapshots，应留在 owning package。

### 3.2 场景结构

```text
snapshots/<profile>/<scenario>/
├── snapshot.yaml
├── session.vN.jsonl
├── session.1.vN.jsonl          # child 1，如有
├── model-stream.jsonl
├── system-prompt.expected.md
├── tool-schemas.expected.json
├── stdout.expected.jsonl
├── workspace/
└── workspace.expected/
```

`snapshot.yaml` 说明 owner、profile、composition、recording source、format version、平台、workspace 和哪些输出被 pin。

### 3.3 三种模式

| 模式 | 网络/Key | 行为 |
|---|---:|---|
| replay | 否 | 只读 fixture，比较结果 |
| record | 是，显式 | 产生新的当前 generation，不删除旧 generation |
| refresh | 否 | 用旧输入跑新 writer，更新当前输出基准 |

所有更新 diff 必须人工审查。禁止测试失败后无解释地批量刷新。

### 3.4 规范化与隐私

- ID 使用保持关系的 typed token，不把所有值替换成同一个占位符；
- 路径变成 `{{cwd}}` 等稳定 locator；
- 系统提示和 tool catalog 可由单独 sidecar owner 持有；
- secret、真实用户内容、环境路径和凭据必须检查；
- normalization 必须是 fixed point；
- Model prose 不能证明 workspace 副作用，必须比较 `workspace.expected`。

## 4. Evals

保留现有 `evals/`，扩展为：

```text
evals/
├── runtime/       终止、取消、重试、no-progress
├── recovery/      WAL、unknown、reconcile
├── memory/        recall、冲突、过期、遗忘、引用
├── experience/    复用是否提高任务结果
├── retrieval/     BM25/hybrid/rerank 对比
├── safety/        scope、permission、secret、prompt injection
├── docs/          当前声明与实现一致性
└── replay/        trace-to-replay deterministic checks
```

### 4.1 Experience paired eval

同一个任务运行两次：A 不提供经验，B 提供匹配 Experience Case；比较首次通过率、工具次数、token、错误和结果质量。只有 B 在独立验证集上稳定改善，才能声称“Agent 从经验中学习”。

### 4.2 Memory 不是只测 recall@K

同时测试：

- relevant recall；
- irrelevant suppression；
- source citation validity；
- stale/conflict handling；
- cross-scope leak = 0；
- revoked/deleted recall = 0；
- prompt injection from memory；
- token budget and cache stability。

## 5. 回归变更规则

任何基线更新 PR 必须回答：

1. 哪个产品行为有意改变？
2. 哪些 diff 是其直接结果？
3. 是否出现意外字段、token、权限或延迟变化？
4. 是否需要迁移旧 Session？
5. 能否用更窄 fixture 证明，而不是更新整个库？

性能下降不能用“功能更多了”自动接受；需要预算、用户价值和替代方案。

## 6. 文档国际化

### 6.1 UI i18n

目标包：`packages/client/locale`。

- 稳定 locale id：`en-US`、`zh-CN`；
- key 按语义而非英文原文命名；
- 参数使用 typed placeholders；
- 缺失 key 在开发/CI 报错，生产明确 fallback；
- Host 只发稳定 error/status code，Client 翻译；
- 日志、协议 field、event type 不翻译；
- Desktop/Web/TUI 共用术语表，但呈现可以不同。

### 6.2 文档配对

公共长期文档采用三件套：

```text
architecture.md
architecture.zh.md
architecture.i18n.yaml
```

YAML 记录两侧 hash、最后确认时间和 schema；它只表示“人工确认语义一致”，不是自动翻译质量证明。

```yaml
schema_version: 1
pair:
  en: architecture.md
  zh: architecture.zh.md
confirmed:
  en_sha256: "..."
  zh_sha256: "..."
  at: 2026-09-23
```

提案期 V2 文档先以中文为主，frontmatter 标明 `language: zh-CN`；接受为公共规范后再分批建立英文 pair，不能为了“看起来双语”生成未经评审的整库翻译。

### 6.3 术语真源

维护 `docs/i18n/terminology.md`，固定 Agent、Run、Turn、Step、Receipt、Observation、Session、Memory、Experience、Ledger、Projection、Replay、Workspace、Provider、Capability seam 等核心术语。UI、README 和技术文档不得各自翻译。

## 7. 文档门禁

建议 `pnpm doc-sync` 聚合：

- frontmatter/YAML schema；
- Markdown links/anchors；
- generated catalogs fresh；
- package README required sections；
- current/target wording lint；
- i18n pair hash/structure；
- event/tool/protocol catalog；
- V2 manifest 的路径完整性；
- roadmap dependency DAG 无环。

检查默认只读；带 `--write` 的命令必须显式指定目标。

## 8. Website

Website 进入 Phase 8，而不是架构 Phase 0。届时：

- 从 `docs/` 读取，不复制正文；
- build 同时做 dead-link、Mermaid 和版本导航检查；
- 当前版与 V2 proposal 明确分栏；
- 展示可运行 demo、evidence bundle viewer 和 benchmark dashboard；
- 不把营销页面的承诺反向当成实现真源。

## 9. 质量完成标准

- 行为、效果和性能各有独立证据层；
- recorded Session 可无 key 回放；
- Memory 的错误召回、越权和遗忘有负面测试；
- benchmark 能指出改动前后，而非只打印一个数字；
- docs 清单、链接、生成图和 roadmap DAG 在 CI 可验证；
- 中英文支持有一个明确真源和 fallback，不在组件中散落条件分支；
- website 未出现之前，README/docs 仍可完整使用。
