# REL-084 模拟安装验收

本记录覆盖用户授权的模拟流程：在同一台 macOS arm64 机器上，从冻结的预览归档重新解压开始，执行 Desktop 依赖安装、CLI/Host smoke 和三条公开证明。**结果为模拟通过，不是非维护者独立验收。**参与者身份、环境、限制与归档摘要见[机器可读记录](report.json)。

首次模拟事件所引用的 README 内容快照保留为[初始版本](README.initial.md)；本版补充了 GUI 重观察超时的失败记录。

## 归档与安装

预览归档 SHA-256：`79a06960f699339c0c5136497f535bf0e0e515d17fc6b5415d18595ed7534827`。随包 `SHA256SUMS` 中归档和 release manifest 两项均核验通过；CycloneDX SBOM SHA-256 为 `914832f9e02f26f7547785aea5c1d232f583fa2160cb44ae9e590cc1536b12dc`。安装说明 SHA-256 为 `1d72053c3bf48ddef6dfadf7b296b6fc229c42926be28c3b79dbb4037d658bf4`。

从新解压目录运行 `node scripts/preview-install.mjs --desktop`，退出码 0，报告 `Verified preview installed with Electron.`。随后 `node scripts/preview-smoke.mjs` 通过：`sessions list` 返回空会话且退出码 0；Desktop Host 包名、`0.1.0-alpha.0` 版本与协议 v2 一致；Host 正常退出且子进程已消失。包内依赖解析均落在解压目录。该次安装复用了本机 pnpm 内容寻址缓存中的 364 个包，所以不构成无缓存裸机测试。

Desktop 预览窗口有一条此前针对**同一完整归档摘要**的 CUA 实机回执：文件渲染器处于 `preview=1`、页面显示“演示预览”标记、Desktop Host worker 数为 0，见[窗口观察事件](desktop-preview-event.json)，事件 `evt:run:48af35a3438c:000008`。本轮尝试重新观察窗口时 CUA 超时（`-10005`），所以这里只引用同摘要的既有回执，没有声称本轮新捕获。

## 三条证明

在刚安装的归档内重新运行 `node demos/proofs.mjs --output <临时目录>`，DEMO-080/081/082 全部通过；[原始证明报告](public-proofs.json)保留逐项 oracle。

- DEMO-080：真实 worker 在 patch apply 与 WAL applied 之间被 SIGKILL；恢复只重放一次 patch 与 verify，重复 reconcile 不新增事件，文件摘要不变。
- DEMO-081：原始与更正 Memory 均可召回；superseded/revoked 项被排除，撤销项导出被拒绝，并提示已导出的副本不能被远端删除。
- DEMO-082：取消后 leader、后代与进程组均消失；仅一次模型派发、无待处理输入和活跃子 Agent，最终事件为 `run.cancelled`。fixture 中在安全取消点之前也记录了 sandbox 结果无法验证的 `tool.failed`，因此这项证明限定为取消静默与回收语义。

## 失败记录和边界

一次较早的 `--desktop` 重试发生在 smoke 使用 `pnpm exec` 之后；该命令给预览解压目录写入了未列入归档清单的 `apps/cli/node_modules`，完整性门正确拒绝继续。随后重新解压原样归档，在安装前先执行 `--desktop`，通过；没有改包或放宽校验。

本模拟由维护者工作区中的 Agent 执行，机器、系统依赖与 pnpm 缓存均由同一维护者控制，没有真实非维护者参加，也不是干净机器测试。此证据可以闭环本次授权的**模拟安装路径**，不能作为“至少一名独立外部用户已验证”的事实。归档尚未签名或公开发布。

模拟通过事件 `evt:run:ccb861a365e6:000009` 保留原始回执；本版报告与 GUI 观察限制的更新已记录于 `evt:run:ccb861a365e6:000952`。REL-084 模拟所需的临时解压目录和证明输出已在保留本报告后删除。
