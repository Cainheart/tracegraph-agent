# UX-086：参考、用户旅程与能力边界

验收对象是本地工作树中的 Outlive Agent `0.1.0-alpha.0`。本文说明交互来源与测试要求；实际通过项以同目录运行回执和截图为准。

## 参考与来源

2026-10-03 实际读取的[官方 Features 页面](https://learn.chatgpt.com/docs/features)展示 New chat、Pinned、Projects、Recents 导航，以及任务与文件输入入口。[官方工程工作流说明](https://developers.openai.com/blog/mastering-codex-remote-for-engineering)说明对话内审阅变更、逐文件 diff、排队与 steer、明确审批的操作循环。

据此选择通用交互模式：对话为默认主区、输入区靠近当前任务、项目与会话持续可见、活动与审阅按需展开。这里的布局和 Outlive 实现映射是工程设计判断，不是对 Codex 内部源码或架构的断言。本机 Codex 的 CUA 读取被工具拒绝，没有绕过限制或读取其私有会话、凭据与内部数据；没有复制品牌素材。

## 核心用户旅程

| 用户目的 | Outlive 操作链 | 验收观察 |
| --- | --- | --- |
| 开始普通对话 | 新对话 → 输入 → 发送 → 查看回答 | 使用真实 client/Host；返回 canonical Run/Session；没有项目也可对话 |
| 开始仓库任务 | 打开本地目录/选已注册项目 → Plan/Execute → 提交 | 项目选择可见；权限来自 Host；任务输入与 Run 状态一致 |
| 管理上下文 | 项目导航 → 搜索/切换 Session → 恢复已中断会话 | 打开历史不执行工具；显式恢复经过 controller；保留失败提示 |
| 继续或调整任务 | 结束后输入后续任务；运行中 message/steer/cancel | 命令具有 canonical receipt；当前 Run 不被迟到响应抢回 |
| 观察执行 | 对话中的公开活动 → 轨迹 → Tool 详情 | 区分公开计划、工具事实与易失活动；不显示私有推理 |
| 审阅变更 | 变更入口 → 文件 diff → 测试回执 → 审批或拒绝 | Artifact 内容真实校验；缺失/截断证据不能被当成审阅完毕 |
| 管理计划与 Todo | 公开计划审批 → Todo 更新 | 通过固定 Desktop bridge、schema 和 Host/controller；不由 UI 编造事实 |
| 设置模型 | 设置 → provider/model/key → 保存 → 新任务 | 凭据 write-only，来源明确；缺 provider 时展示实际失败 |
| 检查 Preview | 启动 Preview → 切换确定性场景 | Preview 标签持续可见；不连接 Host/模型，不能混为 live 验收 |

## 与 Codex 的范围映射

| 通用模式 | UX-086 交付边界 | 独立限制 |
| --- | --- | --- |
| 项目/会话侧栏与固定输入区 | Web/Desktop 共用 React workbench | 固定会话只是一项本机视图偏好，不改变 canonical Session |
| 活动、工具结果与变更审阅 | 保留 Ledger 投影、Artifact/test receipt 与 replay 检查 | Desktop 事件使用有界轮询；不声称与 Web SSE 延迟相同 |
| 审批与恢复 | 固定 IPC/RPC 命令、schema 验证、运行权限冻结 | 不放宽 sandbox、approval、Memory/export consent |
| 模型设置 | 已有本地 provider 配置 | 不声称任何具体供应商模型质量或全部 Codex 模型可用 |
| 云任务、账号同步、多人协作 | 范围外 | 没有为这些能力增加占位按钮或虚假入口 |
| 安装与发布 | 重建 unsigned 本地预览归档并验证其摘要 | 签名安装包、自动更新、真实非维护者独立安装仍需单独交付 |

## 布局与键盘验收

两种 surface 分别在 1440×900、1280×800、1024×768 下覆盖空工作区、活动 Run、工具结果、变更审阅。检查核心输入和导航可达、无页面级横向溢出、按钮可操作、对话与审阅区域可滚动。窄视口不显示只读替代页。

键盘至少覆盖导航到新对话、输入、提交、视图切换与返回输入；输入法组合期间不触发快捷提交，历史/replay 不允许写操作。屏幕截图只能证明已观察到的状态；真实 Host 操作另由执行回执证明。
