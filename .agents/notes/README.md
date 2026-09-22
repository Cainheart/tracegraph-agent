---
id: agent-notes-policy
status: proposed
owner: repository-governance
last_reviewed: 2026-09-23
---

# Agent Notes

Agent Notes preserve **why** a durable repository decision was proposed,
accepted, rejected, superseded, or archived. They complement source code and
tests; they are not runtime instructions.

## Lifecycle

```text
proposed ──accepted and shipped──> implemented ──replaced──> archived
    └────────────rejected────────> rejected
```

- `proposed/`: design under review; may use future tense.
- `implemented/`: verified current decision; must link implementation and tests.
- `rejected/`: proposal retained with a concrete rejection reason.
- `archived/`: formerly implemented decision that is no longer current.

Moving a file is not enough. Rewrite its status, decision, consequences, links,
and dates so the new location tells the truth.

## A Note is required when a change

- changes public commands, queries, events, or persisted formats;
- moves state ownership or introduces a package family;
- changes Memory admission, recall, retention, export, or deletion;
- changes policy, approval, credential, sandbox, or authority behavior;
- adds a new process boundary, product entrypoint, or runtime profile;
- changes benchmark/snapshot meaning or accepts a durable limitation.

Use `TEMPLATE.md`. Do not invent alternatives merely to fill the template.

## Review rules

1. A proposal must distinguish Current, Target, and Deferred behavior.
2. Acceptance criteria must be observable and include failure/recovery cases.
3. A shipped decision needs links to code, tests, and current documentation.
4. Rejected and archived Notes remain searchable so an old debate is not
   silently repeated.
5. Secrets, private prompts, personal memory contents, and raw credentials must
   never appear in a Note.
