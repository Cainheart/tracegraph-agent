# @tracegraph/evidence

## Purpose

Own the canonical Event Ledger and scoped Artifact persistence together with
pure Run Projection and sequence-bounded Replay. The package derives facts from
the `@tracegraph/contracts` event model and does not own Runtime policy.

## Public API

The package root exports `JsonlEventLedger`, `ArtifactStore`, `projectRun`,
`toWireEvent`, and the replay functions/errors. `JsonlEventLedger` also owns
owner-scoped Memory lifecycle, control/tombstone, and versioned feedback
aggregate streams in separate hashed namespaces under the same Ledger root;
these Events do not enter a Run's SessionEvent sequence. Feedback is scoped to
one owner, Memory ID, and immutable version, with CAS, idempotency, and an
independent hash chain. Content-free control tombstones bind deleted lineage and
scope IDs. The Ledger also derives exact-version MemoryUse request summaries
from Run events. Host
composition supplies the typed `EvidencePrimitives` and pure Team/Todo projection
contributors. There are no supported deep imports.

## Dependencies

It depends on `@tracegraph/contracts`, Zod, and Node platform primitives. It
does not import Core, Runtime, Team, Todo, Host, or application packages.

## State ownership

Ledger and Artifact bytes live under caller-provided local filesystem roots.
The package validates Run and Memory aggregate event order, hash-chain
integrity, artifact scope, and content hashes. The Event Ledger remains the
durable source of Run facts and owner-scoped Memory lifecycle, control, and
feedback facts.

## Extension points

`EvidencePrimitives` supplies the host's canonical hashing, ID, and redaction
functions. `ProjectionContributors` supplies pure Team and Todo projectors over
the same event list. These ports avoid dependencies back into Core.

## Model effect

None. The package does not call a model or execute tools. Projection and
Replay are deterministic in-memory transformations; storage methods perform
only the filesystem operations required by their explicit APIs.

## Verification

Run `pnpm --filter @tracegraph/evidence test:unit` and
`pnpm --filter @tracegraph/evidence typecheck` from the repository root.
Workspace boundary and invariant gates validate the public dependency edge,
single Ledger writer, wire filtering, and Projection purity.

## Known limitations

Persistence is local-filesystem based. Callers are responsible for supplying
the canonical Core primitives and projection contributors. The package does
not provide process coordination across multiple Hosts sharing one root.
