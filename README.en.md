# TraceGraph Agent

English · [简体中文](README.md)

> **An architecture-aware Web coding agent whose Context, long-term Memory, and
> verification evidence are all inspectable.**
>
> Status: `v0.1-alpha.0`. Local-first, single-machine, not published to npm; the
> P0 vertical slice is implemented. See
> [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) for boundaries.

Most coding agents leave you with a chat transcript. What changed, why it
changed, and what the change was based on are scattered across dozens of turns
and are effectively impossible to audit afterwards.

TraceGraph Agent puts Decisions, Tools, Approvals, Patches, Tests, Context
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
- **Long-term Memory**: Markdown chunked at headings and paragraphs into an
  atomic JSONL index searched with local BM25. Hits carry source paths, exact
  line numbers, and content hashes, and cited context is injected before each
  model request.
- **Three working modes**: Plain Chat (no file or command capability), Managed
  Project, and Linked Local Folder.

The scope and verified boundaries of each G-01 through G-23 item are in the
[verification map](docs/verification-map.md); per-file responsibilities are in
the [repository map](DIRECTORY.md).

## What this is not

At this point the project is **not**:

- **A production sandbox.** OS-level isolation currently wraps only the
  `run_test` child process, and only on macOS via Seatbelt. Restricted modes on
  Linux and Windows refuse to start with `unmet_constraints` rather than
  pretending isolation succeeded.
- **Semantic retrieval.** Memory is lexical BM25 — no embeddings, vector
  database, or reranker. Paraphrase and cross-language semantic matching are
  out of scope.
- **A distributed system.** The Ledger, Artifact Store, Memory, and retrieval
  index coordinate within a single process. There is no cross-Host lock,
  consensus, or reliable message queue.
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

[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) is the complete, authoritative
boundary list. The list above only tells you what not to expect in the first
five minutes.

## Five-minute local start

Requirements: Node.js `22.19+` and pnpm `11.19.0`.

```bash
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4310` for the Web Workbench; the Host API listens on
`http://127.0.0.1:4311`.

Pick a provider in Settings and enter an API key, then create a project and
submit a task. Keys are write-only: they travel only with the save request,
are never written to browser storage, and are not echoed by Host/SDK
responses.

You can also copy [`.env.example`](.env.example) to `.env.local` and configure
through the environment. For DeepSeek that is just:

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

Data lands in `.tracegraph/` at the repository root, and Sessions default to
`~/.tracegraph/sessions`; both are gitignored. `dataDir` and the Session root are
a pair: when running multiple instances, give each one its own stable
`--session-dir` or startup recovery fails closed.

## Working modes

| Mode | Capability | Boundary |
|---|---|---|
| Plain Chat | Multi-turn Q&A without a project, public execution progress, Markdown/Mermaid output, and paged read-back of the Run's own compacted archive | Every hidden-workspace file and command capability is off; `read_artifact` is not workspace read access and cannot reach a local project or another Run |
| Managed Project | Durable projects, live model Q&A, read/search, file creation and modification, Preview/Approval, Graph Delta | Under `.tracegraph/projects`; with the default `workspace-write` every write needs one-shot approval, `read-only` forbids writes, and explicit `full-write` stops asking but stays bound by workspace, schema, and WAL checks; API keys are resolved only by the local Host |
| Linked Local Folder | Open an existing directory through the native folder picker, read-write or read-only, with reveal-in-file-manager | The browser cannot submit arbitrary paths; the Host normalizes and registers the directory, and workspace capabilities and hard constraints cannot be raised by preset or rule; writes need one-shot approval under the default `workspace-write` |

Natively selected directories are registered in
`.tracegraph/local-projects.json` and are restored after a Host restart.
Removing a local directory only revokes the TraceGraph registration and never
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

The complete mapping from requirements to invariants, implementation files, and
executable commands is in
[docs/verification-map.md](docs/verification-map.md).

## Documentation

- [Documentation index](docs/README.md) — entry point for modules 01–19 and all reference documents
- [Known limitations](KNOWN_LIMITATIONS.md) — the single source of truth for boundaries
- [Repository map](DIRECTORY.md) — responsibility of every source and configuration file
- [Verification map](docs/verification-map.md) — requirement / invariant / implementation / command
- [Changelog](CHANGELOG.md)

## License

MIT. This project is an independent implementation; it does not copy source
code or branded UI from DeepSeek Harness, Claude Code, Codex, Pi, or any other
product. See [NOTICE.md](NOTICE.md).
