# DATA-104：本机资料、每日用量与公开搜索切片

本回执覆盖 2026-10-05 验证的有界 Host/SDK/CLI 切片。DATA-104 整体仍是部分完成，完整客户端流程和最终用户验收尚需闭环。检查使用临时私有 profile 与真实 canonical Ledger/Session 文件，不发付费请求、不读取默认凭据，不声明付费供应商质量或账单准确度已验收。

## Current behavior

个人资料是私有本机配置文件，使用 revision CAS、显式命令 ID 和 canonical `workbench.command_requested/completed/failed` 回执。初始名称为 `Local user`，头像仅用字母和六种预置颜色。成功命令持久化有界且脱敏的名称、简介、版本与命令定位；这些字段不进入模型输入。完全相同的成功命令重试返回原回执；同 ID 换意图拒绝，旧版本写入记录为失败。

文件已改变但成功回执缺失时，核对返回 `unknown` 和独立观察到的资料。观察值不能证明保存成功，也不能授权自动重写。核对不执行命令、不写新回执。已证明的命令 ID 或版本冲突仍是拒绝，不误标为未知写入。

用量读取当前已注册项目/会话 Run 中的真实 `model.request_started` 和有效 `model.usage_reported`。Token 按 UTC 事件日汇总，Run 状态使用 canonical projection。返回缺用量次数，只记录供应商实际报告的币种和金额。缺成本保持 `unknown`，部分成本保持 `partial`，不用估计值填补缺失。日期范围为 1–366 个 UTC 日；每页最多 25 个 Run，继续页返回累计快照，客户端应替换，不能重复相加。

公开搜索仅匹配当前会话标题、已注册项目名称、canonical Run 任务、完成答复和选定相对文件引用。返回精确 project、Session、Run、Event/sequence 及可用 turn 定位。失败答复、临时答案、供应商私有推理、完整 Tool 正文和私有 Artifact 字节不纳入。支持项目、会话、时间、canonical 状态与归档筛选；结果按有界 inventory 扫描返回，不声称全局相关度排序。继续搜索页追加命中。

两类查询复用既有 hash-chain parser，每个 Run 最多读取 1 MiB/5,000 个事件，每页 25 个 Run，每次查询最多 5,000 个 Run，最多保留四个查询游标。游标不透明且绑定查询，60 秒过期，Host 重启后失效。注册项目超过 1,000 时拒绝全局查询，显式项目查询仍可用。链接、损坏、过大或数值不安全的流拒绝或跳过并明确不完整。页信息包含扫描/跳过次数、inventory 完整性、上限和继续游标。不建持久全文索引或第二套业务事件格式。

五个接口都需要 live 本机权限。既有 replay 权限只覆盖选定 Run 前缀，拒绝这些 profile 范围接口，查询也不例外。本切片没有扩大 replay 读取范围。查询不创建 Run、不派发 Tool、不调用供应商。

## Reproducible checks

| 最终检查 | 实际 oracle |
| --- | --- |
| [Contracts](focused-contracts-final.log)：1 文件、4 测试 | 闭合 CAS DTO、日期/范围/查询边界、排除私有选择器、不伪造成功回执 |
| [Host](focused-host-final.log)：1 文件、10 测试 | 真实 0600 文件、重启保留、命令/版本冲突、丢回执只读核对、Ledger UTC 汇总、缺用量/成本、公开精确定位、筛选/作用域/分页及不安全文件/数值 |
| [Evidence](focused-evidence-final.log)：1 文件、7 测试 | 既有证据公开契约及有界读取 hash 完整性、字节/事件上限、符号/硬链接与非法 UTF-8 拒绝 |
| [SDK](focused-sdk-final.log)：1 文件、3 测试 | 固定路由/命令绑定、不重试写操作、搜索作用域与 UTC 范围、拒绝私有响应字段 |
| [CLI](focused-cli-final.log)：1 文件、25 测试 | 既有共享 CLI 加资料/查询入口；unknown 退出 3，failed/not_found 退出 1，completed 退出 0；Goal 与 command 回执 ID 保持不同 |
| [Host types](host-typecheck-final.log)、[Evidence types](evidence-typecheck-final.log)、[SDK types](sdk-typecheck-final.log)、[CLI types](cli-typecheck-final.log) | 当前源码和公共类型边界 |

数量对应上述最终套件，包含已有测试，不代表全部是新测试或独立运行。[缺失 dist 的检查](focused-host-dist-unavailable.log)记录并发构建清除 Core 入口期间失败，保留但不计作产品验收。首轮检查另发现已修复的冲突分类，以及 fixture 时间戳错误：canonical Ledger 时间来自注入时钟，不采用任意 proposal 字段。

在仓库根目录复跑：

```bash
env -u NODE_OPTIONS pnpm --filter @tracegraph/contracts exec vitest run src/personal-data.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/personal-data-control.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/evidence exec vitest run src/public-api.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/sdk exec vitest run src/personal-data.test.ts
env -u NODE_OPTIONS pnpm --filter @tracegraph/cli exec vitest run src/workbench-command.test.ts
```

公共方法为 `getPersonalProfile`、`updatePersonalProfile`、`getPersonalProfileCommandReceipt`、`queryPersonalUsage`、`searchPublicSessions`。CLI 为 `profile get|set|receipt`、`usage daily`、`search sessions`。能力操作名为 `personal.read`、`personal.write`、`personal.reconcile`、`usage.daily`、`search.public`。

## Integration audit correction

独立实际 Computer 控制器/CLI 检查证明：原生边界在真实 fixture 文件副作用后中断，会产生“journal 回调已完成、外部结果 unknown”的回执。[修复前检查](cli-computer-receipt-before-fix.log)复现退出码错误为 0；[最终检查](cli-computer-receipt-final.log)通过 2 个 CLI 文件/26 测试，未知结果保持退出 3，显式暂停 Goal 的正常回执仍为 0。[CLI 类型检查](cli-computer-receipt-typecheck-final.log)通过。原生后端是明确的确定性 seam，此处证明真实文件/回执，不声明操作系统鼠标或键盘验收。只读核对不重复副作用，不改变外部文件。

## Remaining scope

这是已验证的控制器/传输切片。上述测试不证明已安装 GUI、声明上限之外的完整 profile、全局相关度搜索、复杂头像上传或供应商账单。对应 UI 与固定 Desktop 适配已另行接入，必须有独立实际客户端证据。搜索结果打开精确历史 Run 供检查，不自动续任务、不授予执行权限。
