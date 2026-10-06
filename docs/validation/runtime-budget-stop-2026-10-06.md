# macOS Run 提前停止：历史诊断与当前策略

日期：2026-10-06
环境：macOS Apple Silicon；隔离 Profile `desktop-preview-2026-10-06`。

该隔离预览 Profile 已在 2026-10-06 安装复核后清理；默认用户 Profile
未改动。对应安装及保留范围见[安装记录](desktop-install-2026-10-06/README.md)。

## 结论

截图中的 Desktop 窗口仍在运行；停止的是两次 Run。它们处理的是“你介绍下当前这个项目”，不是持续 Goal。截图当时的旧 Host 为普通 Run 配置了有限的 200,000 Token / 900,000 毫秒预算，在第 9 次模型请求派发前因剩余额度无法容纳请求而安全停止。时间上限没有到达，已有项目操作均为只读。`213K / 226K` 是上下文窗口读数，不是此累计预算。

运行账本显示，两次 Run 分别有 8 次模型用量回报、115,053 和 121,149 总 Token；各有第 9 次 `model.request_started`，但没有对应的用量回报。请求预留检查阻止了无法装入剩余额度的请求。账本中的初始化、上下文整理和用量估算事件不是模型最终回答，也没有理由显示成 Goal 进度。

误导来自旧终态：它用 `Goal budget stopped`，并把 `delivery:` 所有者写入 `goal_budget`。Workbench 展示时就像一个不存在的 Goal 停止了 Run。兼容修复让 Runtime 按可信预算所有者记录内部代码与字段；旧记录的摘要只读重建，依据原终态错误码和 `run.created` 的预算身份。

## 影响与安全边界

这两次 Run 的工具事件只有 `read_artifact`、`list_dir`、`read_file` 和 `list_artifacts`；未发现文件写入、项目命令执行或未核对的副作用。两个已停止的历史 Run 没有被重跑。

当前普通 Run 不设置累计 Token、总时长或固定轮数上限；它仍受所选模型上下文窗口、单次输出限制、无进展保护、单项工具超时、权限审批和用户取消约束。Goal 继续使用用户明确设置的预算。上下文压缩在可用输入预算约 80% 时开始；模型请求仅对收到响应前的暂时性失败最多重试五次，模型重试不会重新派发工具或写操作。策略取值参考 DeepSeek Harness 配置目录中的 `thresholdRatio` 默认值 `0.8`。

## 修复与验证

- Core 在终态中按预算身份写入正确的 `delivery_*` / `goal_*` 代码、`budget_kind` 和身份字段。
- Workbench 对旧版 `Goal budget stopped` 只读投影作兼容修复；聊天将预算停止与用户主动停止区分。
- 继续保留预算身份与旧终态兼容修复；普通 Run 已移除 Host 注入的累计预算和环境变量轮数上限。
- Core 覆盖了普通 Run 超过 200,000 provider-use tokens 仍可完成，以及历史有限预算恢复 fixture 的旧行为。
- 模型请求策略最多六次总尝试（一次初始请求加五次重试）；只有响应前可确认的暂时性模型错误可重试。
- 上下文在可用输入预算 80% 开始压缩。Goal 的用户预算和所有操作安全边界保持有效。
- 历史安装包 Build ID `05497c906eb674213d5db0104b304a14287450adebc7cd2a57d261e2707e3dd9` 不是本轮最新包；最新构建与安装验证见下方后续更新。

## macOS 体验包

较早的 Apple Silicon 目录包记录如下，仅作为前一轮安装证据：

- 该临时预览包已在 2026-10-06 存储清理中移除；相同 Build ID 已安装到 `/Users/cain/Applications/Outlive Agent.app`。此次实际安装与启动证据见 [macOS Desktop 安装记录](desktop-install-2026-10-06/README.md)。
- Build ID：`05497c906eb674213d5db0104b304a14287450adebc7cd2a57d261e2707e3dd9`
- Profile：复用原隔离预览 Profile `desktop-preview-2026-10-06`，已有聊天保留。
- 状态：前一轮本机预览包曾启动；没有重跑停止的 Run。
- 发行边界：此目录包未签名、未公证，不等同于正式安装版；Gatekeeper、签名和公证仍待有效发行凭据及正式发行验收。

该历史安装没有修改默认 Profile 或清理用户资料。后续新版的构建、真实 DeepSeek 模型目录回执、默认 Profile 保留和启动验证见[重建安装记录](desktop-install-2026-10-06-rebuild/README.md)。Windows 原生验收仍待用户在 Windows 环境完成。
