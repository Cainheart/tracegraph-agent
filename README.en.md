# Outlive Agent

English · [简体中文](README.md)

> Desktop installers bundle the runtime and CLI; users do not need Node/pnpm. See the [installation guide](docs/releases/README.md) for signing and platform acceptance boundaries. Commands such as `pnpm dev` below require a source checkout. Older Preview archives retain their included guide.

> **An architecture-aware Web coding agent whose Context, long-term Memory, and
> verification evidence are all inspectable.**
>
> Status: `v0.1.0-alpha.0`. Local-first, single-machine, not published to npm; the
> P0 vertical slice is implemented. Current boundaries live in the relevant
> [module documentation](docs/modules/) and the
> [TraceGraph-to-Outlive migration baseline](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md).

Most coding agents leave you with a chat transcript. What changed, why it
changed, and what the change was based on are scattered across dozens of turns
and are effectively impossible to audit afterwards.

Outlive Agent puts Decisions, Tools, Approvals, Patches, Tests, Context
construction, and code-graph changes on **one auditable trajectory**. Every
conclusion traces back to the model request, tool execution, and evidence that
produced it.

## What it does

- **A replayable fact chain**: an append-only JSONL Event Ledger plus an
  Artifact Store and Projection Replay. Any historical projection can be
  reconstructed from its run-local `sequence`, diffed against another point, and
  verified against a canonical snapshot hash. The Replay Debugger steps forward
  and backward one event at a time.
- **Guarded writes**: the full `Decision → Schema/Capability/Policy → Tool →
  Receipt → Observation` chain is auditable. Writes are gated by PatchPreview,
  base/patch hash binding, and one-shot approval; `commit_patch` additionally
  runs behind an Action WAL whose hashes are rechecked after a crash. On
  mismatch it stops for manual review instead of overwriting your edits.
- **Inspectable Context**: a 258K default window with 32K reserved for output.
  Compaction runs `tool_output_pruner → spill → model_summary →
  tiered_checkpoint`; every transformation, superseded original, and token
  estimate is retained and can be read back by byte range.
- **Multiple providers**: built-in presets for OpenAI, DeepSeek, GLM, Qwen/Qwen
  Code, MiniMax, and Claude, plus custom OpenAI Chat Completions or Anthropic
  Messages endpoints, with reasoning effort mapped from `low` through `max`.
- **Code graph and real diagnostics**: a TS/JS static import/export graph and
  top-level AST symbols with `contains` relations and Delta comparison, plus a
  native stdio LSP client that turns real diagnostics into evidence.
- **Bounded subagents and Agent Team**: a parent Run freezes the child's
  provider, role-prompt hash, tool allowlist, and budget. Team roster, mailbox,
  and task board are fully replayed from the root Ledger, tasks are arbitrated
  by an optimistic `version`, and a lost member only returns its tasks to
  `open` — never an automatic reassignment.
- **Local Skills, MCP, and extensions**: `.tracegraph/skills/*/SKILL.md` with
  progressive disclosure of bodies; a Host-owned stdio MCP client; and six
  reversible extension seams. None of them executes third-party code, and
  unopened paths fail closed.
- **Long-term Memory**: G-21 retains its JSONL/BM25 source retrieval. V2 adds
  candidate review, correction, revocation, deletion, and Memory/Experience
  controls. V2 Memory and Experience Recall are off by default; explicit
  enablement still checks scope, status, and policy and records Context
  provenance and Adapter hand-off.
- **Three working modes**: Plain Chat (no project filesystem or command capability; scoped media Artifacts are available), Managed
  Project, and Linked Local Folder.

The V2 disposition of G-01 through G-23 is in the
[Outlive Agent migration baseline](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md).
Current implementation and verification entry points live in the
[module documentation](docs/modules/); per-file responsibilities are in the
[repository map](DIRECTORY.md).

## What this is not

Current product entry points are CLI, Web Workbench, and local Electron Desktop.
All three clients connect to one background Host and shared profile through the
same controllers. Desktop uses an isolated renderer, fixed preload bridge and
authenticated private channel; Web uses local HTTP. Canonical Ledger events arrive
through SSE. The shared workbench centers on conversation, with activity and review
opened on request; see the [Desktop boundaries](apps/desktop/README.md) and
[current acceptance](docs/validation/unified-local-workbench/README.md).
Memory V2 lifecycle, controls, and opt-in Runtime Recall are implemented, while
the G-21 V1 store remains separate. Distribution and independent installation
claims require release evidence.

Here, “local-first” means that the Workspace, Host, and canonical Memory are
managed by one Host on one machine. It does not mean every request stays local:
model requests go to the configured provider, and setting
`TRACEGRAPH_RETRIEVAL_URL` sends retrieval content to that endpoint. The
built-in retrieval service listens on loopback by default. Pointing the CLI at
an external endpoint does not make it a remote Runtime or a multi-user service.
`project_id` is a retrieval partition key, not tenant authorization; the
optional bearer token is service-wide.

At this point the project is **not**:

- **A production sandbox.** OS-level isolation currently wraps only the
  `run_test` child process, and only on macOS via Seatbelt. Restricted modes on
  Linux and Windows refuse to start with `unmet_constraints` rather than
  pretending isolation succeeded.
- **Semantic retrieval.** Memory is lexical BM25 — no embeddings, vector
  database, or reranker. Paraphrase and cross-language semantic matching are
  out of scope.
- **A distributed Runtime.** The Ledger, Artifact Store, and canonical Memory
  are managed by the single-machine Host. There is no cross-Host lock,
  consensus, reliable message queue, or shared multi-user Workspace. The
  optional retrieval service only provides a separate index/search API and
  does not change that boundary.
- **An npm package.** Every workspace package stays `private`, and the release
  workflow does not claim or perform an npm registry publication: it produces a
  SHA-256-checksummed private workspace bundle, not a publication, signature, or
  provenance attestation.
- **Complete code understanding.** CodeGraph is a static import/export graph
  plus top-level symbols — not dynamic calls, DI, routing, or cross-language
  call graphs.
- **Token-level streaming.** A structured Decision enters the Ledger only after
  it validates as a whole. Private model reasoning is neither exposed nor
  fabricated.

The [migration baseline](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md)
records the fuller transition boundaries and their V2 disposition. The list
above only tells you what not to expect in the first five minutes.

## Installed use and shared profile

Open Outlive Agent and the application discovers or starts its bundled runtime. First use saves a model configuration, explicitly tests the connection, then offers a project or plain chat. Saved and tested are separate states. Optional MCP/LSP connections do not block ordinary chat. Closing the window retains background tasks; reopening restores their view without automatically rerunning history. A different installed build owning the runtime is detected and refused until repaired safely.

Web, Desktop and CLI share `~/.outlive/profiles/default`, including configuration, projects, sessions, Memory and tasks. The installed `outlive` CLI starts or discovers this owner for normal commands. Lifecycle commands include `host status`, `host restart` and `host stop`; they are diagnostic operations, not prerequisites for first use. Legacy data migration is explicit in About → Installation diagnostics or the CLI, with conflict preview and backup before committing.

Optional image settings support a dedicated image endpoint, a Responses image tool, or compatible chat-native PNG output. Actual PNG bytes and locally rendered SVG charts are scoped Run Artifacts, verified for preview/download in Web/Desktop and export through CLI. Text, code, or an image URL alone never counts as generation success. See [media boundaries](docs/modules/14-附件与多模态.md) and [current installed-product evidence](docs/validation/installable-product/README.md).

[Four original natural-color logo candidates](docs/brand/logo-candidates.png) are available; A is provisional until the user selects a final mark.

## Source development start

Requirements: Node.js `^22.19.0` or `>=24.0.0` and pnpm `11.19.0`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4310` for the development Web Workbench. A fresh development profile requests port 4311; an existing owner retains its actual address. Installed Desktop uses a dynamically assigned gateway port.

For the live Desktop in a source checkout, first run `pnpm build`, then:

```bash
pnpm --filter @tracegraph/desktop start
```

`pnpm --filter @tracegraph/desktop preview` opens a labelled synthetic demo.
[Independent preview archive installation](docs/releases/README.md) documents
running the prebuilt application without source files.

Pick a provider in Settings and enter an API key, then create a project and
submit a task. Keys are write-only: they travel only with the save request,
are never written to browser storage, and are not echoed by Host/SDK
responses.

Environment configuration below applies to the explicit one-shot and legacy serve
entry points. Persist model configuration for the shared profile through Settings
or CLI config commands. Copy [`.env.example`](.env.example) to `.env.local`; for
DeepSeek that is just:

```dotenv
DEEPSEEK_API_KEY=your-key
```

This uses the default `deepseek-v4-flash` preset; add
`TRACEGRAPH_MODEL=deepseek-v4-pro` for a larger model. Environment configuration
takes precedence over persisted configuration and is a read-only source — the
Settings page shows the origin and refuses to override it, so restart after
editing.

To browse an existing repository read-only:

```bash
pnpm --filter @tracegraph/cli run serve -- --readonly /absolute/repository/path
pnpm --filter @tracegraph/web run dev
```

Permission presets are controlled by the local Host, with a default
`workspace-write` ceiling:

```bash
pnpm --filter @tracegraph/cli run serve -- --permission-preset workspace-write
```

Alternatively set
`TRACEGRAPH_PERMISSION_PRESET=read-only|workspace-write|full-write`. The Web
choice can only equal or lower the ceiling, and a project-level
`.tracegraph/policy.json` can only tighten it further. Changes affect only Runs
created afterwards. `full-write` reports `enforcement:none` explicitly and must
not be read as "the sandbox is on".

Normal clients use the shared profile for data and Sessions. Explicit legacy serve retains `.tracegraph/` at the repository root and `~/.tracegraph/sessions`; these are compatibility paths, not the new product default. `dataDir` and the Session root are
a pair: when running multiple instances, give each one its own stable
`--session-dir` or startup recovery fails closed.

## Working modes

| Mode | Capability | Boundary |
|---|---|---|
| Plain Chat | Multi-turn Q&A without a project, public execution progress, Markdown/Mermaid and scoped image/chart output, and paged read-back of the Run's own compacted archive | Every hidden-workspace file and command capability is off; `read_artifact` is not workspace read access and cannot reach a local project or another Run |
| Managed Project | Durable projects, live model Q&A, read/search, file creation and modification, Preview/Approval, Graph Delta | Under `.tracegraph/projects`; with the default `workspace-write` every write needs one-shot approval, `read-only` forbids writes, and explicit `full-write` stops asking but stays bound by workspace, schema, and WAL checks; API keys are resolved only by the local Host |
| Linked Local Folder | Open an existing directory through the native folder picker, read-write or read-only, with reveal-in-file-manager | The browser cannot submit arbitrary paths; the Host normalizes and registers the directory, and workspace capabilities and hard constraints cannot be raised by preset or rule; writes need one-shot approval under the default `workspace-write` |

Natively selected directories are registered in
`.tracegraph/local-projects.json` and are restored after a Host restart.
Removing a local directory only revokes the Outlive Agent registration and never
deletes the real directory; a Host-created managed project has its copy under
`.tracegraph/projects` deleted after confirmation. If a directory is deleted,
moved, or loses permissions externally, the Host skips the unusable record and
warns rather than presenting a stale path as usable.

## Repository layout

```text
apps/web              React/Vite Web Workbench
apps/cli              Composition root and Host startup
apps/retrieval-service Optional loopback HTTP retrieval service and strict client
packages/contracts    Canonical and wire Zod contracts
packages/core         Runtime, extension manager, Context, policy, tools, ledger, artifacts, session store/recovery
packages/retrieval    Markdown chunking, atomic JSONL index, local BM25, and original-text read-back
packages/telemetry    Vendor-neutral telemetry, noop/memory/OTLP-HTTP sinks, and conformance suite
packages/codegraph    TS/JS static module graph
packages/host         Fastify command/query/artifact/SSE boundary
packages/sdk          Typed TypeScript client
packages/test-support Fixtures, vertical integration tests, and a bounded ScriptedMockProvider
evals/                Offline behaviour, extension, retrieval-quality, performance, documentation, and time-travel evals
examples/             Bundled failing TypeScript repository
```

## Development and verification

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm evals
pnpm coverage
pnpm supply-chain:check
pnpm release:check
```

`test` runs per-package unit tests plus the engineering gates; `test:e2e` walks
the `SDK → Host → Runtime → Approval → Patch → Test → Graph Delta` vertical
chain; `evals` is a separate offline surface (behaviour regressions, retrieval
quality comparison, performance gates, documentation consistency) that does not
replace unit tests or E2E and needs no API key. Performance baselines change
only through an explicit `pnpm evals:update`, and any such change should be
reviewed.

CI consists of three independent jobs (`typecheck` / `test` / `evals`) plus
coverage gates, fail-closed lockfile and supply-chain checks, and a private
release manifest check. Third-party Actions are pinned to full commit SHAs.

Each owning [module document](docs/modules/) records its implementation and
verification entry points; offline documentation evals continue to check
cross-module consistency.

## Documentation

- [Outlive Agent V2 design charter](docs/outlive-agent-v2.md) — proposed product philosophy and target architecture; not evidence of shipped capabilities
- [Outlive Agent migration baseline](docs/outlive-agent-v2/10-tracegraph-to-outlive-migration/README.md) — retained capabilities, current boundaries, and V2 disposition
- [Documentation index](docs/README.md) — entry point for modules 01–19 and all reference documents
- [Repository map](DIRECTORY.md) — responsibility of every source and configuration file
- [Changelog](CHANGELOG.md)

## License

MIT — see [LICENSE](LICENSE).

## Shared local workbench

Web, Desktop and CLI connect to one background Host and the default profile at
`~/.tracegraph/profiles/default`. Host owns configuration, credential references,
projects, Sessions, Memory and tasks. Closing a window detaches; explicit Host
stop terminates background work. Login startup is not installed. Inspect legacy
sources and conflicts before committing migration from Desktop Settings/About
or `host migration preview|commit`; source directories and backups are retained.

The conversation leads the workspace: New chat, Memory, Projects and Recents in
the sidebar; ten settings categories under the avatar menu; one public progress
statement and one real operation by default. Tool results and changes open on
request. Developer tools include Git/worktrees, terminals, loopback preview and
schedules. Host operation capabilities define availability. Test the model
connection independently after saving; the probe sends only a short sentence.

```bash
env -u NODE_OPTIONS node apps/cli/dist/index.js host start
env -u NODE_OPTIONS node apps/cli/dist/index.js doctor --json
env -u NODE_OPTIONS node apps/cli/dist/index.js host stop
```

See the [CLI guide](apps/cli/README.md) and
[local-workbench acceptance](docs/validation/unified-local-workbench/README.md).
