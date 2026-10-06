# macOS final2 包装字节独立审计

本页只记录 final2 实际文件、依赖与来源字节。审计没有启动 App、CLI、浏览器或电脑助手，没有安装/挂载 DMG、读 Profile、调用模型、运行测试或操作服务；仅新增本页与 [JSON 检查记录](checks/package-audit-final2.json)。GUI、恢复与原生行为由主任务独立验收，不从组装或本页 PASS 推导。

## 当前对象和身份

历史包装目录：`_tmp_release/product-workbench-2026-10-05-mac-final2`（已于 2026-10-06 清理）；macOS arm64，版本 `0.1.0-alpha.0`。

| 项目 | 实际值 |
|---|---|
| build ID | `bc5bfd8ed89043fb63f149bcf195231d266aa34caa9795e494a23cf4bb91caa9` |
| DMG | `Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg`，769,797,890 bytes；构建包已于 2026-10-06 清理 |
| DMG SHA-256 | `bae5b0bf58481fb5386d38a777535ddd00a916ce4e3b862a774b655b1641f34c` |
| ZIP | `Outlive-Agent-0.1.0-alpha.0-mac-arm64.zip`，753,214,627 bytes；构建包已于 2026-10-06 清理 |
| ZIP SHA-256 | `9abe022616b4468ef63ac281c3c327dfe8da18047c88429c2c9e8614f2f9327c` |
| 实际 App | 历史构建包已于 2026-10-06 清理；本机当前安装路径见最新安装记录 |
| 发行元数据 | 历史文件已于 2026-10-06 清理；本页保留当时的身份与 SHA 结果 |
| 组装日志 | [product-macos-final2-assembly.log](checks/product-macos-final2-assembly.log) |

按 [组装脚本](../../../scripts/build-desktop-product.mjs) 的实际身份算法，用 stage App 清单、Node 固定版本和安装 Node 前的 browser/computer 资源清单重新计算 build ID。计算结果与 stage receipt、stage inventory、packaged inventory、release 四处完全相同。build ID 表示交付前资源策略与 stage 身份；DMG/ZIP SHA 则表示具体交付容器字节，两者不混用。

## 清单、来源和依赖

| 检查 | 实际结果 |
|---|---|
| stage 完整树 | App 16,464、runtime 906、launcher 1 个文件；长度/SHA、缺失、额外、symlink/非普通文件检查均通过 |
| packaged 完整树 | App 11,825、runtime 906、launcher 1 个文件；同样逐个核验，0 漂移/缺失/额外/不支持文件 |
| 当前构建来源 | stage 中映射到当前 workspace dist/examples 的 2,074 个文件逐个比较，一致 |
| 实际主程序 | `Contents/MacOS/Outlive Agent` 长度/SHA 与 packaged inventory 一致 |
| 依赖闭包 | 独立解析实际 package manifest 与逐层 Node resolution；226 个包、608 条边闭合，精确名称/版本匹配，无 App 外路径 |
| 容器与 blockmap | 两个归档、两个 blockmap 的实际长度/SHA 全部与发行记录一致 |
| ZIP 关键资源 | 直接读取 9 项压缩条目，与 unpacked App 字节一致；没有解包或执行产品 |

JSON 保存各个树清单的重新计算 hash。Packager 删除 4,691 个 stage 文件，194 个同路径变化全部是 `package.json` 规范化，没有运行代码变化；名称、版本、入口、exports、dependencies 等检查字段一致。52 个新增路径来自 stage 内嵌套依赖搬移，50 项可找到相同字节源；两个被搬移 manifest 仅分别删除 `bugs`、`keywords`，运行身份与依赖一致。记录保留这些搬移对应源路径，不能把它们当作无来源文件。

9 项 ZIP 检查是 runtime/browser/computer manifest、电脑助手、ICNS、CLI launcher、Main、`preload.cjs` 与 TypeScript `lib.d.ts`。这不是整 ZIP 解压树逐项复算；完整容器由实际 SHA 绑定，实际 App/stage 则分别逐文件核验。

## 内置资源

| 资源 | 实际检查 |
|---|---|
| Node | `24.21.0`，arm64 Mach-O、0755；SHA `e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b`；本机固定官方归档 SHA 与脚本 pin 相同 |
| Node 动态依赖 | `otool -L` exit 0，仅系统 CoreFoundation/Security/libc++/libSystem，没有 Homebrew 或开发 Node 的 libnode 路径；未执行 Node |
| Chromium | Playwright `1.63.0` 固定资源；arm64 Mach-O、0755；入口 SHA `8319963f6625accf51c0dd4f55091ceaf9f09ed39e7a52fed4fae12b2a6b668a`；整个 runtime 清单匹配 |
| 电脑助手 | arm64 Mach-O、0755；SHA `f3af0d185e6f8cebd8c877e13b37fea94c74b4931fe6cbca0572d5c35b714d1d`；源码 digest 按 [原生组装脚本](../../../scripts/build-native-computer.mjs) 算法与 manifest 一致；单文件严格签名验证 exit 0，为 ad-hoc |
| PTY | darwin-arm64 addon 和 spawn helper 存在、Mach-O 架构匹配，helper 0755，均纳入真实文件清单 |
| TypeScript | darwin-arm64 `7.0.2` 原生编译器、`lib.d.ts` 和 108 项标准库声明存在；未重现旧版错误删标准库资源 |
| CLI | `Contents/Resources/bin/outlive` 为 0755，与当前 launcher 源文件字节一致；没有执行 CLI |
| B 图标 | 实际 `Contents/Resources/icon.icns` 与当前源一致，SHA `bc59efedb9292c9235f75c594dab406daf5dd15bad34c729e5e4a36a765de8d2`；[资产 manifest](../../brand/assets-manifest.json) 的 21 项文件和 B SVG 源逐项通过 |
| App metadata | `com.outlive.agent`、`Outlive Agent`、`icon.icns` 与版本来自实际 Info.plist；没有以文件名代替 Bundle metadata |

## 签名、默认安装与未验范围

组装日志明确跳过 macOS 正式签名，release 是 `signed: false`、`signature_status: not-requested`、`notarization_requested: false`。助手 ad-hoc 签名不能替代 Developer ID、公证或 Gatekeeper 验收。

本轮重新执行只读 `codesign --verify --deep --strict`：packaged Chromium 与同一 pinned Playwright cache 都 exit 1，原文均为 `code has no resources but signature indicates they must be present`。这保持前包已有供应商资源封印边界，不是新的复制/字节漂移证据，也不能标为正式签名通过。原始 argv、stdout、stderr 保存在 JSON。

审计时只读 `~/Applications/Outlive Agent.app` 的公开 runtime manifest，build ID 是 `871f507b0b4cc01f59950715d542b2a40294cf38022a9aed49e2bcbf5832ed8f`，**不是 final2**。没有更新该应用，也没有读取它的 Profile；本页不能声称 final2 已安装。主任务的私有 Profile GUI/实际安装证据另行报告。

Packaged inventory 范围是 Resources/app、runtime、bin 与主程序，不包含外层 Electron Frameworks 的完整逐文件树；Info.plist、icon 分别核对，归档 SHA 绑定交付容器。没有验证正式签名、公证、Gatekeeper、干净双平台安装、Windows 原生、AX/input monitor、电脑输入、Tray/通知送达、OS wake、付费 provider 质量或独立用户验收。

## 历史保持

前包 [c114 审计](package-audit.md) 与 [原 JSON](checks/package-audit-final.json) 完全保持；其 build `c1144883e205de7fb1f9fa342ec29abfa1347536db233f0e6f740b4f10081907`、DMG SHA `0ad01e4e56aedbe28d610574e492036353f45c05806b4fae978206fa6e05a419` 和对应 GUI 验收只覆盖前包。更早 c3d 第一包的记录也不改写。当前 final2 的恢复/配置能力不能从历史包装 PASS 或实际 GUI 记录推断，须读取匹配 final2 身份的新验收。
