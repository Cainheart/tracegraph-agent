---
id: 2026-10-03-product-brand-and-validation-repair
title: Outlive product identity and bounded invalid-tool repair
status: implemented
owners: [product, runtime]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [packages/core, packages/host, packages/sdk, apps/cli, docs/brand]
supersedes: []
---

# Outlive product identity and bounded invalid-tool repair

The user approved Outlive Agent as the product identity and install-and-use local delivery. Current user-facing legacy names and raw Todo validation failures break that experience.

Product copy, command help and application artwork use Outlive Agent. The `@tracegraph/*` package scope, existing wire schema identifiers, legacy environment variables and historical Ledger stay compatible. Renaming those storage/protocol identifiers is deferred; they are not product labels. New artwork candidates are local SVG paths with tapered ends and natural colors, without circular endpoints. The final commercial mark remains the user's selection.

Invalid model-authored tool arguments are rejected before any member of the batch executes. Up to two consecutive rejected batches may be corrected in subsequent model turns; the third terminates with a readable failure. Hard policy/capability denials stay terminal. No arguments are silently coerced and no rejected action is represented as executed. A failed validation receipt and observation are attached to the existing `action.rejected` Ledger event and feed the next model request. These observations cannot satisfy Todo completion evidence. Cancellation and total turn budgets still apply.

Rollback consists of reverting presentation assets and the bounded repair branch; original Ledger formats and Todo invariants are retained. Acceptance covers successful correction, unchanged pending invariant, atomic batch rejection, repeated invalid requests, and policy denial without retry.

Connection tests capture the same immutable model/credential lease as a Run before the command journal yields. Rotating or clearing a key retains that captured credential until the test settles, and a passing result for an old configuration never marks its replacement as tested.

Implementation and evidence:

- [Atomic invalid-batch correction](../../../packages/core/src/domains/runtime/agent-loop.ts), [Todo/model rules](../../../packages/core/src/domains/tools/registry.ts), and [12 plan-mode cases](../../../packages/core/src/domains/runtime/runtime.plan-mode.test.ts) preserve policy refusal and completion evidence.
- [Leased model snapshots](../../../packages/host/src/composition/leased-model.ts) and [connection-test control](../../../packages/host/src/workbench-control.ts), with [rotation test](../../../packages/host/src/workbench-control.test.ts), bind tests across replacement and invalidate the public status for a changed key.
- [Original SVG candidates and editable assets](../../../docs/brand/README.md), bundled app/ICO/ICNS artwork, CLI `outlive` alias, presentation strings and first-use UI are implemented. A remains provisional; this Note does not certify a final commercial identity.
- [Current verification and preserved failures](../../../docs/validation/installable-product/root-verification.md) distinguish source, installed macOS, external-provider quality, Windows-native and signing evidence.
