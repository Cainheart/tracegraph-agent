---
id: 2026-10-05-data-104-local-profile-public-search
status: implemented
date: 2026-10-05
language: zh-CN
canonical: 2026-10-05-data-104-local-profile-public-search.md
---

# DATA-104：本机资料与有界公开账本查询

## Context

[已批准产品工作台计划](../proposed/2026-10-05-complete-product-workbench.zh.md)要求本机个人资料、每日用量和公开会话搜索。既有总用量和仅按标题查询会话不足以提供该流程。供应商私有推理与完整 Tool 正文始终不属于搜索内容。

## Decision

共享个人资料存放于私有本机配置，使用乐观版本、显式命令 ID 和既有 SessionEvent 命令回执。头像仅允许字母和预置颜色。资料文本有界、保存前脱敏，不进入模型请求。文件已改变但回执丢失时保持未知，只读核对而不自动重写。

用量与公开搜索直接从既有 Runtime Event Ledger 和 Session inventory 派生，复用 canonical hash-chain parser 并限制文件读取。限制每页查询、保留扫描状态、结果、事件和日期范围；返回 partial、跳过及继续事实，不把有限页当作全 profile。继续游标不透明、短时有效且绑定查询。不建持久全量全文索引，不增加第二套业务事件协议。

搜索白名单仅含 Session 标题、项目名称、canonical Run 任务/已完成答复及公开相对文件引用，返回实际项目、Session、Run、Event 和可用 turn 定位。可按时间、状态、归档筛选，不复制供应商草稿、临时答案、Tool 原始输出或私有 Artifact 内容。用量按 UTC 日汇总有效 Ledger 报告；缺用量和缺价格保留 unknown，不显示为零成本。

## Scope and compatibility

Host 提供 SDK、CLI 和固定 Desktop 桥消费的 typed 方法，兼容既有 profile、会话与账本。既有 replay 权限拒绝这些 profile 范围接口，查询需要 live 本机读取权限。查询不创建 Run、不执行 Tool、不产生付费请求。UI、完整 Native 验收与 DATA-104 整体义务另需验证。

## Validation

验收真实私有文件 CAS 与重启保留、命令冲突和丢回执核对；真实 Ledger 用量/每日桶、缺用量/成本、损坏或超大流；有界游标与作用域；公开标题/任务/答复/路径精确定位；归档/时间/状态筛选；私有推理/Tool 正文不命中且模型派发为零。

## Verified implementation

已验证范围为本机控制器/传输切片，DATA-104 整体仍是部分完成。[当前行为和最终日志](../../../docs/validation/data-104/README.zh.md)区分 focused 检查与已安装 GUI/用户验收。实现：[contracts](../../../packages/contracts/src/personal-data.ts)、[Host 控制器](../../../packages/host/src/personal-data-control.ts)、[固定路由](../../../packages/host/src/personal-data-routes.ts)、[SDK](../../../packages/sdk/src/index.ts)、[CLI](../../../apps/cli/src/workbench-command.ts)。

[真实文件/Ledger 测试](../../../packages/host/src/personal-data-control.test.ts)覆盖私有持久化、CAS、未知回执、公开搜索排除及有界每日用量。[有界证据读取](../../../packages/evidence/src/event-ledger.ts)保留既有 hash-chain parser。最终 Contracts/Host/Evidence/SDK/CLI focused 套件分别通过 4/10/7/3/25 测试，含既有测试。未使用默认 profile 或付费端点。
