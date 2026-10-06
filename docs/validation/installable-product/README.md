# 安装即用本地产品交付与验收

> 本页保留 Mac-v2 安装即用阶段的历史验收，以下“本轮”“当前”“最终”均指该阶段，SHA、计数及回执不代表现交付字节。当时 A 仅作预览、标志尚未选择；用户随后已确认 B Current。最新 macOS 安装、默认 Profile 复用和打包冒烟见[2026-10-06 安装记录](../desktop-install-2026-10-06/README.md)。当前工作台与图标证据见[当前工作台闭环报告](../current-workbench-recovery/README.md)，发行边界见[当前发布记录](../../releases/README.md)。

本轮交付可本机试用的 **Outlive Agent 0.1.0-alpha.0**。应用随包携带独立 Node、Electron、编译后的 Host/Web/Desktop/CLI 与原生依赖；用户打开应用后配置并测试模型、添加项目或直接聊天，正常流程无需外部 Node/pnpm 或手动启动 Host。

已安装位置：`/Users/cain/Applications/Outlive Agent.app`。新默认 profile 为 `~/.outlive/profiles/default`；旧 `.tracegraph` 数据须显式迁移，启动不会合并旧目录。升级替换应用而保留 profile，不自动重放任务。真实 Key 由用户配置；测试仅发送明确的小请求。可选 MCP/LSP 不阻塞普通对话。正常设置中的修复操作负责重新连接，详细运行时状态位于安装诊断。

## 最终交付字节

以下是此前保留的安装包字节。用户于 2026-10-06 要求清理旧构建包后，这些大型输出已删除；历史 SHA 与当时验收结论继续保留。Windows 交叉包已清理，用户进行原生验证前应从当前源码重新构建。

| 平台 | 实物 | SHA-256 与实际验收 |
| --- | --- | --- |
| macOS arm64 | DMG/ZIP 历史输出已清理 | DMG `4c0f86eba3be42245bbfbece0f573cc07792f63352e949399e5ed8c2cf06d1d1`；ZIP `ee45109d597944f8e7b97fabe6dc5bf97d3377a6f5a01b27ac023cd72660d0ee`。本机当前已安装版本见 2026-10-06 记录。 |
| Windows x64 | NSIS EXE/ZIP 历史输出已清理 | EXE `282f29259275c0ba7bbcee6ea072522ea9a954dfd091bad1ae2305a0e116d1fa`；ZIP `602ff1557481fa96a80c150d3d6a8312e8d1be5919c11293d018d004f4160f55`。macOS 交叉构建及目标二进制检查曾通过；原生安装/启动/PTY 尚未执行，需从当前源码重建。 |

macOS 最终 build ID：`c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`。
[安装回执](installed-dmg-receipt.json)记录 builder 应用、只读挂载 DMG 应用和实际安装应用的 11563 项文件/符号链接 inventory 一致，摘要为 `d08a5fa23ba72569142d2ef5e65590cebc2f19a588f6c8a6bb14223e0a84bbbb`。pre-builder stage 与真实 packaged inventory 分别记录；打包器会重新布置依赖、裁剪非运行元数据，不能将两者等同。

[验后字节复核](post-acceptance-byte-check.json)再次检查已打开的实际安装应用：11293 项 Main/application/runtime/launcher 文件与闭合成员清单均一致，最终 DMG/EXE 摘要相符。当前默认应用已打开在中文模型首次配置页；未填入用户模型 Key。

## 真实端到端结果

| 范围 | 结果与证据 |
| --- | --- |
| 最终安装版运行时 | [Mac-v2 smoke](../installed-local-product/final-mac-v2/report.json)：13 项通过；受限 PATH 中不含外部 Node/pnpm，真实 CodeGraph、随包 Node 子 PTY、同一 Web/CLI/Host、关闭窗口继续 Run、重开复用所有者、空闲设置重启后新 nonce/readiness。强制测试清理的 SIGKILL 单列，不等同正常 Quit。 |
| 正常退出应用 | [实际 native Cmd+Q](../install-use-workbench/attempt011-installed-native-quit/report.json)：Electron 正常 exit 0，同一 Host PID/nonce 保留并完成 held Run；实际随包 CLI 在 Electron 退出后读取同一 Run 完成事实。 |
| 最终 Web | [66 张截图、12 个流程断言](../install-use-workbench/attempt007-final-web-with-approval/report.json)，三种尺寸覆盖首次配置、真实认证失败与测试成功、项目/聊天、审批、文件写入、测试与审阅；独立证据检查 694 项。 |
| 真实 DMG 安装版 Desktop | [66 张截图、12 个流程断言](../install-use-workbench/attempt009-final-installed-dmg-desktop/report.json)，实际 `file:` Renderer/fixed preload/原生 Main/随包 CLI，与 Host 共用同一 Run/Action/test 事实；独立证据检查 706 项。验证实际下载 SVG/PNG、外部文件字节/hash、按需审阅与默认折叠活动。 |
| 三端真实媒体 | [最终安装版报告](../media-094/evidence/installed-mac-final/report.json)：94 断言、20 次实际随包 CLI、6 份真实 PNG/SVG、8 次受控 HTTP；[独立检查](../media-094/evidence/installed-mac-final/independent-verification.json)666 项，包括 12 个安装模块前后同哈希。 |
| 当前源码回归 | [构建、1379 单测、109 工程测试、32 eval、五个规范 snapshot 及失败记录](root-verification.md)。 |

UI 默认显示一句公开进展与一行真实活动，点击展开执行记录和输出；项目与聊天使用同一共享工作台。侧栏、头像设置入口、首次使用、模型与媒体配置、诊断入口和实际结果展示均已接到后端。取消或拒绝审批不会伪造成功。模型工具参数错误先整批拒绝且零执行，允许两次纠正，连续第三次失败才停止；策略拒绝仍直接停止。

## 媒体能力的明确边界

聊天模型生成代码或口头声称画图不能产生图片。现在显式接入专用 `openai-images`、Responses 图片工具和声明兼容的聊天原生图片协议；必须取得受校验的实际 PNG 字节才能形成成功回执。PNG 范围、凭据租约、unknown 命令去重、作用域、回放读取限制及错误见 [MEDIA-094](../media-094/README.md)。本地图表采用受限 SVG 描述，不执行任意 HTML/脚本。

上述 Provider 使用本地假密钥 HTTP 夹具；真实提供商权限、生成质量和成本未知。普通非 Patch UI 手动审批沿用现有机制并 fail closed，不能由正面的 Patch 审批测试推断所有媒体审批入口都可用。

## 路线图状态与发布边界

- HOST-087 自动运行时扩展、PAR-088/CLI-089/SET-090/DEV-091/RUN-092 原共享能力与 UX-086 本轮本机范围已有实现和操作证据。
- MEDIA-094 实现及受控三端验收完成；真实付费 Provider 的质量/费用不在该证据范围。
- BRAND-093 产品展示名称与候选已完成；[四个原创自然色 SVG](../../brand/README.md)供用户选。A 暂用于预览，最终商业标志尚未确认。
- DIST-095/REL-083 完成了安装器实现和本机 macOS 操作，**完整发行验收仍待完成**：全新 macOS/Windows 无开发工具安装与升级、Windows 原生 PTY/进程行为、平台签名/公证及真实非维护者。不能将 Windows cross-build、本机新 profile 或模拟 Provider 写为上述条件通过。

无云执行、Linux 安装包、开机启动或自动更新交付。未签名实物不提供平台信任承诺；[安装说明](../../releases/README.md)、[发行限制](../../releases/KNOWN-LIMITATIONS.md)与[任务表](../../outlive-agent-v2/09-implementation-roadmap/README.md)保持同一范围。旧共享三端[历史验收](../unified-local-workbench/README.md)和失败候选均保留，不能替代最终包证据。
