---
id: repository-skills-catalog
status: proposed
owner: repository-governance
last_reviewed: 2026-09-23
---

# Repository Skills

This directory will contain reusable, repository-specific operating manuals.
No skill is active merely because it appears in the candidate list below. A
skill becomes callable only when its own directory contains a reviewed
`SKILL.md` and the scripts/documents it references exist.

## Candidate skills

| Candidate | Purpose | Create after |
|---|---|---|
| `outlive-pre-push` | Select the narrowest trustworthy verification set | architecture/doc checks exist |
| `outlive-code-review` | Review evidence, authority, recovery, compatibility | V2 rules are accepted |
| `outlive-agent-note` | Propose, implement, reject, or archive a Note safely | Note lifecycle is exercised twice |
| `outlive-doc-sync` | Validate links, manifests, generated catalogs, status labels | docs checker exists |
| `outlive-snapshot` | Record, scrub, replay, and review Session fixtures | snapshot contract exists |
| `outlive-benchmark` | Run calibrated before/after budgets | benchmark harness exists |
| `outlive-translate-docs` | Maintain paired docs and terminology hashes | i18n pair manifest exists |
| `outlive-release-proof` | Produce recovery/cancel/evidence demonstrations | release proof contract exists |

## Skill contract

A repository skill must:

1. have a precise trigger and bounded scope;
2. point to existing scripts and canonical docs instead of copying logic;
3. declare writes, destructive risk, prerequisites, and failure behavior;
4. produce an inspectable artifact or verification result;
5. stop on unknown state instead of claiming success;
6. contain no credentials, private memory, or machine-specific absolute paths.

Do not create a skill for a one-off operation or for a process that is still
changing on every attempt. First record the decision in a Note and stabilize
the underlying script.
