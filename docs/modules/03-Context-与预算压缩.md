# 模块 03：Context 组装、策略压缩与 Token 预算

> 定位：决定“模型这一轮看到了什么”，并把取舍、外置原文、摘要调用与 token 减量变成可审计事实。  
> 代码：`packages/core/src/{context,context-compaction,memory,token-meter,model-provider,runtime}.ts`  
> 契约：`packages/contracts/src/{context,memory,token,event,action,common}.ts`  
> 最后核对：2026-09-19  
> 实现状态：**G-02 / G-03 / G-21 Context 注入已验证**

---

## 1. 一句话职责

Context 层在 Host 指定的输入预算内，保留 system/goal 安全锚点，接收 G-21 已排序且先行预算的检索命中，按固定顺序缩减 history 和 tool Observation，并产出一份能回答以下问题的 `ContextManifest`：

- 压缩前后有多少 token；
- 每一步用了什么策略；
- 哪些原节点被哪个新节点替代；
- 完整原文存在哪个 Artifact；
- 摘要由哪个 model call / prompt version 生成；
- 最终可见 token 是否落入输入预算。
- 每条 retrieved Memory 来自哪个 hit、文件和行区间，分数与最终注入 token 是否一致。

G-02 引入了模型摘要，因此这条路径不再是全程纯函数。可重放的是 Manifest、Artifact 和 Event 里的**已发生事实**，而不是依赖重跑 provider 再生成相同摘要。

---

## 2. 两个入口与默认预算

`DeterministicContextBuilder` 保留两个入口：

| 入口 | 用途 |
|---|---|
| `build(input)` | 旧的同步、确定性兼容路径；供存量测试与嵌入调用使用 |
| `buildWithStrategies(input, dependencies)` | Runtime 主路径；可持久化 Artifact、调用 `summarizeContext()`、接收 AbortSignal，返回 `notices` 供 Runtime 落账 |

`DEFAULT_CONTEXT_POLICY` 的总体预算仍是：

| 量 | 值 |
|---|---:|
| 产品窗口 `window_tokens` | 258,000 |
| 预留输出 `reserved_output_tokens` | 32,000 |
| 有效输入预算 | 226,000 |
| 预警阈值 | 70% = 158,200 |
| 压缩阈值 | 80% = 180,800 |
| 默认保留最近历史 | 16 条 |

`258K` 是 Harness 策略，不是对每个 provider/model 的窗口承诺。`token_limit - reserved_output_tokens <= 0` 或固定锚点本身已超预算时，Context 层会 fail-closed，不会删除安全规则来强行发请求。

---

## 3. Surface graph：不就地改历史

`compactContext()` 先把当前可见内容转成 `ContextNode[]`：

- `raw`：初始 system / goal / history / tool 节点；
- `retrieved`：G-21 检索命中；只能属于 `memory` section，并携带 strict provenance；
- `spill_ref`：预览 + opaque locator；
- `summary`：通过 strict schema 的模型摘要；
- `checkpoint`：确定性兜底表示。

策略替代一个节点时，旧 node 只增加 `superseded_by`，新 node 以 `parent_node_id` 指回源节点。Manifest 保留这个表面图，而给模型的 `modelContext` 只使用 active surface。这意味着“从 prompt 移除”不等于“从证据中删除”。

system 锚点额外告诉模型：看到 `artifact:<id>` 时必须从 `offset:0` 开始调用 `read_artifact`，再严格按 `next_offset` 分页直到 `truncated:false`；不得跳 offset、猜测或编造被外置的内容。

### 3.1 G-21 检索不是裸字符串拼接

Runtime 在每轮调用 builder 前完成 recall。MemoryManager 已先执行 `max_hits/max_tokens` 预算、project/run scope、status/trust/source/expiry/superseded 过滤；builder 仍按本轮全局输入余量二次截断。每个仍可见的命中形成：

- `ContextManifestItem {section:"memory", action:"retrieved", content, retrieval}`；
- `ContextNode {section:"memory", kind:"retrieved", retrieval}`；
- 模型 Context 中的 `[memory]` section。

`retrieval` 同时保存 rank、hit id、源内容 hash、BM25 score、source path、heading、起止行与最终 `injected_tokens`。若 builder 因总预算再次截短正文，会同步收窄 `end_line` 和 token；契约要求 item/node 的 hit id、content hash 和 token 账一致。该 source 被标记为 `untrusted`，检索排名不会把仓库/记忆文本提升成 system instruction。

---

## 4. 默认策略链

默认顺序是硬编排序，不是 Map 或配置对象的偶然遍历顺序：

```text
tool_output_pruner
        ↓
spill
        ↓
model_summary
        ↓
tiered_checkpoint
        ↓
hard-budget force fit（仅在仍未收敛时）
```

| 策略 | 默认配置 | 作用 |
|---|---|---|
| `tool_output_pruner` | 阈值 3,000，目标 1,500 | 保留 status/summary、有界标量 facts、observation/receipt id 和 fact keys；只有真实减量才记 step |
| `spill` | 阈值 12,000，预览 800 | 将完整工具原文写为 `spilled_tool_output`，prompt 只保留 head/tail 预览、字节数、hash 绑定 locator；默认阈值与 G-05 从 `tool-output-limits.ts` 共享 |
| `model_summary` | 阈值 24,000，目标 4,096，15s | 摘要最近 16 条之前的 history；同时在全局达到压缩阈值时可触发 |
| `tiered_checkpoint` | 阈值 24,000，目标 4,096 | summary 失败、早期历史过大或总体超预算时的确定性兜底 |

四个策略均有独立 `enabled`。某一步没有降低 active token 时不会伪造 `CompactionStep`。如果开启的策略仍无法使可见内容落入预算，force-fit 会优先处理工具与较旧历史，每份被替代原文仍先归档；连这也不能收敛则抛错，而不发出超预算请求。

### 4.1 工具原文的优先级

如 Observation 已有同 project/run 下的 `tool_output` Artifact，策略链会先用 internal reader 验证 kind/hash/scope，然后以其完整字节作为 spill 源，不会把早已有界的 `content_excerpt` 冒充为完整原文。可选 Artifact 缺失/损坏时，仍可使用已校验的有界 Observation，但不信任未验证字节。

`read_artifact` 自身返回的 Observation 不会被再次 pruner/spill，避免“locator → 回读 → 再外置 → 新 locator”的递归循环。

---

## 5. 结构化模型摘要

summary 不复用 `ModelAdapter.decide()`，而走独立接口：

```ts
summarizeContext(input: {
  projectId: string;
  runId: string;
  modelCallId: string;
  promptVersion: string;
  targetTokens: number;
  sourceText: string;
  onUsage?: (usage: ModelUsageReport) => void;
  signal?: AbortSignal;
}): Promise<unknown>
```

provider 回包先只做 JSON 语法解析，Context 层再用同一个 strict schema 做信任边界：

```ts
{
  facts: string[];
  open_questions: string[];
  refs: Array<{ path: RelativePath; lines: { start: number; end: number } }>;
}
```

还需同时满足：

- JSON 长度不超过 Manifest item 的 12,000 字符边界；
- summary token 不超 `target_tokens`；
- summary token 必须小于源 token，否则它不是压缩；
- `refs.path` 是仓库相对路径，`start/end` 为正数且 `end >= start`。

`facts` 只是模型产生的**不可信有损表示**，不是 TraceGraph 已验证的事实真值。需要准确字节时，必须根据 `refs` 或 archive locator 回查。`archive_locator` 不是 provider 可以自报的 summary 字段：Core 先用上述 strict schema 校验，再归档源文本并把可信 locator 加到最终可见 summary；确定性 checkpoint 也直接包含该 locator。压缩表示不会把“原文在哪里”只藏在 Manifest 里。

### 5.1 失败与降级

| reason | 含义 |
|---|---|
| `model_unavailable` | adapter 没有 summary 能力/未配置 |
| `invalid_summary` | JSON 或 strict schema 不合法 |
| `summary_too_large` | 超目标、超字符边界或未产生减量 |
| `timeout` | 超过 policy timeout |
| `aborted` | 父 Run 取消 |
| `request_failed` | provider/网络其它失败 |

失败会产生 `context.summary_failed {fallback:"tiered_checkpoint"}`。除父 Run 本身已取消外，Context 继续走确定性 checkpoint，不会伪造一份 summary 或直接丢掉早期历史。

### 5.2 Summary usage

summary provider 回报使用量时，Runtime 用 summary 自己的 `model_call_id`、`request_kind:"summary"`、`request_sequence:1` 写 `model.usage_reported`。该请求形状不是 Decision Context，所以 `calibration_applied:false`，不拿它更新 initial request 的 provider/model 校准。

---

## 6. Archive、locator 与 `read_artifact`

被替代的完整原文保存在 `<dataDir>/artifacts`：

| kind | 用途 |
|---|---|
| `spilled_tool_output` | 超大工具原文，对模型暴露预览 + locator |
| `context_source_archive` | pruner、model summary、checkpoint 或 hard-budget 替代的精确源文本 |

locator 形如 `artifact:<artifact_id>`，是 opaque 句柄，不是文件路径；`SpillRefSchema` 强制 locator 必须逐字等于该 `artifact_id` 的这个编码。`read_artifact` 工具本身不持有 ArtifactStore；Runtime 注入 reader，并在每次读取时重做：

1. locator 格式和 artifact id 解析；
2. 当前 Run scope（内部以该 Run 的 `project_id + run_id` 读取，知道其它 Run 的 locator 也不能越界）；
3. kind 必须是上述两种 Context archive；
4. metadata/字节长度/content hash/二次脱敏校验；
5. 成功后写 `context.spill_refetched`，Event 只带 locator/hash/ArtifactRef 与分页范围，不复制全文。

工具输入为 `{locator, offset = 0, limit = 4000}`：`offset/next_offset` 都是 UTF-8 字节偏移，单页 `limit` 为 64..4,000 字节；返回 `bytes_read / total_bytes / truncated / next_offset?`。模型必须顺序分页，不能把 8 MiB 内部硬上限误解成单次 Observation 可见 8 MiB。`read_artifact` 的授权来自**当前 Run 已拥有的 archive**而不是 Workspace 文件能力，所以无文件能力的 Plain Chat 也能回读自己这一 Run 的 spill；它仍不能借此读取工作区文件或其它 Run 的 Artifact。

Artifact root/data/meta 在 POSIX 下使用 `0700`/`0600`，并拒绝 symlink root、错误 owner/权限和 hash 损坏，但**未加密**。两条读取边界不要混淆：

- Host/Web 公开 Artifact Wire：1 MiB；
- Runtime-only `getInternal()`：单个 archive 最多 8 MiB；`read_artifact` 在此边界内按最多 4,000 字节/页回读。

Web `mapContextSources()` 只把 active Manifest item 的 archive 映射为 idle locator；用户打开显式 `<details>` 后，`loadContextArchive()` 才校验当前/所选历史事件 scope 并走公开路由加载。超过 1 MiB、缺失或损坏时只显示 unavailable/corrupt，不会借前端绕过公开上限；仅出现在历史 step、但不属于 active item 的 archive 也不能由 UI 直接取回。

G-05 的 `list_artifacts {offset=0,limit=50}` 补的是“发现”而不是“读取”：Runtime 只汇总当前 project/Run 已在 canonical Event 中引用的 Artifact，排除内部 `recovery_state`，返回 artifact id、opaque locator、kind、hash、MIME、bytes、created_at 等公开 metadata，并按稳定顺序分页；不返回 content。其结果本身也不会再保存成 `tool_output`，避免“每次列举都会多出一个可列举工件”的递归。模型看到一个 locator 并不自动获得读取权：`read_artifact` 仍只允许上述两种 Context archive，继续执行 current-Run、kind、hash 与分页校验。

---

## 7. Manifest 与事件时序

G-02 在 `ContextManifest` 中新增两组 optional 字段：

- `nodes[]`：append-only surface graph；
- `compaction_steps[]`：真实产生减量的步骤，含 section、before/after、归档引用和可选 summary model/prompt 身份。

`compression.strategy` 仍只有 `none/tiered_history_checkpoint`，用于旧消费者兼容；新链的权威标识是 `compression.applied_strategy:"strategy_chain"` 与 `compaction_steps`。

Runtime 的 durable 顺序是：

```text
context.compaction_started
  → context.tool_output_spilled / context.summary_created / context.summary_failed
  → model.usage_reported(request_kind=summary，若 provider 有回报)
  → context.compaction_completed(steps + archive refs)
  → context.budget_warning（仅 warning）
  → context.built
  → model.request_started（Decision 请求）
```

`context.compaction_completed.data.steps` 与 Manifest 相同，但完整 Manifest 仍以 `context_manifest` Artifact 为准。Event 只放有界账目和 ArtifactRef，不把归档原文复制进 Ledger。

这里的“先”是副作用边界：Runtime 在任何 archive `put()` 或 summary provider 调用之前就提交 `context.compaction_started`。因此进程若在外置/摘要期间崩溃，Ledger 不会只剩无法解释的 Artifact/provider 副作用。无压缩时不发这对事件。

---

## 8. G-03 preflight 与 provider usage 分账

G-02 没有改变 G-03 的基本语义：

1. 原始 surface 先由 `TokenMeter` 估算，得到 provider/model 校准比例与逐 section 基线；
2. 策略链使用同一缩放口径作决策；
3. 最终 active surface 再估算一次，通过 largest-remainder 将 section 总量确定性分配回 item；
4. Manifest 保存请求前 `TokenEstimate`；provider 回报只追加 Event，不回写 Manifest。

最终强制：

```text
sum(token_estimate.per_section)
  == token_estimate.input_tokens
  == manifest.input_tokens
  == sum(items[].included_tokens)
```

`heuristic_v2` 对 CJK 按每字 1 token、连续拉丁段按约 3.5 字符/token，符号与空白分别加权，比简单“字符数/4”更保守。有历史 provider usage 时会按 `(provider,model)` 校准；但它仍不包含 provider-owned system prompt、JSON envelope 与完整 wire framing，所以不能称为 provider-exact 逐 section 计费。

---

## 9. 契约强制的主要不变量

1. `input_tokens <= token_limit - reserved_output_tokens`。
2. system 与 goal 是 `pinned`，不允许为了适配预算而丢弃。
3. 每个 `CompactionStep` 必须严格满足 `tokens_after < tokens_before`；零减量策略不生成 step。
4. 第一步的 before = `compression.before_tokens`，后一步 before = 前一步 after，最后一步 after = `manifest.input_tokens`。
5. 各步减量之和 = `compression.before_tokens - compression.after_tokens`。
6. step 顺序只能沿 `tool_output_pruner → spill → model_summary → tiered_checkpoint` 前进；只有 checkpoint 可因处理多个 section 连续出现。
7. summary step 必须同时有 `model_call_id` 和 `prompt_version`。
8. archive 必须与 Manifest 的 project/run 一致，kind 只能是 G-02 的两种 Context archive，且不能在不同 step 重复声明。
9. `SpillRef.locator` 必须严格绑定同一对象的 `artifact_id`，不能以另一个有效 locator 顶替。
10. node id 唯一，`parent_node_id` / `superseded_by` 必须指向同一 Manifest 内的节点。
11. `applied_strategy:"strategy_chain"` 必须至少有一个 step；反之多个 step 不能伪装成旧单策略。
12. `masked` item 的 `included_tokens` 必须是 0；任何可见 item 不能超过契约字符上限。
13. `retrieved` 只能用于 `memory` section 且必须带 provenance；非 retrieved item/node 不能夹带 retrieval metadata。
14. retrieved item/node 的 hit id 与 content hash 必须配对，`retrieval.injected_tokens === item.included_tokens === node.tokens`。

---

## 10. 测试证据

| 文件 | 关键覆盖 |
|---|---|
| `packages/contracts/src/context-g02.test.ts` | policy 兼容/严格性、summary refs、SpillRef locator 绑定/node、step 严格下降/连续账/策略顺序、archive scope/kind、旧 Manifest |
| `packages/contracts/src/memory-g21.test.ts` | retrieved item/node 的 section、provenance、token 与 Manifest 双向引用约束 |
| `packages/core/src/context-compaction.test.ts` | 严格策略顺序、独立开关、invalid/timeout 降级、locator/hash 回读、完整 tool Artifact spill、防递归 spill、300K 级预算收敛 |
| `packages/core/src/memory-g21.test.ts` | recall 预算后命中进入真实 Context builder，Manifest 可解释 source path/lines/score/hash/token；Runtime 每轮在模型请求前自动注入 |
| `packages/core/src/model-provider.test.ts` | OpenAI/Anthropic summary 请求、strict 输出边界、summary usage、错误/取消 |
| `packages/core/src/tool-registry.test.ts` | run-scoped locator 分页回读、offset/limit 上界、Plain Chat 零文件能力下仍只能读本 Run archive，以及 `lists only stable paged metadata from the current Run` |
| `packages/test-support/src/runtime.integration.test.ts` | summary/Event/usage 整链、invalid/timeout fallback、spill→`read_artifact`→hash、原文不进 Ledger、300K 级连续减量账 |
| `apps/web/src/components/ContextBudget.test.tsx` | 被压缩原文在明确 disclosure 后展开 |

精确 `it()` 名以对应测试源码和当次测试输出为准。

---

## 11. 明确边界

1. **策略链主要压缩 history 与 tool，Memory 由独立 recall 先行预算。** `memory/retrieved` 已有 G-21 生产者，并在 hard-budget 下仍受全局 force-fit；`repo` 仍主要是 section vocabulary，没有自动全仓索引/注入生产者。
2. **summary 不是事实真值。** strict JSON 能防止形状漂移，不能证明内容正确；必须保留 refs/archive 作回查证据。
3. **Archive 私有但未加密。** 文件权限、scope 和 hash 不等于 encryption-at-rest。
4. **1 MiB、8 MiB 与 4,000-byte page 是三层边界。** Web 只走公开 1 MiB Wire；Runtime internal 允许校验最多 8 MiB 的 archive；模型每次只得到最多 4,000 字节并按 `next_offset` 分页，仍不是无限大文件管道。
5. **provider 不可用只会使 summary 降级，不会使预算保护失效。** 确定性 checkpoint/hard-budget 路径仍可收敛；若开关组合不足以收敛则 fail-closed。
6. **300K 验收是合成 preflight 口径。** 它证明预算/账目不变量，不证明每个 provider 支持该窗口，也没有评测摘要事实正确率。
7. **Archive locator 本身不是长期记忆。** G-21 已另行提供 canonical Memory JSONL、准入与 BM25 recall；G-02 archive 仍只是当前 Run 的压缩原文回读，不能被误当成 Memory record、检索索引或忘却策略。
8. **`list_artifacts` 不扩大读取权。** 它只给当前 Run 的公开 metadata，排除 recovery payload 且不返回 content；非 Context Artifact 不能借 `read_artifact` 读取，跨 Run 也始终拒绝。

---

## 12. 相关文档

- 模块 01：Context/Token/Event/Artifact 契约
- 模块 02：Runtime 中的落账时序
- 模块 04：`read_artifact` 工具与能力边界
- 模块 05：Artifact Store、公开/内部读取与投影
- 模块 06：OpenAI/Anthropic summary provider 适配
- 模块 10：Web Context 原文 disclosure
- 模块 08：G-21 Memory 准入、BM25 检索、来源与 degraded recall
- `../outlive-agent-v2/10-tracegraph-to-outlive-migration.md`：G-02/G-03/G-21 的 V2 去向与迁移边界
