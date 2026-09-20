# 模块 07：CodeGraph 代码图

> 定位：把工作区变成一个**确定性、可复算、内容可寻址**的静态代码图；它保留模块依赖拓扑，并产出顶层声明级的受限语义节点，供 Run 的变更诊断与审查使用。
> 代码：`packages/codegraph/src/`（`analyze.ts` 929 行、`diff.ts` 132 行、`impact.ts` 77 行、`hash.ts` 26 行、`path.ts` 40 行、`types.ts` 102 行、`index.ts` 26 行）
> 包名：`@tracegraph/codegraph@0.1.0-alpha.0`（private），依赖 `@tracegraph/contracts` + `typescript`
> 契约：`packages/contracts/src/graph.ts`（`GraphSnapshot` / `GraphNode` / `GraphEdge` / `GraphDelta`）
> 最后核对：2026-09-18
> 实现状态：**部分验证**（`tests/codegraph.test.ts`，vitest；`hash.ts` / `path.ts` 无独立单测，仅经分析器间接覆盖）

---

## 1. 导出的三件事

```1:3:packages/codegraph/src/index.ts
export { analyzeCodeGraph, CodeGraphAnalysisError } from "./analyze.js";
export { diffGraphSnapshots } from "./diff.js";
export { getImpactNeighborhood } from "./impact.js";
```

职责划分干净：

| 导出 | 作用 | 输入 → 输出 |
|---|---|---|
| `analyzeCodeGraph` | 全量扫描工作区建图 | `AnalyzeCodeGraphOptions` → `CodeGraphAnalysis` |
| `diffGraphSnapshots` | 比较两个快照 | 两个 `GraphSnapshot` → `GraphDelta` |
| `getImpactNeighborhood` | 邻域影响面 | `GraphSnapshot` + 节点 id → `ImpactNeighborhood` |

注意：**本包不实现 core 的 `CodeGraphProvider` 接口**。具体适配在 CLI composition 侧完成（见 §2）；`packages/host` 保持传入式、provider-neutral。

---

## 2. 装配位置（关键事实）

`CodeGraphProvider` 的具体适配器在 **`apps/cli/src/composition.ts`**，并由 `apps/cli/src/index.ts` 在创建 `AgentRuntime` 时注入：

```4:23:apps/cli/src/composition.ts
export function createCodeGraphProvider(): CodeGraphProvider {
  return {
    async createSnapshot({ projectId, workspaceRoot, signal }) {
      return (
        await analyzeCodeGraph({
          project_id: projectId,
          workspace_root: workspaceRoot,
          ...(signal === undefined ? {} : { signal }),
        })
      ).snapshot;
    },
    async createDelta({ base, result, patchEventId, signal }) {
      ...
      return diffGraphSnapshots(base, result, {
        ...(patchEventId === undefined ? {} : { patch_event_id: patchEventId }),
      });
    },
    async captureGitContext({ workspaceRoot, signal }) {
      // 固定、只读的 git argv；只返回 base/branch/dirty/fingerprint。
      ...
    },
  };
}
```

`packages/host` 与 `packages/sdk` **不自行构造** CodeGraph，这是刻意的依赖倒置：它们只传输 `RunProjection` 与 SSE 中的 canonical 事件，不能从浏览器参数推导本机扫描器或 Git 命令。标准 `tracegraph serve` 走的正是 CLI composition，因此 Web 获得的是已经注入 Runtime、再经 Host/SDK 传出的图快照、delta 与 `code_intel` 投影；并不存在“Web 另造一个 provider”的路径。

嵌入式 Host 若绕过 CLI composition 创建 Runtime，仍须显式注入 `codeGraph` 才会得到图/CodeIntel。未注入时 Runtime 把 Git 上下文记为 `unavailable`，但不会伪造图、符号或 Git 基线保证。

---

## 3. 扫描范围与硬上限

```41:81:packages/codegraph/src/analyze.ts
const SOURCE_EXTENSIONS = new Set([
  ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx",
]);

const RESOLUTION_EXTENSIONS = [
  ".ts", ".tsx", ".d.ts", ".mts", ".d.mts", ".cts", ".d.cts",
  ".js", ".jsx", ".mjs", ".cjs",
] as const;

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_DEADLINE_MS = 30_000;

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules", "out",
]);
```

| 限制 | 默认 | 超限行为 |
|---|---|---|
| 文件数 | 10 000 | `analysis_file_limit_exceeded` |
| 总字节 | 64 MiB | `analysis_byte_limit_exceeded` |
| 单文件 | 5 MiB | `analysis_file_too_large` |
| 目录深度 | 64 | `analysis_depth_limit_exceeded` |
| 墙钟时间 | 30 s | `analysis_deadline_exceeded` |

`exclude_directories` 只能**追加**，无法移除默认排除项。数值非法（非安全整数、正数约束）抛 `analysis_invalid_limit`；`deadlineMs` 与 `maxDepth` 允许 0。

支持的语言面：**只有 JS/TS 家族（8 个扩展名）**。

---

## 4. 文件发现的防穿越设计

目录遍历 `discoverSourceFiles` 做了完整的符号链接与越界防护：

- 每个目录入口先 `assertSafeWorkspaceDirectory`：`lstat` 必须是非符号链接的目录，`realpath` 必须在工作区内，**且规范化后与传入路径一致**。
- `entry.isSymbolicLink()` 直接 `continue`（目录与文件都跳过）。
- 条目按名称 `localeCompare` 排序，保证遍历顺序确定。
- 命中扩展名即收集，超过 `maxFiles` 立即抛错。
- 每个阶段都有 `assertAnalysisActive(guard, phase)` 检查中止信号与 deadline。

读文件 `readSourceRecords` 用了一条**TOCTOU 全链路校验**：

| 时点 | 校验 |
|---|---|
| 打开前 | `lstat` 非符号链接且为普通文件；`realpath` 在工作区内且与传入路径规范一致 |
| 打开时 | `O_RDONLY \| O_NOFOLLOW` |
| 打开后 | `dev` / `ino` 与打开前一致，否则 `analysis_unsafe_source_file` |
| 读完后 | `size` 与 `mtimeMs` 未变，否则视为"读取期间被修改" |
| 读完后 | 再次 `realpath`，路径未变 |
| 读完后 | 再查一次单文件与总字节上限（防止读取期间增长） |

`inspectSourceFile` 另有一层保护：`realpath` 必须在工作区内**且与传入的绝对路径规范一致**——这直接拒绝"通过符号链接指向工作区外但在工作区内的路径"。

**失败处理分两类**（这是有意的分层）：

- `CodeGraphAnalysisError` → **向上抛**（安全与限额问题必须终止）。
- 其他错误（如 EACCES、EISDIR）→ 记为 `file_read_failed` 诊断（severity `error`）并**继续**处理其余文件。

若发现了文件但一个都读不出来 → `analysis_no_readable_files`。

---

## 5. 建图算法

### 5.1 节点

| 类型 | id | 说明 |
|---|---|---|
| `file` | `file:<workspacePath>`（超 160 字符则 `file:sha256(path)`） | `content_hash = sha256(文件内容)`，`line: 1` |
| `directory` | `directory:<workspacePath>` | 总是包含根目录 `.`，并为每个文件补齐全部祖先目录 |
| `module` | `module:sha256(scope)` | `scope = moduleName` 或 `<sourcePath>:<moduleName>` |
| `symbol` | `symbol:sha256(filePath\0declarationKind\0name\0ordinal)` | JS/TS 顶层声明；带 `symbol_name`、`declaration_kind`、起止行与声明文本 hash |

### 5.2 边的抽取（AST 遍历）

用 `typescript/unstable/ast` + `typescript/unstable/sync`（`TypeScriptApi`）逐个文件解析，`scanStaticReferences` 识别：

| 语法 | 处理 |
|---|---|
| `import ... from "x"` | `static_import` |
| `import x = require("x")` | `static_import` |
| `export ... from "x"` | `static_export` |
| `require("字面量")`（恰好 1 个字符串参数） | `static_import`，**标记 `conservative: true`** |
| `require(变量)` / 多参数 | 跳过 → `commonjs_require_unsupported`（warning） |
| `import(...)` 动态导入 | 跳过 → `dynamic_import_unsupported`（info） |

边 id 为 `edge:sha256(kind\0source\0target)`——即**按 (类型, 源, 目标) 去重**，同一模块被 import 多次只留一条，保留**行号最小**的那条。

### 5.2.1 顶层声明语义（G-20）

在同一份 TypeScript AST 中，分析器还读取每个 source file 的**顶层** `class`、`enum`、`function`、`interface`、`namespace`、`type` 与具名 `variable` 声明。每个声明产生一个 `symbol` 节点，并从所属 `file` 节点产生一条高置信、resolved 的 `contains` 边。节点 identity 使用相对文件、声明类别、名称与同名 ordinal；格式化不改变 identity，但声明范围或声明文本变化会进入节点内容，从而在 `GraphDelta` 中成为 `changed`。

这不是调用图：不会声称解析方法、匿名函数、动态调用、反射、依赖注入、路由注册或跨语言符号。模块 import/export 边仍是静态关系；symbol 只表示有限的 AST 声明位置。

### 5.3 目标解析与置信度

| 情形 | 节点 | confidence | resolution | 诊断 |
|---|---|---|---|---|
| 相对路径命中唯一文件 | 该 file 节点 | `high` | `resolved` | — |
| 相对路径命中多个候选 | 首个候选 | `medium` | `partial` | `ambiguous_static_module`（warning） |
| 字面量 `require()` 命中 | 该 file 节点 | `medium` | `partial` | `commonjs_require_partial`（info） |
| 非相对（外部包） | `module:<name>` | `medium` | `partial` | `external_module_partial`（info） |
| 相对但不存在的模块 | `module:<path>:<name>` | `low` | `unknown` | `static_module_unresolved`（warning） |

模块候选解析（`moduleCandidates`）复刻了 TypeScript 的扩展替换规则：

- 无扩展名：11 个 `RESOLUTION_EXTENSIONS` 各试一次，再各试一次 `index<ext>`。
- 有扩展名：按替换表（`.js` → `.ts`、`.tsx`、`.d.ts`、`.js`、`.jsx`；`.mjs` → `.mts`、`.d.mts`、`.mjs`；`.cjs` → `.cts`、`.d.cts`、`.cjs`；`.jsx` → `.tsx`、`.d.ts`、`.jsx`），未知扩展名按原路径。

### 5.4 快照身份

```313:330:packages/codegraph/src/analyze.ts
  const sortedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const sortedEdges = [...edges.values()].sort((left, right) => left.id.localeCompare(right.id));
  const workspaceHash = sha256(
    stableJson(
      records.map(({ content, workspacePath }) => ({
        content_hash: sha256(content),
        file_path: workspacePath,
      })),
    ),
  );
  const snapshotId = `graph_snapshot:${sha256(
    stableJson({
      edges: sortedEdges,
      nodes: sortedNodes,
      project_id: options.project_id,
      workspace_hash: workspaceHash,
    }),
  )}`;
```

**`created_at` 不参与 `snapshot_id`。** 因此"内容相同、时间不同"的两次分析得到**相同的 snapshot_id**——这是幂等性的来源，也是模块 02 中 `delta.base_snapshot_id !== state.baseGraph.snapshot_id` 校验能成立的前提。

确定性由三点共同保证：节点/边按 id 排序、`stableJson` 递归按 key 排序、文件遍历按名称排序。

### 5.5 覆盖度

```348:364:packages/codegraph/src/analyze.ts
    coverage: {
      status:
        skippedDynamicImportCount > 0 ||
        skippedCommonJsRequireCount > 0 ||
        unresolvedStaticEdgeCount > 0 ||
        partialStaticEdgeCount > 0 ||
        diagnostics.some(
          ({ code, severity }) => severity === "error" || code === "invalid_tsconfig",
        )
          ? "partial"
          : "complete",
      indexed_file_count: records.length,
      skipped_dynamic_import_count: skippedDynamicImportCount,
      skipped_commonjs_require_count: skippedCommonJsRequireCount,
      unresolved_static_edge_count: unresolvedStaticEdgeCount,
      partial_static_edge_count: partialStaticEdgeCount,
    },
```

**任何一个不确定的边都会把整份图降级为 `partial`。** 这是诚实的做法：`complete` 是真的完整，不是"没报错"。

诊断顺序固定（`file_path` → `line` → `code`），错误消息里的工作区绝对路径被替换为 `<workspace>`。

---

## 6. 快照差分

`diffGraphSnapshots(before, after, options)`：

1. `project_id` 不同直接抛错。
2. 节点与边各自按 id 做集合差分，ids **排序后**遍历（确定性）。
3. 变化分类：

| 情形 | `change` |
|---|---|
| 仅 before 有 | `removed` |
| 仅 after 有（节点） | `added` |
| 仅 after 有（边） | 按 `resolution`：`unknown` → `unknown`，`partial` → `partial`，否则 `added` |
| 都有但 `stableJson` 不同（节点） | `changed` |
| 都有但 `stableJson` 不同（边） | `weakestCertainty`：任一为 `unknown` → `unknown`，任一为 `partial` → `partial`，否则 `changed` |

4. delta 身份同样是内容寻址：

```
graph_delta_id = "graph_delta:" + sha256(stableJson({
  base_snapshot_id, edge_changes, node_changes,
  patch_event_id, project_id, result_snapshot_id,
}))
```

`created_at` 同样不进 id；非法时间戳抛错，缺省取当前时间。

**注意边的 `change` 混入了"确定性"语义**：一条新增边如果 resolution 是 `unknown`，它的 `change` 就是 `unknown` 而不是 `added`——`GraphChangeKind` 同时承载了"变没变"和"有多确定"两件事。

---

## 7. 影响面

```8:23:packages/codegraph/src/impact.ts
export function getImpactNeighborhood(
  snapshot: GraphSnapshot,
  originNodeId: string,
  options: {
    readonly direction?: "upstream" | "downstream" | "both";
    readonly max_depth?: 1 | 2;
  } = {},
): ImpactNeighborhood {
```

- 默认 `direction: "upstream"`（**谁依赖我**，即反向边）、`max_depth: 2`。
- `upstream` 走 `edge.target_node_id === nodeId → edge.source_node_id`；`downstream` 反之；`both` 双向。
- `max_depth` 只接受 `1 | 2`，否则抛错；起点节点不存在抛错。
- 逐层 BFS，被选中的边无条件加入结果（即便邻居已访问过），保证"影响路径"完整。
- 输出节点按 `depth` 再按 id 排序，边按 id 排序。

**结果规模天然有界**（最多 2 层），但对超大图每次扩展都全表扫描 `snapshot.edges`。`getImpactNeighborhood` 目前**没有任何调用方**——它被导出但 Runtime / Host / CLI 都未使用。

---

## 8. Run 语义投影、LSP 摘要与 Git 基线（G-20）

启用 provider 的 Run 在启动时先产生 `graph.snapshot_created`，再追加 `code.intel_updated { phase:"baseline" }`。成功提交 Patch 后，Runtime 产生结果快照与 `graph.delta_created`，将受影响文件和 delta 中的 `symbol` 节点压缩为有界 `changed_files` / `changed_symbols`，最后追加 `code.intel_updated { phase:"post_patch" }`。每组最多 128 项，超出会显式标记 truncated；这两个事件是可重放的事实，不依赖 Web 内存。

`RunProjection.code_intel` 使用 `CODE_INTEL_VERSION = "tracegraph.code-intel.v1"` 的 `CodeIntelProjectionSchema`，保存最新的 Git 上下文、快照 identity、受影响文件/符号及截断标记。若当前 Run 已有 G-12 `lsp.diagnostics_received` 摘要，投影会把同一份有界 `diagnostics_summary` 合并到 `code_intel`；不会自动启动 LSP、自动扫描诊断，完整诊断也不会进入投影。

CLI provider 的 Git probe 只运行固定的、`shell:false` 的只读 argv：工作树判定、`HEAD`、当前 branch 与包含 untracked 文件的 porcelain status。公开事实只含 full base commit、可选 branch、dirty、status SHA-256 fingerprint 与时间，**不含**远程、绝对路径、原始 status 或仓库提供的命令。probe 不可用时写 `git_context.status:"unavailable"`，这保留审计事实但不提供 stale-base 保护。

在 Patch ask 审批真正进入 `commit_patch` 前，Runtime 会重新探测一个先前可用的 Git 基线。若 commit、branch、worktree fingerprint 变化，或新的 probe 变为 unavailable，就追加 `code.stale_base_detected`，以 `approval.denied { reason:"stale_base" }` 作废旧审批，并生成新的 `approval.requested`；不会借旧 token 写盘。文件 `base_hash` 的原子提交校验仍是最后一道单目标写入保护，二者不能互相替代。

Web Changes 视图消费同一 Run/SSE 投影，显示受影响文件、声明、LSP 摘要和需要重新审批的 Git 漂移。查看历史 timeline 时，它只关联所选 Patch/CodeIntel 事件的事实，不把 Run head 的较新 `code_intel` 倒灌到旧事件。

---

## 9. 哈希与路径工具

```3:5:packages/codegraph/src/hash.ts
export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
```

`stableJson` 递归排序所有对象 key（`localeCompare`），数组保持顺序。**不含盐、不含前缀**——纯内容哈希，任何持有内容的人都能复算。

`isInsideWorkspace` 的判定用 `path.relative` 结果是否以 `..` 开头、是否等于 `..`、是否绝对路径三者共同确定，比字符串前缀比较更稳。

---

## 10. 已知缺口

1. **嵌入式 composition 仍须显式注入。** `packages/host` 不会偷偷创建 scanner/Git adapter；标准 CLI/Web 路径已经注入，但自定义 Host composition 忘记传 `codeGraph` 时没有图、符号或 Git stale-base 保证。

2. **没有增量分析。** 每次 `createSnapshot` 都是全量目录扫描 + 全量 TypeScript program 加载 + 全量 AST 遍历。而 Runtime 在每次补丁后都会抓一次结果快照，于是"改一行"要付全仓分析的代价（上限 30 s / 64 MiB）。没有缓存、没有脏文件集、没有 mtime 复用。

3. **CodeGraph 自身的诊断仍被削平。** 写入 `GraphSnapshot` 时只保留 `{ file_path?, message }`：

```339:342:packages/codegraph/src/analyze.ts
    diagnostics: diagnostics.map(({ file_path, message }) => ({
      ...(file_path === undefined ? {} : { file_path }),
      message,
    })),
```

`code` 与 `severity` 只存在于 `CodeGraphAnalysis.diagnostics`。G-20 合并的是独立 G-12 LSP 的有界诊断摘要，不会把这些 CodeGraph analysis diagnostics 冒充成 LSP 语义诊断；coverage 与完整分析诊断仍不进入 Projection/UI。

4. **符号链接被静默跳过。** 目录与文件都 `continue`，不产生任何诊断、也不影响 `coverage`。用 symlink 组织包的 monorepo 会**缺失整块图却显示 coverage 正常**。

5. **语义粒度仍受限。** 当前有顶层 `symbol` 节点和 `file → contains → symbol`，但没有方法/匿名函数/局部声明、调用边、动态调用、DI、路由、反射或跨语言解析。因此它仍不是全语义调用图，不能回答“哪个函数在运行时调用了被改函数”。

6. **`getImpactNeighborhood` 零调用方。** 已实现、已测试，但没有任何产品路径使用它。

7. **`GraphChangeKind` 语义重载**（见 §6）：边的新增可能被报告为 `unknown` 或 `partial`，消费方若按"没有 `added` 就没有新增"来理解会漏判。

8. **相同 snapshot_id 可能对应不同字节。** `created_at` 不进 id 但存在于快照体中，同一份代码两次分析会得到**同 id、不同内容**的 JSON 工件（模块 02 会把 delta 落盘为工件）。比较时不能假设"同 id ⇒ 同字节"。

9. **限额是硬拒绝而非部分成功。** 超过 10 000 文件或 64 MiB 直接抛错，大仓上完全没有结果（而不是"索引了前 N 个"）。`coverage` 的诚实性只覆盖语法层不确定性，不覆盖"被限额截断"。

10. **只有 JS/TS。** 8 个扩展名硬编码，Python / Go / Java 等一律不可见且不报错。

11. **deadline 只在检查点生效。** 单次巨大的 `readdir`、单文件读取或 TypeScript 编译不会被中断，实际耗时可能显著超过 30 s。

12. **`tsconfig_path` 必须显式传入。** 不传时依赖 TypeScript 的默认推断；传了则做工作区内校验（必须存在、必须是文件、必须在工作区内），校验失败抛普通 `Error` 而非 `CodeGraphAnalysisError`，错误码层面不一致。

---

## 11. 相关文档

- 模块 01（契约层）：`GraphSnapshot` / `GraphDelta` / `GraphNode` / `GraphEdge` 字段
- 模块 02（Runtime）：`#bootstrapRun` 的基线快照、`approve` 后的 delta 与四字段交叉校验、`indexing_failed` / `graph_delta_failed`
- 模块 11（CLI）：`createCodeGraphProvider()` 的装配点
