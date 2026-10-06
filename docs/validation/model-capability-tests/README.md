---
id: outlive-model-capability-tests
language: en
status: current
---

# Explicit model capability tests: verified source slice

[简体中文](README.zh.md)

Verified on 2026-10-05. This closes the explicit small-test controller/transport/settings slice of CFG-098; it does not complete all configuration, fallback, product, paid-model quality or native installation acceptance.

## User entry and result meaning

In Settings → Models, expand **Test model capabilities** on a saved connection. Select its exact configured model and one or more tests, then confirm **Run selected tests**. Read-only environment connections remain testable. Each supported selected item sends at most one bounded request, sequentially, with generated data only. No project, chat, Memory or personal profile is sent. Passing never grants tool permissions, changes an image declaration or alters an admitted task's configuration.

| Kind | OpenAI Chat Completions | Anthropic Messages | Evidence required |
| --- | --- | --- | --- |
| text | Native text | Native text | Exact generated challenge |
| tools | Native function tool call | Native tool_use block | Exact declared tool and arguments; no execution |
| image | PNG image_url data URI | PNG base64 image block | Correct order of four generated color quadrants |
| structured | Strict JSON Schema response_format | Unsupported, zero request | Native-format request and one exact returned fixture object |

HTTP 200 or self-reported prose cannot pass. The structured fixture does not establish universal vendor enforcement of every schema. The generated 32×32 PNG is a bounded input test, not a vision benchmark. OpenAI-compatible endpoints can reject a native format; a failed probe cannot be promoted into protocol-wide support.

Each request caps output at 192 tokens, response at 64 KiB and controller deadline at 15 seconds. Results preserve provider-reported usage only when valid; absent usage or cost remains **Unknown**. Raw provider output, generated image bytes, secrets and private storage error details are absent from receipts. Native response format, exact challenges, refusal, truncation, malformed arguments, extra schema fields, HTTP errors and missing accounting have separate checks.

## Authority, persistence and recovery

The command binds connection ID, configuration revision, exact model, selected kinds and explicit confirmation. The [controller](../../../packages/host/src/model-capability-control.ts) uses its own canonical Journal and captured configuration/credential lease. Same-ID same-intent dispatch coalesces or reads the original result; changed intent conflicts. Rotating the saved Key during a held test does not change its admitted model/Key.

Canonical command completion precedes the optional current-revision settings projection. A projection error returns a safe failure but leaves the completed receipt readable; repeating that command never repeats provider work. Failed, unsupported and unknown feature results are preserved as such. A completed command is not equivalent to all tests passing. Only unsettled active requests/receipt writes hold the controller busy; historical unknown provider usage does not represent an unknown project write.

Profile-managed connections reopen their saved current-revision summary. Replacing the model or Key invalidates it while historical receipts remain readable. Environment-managed connections clear that summary whenever the owner reopens: external credentials or endpoints can change without a saved revision. A fresh explicit test creates a summary for the current owner. This does not change Run revisions or leases.

**Inspect previous test** reads the original receipt without another provider request. An uncertain command pointer survives settings remounts in session storage; it is a reconciliation pointer, not a success fact. Mounted controls also discard late old-owner reads/results and reset removed models without requiring a remount. A same-revision environment receipt is explicitly historical unless its command matches the current owner's summary or an uninterrupted explicit test. No automatic repeat follows timeout, dropped transport, absent receipt or projection failure. CLI equivalents are:

```text
outlive models capability-test <connection-id> --input-file test.json --command-id <id>
outlive models capability-receipt <id>
```

The JSON selects `expected_revision`, `model`, unique `features` and `confirmed:true`; it cannot inject a prompt, file path, project scope or secret. CLI exit 0 requires all passed items, exit 1 reports failed/unsupported, and exit 3 reports unknown. Completed receipts use the same business-result classification. Existing tiny text connection tests remain compatible.

## Verification evidence

All checks below ran in the current worktree with synthetic loopback credentials. No paid provider or user Key was used. These are source/unit/real local HTTP checks, not new-package screenshots.

| Check | Actual result | Raw output |
| --- | --- | --- |
| Core native probes plus existing model adapter | 2 files, 58 tests passed | [core-final.log](checks/core-final.log) |
| Actual shared composition/HTTP, Journal projection and lease tests | 3 files, 10 tests passed | [host-final.log](checks/host-final.log) |
| Capability absent/present negative | 1 passed, 21 intentionally skipped | [capabilities-final.log](checks/capabilities-final.log) |
| Strict request/evidence contracts | 1 file, 2 tests passed | [contracts-final.log](checks/contracts-final.log) |
| SDK intent checks and shared Chinese/English locale | 2 files, 15 tests passed | [sdk-locale-final.log](checks/sdk-locale-final.log) |
| Fixed Desktop bridge and existing strict routes | 2 files, 7 tests passed | [desktop-final.log](checks/desktop-final.log) |
| CLI parser plus actual CLI→owner→HTTP provider | 2 files, 31 tests passed | [cli-final.log](checks/cli-final.log) |
| Settings capability controls, existing conversation and Help | 3 files, 38 tests passed | [ui-final.log](checks/ui-final.log) |
| Contracts/Core/Host/SDK/Workbench/Desktop typecheck | Six package checks passed | [Contracts](checks/contracts-types-final.log), [Core](checks/core-types-final.log), [Host](checks/host-types-final.log), [SDK](checks/sdk-types-final.log), [Workbench](checks/workbench-types-final.log), [Desktop](checks/desktop-types-final.log) |

The final CLI typecheck initially encountered an unrelated legacy-optional session ID in interactive chat, retained in [cli-types-final.log](checks/cli-types-final.log). The owning root fixed it and verified [CLI types](../product-workbench-2026-10-05/checks/cli-interactive-types.log) and [12 interactive checks](../product-workbench-2026-10-05/checks/cli-interactive-current.log) separately. Do not treat the preserved failing attempt as a passed command.

Early attempts retained actual fixture mistakes: the HTTP harness initially omitted bootstrap, then workbench route registration; UI tests initially used an unavailable helper package, assumed an aria-label was visible text and asserted old explanatory copy. A locale negative found a real missing **Image input** label; it is now translated. Before-fix logs remain in `checks/` alongside final passing outputs.

## Remaining scope and source anchors

Real paid-provider behavior/quality, billing reconciliation, native installed UI at three sizes/themes, and the root's full build/release acceptance require their own evidence. No automated fallback selection, broad capability inference or universal protocol guarantee was added.

- [Typed contracts](../../../packages/contracts/src/model-capability-tests.ts), [native probe implementation](../../../packages/core/src/domains/model/model-capability-probe.ts), [actual HTTP tests](../../../packages/host/src/model-capability-http.test.ts).
- [Result projection and revision owner](../../../packages/host/src/conversation-control.ts), [shared controls](../../../packages/workbench/src/components/ModelCapabilityTests.tsx), [CLI commands](../../../apps/cli/src/workbench-command.ts).
- [Model module](../../modules/06-模型适配与推理强度.md), [Host/SDK module](../../modules/09-Host-与-SDK-接口层.md), [user guide](../../user-guide/README.md).
