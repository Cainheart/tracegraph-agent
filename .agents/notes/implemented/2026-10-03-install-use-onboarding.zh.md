---
id: 2026-10-03-install-use-onboarding
title: 通过共享工作台完成可操作的首次使用
status: implemented
language: zh-CN
owners: [workbench, sdk, desktop]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/workbench, packages/sdk, apps/desktop]
supersedes: []
---

# Agent Note：安装后直接使用的引导

## 修改前的当前状态

共享工作台已通过有类型的 Host 接口保存模型配置，并独立测试已保存的配置。设置保留安全凭据元数据及绑定配置的测试结果。普通对话需要配置模型，但不需要项目、MCP 或 LSP 服务。当前入口仍展示缺少模型及本地服务术语，未引导新安装完成上述操作。

## 已接受的目标

共享界面提供首次使用流程：选择真实提供商与模型、需要时保存只写凭据、明确发起有上限的连接测试，再选择/添加项目或继续普通对话。保存配置不代表连接测试成功。打开应用或编辑字段不会自动请求模型提供商。

准备状态来自现有安全模型、设置和能力投影。步骤与草稿仅为临时 UI 状态；不增加首次引导标记、凭据仓库、事件格式或高权限渲染器方法。已有模型配置的用户保留对话画布。可选工具缺失只影响相应工具，不阻挡模型配置或普通对话。

入口文案提供连接模型、选择项目和修复安装的操作。准确的传输/配置事实保留在诊断中。画布以对话为主，仅展示一句公开当前说明和一行真实操作；展开细节不显示私有推理、不触发回放。

## 权限与恢复

密钥仅通过只写输入交给 configureModel；不读取或记录已有密钥。遵守凭据来源/可写元数据、配置修订、真实能力、只读回放和权限上限。桌面生命周期仍由 Main 及现有固定启动/重连接口处理；渲染器不自行启动服务，不接受通用 shell/文件权限。保存失败保留草稿；测试失败明确显示失败；取消和重试由用户明确触发且有界。

## 验证与完成条件

- [x] 新的隔离配置通过已构建 Web/Desktop 真实传输保存模型并明确完成有上限的连接测试。
- [x] 缺失、失败、锁定凭据状态提供明确操作，不伪造就绪。
- [x] 项目选择、创建、本地目录选择调用真实接口；无 MCP/LSP、无项目仍可普通对话。
- [x] 首次使用、已配置、加载和修复状态在 1024、1280、1440 宽度下可用。
- [x] 现有对话、审批、审阅及隐私、滚动、键盘不变量回归通过。
- [x] 当前文档与证据区分本地模拟验证、独立用户验收及签名发布。

## 已实施行为与证据

`SetupFlow` 通过安全配置、来源与能力投影驱动临时引导：保存与显式 16-token 连接测试独立；401 失败不会前进；原生目录选择取消不会关闭项目步骤。已有配置用户保留对话。缺少项目、MCP 或 LSP 不阻挡普通对话。环境管理的凭据只读，失败草稿保留且不会在诊断中显示密钥。

共享设置把生命周期命令、配置目录、CLI 与准确协议事实放在安装诊断中；普通界面提供连接模型、修复连接和明确应用重启操作。重启接受回执不等于完成，必须重新连接并读取 `pending_restart` 消除；忙碌拒绝不取消任务。活动默认为一句公开说明与一行配对的实际操作，详细传输事实折叠；无常驻 Local 徽标和零长度队列，审批成功保留对话，审阅由用户明确打开。媒体界面消费受能力约束的 typed 操作与 canonical 工具/Artifact 事实，未知接受结果保留原命令，用户明确检查；预览与下载使用经 SDK 验证的 scoped 字节。

- Workbench 28 个文件 / 209 项单测、类型检查通过，覆盖只读凭据、保存失败、原生选择取消、连接测试失败、设置不可用、重启接受与生效的区别、Replay/输入法/滚动及媒体接收边界。
- [最新 Web 全流程](../../../docs/validation/install-use-workbench/attempt007-final-web-with-approval/report.json)：66 张实际截图 / 22 个状态，每个状态覆盖 1440×900、1280×800、1024×768；真实 Host、模型与媒体 HTTP、审批、文件写入和测试；独立验证 694 项通过。
- [从 DMG 安装后的 Desktop 全流程](../../../docs/validation/install-use-workbench/attempt009-final-installed-dmg-desktop/report.json)：同样 66 张实际渲染截图，运行 `/Users/cain/Applications/Outlive Agent.app`，自带 Node，PATH 最小化，无源码兜底或模拟 bridge；明确测试→创建项目→普通对话→PNG/SVG 预览与实际下载→审批→变更审阅，包内 `bin/outlive` 重读同一 Run/Action/test。独立验证 706 项通过，包清单哈希前后不变，清理通过。
- 文件修改的前后原始内容及 SHA256、exact approval/Action/事件、真实 test business success 和独立 CLI 投影见对应 `patch-proof.json`、`before-add.ts`、`applied-add.ts`、`cli-run-read.stdout.json`。

保留早期负例：Web 本地媒体曾错误触发 Memory 派生模型调用（Core 受信媒体禁派生修复）；安装包曾误删 TypeScript native 的运行时 `lib.d.ts`（打包修复，新 build ID `c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`）。attempt004 是打包目录假设错误，attempt005 是验收 fetch(blob) 被正确 CSP 拒绝，后续改为真实 Download 点击；attempt008 的原生观察 marker 超时，不计为 CmdQ 成功。所有负例原报告保留。

验证参与者为维护者工作区内 Agent，模型与图像提供商为确定性 loopback fixture；证明真实传输、治理和输出字节，不能证明真实 AI 内容质量、公开签名分发或独立用户验收。[独立的安装后原生退出验收](../../../docs/validation/install-use-workbench/attempt011-installed-native-quit/report.json)通过：实际 CUA Cmd+Q 后 Electron 退出码 0，同一 owner PID/boot nonce 继续完成已等待的真实 Run，安装包 CLI 再读到 completed，清理通过。attempt010 仅为 fixture 在初始 loadFile 中过早 reload 的导航竞态，等待实际 `.app` 挂载后重跑，不修改产品。

## 延后范围

提供商注册、远程 OAuth、云端计费、私有模型推理不在本次范围内。包 scope 与旧 wire version 保持兼容。原生安装/启动和品牌素材由独立任务负责。
