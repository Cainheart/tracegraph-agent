# TraceGraph Agent

English · [简体中文](README.md)

> Status: P0 `v0.1-alpha`, implemented as a verifiable vertical slice  
> Direction: TypeScript-first, Web-first, bounded parent/child agents, event-native  
> The project name and `@tracegraph/*` package scope still require a public registry/name review before a public release.

TraceGraph Agent is a local-first Web coding agent. It places Decisions, Tools,
Approvals, Patches, Tests, Context construction, and code-graph changes on one
auditable event trajectory instead of presenting only a chat answer.

G07 adds bounded subagent delegation. A model may select only a Host-registered
profile, task packet, `isolated|fork` context scope, and requested budget; it
cannot submit provider, role-prompt, or tool-allowlist authority. Each child has
an independent Run, Session, ledger, recovery seed, tool allowlist, and hard
step/token budget. The parent ledger keeps only bounded lifecycle/message/result
facts, while Host, SDK, and Web can open the child ledger read-only. Defaults are
two parallel direct children and depth one. `spawn_subagent` currently blocks until the child is terminal, so
send/interrupt are primarily Runtime/concurrent control-plane operations rather
than a claim of arbitrary later model-turn conversation. On restart, active
parent links are reconciled: an already-terminal child gets a hash-linked parent
receipt, while a nonterminal child has descendants closed first, is cancelled,
and is then reflected in the parent. Recovery never restarts the old child model
loop automatically. If the child terminal is durable but the parent terminal
receipt keeps failing to append, Runtime deliberately fail-stops: the parent
stays `running`, its permit remains held, and Host restart is required before
ledger-first reconciliation can close the link.

G08 builds a bounded Agent Team on that G07 seam. The coordinator/root Run
ledger is the sole source of truth for the durable roster, mailbox, and shared
task board. Thirteen `team.*` Events project `RunProjection.team`; mailbox
delivery/claim survives restart, and task mutations use an optimistic version
so concurrent claims yield only one owner. Before accepting completion, the
production Runtime checks eligible evidence only in the canonical child ledger
bound to the current owner; forged or other-child Event ids are rejected. The
durable root `team.task_completed` fact is then a verified receipt, so replay
does not re-query child files. Late create plus running-child backfill, later
`subagent.started` plus member join, and every sweep's full loss set plus
`team.sweep_completed` receipt are each committed by one durable replacement of
the root Run JSONL. An empty sweep still writes a receipt, while legacy partial
sweep tails remain repairable with the original command id. Heartbeats and loss
sweeps are explicit. One `team.member_lost` fact marks a worker lost and reopens
all of its claimed tasks atomically, without selecting a replacement. The Web
Team panel is primarily read-only and permits user steer and task cancellation;
failed or uncertain steer attempts retain the draft. This is
still a single-Host coordination boundary: it has no cross-Host consensus,
automatic restart of old workers, automatic task reassignment, or general
non-blocking parent loop. Parallel workers arise only when G05 batches multiple
G07 spawns, subject to the G07 permit; one spawn remains synchronous.

The model-facing `team_read` Tool reads one `roster`, `mailbox`, or `task_board`
section at a time with `offset`/`limit` paging (25 by default, 100 maximum) and
UTF-8 byte-safe dynamic page sizing. Later pages pin the first page's
`last_sequence` as `expected_last_sequence`; a concurrent change returns
`team_snapshot_changed` instead of mixing snapshots. Every complete page is
preserved as a current-Run `spilled_tool_output` Artifact and can be continued
with `read_artifact`. Team mutation Tools return compact command/Event receipts
and projection counts; the typed Host/SDK/CLI/Web read surface still returns the
full canonical projection.

G23 adds an interactive Trace Replay Debugger. Selecting a Trajectory event
reconstructs that Run at its run-local sequence, exposes a canonical snapshot
hash and structured adjacent-step diff, and supports button or left/right-key
stepping before returning to a freshly loaded live head. Replay uses a short-lived,
read-only Host capability scoped to the selected session, project, Run, frozen
head, and Artifact prefix; the SDK never upgrades an expired replay bearer into
live authority.

G21 adds a production local retrieval path. `@tracegraph/retrieval` chunks
Markdown at headings and paragraphs without splitting fenced code blocks,
persists a project-isolated atomic JSONL index, and returns BM25-ranked hits
with content hashes and exact source lines. Runtime `remember()` evaluates and
persists attributed Memory candidates before indexing them; `recall()` filters
hits by Memory scope and Context budget, records durable audit events, and
automatically injects cited `retrieved` nodes before each model request. This is
lexical BM25 retrieval, not embedding-based semantic search or a vector database.

G17 adds a trusted in-process extension kernel with six reversible seams:
tools, telemetry sinks, Context strategies, policy rules, bounded commands, and
Event hooks. The default twenty-Tool surface is now composed from six core
Tools plus two built-in extensions: `@tracegraph/builtin-artifact-tools` owns
the two Artifact Tools, while `@tracegraph/builtin-run-state-tools` owns the
Todo, four subagent-control, and five Team Tools. Each Run acquires a lease and freezes the
extension generation, config digest, active extensions, and effective Tool
surface. Reload/deactivation is idle-only, and recovery v5 fails closed if that
snapshot has drifted. Hook/context/sink failures are isolated and may append the
then-77th canonical Event, `extension.error`, without recursively dispatching it
or changing the Run outcome. G08 later raises the total to 90 Events, G10/G11
add Skill/MCP events, and G12 adds two LSP events: the current total is 100 and
the projector remains `tracegraph.projector.v8`; recovery remains v5.

G18 adds scoped PNG, JPEG, and PDF attachments for new Runs. Uploads use a
durable two-phase stage/claim flow; each file is limited to 5 MiB and each Run
to eight files. Images are offloaded by default and become provider image
blocks only after an explicit user choice and an explicit Host-owned
`image_input` capability. PDF text is stored as a separate Artifact; extraction
failure remains visible as a reference-only fallback. Running steering cannot
add attachments, and replay shows attachment metadata without binary preview.

## Five-minute local start

Requirements: Node.js `22.19+` and pnpm `11.19.0`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm serve
```

Open `http://127.0.0.1:4310`. The local Host API listens on
`http://127.0.0.1:4311`. Configure a supported provider in Settings before
starting a live model run. API keys are write-only in the browser and are
resolved by the local Host; they are not stored in browser storage or returned
by Host/SDK responses.

For development with separate Host and Web processes:

```bash
pnpm dev
```

G17 reads `<dataDir>/extensions.json` by default; use
`TRACEGRAPH_EXTENSION_CONFIG` or `--extension-config` to select another file.
The file is strict `tracegraph.extensions-config.v1` JSON, capped at 256 KiB,
must be a regular non-symlink file, and may select only extensions compiled into
the Host-owned catalog. For example:

```json
{
  "config_version": "tracegraph.extensions-config.v1",
  "extensions": [
    {
      "name": "@tracegraph/builtin-artifact-tools",
      "module": "@tracegraph/builtin-artifact-tools",
      "enabled": true,
      "required": true
    },
    {
      "name": "@tracegraph/builtin-run-state-tools",
      "module": "@tracegraph/builtin-run-state-tools",
      "enabled": true,
      "required": true
    }
  ]
}
```

With the Host running, the typed SDK exposes `listExtensions()`,
`reloadExtension()`, and `runExtensionCommand()`. Equivalent CLI operations are:

```bash
node apps/cli/dist/index.js extensions list
node apps/cli/dist/index.js extensions reload @tracegraph/builtin-artifact-tools
node apps/cli/dist/index.js extensions run <registered-command> [args...]
```

The Host routes are `GET /api/extensions`, `POST /api/extensions/reload`, and
`POST /api/extensions/commands/:name`. Web Settings shows status, generation,
registration count, bounded errors, and reload controls. The config's `module`
is only a trusted catalog key: TraceGraph does not `import()` repository JS/TS,
npm packages, or local paths from this file.

G-08 Team also exposes an operator CLI against a running Host:

```bash
node apps/cli/dist/index.js team show <coordinator-run-id>
node apps/cli/dist/index.js team create <coordinator-run-id> --command-id <stable-id>
node apps/cli/dist/index.js team task claim <member-run-id> --task-id <id> --expected-version <n> --command-id <stable-id>
```

The `team` family also covers mailbox send/claim, task create/complete/block/cancel/reopen, heartbeat, and sweep. Every mutation accepts an optional `--command-id` so the exact same request can be retried after a lost response; read-only `show` deliberately does not. See the `tracegraph team` usage and `docs/modules/11-CLI-与装配.md` for the complete flags.

The CLI uses `<dataDir>/retrieval-index` locally by default. The optional
loopback-only HTTP seam can be exercised in two terminals; use a distinct
service data directory so two processes do not share one local index writer:

```bash
TRACEGRAPH_RETRIEVAL_DATA_DIR=/absolute/path/to/retrieval-service-data \
TRACEGRAPH_RETRIEVAL_TOKEN=replace-me \
pnpm retrieval:serve

TRACEGRAPH_RETRIEVAL_URL=http://127.0.0.1:4312 \
TRACEGRAPH_RETRIEVAL_TOKEN=replace-me \
TRACEGRAPH_RETRIEVAL_TIMEOUT_MS=10000 \
pnpm serve
```

The built-in service exposes strict `/health`, `/ingest`, and `/search`
contracts and listens on port `4312` by default. Remote writes are mirrored to
the CLI's local index. Only connectivity, deadline, and `502/503/504` failures
fall back locally; authentication, contract, scope, and integrity failures stay
visible. The service uses the same JSONL/BM25 backend and does not claim
Qdrant, distributed retrieval, or vector semantics.

## Verification and release discipline

```bash
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm coverage
pnpm evals
pnpm supply-chain:check
pnpm release:check
```

The GitHub Actions workflow defines three independent CI jobs: type/release-shape checks,
tests/coverage/supply-chain checks, and credential-free offline evaluations.
Dependencies and Actions are pinned, the lockfile is verified fail-closed, and
high or critical audit findings fail CI. Coverage is gated globally and with
stricter thresholds for Contracts and Core context/policy code.

The workflow shape and the same commands are verified locally. A GitHub-hosted
run URL remains external release evidence and cannot be manufactured by this
local checkout.

Tag workflows accept only a tag exactly matching `v<package.json version>`.
They produce a checksummed private-workspace build artifact described by
`tracegraph.release-manifest.v1`. All workspace packages remain `private`;
this workflow does not claim or perform an npm registry publication.

See the bilingual [documentation index](docs/README.md), the
[extension-system module](docs/modules/15-插件与扩展系统.md), the
[Agent Team module](docs/modules/16-Agent-Team.md), the
[Skill system module](docs/modules/17-Skill系统.md), the
[engineering and release module](docs/modules/13-工程化与发布.md), and the
[known limitations](KNOWN_LIMITATIONS.md) for exact boundaries.

## Safety boundaries

- The canonical append-only Event Ledger remains the recovery and audit source.
- Write operations stay behind workspace capabilities, policy, approval, hashes,
  and the Patch Action WAL.
- Restricted native sandbox execution is currently strongest on macOS and only
  wraps the `run_test` child process; Linux/Windows limitations are explicit.
- G16 evaluations are deterministic and offline. They are regression evidence,
  not real-provider or production-network benchmarks.
- G17 is a trusted Host/Core composition boundary, not a sandbox or marketplace
  for arbitrary third-party code. It has no npm/path plugin loading, plugin
  signatures, process isolation, extension-provided UI, or active-Run HMR.
  Trusted in-process extension code has Host authority: `registerTool` joins the
  standard schema/policy/receipt path, but does not automatically add an OS
  sandbox, Action WAL, or crash reconciliation. The shipped catalog contains
  only read/none Tools; future side-effect adapters need those boundaries
  explicitly.
  G11 now provides a Host-owned stdio MCP client with required/optional
  lifecycle, degraded startup, native tool discovery/refresh, secret references,
  and canonical `mcp.*` events. PTC, HTTP/SSE, resources/instructions and
  arbitrary third-party dynamic loading remain explicitly unsupported; G10
  Skill support remains a separate local `SKILL.md` data subsystem.
- G12 adds a Host-owned native stdio LSP client. Per-project sessions lazily
  negotiate `typescript-language-server` or `pyright-langserver`, publish
  bounded diagnostics, and expose definition/references through a strict Core
  seam. `get_diagnostics` returns an auditable `unavailable` result when no
  server is installed; only a bounded summary/sample/hash enters the canonical
  Ledger/Projection. Automatic Context injection, full workspace indexing,
  HTTP/SSE LSP, and the G20 CodeGraph merge remain future boundaries.
- The G21 quality eval runs the production ingest/search/read-back package and
  compares deterministic task success and citation accuracy with and without
  retrieval. Its fixed local `0 -> 1` result is not a general RAG benchmark or
  an online model-quality claim.
- The G23 time-travel eval reopens the same on-disk ledger with a new Runtime and
  checks every sequence, snapshot hash, anchor, structured diff, and the absence
  of replay writes.
- G08 provides a durable coordinator-led roster, mailbox, and optimistic task
  board, but it does not change G07's synchronous per-spawn execution boundary.
  Ordinary Session history is root-only by default; child Sessions are reached
  through their parent projection and read-only view. Restart reconciliation
  safely closes active links and replays Team facts, but does not resume prior
  child model requests, reassign tasks, or coordinate multiple Hosts.
- Canonical Memory records live under `<dataDir>/memory/records.jsonl`; the
  JSONL BM25 index is a rebuildable projection. Automatic recall is wired into
  CLI Runs, while candidate creation is currently a Core Runtime `remember()`
  seam without a Host/SDK/Web write surface or automatic memory-creation policy.
- Replay reconstructs canonical Ledger-to-Projection state; it does not execute
  Models or Tools, pause the background Agent, revoke another client's live
  bearer, fork from history, merge multiple Runs, or persist a browser replay
  cursor. A real-browser Playwright E2E suite is still absent.
- Attachments are accepted only for the next new Run. Supported formats are
  PNG, JPEG, and PDF, with 5 MiB per file and eight files per Run. The Host's
  6 MiB raw-body cap is a transport boundary, not an increased product limit.
  PDF extraction is conservative and has no OCR; replay never exposes binary
  attachment content. Image input is disabled unless the Host explicitly sets
  `TRACEGRAPH_MODEL_IMAGE_INPUT=true` or `1` for a known-capable model.

The full Chinese README is the detailed product and architecture reference.
