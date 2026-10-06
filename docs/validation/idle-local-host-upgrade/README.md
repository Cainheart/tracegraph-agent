# 本机 owner 的安全空闲升级：源码与隔离验证

2026-10-05，HOST-087 / DIST-095 的本轮窄切片。当前支持固定协议的 owner，可由已验证本机 runtime 的新客户端在安全空闲点替换；旧任务、写入和审批均不重提。新安装包 GUI、Windows 原生和签名升级验收待整合发布另行记录。本报告不改写前一安装包的事实。

## 当前实现

- [Owner/controller](../../../packages/host/src/local-host.ts)、[私有升级控制器](../../../packages/host/src/local-host-upgrade.ts)、[supervisor](../../../packages/host/src/local-connection-supervisor.ts)：绑定 Profile、owner nonce 和 source/target build，固定私有认证 prepare/status/receipt；不接受路径、任意 RPC 或 PID kill。
- 准入同步封闭，再暂停 producer、检查活跃 Run/Goal/审批、工作区 claim、浏览器/电脑租约、资源、在途 handler 和规范日志/WAL。繁忙拒绝恢复原服务；未知、清理失败或 prepared-only 保持旧 owner/租约，不启动另一个 Runtime。
- `owner-upgrade-events` 使用既有 SessionEvent/WorkbenchJournal；prepared 与 retired 是不同事实。启动新 owner 前验证 retire、lease/discovery 释放与显式 stop 标记。停止意图不因升级/监控而清除。
- [HTTP 生命周期](../../../packages/host/src/webserver/index.ts) 在真正的 handler 响应后释放准入；socket abort 不表示业务结束。并发 prepare 属于串行生命周期检查，不算彼此的业务 mutation；所有其它已准入业务命令仍阻断接替。
- [Memory](../../../packages/core/src/domains/memory/memory-background-pipeline.ts)、[工作区](../../../packages/host/src/workspace-coordinator.ts)、[scheduler](../../../packages/host/src/scheduler.ts)、[视觉清理](../../../packages/host/src/visual-evidence-control.ts) 有 owner barrier。Memory 等待/重试索引不受公开 100 条 job 投影截断影响。进行中的 Full grant 自动检查也计入繁忙。
- 完成的 `models.capabilities.test` 严格验证结果/command ID，保留能力和用量 unknown；它不执行项目工具，不成为永久未知文件写锁。真实网络、完整 receipt/projection `pending` 仍阻断升级，历史测试不会重发。
- 规范工具 action 使用顶层 `action_id`，并行工具互不覆盖；未知效果只由对应 action 或原命令的明确对账事实解除。当前 Run 状态来自 canonical projector，旧 interrupted 后 resumed 不被当作终态。

## 已执行验证

运行环境为本机 macOS。全部 fixture 使用新建临时 Profile、本地受控 HTTP provider 和 fixture key，不读取默认 Profile/用户凭据，不发送付费模型请求。

| 命令 | 当前结果 | 原始日志 |
|---|---|---|
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host build` | exit 0 | [Host build](checks/host-build-complete.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host typecheck` | exit 0 | [Host types](checks/host-types-complete.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/core typecheck` | exit 0 | [Core types](checks/core-types.log) |
| `env -u NODE_OPTIONS pnpm --filter @tracegraph/host exec vitest run src/local-host-upgrade.test.ts src/local-upgrade-model-probe.test.ts src/local-upgrade-aborted-handler.test.ts src/local-host-upgrade-owner.e2e.test.ts src/local-connection-supervisor.test.ts --maxWorkers=1 --no-file-parallelism` | 5 files / 28 tests PASS | [最终窄测试](checks/focused-complete.log) |

日志实际命令在相应 package cwd 执行，表中 filter 形式对应同一脚本/测试集合。没有重跑整库或 installer，也没有制造额外 stdout。

| 测试 | 实际 oracle |
|---|---|
| [升级控制器 8 tests](../../../packages/host/src/local-host-upgrade.test.ts) | gate 先封闭、第二客户端拒绝并观察；业务/producer busy 不取消、未写 prepare；failed append 保持 sealed；prepared-only 不启动；retired source 禁止回退；并行 action、准确对账、旧 terminal 后 resume、实际 WAL；伪造 Profile/path 词汇拒绝 |
| [模型 probe 2 tests](../../../packages/host/src/local-upgrade-model-probe.test.ts) | 实际本地 HTTP held request 与后续 receipt projection 保持 pending；无 usage 的成功结果、已 abort 的 unknown 结果保留，允许结算后升级；provider 每例只调用 1 次 |
| [断连 handler 1 test](../../../packages/host/src/local-upgrade-aborted-handler.test.ts) | 真实私有 UDS HTTP socket abort 后原 handler 未结束，计数仍 1；实际 promise 完成才为 0 |
| [实际 owner 3 tests](../../../packages/host/src/local-host-upgrade-owner.e2e.test.ts) | 两首次客户端收敛到 1 个新 detached PID/build/nonce；同 Profile/gateway；credential/settings 字节一致；原 completed Run 完整 timeline 一致；原任务仅 1 次，全部 provider 请求先于 prepared 事件；真实 held Run/未结算 file command 拒绝；停止 marker 不被新 bundle 恢复 |
| [supervisor 14 tests](../../../packages/host/src/local-connection-supervisor.test.ts) | 保留恢复预算、读/写 generation 与 Replay 边界；已绑定旧窗口不反向替换 foreign build；源码身份不冒充 bundle 权威 |

实际进程 fixture 硬链接经独立身份探测的受支持开发 Node，并给临时 runtime manifest 指定 test build `a…a` / `b…b`；使用真实固定 worker、私有 socket 和 owner/root lease。这证明进程/协议闭环，**不证明 vendor Node 图、正式安装包签名或 Windows 原生行为**。配置比较只忽略由读取文件 mtime 派生的 `credential.last_updated_at`；credential 原始文件 SHA 和其它公开字段必须完全一致。所有临时 owner/profile 在 `finally` 中显式清理；不操作其它 owner。

完成 Run 后，原 owner 的合法 Memory 派生请求可能仍在收尾；fixture 只对权威的 background-busy 拒绝作有界等待，不猜测 idle、不延长 deadline、不取消任务。零重提 oracle 使用任务请求数、完整 timeline 和规范 prepared 事件时间，不能把准备前的原后台请求误算为升级重发。

## 保留的失败与诊断

- [历史断连实现负例](checks/aborted-handler-before-fix.log)：仅临时还原旧 `onRequestAbort` 释放准入逻辑，真实 handler 尚未结束时计数误为 0；exit 1。源已在 `finally` 还原，修后最终集合通过。
- [模型 probe 修前负例](checks/model-probe-before-fix.log)：真实成功但缺 usage、真实 abort 后已结算的只读 unknown 两例都被误算为未知文件效果；2/2 FAIL。 [修后](checks/model-probe-after-fix.log) 两文件 10 tests PASS。
- [第一组当前尝试](checks/focused-current.log)：25/26 PASS；换 owner 已执行，公开 credential 派生时间相差 1 ms 的断言失败。修正为原 credential 字节 SHA + 除派生时间外全部公开字段。
- [完成 Run 后直接尝试](checks/focused-final.log)、[并发修正后尝试](checks/focused-final-after-concurrency-fix.log)：27/28 PASS；权威 busy 拒绝保持旧 owner，不能把 Run.completed 或固定 150 ms 当后台已结算。
- [单客户端诊断](checks/single-client-diagnostic.log)、[并发诊断](checks/concurrent-client-diagnostic.log)：各 1 PASS / 2 未选中。前者不能单独证明所有失败由并发造成。
- [不合适的后台 job fixture](checks/focused-settled-final.log)：27/28 PASS；等待不存在的推导 job 超时，没有发生 upgrade。该假设不再作为验收依据。
- [过早模型调用计数](checks/process-final.log)：2/3 PASS；将准备前正常派生请求误算成重发。最终 oracle 按原任务及 prepared 时间核对，失败原文保留。

## 兼容与未证明边界

不认识 `outlive.local-upgrade.v1` 的已运行旧二进制不能被追注入新协议。保持 `local_host_upgrade_required`，先通过旧应用支持的 Stop Host 操作明确安全退役，再打开新安装包；不会自动 kill。未知历史/WAL/cleanup、超界/损坏事实、waiting Memory job、开放浏览器标签页、暂停但未交还的电脑 lease 及后台资源均阻断接替，并给安全原因。

本轮没有实际 OS 崩溃/清理失败后强制接替、Windows pipe/native installer、任意第三方老 owner、签名/公证、跨版本 schema 迁移或付费 provider 质量验收。未知写入需要原有只读对账，不会为升级自动执行修复。软件 resume 另属显式用户控制；升级本身不调用 resume。整合 full build/unit/打包与实际安装 GUI 由主任务继续验证。

[模块 09 当前边界](../../modules/09-Host-与-SDK-接口层.md) · [决策 Note](../../../.agents/notes/proposed/2026-10-05-idle-local-host-upgrade.md)
