# 变更记录

[English](CHANGELOG.md) · 中文

这里记录 TraceGraph Agent 的重要变更。项目使用语义化版本标识，但所有 workspace 包仍为私有，因此目前仍属预发布阶段。

## [0.1.0-alpha.0] - 2026-09-19

### 新增

- 持久 Session 恢复、Context 压缩、供应商用量统计、Patch Action WAL 与对账、严格的 Tool 执行、权限策略预设、Plan/Todo、沙箱状态报告、运行时引导、Telemetry 以及离线评测。
- G22 工程门禁：三个独立 CI job、全局及关键领域覆盖率阈值、精确依赖与锁文件检查、高危漏洞审计门、确定性发布清单、中英文入口，以及可执行的文档—实现映射检查。
- G23 交互式 Trace Replay Debugger：按 sequence 限界的规范化快照、稳定的回放 hash、正向/反向结构化差异、轮换的只读 Host capability、SDK 权限恢复，以及 Web 时间线的时间回溯。
- G21 生产检索路径：保留完整代码围栏和精确源码行号的 Markdown 分块、按项目隔离的原子 JSONL 索引、本地 BM25 排序与来源回读、持久的 Runtime remember/recall 事件及预算内 Context 注入、可选的严格 loopback 检索服务与 CLI 回退组合，以及离线任务质量/引用准确率对比。
- G07 有界子 Agent 委派：由 Host 持有的可信 profile、独立的子 Run/Session/Ledger 与恢复状态、深度/并行/token/步数/工具限制、四个严格控制工具、通过 hash 关联的父子生命周期 Receipt、重启对账、按关系限定作用域的 Host/SDK 读取，以及只读的 Web 子 Ledger 视图。
- G08 有界 Agent Team 协调：基于 root Run Ledger 的成员名册、持久 mailbox、使用乐观版本号的共享任务板、子 Ledger 完成证据、显式 heartbeat/sweep、成员失联时原子地重新开放任务、严格的 Host/SDK/CLI 接口，以及主要为只读的 Web Team 面板。

### 发布边界

- 所有 workspace 包仍保持 `private`，不执行 npm 发布。
- 只有完整验证链通过后，匹配的 `v0.1.0-alpha.0` tag 才会产出带校验和的 GitHub Actions 构建工件。
- G21 当前仅提供基于 JSONL/BM25 的词法检索；不宣称具备 embedding 语义检索、向量数据库或生产级分布式检索部署。
- G08 仍是在 G07 同步 spawn 机制之上的单 Host 协调器：没有跨 Host 共识、后台存活检测守护进程、自动重启 worker / 自动重新分配任务，也没有任意非阻塞父 Agent Loop。父级终态 Receipt 的持久追加失败时，系统仍有意停止，直到 Host 重启后完成对账。
