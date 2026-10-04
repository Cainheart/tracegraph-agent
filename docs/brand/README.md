# Outlive Agent identity candidates

用户已选择 **B Current**。唯一生产矢量源是 [current.svg](current.svg)，工作台透明标志、网站 favicon 和原生应用图标均由该源派生。[候选预览](logo-candidates.svg)及四个候选文件保留为历史设计，不再作为生产资源。

产品展示名统一为 **Outlive Agent**。`@tracegraph/*`、旧环境变量、已有 wire schema 与历史 Ledger 是兼容技术标识，保留读取，不作为新产品展示名。

候选源文件：

- [A Grove](candidates/A-grove.svg)
- [B Current](candidates/B-current.svg)
- [C Canopy](candidates/C-canopy.svg)
- [D Confluence](candidates/D-confluence.svg)

颜色：深海绿 `#225C55`、桉叶绿 `#79A388`、苔藓 `#B5C1A0`、暖象牙 `#F6F4ED`、少量琥珀 `#C5AA72`。暗色背景使用象牙与浅桉叶绿替换主色；保持同一轮廓。

原生图标使用一个暖象牙圆角底板，1024 方形画布四边留白 24 px；Current 标志统一使用 `translate(112 112) scale(8)`。[app-icon.svg](app-icon.svg) 是生成产物，不单独编辑。所有 PNG 尺寸、ICNS、七尺寸 ICO、透明 favicon 和 Workbench 路径常量由固定的 `@resvg/resvg-js@2.6.2` 渲染，无系统字体或截图依赖。

```bash
node scripts/build-brand-icons.mjs
node scripts/build-brand-icons.mjs --check
node --test scripts/build-brand-icons.test.mjs
```

[资源清单](assets-manifest.json)记录唯一源 SHA256、派生参数和每个文件的哈希。打包前须通过派生校验；更换 PNG 而保留旧 ICNS 不视为更新完成。实际安装后的 Dock、Finder 与 Windows 图标需要单独查看，文件校验不能替代真实系统显示验收。

本轮 final8 安装资源与应用内、Finder/应用简介显示已核验，见[实际原生观察](../validation/current-workbench-recovery/native-default/report.json)。Dock 在启用的 CUA 界面中不可观察，Windows 原生显示尚未验收；这两项不计入已完成显示验证。
