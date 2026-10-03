# MEDIA-094：图片输出与 Artifact 字节验收

当前后端、SDK 和 CLI 已实现并通过源码验收。此页证明协议、运行治理和真实文件输出；外部模型的访问权限、画面质量、耗时、计费和限额仍未验证。

## 可复现证据

最终 Mac-v2 DMG（build ID `c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`）安装到 `/Users/cain/Applications/Outlive Agent.app` 后，使用应用自带 Node、`PATH=/usr/bin:/bin`、临时私有凭据 profile 和安装依赖（无源码 import fallback）重跑同一完整链路：[安装报告](evidence/installed-mac-final/report.json) **94 断言 / 20 CLI / 6 文件通过**，[独立校验](evidence/installed-mac-final/independent-verification.json) **666 项通过**；12 个安装生产模块字节在验收前后相同，测试资源清理通过。验收脚本与证据位于安装树之外。

- [真实 CLI / 分离 Host 报告](evidence/source-final/report.json)：94 项断言通过；20 次 CLI 调用；6 份生成媒体；8 次确定性提供商 HTTP 请求；自有 Host 与连接已清理。
- [独立字节验证](evidence/source-final/independent-verification.json)：666 项检查通过，重读导出的字节、PNG chunk CRC / 解压行、SHA-256、同 Run / project 的 Artifact 和 canonical receipt；不导入生产校验实现。
- [CLI 结构化结果](evidence/source-final/cli-receipts.json)、[提供商请求计数](evidence/source-final/provider-requests.json)、[Artifact 引用](evidence/source-final/artifacts.json)、[实际 Run 投影](evidence/source-final/runs/)。
- 三种协议的实际 PNG：[Images](evidence/source-final/openai-images.png)、[Responses](evidence/source-final/openai-responses.png)、[兼容原生 Chat](evidence/source-final/openai-chat-images.png)。本地 SVG：[流程图](evidence/source-final/diagram.svg)、[图表](evidence/source-final/chart.svg)、[已配置聊天模型的图表](evidence/source-final/chart-with-chat.svg)。
- [中间 Mac 包的媒体通过记录](evidence/installed-mac/report.json)保留；最终链接只采用修复 TS 标准库后重新安装的 Mac-v2 验收，不以中间包替代最终包。
- [初次完整通过报告](evidence/source/report.json)保留 94 项通过断言；[最终运行输入摘要](evidence/source-final/execution-inputs.json)记录加载前 12 个生产模块的 hash，独立验证确认字节未改变。
- [保留的安装身份失败](evidence/attempts/002-installed-caller-identity/report.json)：外部脚本首次用系统 Node 调用安装 API，测试 owner 缺 bundle identity，真实 bundled CLI 正确以 `local_host_upgrade_required` 拒绝，0 个 provider 请求且清理通过。改为使用安装自带 Node 执行整个外部脚本后重跑；不修改产品或规避 build 身份校验。
- [保留的首次失败](evidence/attempts/001-chat-config-fixture/report.json)：51 项断言到聊天配置夹具使用错误枚举时失败，20 次完整 CLI 验收尚未完成；自有资源清理通过。将夹具改为真实 `custom` / `openai-chat-completions` 后重新运行，原报告保留。

提供商是本机真实 HTTP 服务，返回由夹具算法构建的 320×180 RGBA PNG。执行真实生产 CLI、认证 UDS、独立 Node Host、Runtime、工具、Artifact Store 和 SDK；凭据仅为临时 profile 的固定假密钥，CLI `PATH=/usr/bin:/bin`。这些图像验证传输和输出，不代表 AI 画面质量。PNG 正式生成需要用户自行配置有权限的提供商；本地图表无需模型配置。

```bash
env -u NODE_OPTIONS node docs/validation/media-094/run-media-validation.mjs docs/validation/media-094/evidence/new-attempt
env -u NODE_OPTIONS node docs/validation/media-094/verify-media-evidence.mjs docs/validation/media-094/evidence/new-attempt
```

每次运行使用新目录，拒绝覆盖已有 `report.json`。测试安装树时，使用随应用分发的 Node 执行整个脚本，并设置 `OUTLIVE_REPOSITORY_ROOT` 和 `OUTLIVE_NODE_EXECUTABLE` 指向真实安装资源与随应用分发的独立 Node；证据目录保持在安装树之外，不添加文件到安装清单。

## 能力与治理矩阵

| 能力 / 入口 | 当前实现与实际验收 | 未验证 / 约束 |
|---|---|---|
| `image.read/configure/clear` | 独立 image provider 配置；Host 返回有无凭据的 metadata，存储 credential reference；CLI key 走 stdin | 不自动借用聊天密钥；远端模型访问和费用未知 |
| `media.generate` / `generate_image` | 独立 Images、Responses image tool、兼容 Chat 三种显式协议；实际 PNG 解码和存储；3 个协议分别单次派发 | PNG-only；原生 Chat 仅接受单个 PNG data URL 的声明协议，具体厂商兼容性未独立验证；仅 Images / Responses 发送 size、quality 选项 |
| `media.diagram` / `render_diagram` | 已验证转义后的 SVG；1–16 个唯一节点、最多 32 条有效边 | 接受结构化数据，不能执行任意 SVG、Mermaid、HTML 或脚本 |
| `media.chart` / `render_chart` | 真实 SVG；bar / line，1–24 对标签数值，数值 ±1e9 | 不支持任意代码/绘图脚本、外部资源、导入 SVG |
| `artifacts.binary.read` | live-only 内容接口，关系绑定到当前可读项目 / Run；hash、MIME、长度三重核对；SDK 再校验摘要；CLI 输出用 `wx` 避免覆盖 | Replay 禁止读取字节；旧文本 Artifact 接口仍不返回二进制 |
| plain chat / project | 媒体工具可独立发布本 Run Artifact；真实无 FS 能力夹具仍能绘图 | 不授予项目读写、shell、patch 或命令执行能力；Host / Skill / Plan Mode / approval policy 继续裁决 |
| 成功判定 | `tool.completed` + `Receipt.business_status=success` + `media_artifact_created` + 实际 scoped bytes / SHA | HTTP 200、Markdown、代码、解释性 prose 不等于图像成功 |
| malformed / auth / unknown | 真实 CLI malformed/prose/401 退出 1；503 unknown 退出 3，均零成功 PNG；after-dispatch timeout unit 验收为 unknown、不重试 | 无真实厂商不确定结果或收费回执；用户需检查旧 Run，不盲目重新派发 |
| exact retry / cancel | 同 command + 全部 typed 参数哈希复用原 Run 和输出，不重复请求；改参数 409；真实挂起 provider 中取消后零成功图像 | 取消不能保证外部服务没有消费请求或收费 |
| 配置绑定 | Run admission 时冻结 image provider 与 credential reference；改配置后旧 Run 保留旧 key，terminal / cancel 释放 | 公共客户端不能注入 executor 或控制配置绑定 |
| 本地模型请求 | 未配置模型时 diagram/chart 都通过；配置聊天 provider 后额外 chart 仍零 chat/image/tail HTTP | 显式媒体一键 Run 持久记录禁用 post-run 模型抽取；普通聊天/任务仍沿原抽取流程 |
| formats / limits | 生成 PNG 最大 20 MiB；全 chunk CRC、IHDR、IDAT 解压、过滤字节检查；可信 SVG 可下载 | PNG 仅 8-bit、非隔行灰度/RGB/alpha 子集，边长 ≤8192、像素数 ≤16,777,216；JPEG/WebP 生成明确不支持，不靠 signature 宣称解码 |

审批的窄测试通过可信 `approvalAnswerer` 一次性 token 后才派发 provider；未批准时请求数为零。普通非 Patch `ask` 没有可信 answerer 时按既有 Runtime fail closed，不能假称已通过 UI 普通审批接通。Plan Mode 外部图片生成被拒绝、provider 请求为零。

一键本地绘图依然使用 normal Runtime 的模型适配器决策事件和工具事件；该适配器是 Host 内部闭合指令执行器，`model.request_started` 不表示发出了网络模型请求。它以不可由客户端输入的 `backgroundModelDerivation:false` admission 写入 canonical `run.created`，后台抽取包括恢复路径都跳过该 Run。普通 Run 的 Memory 抽取未关闭。UI 使用友好的“Create image/diagram/chart”标题，完整参数保留在类型化工具事实和内部 intent hash 中。

## 源码与测试

主要代码：`packages/contracts/src/media.ts`；`packages/core/src/seams/media/`；`packages/core/src/domains/runtime/runtime.ts`；`packages/evidence/src/artifact-store.ts`；`packages/host/src/composition/image-config.ts`；`packages/host/src/webserver/index.ts`；`packages/sdk/src/index.ts`；`apps/cli/src/workbench-command.ts`。

截至本证据运行，Core 媒体与 Memory 后台回归 3 文件 / 50 测试通过；Host 真实协议 2 测试、SDK 2 测试和 CLI 16 测试通过；相关 Core/Host/SDK/CLI 类型检查及构建通过。Web [54 张最终受控 UI 证据](../install-use-workbench/attempt003-final-web/report.json)包含 first use、媒体生成、真实 PNG/SVG preview/download 与字节验证。根线程负责全仓 gates、完整 Desktop 安装旅程和整树清单验收；本页的安装 CLI 媒体通过不能代替完整安装旅程验收，历史 UI / 发布证据也不能代替本次媒体功能验收。

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/core exec vitest run src/seams/media src/domains/memory/memory-background-pipeline.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/media.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk exec vitest run src/media.test.ts --maxWorkers=1
env -u NODE_OPTIONS pnpm --filter @tracegraph/cli exec vitest run src/workbench-command.test.ts --maxWorkers=1
```

实现依据为 2026-10-03 查阅的官方 [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate)、[图片生成](https://developers.openai.com/api/docs/guides/image-generation)与 [Responses image tool](https://developers.openai.com/api/docs/guides/tools-image-generation)。兼容 Chat 是明确选择的响应约定，不宣称所有兼容服务或当下某个厂商均支持。
