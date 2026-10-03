# External acceptance handoff

[中文](external-acceptance.zh.md)

This page separates the user-authorized local acceptance work from stronger
external claims. The LongMemEval public-benchmark run and REL-084 maintainer
simulation are complete for their requested local scopes. Neither a public
benchmark nor a maintainer simulation establishes production-distribution
quality or an independent non-maintainer pass.

## EVAL-074: public benchmark and live-distribution boundary

The requested public-benchmark assessment uses [LongMemEval and LongMemEval-V2](2026-10-03-eval074-public-benchmarks/README.md).
Its paired protocol, item scores, confidence intervals, model/resource record,
and limitations are complete in that report. The 2026-10-01 synthetic pilot
remains immutable and exploratory/inconclusive; Langfuse stays outside normal
local tests and CI.

This public-data lane is not a real-user distribution study. Quality on an
authorized live-user population, fresh-memory drift, human Experience
admission, and independently verified Experience reuse remain unknown. If a
stronger live-distribution claim is needed, use the existing [paired study
protocol](../outlive-agent-v2/07-quality-benchmarks-snapshots-i18n/05-memory-experience-paired-evaluation.md)
and collect a separately authorized, minimized holdout.

Before collecting final scores, record the following in the external study:

- The exact authorized, minimized dataset scope; its frozen digest; collection
  population; holdout/development separation; and retention/deletion policy.
- Application commit and working-tree digest, model/provider version,
  prompt/configuration hashes, evaluator/rubric version, arm randomization,
  replicate count and random seed. Only the relevant Recall flag changes.
- The primary outcome, meaningful benefit/harm thresholds, sample-size plan,
  exclusions and blinded scoring procedure. Define these before viewing the
  final outcomes; do not reuse the synthetic pilot's effect as a quality claim.
- Memory relevance, freshness and source support metrics with explicit
  denominators, plus Experience applicability and independently verified reuse
  outcomes. Record harms and failures for both lanes.

The final report must contain paired item-level run/trace/score references,
dataset read-back verification, wins/ties/losses, effect and 95% paired cluster
bootstrap interval, resource costs where observed, exclusions and limitations.
Link the local scope/revoked/deleted/injection negative-gate results separately.
An unavailable field stays unknown; inconclusive results remain inconclusive.

The user-authorized public-benchmark acceptance closed with a full item-level
report. The separate live-distribution study still requires an authorized
holdout, independent scoring and an auditable report; no such population was
supplied for the 2026-10-03 implementation pass, so quality on that population
remains **unknown**. This optional follow-up does not block local CI.

## REL-084: independent installation

The user-authorized simulation passed on 2026-10-03. Its exact archive,
install/smoke receipts, public-proof report, failure history, and explicit
identity/environment limits are in the [simulation record](2026-10-03-rel084-simulation/README.md).
This satisfies the requested simulated path. It does **not** establish that a
real non-maintainer independently completed the workflow; that stronger claim
remains unverified.

Give a non-maintainer the exact preview archive, its checksum and SBOM, and
the installation instructions delivered inside that archive. Freeze the
archive before the attempt. The participant must begin in a new directory
without the repository's `node_modules`, workspace symlinks or existing data.
An isolated container smoke is useful release evidence but is not a human
participant.

The participant independently follows the shipped instructions to verify the
checksum, install prerequisites and dependencies, start the CLI/Host, open the
Desktop preview, and reproduce the three evidence demos. Record every failed
step and the observed output. Do not include credentials or private project
contents. If instructions change, identify both revisions and rerun the failed
steps from the stated starting point.

The recorded simulation follows; preserve these fields for any future
independent pass. Blank fields are not success:

```yaml
task: REL-084
status: simulated-pass
participant_pseudonym: Codex-assisted maintainer simulation
participant_confirms_not_maintainer: false
date_and_platform: 2026-10-03, macOS arm64, Node 24.21.0
archive_sha256: 79a06960f699339c0c5136497f535bf0e0e515d17fc6b5415d18595ed7534827
instructions_revision: INSTALL.txt sha256 1d72053c3bf48ddef6dfadf7b296b6fc229c42926be28c3b79dbb4037d658bf4
initial_environment_and_prerequisites: fresh archive extraction on maintainer workstation; shared pnpm content cache reused
checksum_verification: archive and release manifest both passed SHA256SUMS
install_command_and_exit_code: node scripts/preview-install.mjs --desktop; 0
cli_host_observation: preview-smoke passed; CLI exit 0; Host identity matched package and exited cleanly
desktop_preview_observation: same-archive CUA receipt observed preview=1 badge and zero Host workers; current recapture timed out with CUA error -10005
recovery_memory_cancel_evidence_refs: [public-proofs.json; DEMO-080/081/082 all passed]
failed_steps_and_documentation_fixes: [earlier contaminated extraction was rejected for unlisted node_modules; a clean re-extraction passed without source changes]
rerun_evidence_refs: [2026-10-03-rel084-simulation/README.md]
participant_conclusion: requested maintainer simulation passed; independent non-maintainer attempt not performed
```

The roadmap task's simulation acceptance is complete for the user-authorized
scope. Any claim of actual independent-user acceptance still requires a real
non-maintainer pass with the failure/fix history. Maintainer and agent tests
must stay labeled as such; no participant was contacted or external result
fabricated by the implementation workflow.
