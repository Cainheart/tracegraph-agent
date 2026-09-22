# TraceGraph / Outlive Agent Repository Instructions

## Scope and authority

This file governs work inside `tracegraph-agent/`. The parent workspace
`../AGENTS.md` and its canonical `.claude/` workflows still govern workspace-wide
job-search and agent-trace behavior. This file adds repository architecture,
evidence, and verification rules; it does not replace those parent rules.

## Read the right source first

- For **current product behavior**, read `README.md`, the relevant
  `docs/modules/*.md` file, and the source/tests linked from that module.
- For the **proposed V2 target**, start at `docs/outlive-agent-v2.md`, then open
  only the linked module needed for the task.
- For **why a repository decision exists**, read `.agents/notes/`.
- For **repeatable maintenance procedures**, use `.agents/skills/` only after a
  real `SKILL.md` has been accepted. A planned skill name is not an executable
  instruction.
- `docs/outlive-agent-v2/10-tracegraph-to-outlive-migration.md` records how
  TraceGraph capabilities and boundaries migrate into V2. It is not proof that
  a V2 capability has shipped.

Never convert a proposed design into a current-capability claim without code,
tests, and an updated owning module document.

## Non-negotiable invariants

1. The append-only event ledger is the source of durable run facts. Reports,
   UI state, memory candidates, and summaries are replayable projections.
2. A fact may be model-visible only if it is durably logged or explicitly
   marked as ephemeral and non-authoritative.
3. A tool exit code or HTTP success is not business success. Side effects need
   a durable command, receipt, observation, and—when outcome is uncertain—a
   reconciliation path.
4. Memory must carry provenance, scope, validity, revision, and governance
   state. Retrieval similarity never turns text into truth.
5. Restored sessions may inherit knowledge, but must re-evaluate policy,
   credentials, approvals, and workspace authority.
6. Cancellation must stop new dispatch and settle child work; retries must be
   bounded, typed, and visible in evidence.
7. Do not add product behavior to `scripts/`. Do not add client-specific
   business semantics to `apps/`.

## Architecture rules

- Keep `apps/*` as composition roots and delivery surfaces.
- Depend inward through public package exports; no deep cross-package imports.
- Keep domain contracts independent from transports, model vendors, UI, and
  persistence implementations.
- Introduce a physical package only after its boundary is stable, has at least
  two consumers or a hard isolation reason, and has contract tests.
- Register optional capabilities through typed seams. Do not grow new
  feature-specific branches in the central Agent Loop.
- Persistent schema, event, protocol, authority, package-boundary, and Desktop
  decisions require an Agent Note before implementation.
- During V2 migration, retain the `@tracegraph/*` package scope unless a
  separate accepted Note changes it.

## Change workflow

1. Inspect the worktree and preserve unrelated user changes.
2. Classify the change as `behavior`, `protocol`, `storage`, `refactor`,
   `tooling`, `docs`, or `tests`.
3. Identify the owner, source of truth, compatibility impact, and recovery path.
4. For durable or architectural changes, create/update a Note under
   `.agents/notes/proposed/` before editing implementation.
5. Implement the smallest vertical slice. Keep moves/refactors separate from
   semantic changes where practical.
6. Add the narrowest useful unit/contract/invariant test, then run the broader
   gate required by the changed boundary.
7. Update current docs only after behavior is verified. Keep target-state text
   labelled `proposed`, `target`, or `deferred` until then.

## Verification

Choose the narrowest command that can disprove the change, then broaden in
proportion to risk:

```bash
pnpm --filter <package> test
pnpm --filter <package> typecheck
pnpm test:engineering
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm evals
pnpm coverage
```

For contract changes, rebuild generated declarations before typecheck. For
documentation-only changes, at minimum validate Markdown links, YAML parsing,
the roadmap DAG, and trailing whitespace. Do not claim a command passed unless
it ran in the current worktree.

## Completion standard

A task is complete only when the implementation, evidence, tests, current docs,
and stated limitations agree. If external outcome is unknown, record `unknown`
and reconciliation instructions instead of reporting success.
