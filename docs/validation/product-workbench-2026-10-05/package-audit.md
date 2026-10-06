# macOS 包装字节独立审计

本页记录包装资源、依赖和来源字节的一致性。审计没有启动 App、安装 DMG、发送模型请求、执行产品工具、清理 Profile 或操作服务；只新增本页和 [JSON 检查记录](checks/package-audit-final.json)。实际 GUI 验收由主报告分别记录，不从包装成功推导产品成功。

## 当前最终包

历史包装目录：`_tmp_release/product-workbench-2026-10-05-mac-final`（已于 2026-10-06 清理）；macOS arm64，版本 `0.1.0-alpha.0`。

| 项目 | 实际值 |
|---|---|
| build ID | `c1144883e205de7fb1f9fa342ec29abfa1347536db233f0e6f740b4f10081907` |
| DMG | `Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg`，769,728,881 bytes；构建包已于 2026-10-06 清理 |
| DMG SHA-256 | `0ad01e4e56aedbe28d610574e492036353f45c05806b4fae978206fa6e05a419` |
| ZIP | `Outlive-Agent-0.1.0-alpha.0-mac-arm64.zip`，753,119,312 bytes；构建包已于 2026-10-06 清理 |
| ZIP SHA-256 | `f71c9f4680e47fa30311f9f6dcc70d69990e8d68e907097055494e2163620537` |
| App | 历史构建包已于 2026-10-06 清理；本机当前安装路径见最新安装记录 |
| 发行元数据 | 历史文件已于 2026-10-06 清理；本页保留当时的身份与 SHA 结果 |
| 组装日志 | [product-macos-final-assembly.log](checks/product-macos-final-assembly.log) |

重新计算 stage build ID，结果与 stage receipt、stage inventory、packaged inventory 和 release 元数据四处相同。算法来自 [交付组装脚本](../../../scripts/build-desktop-product.mjs)：stage App 文件清单、安装前浏览器/电脑助手清单、固定 Node 版本及资源策略共同组成身份。该身份与实际 ZIP/DMG 容器 SHA 的边界不同。

| 检查范围 | 结果 |
|---|---|
| stage 完整树 | App 16,432、runtime 906、launcher 1 个文件；逐文件 SHA/长度、缺失、额外及非普通文件检查全部通过 |
| 实际 packaged 完整树 | App 11,801、runtime 906、launcher 1 个文件；逐文件 SHA/长度、缺失、额外及非普通文件检查全部通过 |
| 当前构建来源 | stage 中映射到当前 workspace dist 和 examples 的 2,042 个文件逐个比较，无缺失或字节漂移 |
| 实际主程序 | `Contents/MacOS/Outlive Agent` 长度与 SHA 匹配 packaged inventory |
| 安装内依赖 | 独立解析 package manifest 和逐层本机解析路径；226 个包、608 条边全部闭合，名称和精确版本匹配，没有逃出 App 的依赖 |
| 容器 | DMG、ZIP 和各自 blockmap 的实际长度与 SHA 全部重算一致 |
| ZIP 内关键资源 | 直接读压缩包中的 9 个关键条目，与 unpacked App 完全相同，没有解包或执行应用 |

打包器从 stage 删除 4,683 个源文件、测试、声明或文档文件，194 个保留路径的变化全部是 `package.json` 的元数据规范化。52 个新增路径来自同一 stage 中嵌套依赖的搬移：非 manifest 文件字节相同；搬移后的两个 manifest 只删除了 `bugs` 或 `keywords` 描述字段，包名、版本及运行依赖保持一致。JSON 记录保留对应来源路径与差异，不能把打包器搬移误报成新运行代码。

## 内置资源

| 资源 | 实际检查 |
|---|---|
| Node | `24.21.0`，arm64 Mach-O、0755；实际执行文件 SHA `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`；本地固定官方归档 SHA 与脚本 pin 一致 |
| Chromium | Playwright `1.63.0` 固定资源，arm64 Mach-O、0755；执行文件 SHA `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a`，浏览器资源完整清单匹配 |
| 原生电脑助手 | arm64 Mach-O、0755；SHA `f3af0d185e6f8cebd8c877e13b37fea94c74b4931fe6cbca0572d5c35b714d1d`，按 [原生组装脚本](../../../scripts/build-native-computer.mjs) 的文件名与内容算法计算，源码 SHA 与 manifest 相同；严格单文件签名检查 exit 0，属于 ad-hoc 签名 |
| PTY | darwin-arm64 原生 addon 和可执行 spawn helper 均存在且架构正确；资源在完整文件清单内 |
| TypeScript | darwin-arm64 `7.0.2` 原生编译器与运行时标准库存在，保留 108 个 `*.d.ts` 文件；没有重现旧包删掉 `lib.d.ts` 的资源缺失 |
| CLI | `Contents/Resources/bin/outlive` 为 0755，与当前 launcher 源文件字节相同；本审计不执行 CLI |
| B 图标 | 实际 `Contents/Resources/icon.icns` 与当前源图标完全相同，SHA `bc59efedb9292c9235f75c594dab406daf5dd15bad34c729e5e4a36a765de8d2`；[资产 manifest](../../brand/assets-manifest.json) 的 21 个文件及选中 SVG 源全部重新核验 |

实际 Main 指定 `preload.cjs`，ZIP 中该文件与 App 相同。审计脚本最初误用 `preload.js` 作为探测路径；JSON 中保留这个探测更正，未改任何产品资源。

## 签名及本轮未验证范围

最终组装日志明确跳过 macOS 签名，release 为 `signed: false`、`signature_status: not-requested`、`notarization_requested: false`。电脑助手的 ad-hoc 签名不能替代 Developer ID 或公证。

实际 Chromium `codesign --verify --deep --strict` 返回 exit 1：`code has no resources but signature indicates they must be present`。原始固定 Playwright cache 的同一 Chromium 也返回相同结果。JSON 保留两个真实命令和输出；本轮未证明这是新的复制缺陷，也不能把它标成正式供应商资源封印通过。实际运行与 macOS 安全机制结果需要对应原生验收。

packaged inventory 覆盖 `Contents/Resources/app`、`runtime`、`bin` 和主程序，并非外层 Electron Frameworks、Info.plist 和 icon 的逐文件完整清单。图标与 plist 另行核对，容器 SHA 绑定交付归档。本审计未挂载/安装 DMG、验证 Gatekeeper、OS 授权、通知送达、实际 Dock 图标、Windows 原生环境、干净升级或独立用户质量。

## 第一包历史

第一包目录 `_tmp_release/product-workbench-2026-10-05-mac` 已于 2026-10-06 清理，build ID `c3d948403041ddb92b5a801c334ced78598d392cc871f8ebefade9a316046e05`。原 DMG SHA 为 `963ad32724a8929d994fda2a9923bff7e6d748078291b4d08da929980e90eebe`，ZIP SHA 为 `e246e78522c6d08991ad10fce2c15c0ae0497e75b34902b47b8e32efda75f991`；组装日志保留在本目录。

上一轮独立只读检查也确认第一包 stage/packaged 清单、226 包/608 边及关键运行资源完整，并观察到原始 Chromium cache 的同一严格签名失败。该轮逐项检查工具输出只存在会话中，没有把它伪装成本页新保存的 raw stdout。第一包真实 Skills、截图保留、共享 CLI、重连与退出记录继续由[主报告](README.md)保留；后续公共回答文案与 Skills 成功回执修复进入本页的当前最终包，因此第一包不充当最新字节或 GUI 验收。
