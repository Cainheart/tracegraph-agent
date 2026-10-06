# 共享本机工作台二次验收（历史基线）

此页记录安装即用改造前的共享工作台与 unsigned Preview 字节。最新的默认 profile、动态端口、随包 Node/CLI、首次使用及媒体验收见[安装即用产品报告](../installable-product/README.md)；下文的 Node/pnpm 要求与固定端口边界仅属于该历史归档。

状态：本轮计划的七项实现/二次验收，以及用户授权的本机归档模拟验收已完成；独立外部用户发布条件仍未验证。

本轮覆盖 HOST-087、PAR-088、CLI-089、SET-090、DEV-091、RUN-092 与 UX-086 二次验收。首轮 UI/预览归档的记录保留在 [历史报告](../ui-086-workbench-ux/README.md)；旧摘要不作为本轮安装与功能证据。

实现 Note：[统一本地工作台](../../../.agents/notes/implemented/2026-10-03-unified-local-workbench.zh.md)。操作入口、权威和限制见 [三端能力矩阵](capability-matrix.md)。

## 实际交付

共享 profile 由一个独立后台 Node Host 持有。Desktop Main 与 CLI 使用认证本机私有通道，Web 使用同一服务的回环网关。关闭客户端或进度订阅只分离查看者；显式停止 Host 才结束后台服务和资源。默认没有安装开机启动。

模型、权限、项目、工具服务、用量和 Recall 装配从客户端集中到 Host。共享设置支持 revision/CAS、字段来源/范围/生效时机、独立模型小请求、清除 Key 和诊断。保存、尚未测试、测试成功和测试失败分别显示。进行中的 Run 保留绑定的模型、凭据和权限；历史恢复重新评估当前 Host/project/extension 规则，规则改变时拒绝旧权限继续执行。Recall 默认关闭。

共享工作台取消置顶区、重复设置、当前运行区和常驻标签栏。对话中默认一条公开说明与一条真实活动；展开只读取记录。审阅按需打开侧面板，窄窗口覆盖显示。设置采用十类导航、搜索、真实读写和有限失败态。Desktop 的固定 schema 桥补齐共享 SDK 操作及三条独立公开实时流；CLI 的命令、JSON/JSONL 和明确取消调用同一控制器。

Git/worktree、真实 PTY、本地预览和定时任务有独立操作入口。它们与 Run 共用规范工作区 FIFO；终端和自建预览持有租约，必须显式关闭资源才能释放。PTY 跟踪实际终端 job-control 进程组，Host 死亡由独立 guardian 回收已验证归属的进程。无法确认归属/退出时保留失败和租约。定时触发先持久记录再执行，重启不重复，错过和重叠触发跳过，待审批会暂停。通知保留规范事件 ID，完成任务不会因退出后台运行列表而丢失；重连展示已有事实。系统通知要求客户端仍连接且用户明确允许。

旧数据迁移提供扫描、来源选择、备份和提交，保留原目录、事件身份及凭据引用；冲突隔离而非静默合并。迁移前拒绝活跃旧写入者和后台资源，提交后同一 profile 重启并重新连接；未知结果先查询耐久 operation ID 回执。恢复历史不自动执行。

## 验证方式与边界

模型响应使用声明的本地合成 Provider；实际 Runtime、Ledger、审批、文件 patch、测试进程、Git、PTY、预览服务和迁移目录均执行外部状态校验。模型供应商质量、真实 API Key 可用性及真实非维护者验收不能由这些 fixture 推导。

Web 与实际 Electron 在 1440×900、1280×800、1024×768 验证。Desktop 矩阵另覆盖浅色/深色、十类设置和开发资源；布局检查核对真实边界及视口交集，DOM 元素存在不能冒充可见。CLI 使用真实子进程、退出码、JSON/JSONL 和规范终态回执。源版本与新安装版本分别记录产物 SHA-256。

失败记录保留原状态和清理结果：[Desktop 尝试索引](../unified-workbench/desktop-attempts.md)、[Web 尝试目录](evidence/ui-attempts/)。已修正真实问题包括终端逐字输入乱序、终端关闭被排队 Git 操作禁用、窄审阅面板 grid 位置、终态 CLI 订阅不退出、窗口 reload/crash 的订阅泄漏，以及资源进程归属清理。脚本选择器、toggle 时序和合成模型计划不合法的失败分别注明 fixture 原因。

当前真实平台为 macOS arm64。受限原生执行在缺少完整沙箱的平台 fail closed；本轮不把 Mac 操作证据称为 Windows/Linux GUI 验收。归档仍为 unsigned Preview，需要 Node/pnpm；签名安装器、公开发布和独立非维护者验收保留在发布边界之外。

## 最终回执

- [机器验收回执](evidence/acceptance.json)：任务、测试计数、平台、归档摘要与验收边界。
- [最新 Web](evidence/ui/report.json)：14 条验收、102 张三尺寸截图、零错误、清理通过；[文件回滚证明](evidence/ui/rollback-proof.json)和[渲染产物摘要](evidence/ui/renderer-build-hashes.json)。
- [安装版 Desktop](evidence/installed-desktop/report.json)：21 条实际旅程、134 张浅/深色三尺寸截图、22 次真实 CLI；精确审批、附件、Artifact、只读回放、回滚、后台运行、迁移、终端/预览和 Host 停止/同端口重启均通过。
- [安装后的闭合目录校验](evidence/installed-desktop/post-inventory-integrity.json)：1489 个列出文件，23746578 字节，无额外文件；实际 Main/CLI/Host/SDK/模板来自安装树。
- [共享 Host/CLI 安装 smoke](evidence/installed-smoke.json)、[归档内三条公开证明](evidence/release-complete-proofs/report.json)、[发布清单](evidence/release-manifest.json)与 [SHA256SUMS](evidence/release-SHA256SUMS)。
- [源码/测试/配置摘要](evidence/source-inventory.json)：工作树为 dirty；Git HEAD 单独不能代表本轮字节。源码模式与安装模式分别记录。
- [Host 设计与窄验证](host-design-and-verification.md)、[检查原始日志](evidence/checks/)。统一构建/类型检查通过；21 个 workspace 单测汇总为 **1367 passed / 0 failed**；离线评估 **32 passed**，五条 recorded snapshots 通过；工程门 **94 Node + 8 Vitest passed**，最后发布脚本窄门 **11 passed**。
- [独立只读复核](independent-review.md)：分别核对源码与安装版产物、PNG、规范事件、文件哈希、进程退出和发布边界。文档/翻译/目录/模块图/架构/锁文件/发布门与 `git diff --check` 通过；翻译登记仍不等于人工审校。

最终归档 `outlive-agent-0.1.0-alpha.0-preview.tar.gz`（SHA-256 `33147dfea9230ad877627946d5117bd1eb96bc27289435528bd60b067f87c615`）已于 2026-10-06 清理；本页验收记录与摘要保留。安装步骤见[发布说明](../../releases/README.md)。本轮不提交、不推送、不打 tag，也未公开发布。

安装尝试同样保留失败：第一候选 smoke 使用旧 `--host-url`，第二候选缺 HTTP SDK bootstrap，第三候选漏带 fixture 模板、在任何 GUI 断言前失败；最终候选修正 smoke 并包含固定的六个模板资源，重新校验/安装/完整 GUI 与 CLI 后通过。见[安装缺资源的原始失败](evidence/attempts/installed-001-missing-fixture-source/report.json)及 `evidence/checks/outlive-unified-installed-smoke.log` / `outlive-unified-final-smoke.log`。早期 source Desktop 矩阵早于最后一句遥测文案校准，最新安装矩阵验证最终字节；原图/摘要仍保留。

实际端口边界：新 profile 默认回环 4311；本机旧服务仍占该端口时首次启动会在有界时间内报 setup unavailable，需停止相冲突的旧服务后重试。不会静默换端口，也没有停止用户原有服务。本轮实际重启保留同 profile 的可信原端口，并以新 PID/同地址核验。成功迁移提供备份和失败回退；没有新增“成功迁移后自动恢复旧数据”的命令。
