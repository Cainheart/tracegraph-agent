# 分范围管理本机 Skill

[English](README.md)

本 CAP-103 切片通过共享 Host、SDK、固定 Desktop 桥、CLI 和 Workbench 实现单个有界 SKILL.md 的生命周期。不代表整个能力路线图完成，也不代表最新安装包已验收。下述控制器、传输、界面源码和真实磁盘证据已验证；安装版 GUI 与 Windows 验收仍各自独立。

## 使用真实入口

打开设置 → Skills 与扩展 → 管理本机 Skills。无需项目也可使用“本机全局”；选择已登记项目可管理该项目的覆盖定义。填写名称与 Markdown 正文，或明确选择本机 SKILL.md，校验后保存。仅选择文件不会写入、下载 URL、运行辅助脚本或调用模型。本切片仅导入最多 256 KiB 的 UTF-8 Markdown，不导入任意包目录或脚本。

既有条目展示来源、版本、原文件 SHA、范围设置版本、校验诊断和实际生效的冲突。打开条目后可编辑。保存绑定原文件 SHA；启停和移除/恢复还绑定原范围状态 SHA。拒绝会保留草稿。替换外部已修改的版本前需明确读取现状，没有自动合并。

“移出已加载列表（保留文件）”使用可恢复标记，不物理删除原文件；恢复需明确操作。移除或停用项目覆盖后，可继承启用的全局定义。外部编辑正文或重启服务不会默默恢复已移出的技能；共享 disabled_skills 仍只能收紧。变更用于后续任务，已受理任务保留冻结的技能定义。

精确审批展示范围、名称、原哈希和命令 ID，批准/拒绝使用原意图及匹配审批 ID。结果未知时锁定后续写入，只能核对技能变更结果；观察到文件哈希不等于命令已完成。同一客户端关闭并重新打开页面仍保留草稿及待核对意图。进程重启后可用 CLI 查原回执，不增加自动重发。

## 实际验证

下表记录原始控制器、传输与界面检查点。后续源码修正和安装页观察保留各自范围，不替换这些已记录数量。

| 层 | 结果 | 证据 |
|---|---|---|
| Host 磁盘控制器及构建版 HTTP/SDK | 2 文件、13 测试通过 | [host-final-tests.log](checks/host-final-tests.log) |
| 原 Core 扫描器/运行时 | 4 测试通过 | [core-tests.log](checks/core-tests.log) |
| SDK 完整性与语言目录 | 2 文件、11 测试通过 | [sdk-locale-final-tests.log](checks/sdk-locale-final-tests.log) |
| 共享 CLI | 28 测试通过，其中 2 项 Skills 新例 | [cli-tests.log](checks/cli-tests.log) |
| 技能界面与权限展示 | 2 文件、17 测试通过，其中 7 项技能新旅程 | [ui-tests.log](checks/ui-tests.log) |
| 全 Workbench | 40 文件、314 测试通过 | [workbench-all-tests.log](checks/workbench-all-tests.log) |
| 类型检查 | Core、Host、SDK、CLI、Workbench 通过 | [Core](checks/core-types.log)、[Host](checks/host-types.log)、[SDK](checks/sdk-types.log)、[CLI](checks/cli-types.log)、[Workbench](checks/ui-types.log) |
| 构建 | Core、Host、SDK 定向构建通过，未清理 dist | [Core](checks/core-build.log)、[Host](checks/host-build.log)、[SDK](checks/sdk-build.log) |

构建版 HTTP 测试启动隔离私有配置，经过真实认证 SDK 路由核对磁盘原字节，拒绝无认证与任意路径请求，重启后读取移除状态和回执。第二个测试使用确定性回环服务，无付费模型请求：任务等待时编辑技能，然后证明 load_skill 仍使用已受理的原正文，后续任务看到新的目录版本和摘要。这是集成证据，不是模型质量或外部用户验收。

原扫描器硬链接负例先真实失败：有效的私有 Markdown 硬链接进入技能目录，[修复前输出](checks/core-hardlink-before-fix.log) 已保留。原扫描器现拒绝多链接文件，并通过有界 UTF-8 读取及文件/目录身份核对；同一负例通过。初始 HTTP 夹具曾使用错误工具决策结构并重复释放响应，[夹具失败](checks/http-fixture-invalid-tool-before-fix.log) 与[清理修正](checks/http-fixture-double-release-before-fix.log) 保留，随后完整测试通过。

### 后续源码修正

真实 HTTP 夹具现提供默认有限预算要求的服务用量；生产环境缺失用量仍会停止工作。[Skill HTTP 与视觉证据联合回归](../product-workbench-2026-10-05/checks/host-nonbudget-isolated-final.log)通过两文件、15 项测试。Skill 夹具证明已受理任务保留原正文，后续任务使用编辑后正文；两次请求均计数且无未知用量，不绕过预算。

新 Skill 模板使用所选语言，不改写导入或已保存文档。已知结果码与内置扩展状态使用友好文案，技术标识仍在诊断中。确认创建/保存回执在选中已保存文档后保留，打开新草稿时才清除。[回执与本地日期回归](../product-workbench-2026-10-05/checks/skills-receipt-dates-ui-final.log)通过三文件、20 项测试。[设置隔离与初始状态回归](../product-workbench-2026-10-05/checks/settings-focus-connection-ui-final.log)通过五文件、32 项测试：设置将底层聊天设为 inert，包含展开标题及越界焦点，并恢复未改变的草稿。这些是源码级 DOM 夹具；最终重建包需独立原生观察。

[首轮重建 macOS 安装页观察](../product-workbench-2026-10-05/README.md)按明确历史 build ID 记录真实 Skill 创建、编辑、移出、恢复和共享 CLI 读取。后续界面与后端变更需重新打包，不把此前观察当作最终字节验收。

## 安全与限制

管理接口仅接收范围、名称和内容，不接收主机导入路径或下载 URL。全局文件属于所选本机配置的固定 skills 目录；项目使用已登记的 .tracegraph/skills。解析与加载仍复用原 SkillRegistry。规范 SessionEvent 记录内容哈希、意图/策略摘要、审批、派发和回执，管理事件与回执不包含 Markdown 正文或私有配置路径。明确的本机文档读取返回正文；既有 Agent load_skill 路径会按授权任务把已受理技能正文加入模型上下文，管理本身不会向提供商发送正文。

allowed_tools 不能授予文件、命令、模型或系统权限。只读/拒绝、精确 ask 审批、选定的不可变上限和项目写入协调仍生效。已验证符号链接、硬链接、坏 UTF-8、过大文本、陈旧文件/状态哈希、同一命令 ID 跨范围并发，以及状态溢出。一个 ID 只绑定一个规范意图，最多派发一次。

Linux 通过已固定父目录 FD 路径写入。macOS 使用内核 O_NOFOLLOW_ANY 标志（需实际探测，不退回不安全方式），并核对目录/目标 inode 及文件 CAS。真实最后开文件祖先替换攻击返回未知，私有标记未变，未创建 SKILL.md，连空文件也没有。这不等于原子 openat/inode 事务；同一用户并发替换真实目录时仍保守保持未知。Windows 写入在平台验证前明确不可用，本报告没有 Windows 原生证据。多文件技能包、远程市场和自动下载不属于此切片。

旧独立 SkillRegistry 消费者保留原默认根。共享管理明确使用所选本机配置的固定根；位于其它旧全局目录的 Markdown 需明确导入，不自动复制任意旧文件或私有文件。

## 等效 CLI 操作

`outlive skills list` 默认全局范围；通过 `--project-id` 选择已登记项目。`read --name`、`validate --input-file`、`create/save/import/remove/restore/set-enabled --input-file` 和 `receipt <command-id>` 使用同一控制器。内容 JSON 包含名称和原 expected_sha256，范围状态变更还需 expected_state_sha256；精确审批在原命令 JSON 中提交。未知/待审批退出 3；拒绝、冲突、失败或无效校验为非零退出。核对回执不会提交另一笔写入。

## 相关后台入口

Desktop 托盘提供“浮动聊天窗口”和“窗口置顶”，操作同一已加载渲染窗口，可缩小并恢复；置顶默认关闭，只在本次应用运行中保留。不会创建第二个客户端或任务。第二渲染窗口及快捷键附加上下文不属于已交付的展示切片，见[浮动展示 Note](../../../.agents/notes/proposed/2026-10-05-app-105-floating-presentation.zh.md)。

[当前模块](../../modules/17-Skill系统.md)、[有界实现 Note](../../../.agents/notes/implemented/2026-10-05-cap-103-skill-lifecycle.zh.md)。
