---
id: 2026-10-05-data-104-visual-evidence-retention
status: implemented
date: 2026-10-05
language: zh-CN
---

# DATA-104：限定范围的视觉证据保留

[English](2026-10-05-data-104-visual-evidence-retention.md)

## 决策

Browser 和 Computer 截图默认在本机保留 30 天，可配置为 1 至 365 天。用户可固定保留数量受限的单条观察。只有可信截图控制器及其 Runtime 工具适配器能登记来源。一张截图可能同时存在私有原始副本和若干作用域明确的 Run Artifact 副本；清理一并覆盖登记的副本。生成媒体、附件、辅助功能文本、DOM 描述、Ledger 事件、消息和项目文件不受此策略影响。

通过 WorkbenchJournal 使用标准 SessionEvent 命令回执，以有界私有清单作为经过验证的投影。同一标准 Ledger 的清单检查点流保存投影哈希/版本；恢复固定或策略更新之前的投影会与后续事实比对并保守拒绝。保留配置与固定保留操作使用明确命令 ID 和版本检查。清理是有界显式命令；自动每小时检查仅在启用且存在过期记录时，提交同类持久清理命令。每次清理记录准确证据及 Artifact ID、验证后的哈希与删除结果，不记录像素内容或绝对路径。删除字节后仍保留 Artifact 元数据。

## 安全与恢复

仅删除固定私有存储位置中已登记的准确 PNG，先验证作用域、元数据、哈希、大小、文件身份、属主及无符号链接。不跟随链接、不删除目录。登记、固定保留与清理串行执行；限制清单数量、固定保留数量、批次大小及私有文件读取。删除前投影先记录待清理状态。崩溃或回执丢失保持 unknown，禁止再次删除该观察；只读核对检查剩余字节，不重复副作用。回放不能配置、固定保留或清理实时证据。

缺少可靠已登记来源的旧截图继续保留。不根据 PNG MIME、任意 Artifact 引用或文件扫描推断截图来源。增量切片不承诺删除备份中的副本、原生截图权限、Windows 原生验收或整个 DATA-104 已完成。

## 验证

- 实际删除过期字节，并保留原元数据与 Ledger。
- 保留固定、未过期、无关图片及项目文件。
- 同命令重试与冲突、未知回执及只读核对。
- 跨 Run 范围、错误来源、符号链接/硬链接替换及并发固定与清理拒绝。
- 共用鉴权 HTTP/SDK/CLI/固定 Desktop 路由及真实设置接入。

## 已验证切片与限制

[当前行为及准确原始日志](../../../docs/validation/visual-evidence-retention/README.zh.md)记录 Host 三文件 17 测试、CLI 两文件 29 测试、SDK 两测试、契约一测试、Evidence 七测试，以及五包类型检查和架构边界。数量包含既有 CLI/Evidence 用例。已验证真实隔离 Chromium 截图、私有原图及限定 Run 字节删除、固定保留、回放拒绝、旧投影及可选 LocalHost 故障隔离。Computer 像素使用确定性原生边界，不代表操作系统权限或鼠标/键盘验收。

损坏/过期投影仅停用此可选服务及垃圾清理，普通 Plan 仍完成；没有自动回退或修复投影。清单限制为 10,000 条观察/10,000 个检查点、500 条固定、16 副本、100 条批次和 8 MiB 私有投影。检查点容量耗尽需要维护，不承诺 Ledger 压缩。Node 按路径 unlink 不能原子绑定最后 inode 核验；同用户恶意进程在该窗口替换，超出私有存储安全边界。安装版界面、Windows 原生验收和整个 DATA-104 仍单独待验收。

[控制器](../../../packages/host/src/visual-evidence-control.ts)、[实际文件/采集测试](../../../packages/host/src/visual-evidence-capture.test.ts)、[可选共享 owner 测试](../../../packages/host/src/visual-evidence-local-host.test.ts)、[真实 HTTP/CLI 测试](../../../apps/cli/src/visual-evidence-http.test.ts)给出可复现证据。没有使用默认 profile、真实凭据或付费模型。
