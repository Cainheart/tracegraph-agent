# 故意失败的 TypeScript 测试仓库

[English](README.md) · 中文

这个目录是不可修改的演示模板。TraceGraph 会先把它复制到一次性工作区，再运行补丁与测试流程。仓库中自带的 bug 是故意保留的：`add()` 错把第二个参数做减法，因此在复制出的工作区中提交获批补丁之前，`test/run.mjs` 会失败。
