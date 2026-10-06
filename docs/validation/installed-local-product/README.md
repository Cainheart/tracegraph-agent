# Self-contained local product verification

The current local product bundles independent Node 24.21.0, Electron 44.5.1,
Web assets, the actual CLI and target-native dependencies. The verified macOS
artifact uses the v2 resource policy below. Windows x64 was cross-built on
macOS; its native installation, launch and PTY remain unverified. Default
artifacts are unsigned and unnotarized. All provider responses in these
acceptance fixtures are synthetic, and all profiles are isolated.

## Delivered bytes

The historical package payloads listed below were removed during the
2026-10-06 cleanup at the user's request. Their checksums and operation reports
remain historical evidence; rebuild from the current source before a new
platform acceptance. The latest installed macOS build is documented in
[`desktop-install-2026-10-06`](../desktop-install-2026-10-06/README.md).

| Target | Historical output (removed) | SHA-256 |
| --- | --- | --- |
| macOS arm64 DMG | `installed-product-complete-mac-v2/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.dmg` | `4c0f86eba3be42245bbfbece0f573cc07792f63352e949399e5ed8c2cf06d1d1` |
| macOS arm64 ZIP | `installed-product-complete-mac-v2/artifacts/Outlive-Agent-0.1.0-alpha.0-mac-arm64.zip` | `ee45109d597944f8e7b97fabe6dc5bf97d3377a6f5a01b27ac023cd72660d0ee` |
| Windows x64 NSIS | `installed-product-complete-win-v2/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.exe` | `282f29259275c0ba7bbcee6ea072522ea9a954dfd091bad1ae2305a0e116d1fa` |
| Windows x64 ZIP | `installed-product-complete-win-v2/artifacts/Outlive-Agent-0.1.0-alpha.0-win-x64.zip` | `602ff1557481fa96a80c150d3d6a8312e8d1be5919c11293d018d004f4160f55` |

The macOS build identity is
`c72a0a30a897dab039db2275ddcb839ce4dc617fdb16da92968867e619c507f2`;
Windows uses
`23c674c49a4868e1d0929e8ab66d4ecd5da0203ac95e85625ab5079464180732`.
These identities cover the pre-builder application stage, pinned Node and
runtime resource policy. Container checksums identify delivered archive bytes.
`product-release.json`, `stage/stage-inventory.json` and
`packaged-inventory.json` are retained alongside each artifact. The latter is
the actual post-builder closed resource inventory, including 202 resolved
package nodes and 508 exact dependency edges for each target.

The [macOS byte audit](checks/packaged-byte-audit-darwin-v2.json) matches a
fresh stage assembled from the current compiled tree, all 1,491 required
application/template/native-library files, Node and CLI launchers. It records
11,288 actual packaged application files. The
[Windows byte audit](checks/packaged-byte-audit-win32-v2.json) records 11,300
files and the same required-resource/dependency checks. The
[Windows static verification](checks/windows-static-v2.json) confirms an x64
PE, actual Outlive product metadata and the selected provisional icon's bytes;
it explicitly marks native installation/launch/PTY as not run.

## Implementation and tested boundaries

[Bundled runtime validation](../../../packages/host/src/composition/bundled-runtime.ts)
verifies the fixed manifest, binary hash, platform, CPU, supported version,
standalone Node identity and build ID; missing/corrupt bundles never fall back
to an external executable. [Local owner startup](../../../packages/host/src/local-host.ts)
uses the shared private profile, owner lease, authenticated UDS/named-pipe
HTTP and dynamically assigned loopback gateway. Installed clients refuse a
different live build without automatically terminating its work. Bundled Node
is prepended only to the owner/CLI child PATH. The default profile is
`~/.outlive/profiles/default`; explicit legacy roots remain supported without
an automatic merge. Existing backup/selection migration and safe recovery
semantics remain unchanged.

[Packaged Web](../../../packages/host/src/packaged-web.ts) uses a sealed asset
inventory on the same Runtime. Exact same-origin browser provenance is
required for missing-Origin requests; hostile/missing provenance and spoofed
gateway identity fail. The private renderer bridge grants only fixed typed
operations, not filesystem or generic invocation access. Model/image keys
are write-only and saving configuration is distinct from an explicit model
connection test.

`host.restart` quiesces write admission before testing idle state and refuses
active Runs, queued work, terminals, previews or concurrent mutations without
cancelling them. Desktop rebinds only after a different boot nonce; the UI
checks that restart-scoped settings actually cleared. The real transport
[restart tests](../../../packages/host/src/local-restart.test.ts) exercise held
model work, busy PTY and rejected new admission during an idle restart.

[Delivery assembly](../../../scripts/build-desktop-product.mjs) selects the
target TypeScript native dependency using exact lockfile integrity and checks
its OS/CPU/PE or Mach-O identity. The fixed `afterPack` step preserves its full
standard-library tree: `.d.ts` files here are runtime data. Every installed
production dependency is resolved inside the app with its exact version.
Native CI is configured in [release.yml](../../../.github/workflows/release.yml);
its two jobs use pinned actions, least permissions and pre-install lockfile
guards. CI configuration is not evidence that those jobs have executed.
Signing and notarization require explicit trusted flags/credentials and native
verification; none were used for these artifacts.

## Real application and installed UI evidence

[Final macOS runtime smoke](final-mac-v2/report.json) passed 13 assertions using
the actual packaged window with a system-only child PATH. It executes the
real native TypeScript CodeGraph API, then verifies the private owner, same
Web gateway, saved configuration, explicit tiny connection test, same-profile
bundled CLI, managed project and bundled Node in an actual restricted PTY. A
held chat completes after the window/client closes; reopening reuses the
owner. An idle settings restart yields a new nonce and clears pending settings.
All owned profiles, owners and app processes were cleaned. Its first client
exited zero; the second needed SIGKILL during harness signal cleanup. That
cleanup is recorded, not promoted to a normal macOS Cmd-Q observation.

Root mounted the final DMG readonly and copied it to
`~/Applications/Outlive Agent.app`. The
[actual installed GUI report](../install-use-workbench/attempt009-final-installed-dmg-desktop/report.json)
passed 12 behavioral assertions and 66 screenshots at three sizes. The real
renderer exercises fresh setup, failed/successful bounded connection tests,
managed project creation, plain chat, diagram/chart/PNG rendering and download,
exact patch approval, actual changed-file and passing-test facts, Review and
same-profile reads through the actual installed CLI. Cleanup passed. Provider
quality and real third-party billing behavior are outside this synthetic test.

[Installed media](../media-094/evidence/installed-mac-final/report.json) passed
94 oracles with 20 actual CLI calls and six real exported files. Its
[independent verification](../media-094/evidence/installed-mac-final/independent-verification.json)
passed 666 checks of scoped receipts, ledgers, hashes, types, request counts and
negative outcomes. The harness itself and all clients use bundled Node with
`PATH=/usr/bin:/bin`, and installed production module hashes remain unchanged.
Normal application-quit observation is maintained separately by the root
installation acceptance; this report does not infer it from process signals.

## Commands and durable logs

The final build and smoke commands use a frozen compiled tree; no implicit
root build is performed by these scripts:

```bash
env -u NODE_OPTIONS node scripts/build-desktop-product.mjs --output _tmp_release/installed-product-complete-mac-v2
env -u NODE_OPTIONS node scripts/build-desktop-product.mjs --platform win32 --arch x64 --output _tmp_release/installed-product-complete-win-v2
env -u NODE_OPTIONS node scripts/smoke-desktop-product.mjs --product _tmp_release/installed-product-complete-mac-v2 --output docs/validation/installed-local-product/final-mac-v2
env -u NODE_OPTIONS node --test scripts/build-desktop-product.test.mjs
env -u NODE_OPTIONS pnpm exec vitest run --config vitest.evals.config.ts evals/docs/g22-release-consistency.eval.ts
```

Full stdout is retained for [macOS build](checks/mac-build-v2.log),
[Windows cross-build](checks/windows-cross-build-v2.log),
[runtime smoke](checks/mac-smoke-v2.log),
[native CodeGraph](checks/bundled-codegraph-v2.log),
[seven installer tests](checks/installer-tests.log) and
[four release-CI evaluations](checks/release-ci-eval.log).
Earlier runtime/transport negative unit runs (21 tests plus two actual restart
tests) passed, but their raw stdout was not retained. Root's final repository
logs provide the broader durable gates; no old tool output has been fabricated.

## Retained failures and remaining acceptance

The first assembly failed to find a local Electron download; the builder now
uses the official cache/download when that optional source runtime is absent.
An early signal-cleanup attempt failed before waiting for termination and was
retained at [attempt 003](attempts/003-smoke/report.json).
[Attempt 006](attempts/006-intermediate-app-quit/report.json) wrongly treated a
remote browser-window close as application exit on macOS; cleanup still exited
zero and the false app-quit assumption remains a failed test. The
[pre-builder identity assumption](attempts/007-pre-builder-inventory-assumption/report.json)
records why the actual packaged resource inventory must be distinct from the
builder input inventory.

The first actual installed project failed because the builder pruned TypeScript
runtime standard libraries; the [raw native failure](checks/bundled-codegraph.log)
and [GUI failure](../install-use-workbench/attempt006-installed-dmg-desktop/report.json)
remain available. The final v2 resource policy, native CodeGraph oracle and
installed patch/test journey correct that failure. Earlier `final-mac` labels
name historical intermediate attempts; their pre-v2 identity never qualifies
as current installation acceptance.

Unverified gates remain native Windows install/launch/process behavior, signing
and notarization with actual credentials, independent fresh-machine external
user acceptance, production provider quality and auto-update. No login startup
or global CLI/PATH modification is installed. See
[distribution limitations](../../releases/KNOWN-LIMITATIONS.md).
