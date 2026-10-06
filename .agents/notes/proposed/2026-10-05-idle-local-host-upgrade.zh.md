---
id: idle-local-host-upgrade-2026-10-05
status: proposed
owner: HOST-087 / DIST-095
last_reviewed: 2026-10-05
language: zh-CN
---

# 本机 Host 版本在空闲点原子接替

[English](2026-10-05-idle-local-host-upgrade.md)

## 范围与已确认要求

用户已授权安装即用产品。经过验证的新安装包应能在安全空闲点接替支持协议的私有 owner，无须用户通过 CLI 手动停止。后台工作、显式停止意图、审批与未知效果仍保留权威。本 Note 已在生命周期和协议修改前记录决策。下述源码与隔离验证是当前事实；整合安装包验收待进行，Note 暂保留 `proposed`。

## 决策

1. Main 与内置 CLI 复用 native connection/ensure 接缝。不同 build 调用封闭、私有认证的 `prepare-upgrade`，只传命令标识、预期 Profile/owner nonce 和目标 build 标识。禁止 renderer/model 路径、任意 RPC、按 PID 杀进程和重播工具。
2. 旧 owner 先同步封闭 mutation/Run 准入并暂停 scheduler producer，再检查已准入 mutation、workspace claim、持久 Run/Goal/命令事实、审批、终端/预览、浏览器会话与原生电脑租约。未知、缺失、损坏、超出界限或不支持状态明确拒绝并保留旧进程；繁忙拒绝后恢复准入与 producer。
3. 准备回执先写入规范 SessionEvent 命令账本，再关闭 owner。prepared 只表示准入已封闭，不表示新版本成功。Native 客户端等待旧租约/discovery 退出，再核对显式停止意图，只启动自己验证过的内置 Node/worker 路径。成功必须是同 Profile、指定 build 的新私有认证 owner；任何旧 Run 或写入均不重提。
4. 客户端退出、准备结果未知、清理失败和旧协议不支持，都不触发 kill、猜测停机、重播 mutation 或绕过停止标记。没有此协议的旧 owner 继续显示 upgrade-required；不能安全地把新代码追注入已运行的旧进程。
5. GET/health 不作为空闲依据。Replay 不发起升级。源码模式的显式 buildID 不等于生产安装包权威；隔离测试可用实际固定 worker 路径与明确标识组装临时 owner。
6. build 哈希没有时间顺序。已绑定不同 build 的客户端不能反向接替已确认的新 owner；规范 source/target 退役记录禁止自动回到已退役源 build。明确降级需单独人工操作，避免旧窗口/CLI 在两个 build 之间来回切换。

7. 已完成的 `models.capabilities.test` 回执属于封闭的只读模型测试，不属于未知项目写入。严格结果和原 `command_id` 必须验证；`status: unknown`、`usage_status: unknown` 原样保留，不形成永久写锁。实际请求与回执投影的 `pending` 仍阻断接替。私有 prepare 是序列化生命周期检查，不计作业务 mutation；其它已准入命令直到 handler 真正结束才释放，断开 socket 不能冒充结算。

## 验证与限制

负例必须涵盖活动/排队 Run、未结束审批/Goal/命令/效果、定时器竞态、并发 mutation/start、活动浏览器/电脑租约/资源、伪造 owner/Profile、错误安装包、Replay、停止意图、清理失败与旧协议不支持。真实临时 Profile 子进程证据应证明 PID/build 接替、单一 owner、持久配置与 Run 事实不变、没有任务/模型/写入重提，并清理全部自有资源。正式签名、Windows 原生和付费模型质量仍是独立条件。

## 实现证据

- [当前源码和命令验证](../../../docs/validation/idle-local-host-upgrade/README.md)：五个窄测试文件、28 项通过；使用真实本地 provider、UDS handler 和 detached 子进程。Host build 与 Host/Core typecheck 均退出 0。历史失败尝试保持可查。
- [私有生命周期/回执控制器](../../../packages/host/src/local-host-upgrade.ts)、[owner 与 native transport](../../../packages/host/src/local-host.ts)、[连接监督器](../../../packages/host/src/local-connection-supervisor.ts)、[HTTP handler 生命周期](../../../packages/host/src/webserver/index.ts)、[Memory producer 屏障](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)。
- [真实子进程 oracle](../../../packages/host/src/local-host-upgrade-owner.e2e.test.ts) 验证并发首次客户端收敛到一个新 PID/nonce/build，同 Profile/gateway，凭据/设置原始字节和完整 completed Run 时间线保持一致。原任务只请求一次，所有 provider 请求均先于规范 prepared 事件；旧派生工作可以在准备前正常结束，不误算为重播。
- [真实 probe 结算](../../../packages/host/src/local-upgrade-model-probe.test.ts) 拒绝仍在执行的网络与回执投影，随后允许无用量成功结果和已终止的只读 unknown 结果，不重提。 [断连 handler](../../../packages/host/src/local-upgrade-aborted-handler.test.ts) 保留业务准入直到原 handler 完成。

子进程 fixture 使用受支持开发 Node 的硬链接、严格测试 runtime manifest 和真实固定 worker，不证明 vendor runtime/安装包、Windows 原生、签名升级或任意旧二进制。缺少升级协议时须先用旧应用支持的 Stop Host 操作明确安全退役。未知清理/回执、waiting Memory job、活跃浏览器/输入/资源租约和检查界限均保留旧 owner，不通过取消工作制造空闲。
