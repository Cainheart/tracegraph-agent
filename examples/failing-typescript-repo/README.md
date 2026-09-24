# Failing TypeScript Fixture

[中文](README.zh.md) · English

This directory is an immutable demo template. TraceGraph copies it into a
disposable workspace before running the patch-and-test flow. The checked-in
bug is intentional: `add()` subtracts its second argument, so `test/run.mjs`
fails until the approved patch is committed in the copy.
