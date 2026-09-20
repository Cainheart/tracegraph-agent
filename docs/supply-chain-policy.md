# Supply-chain policy

TraceGraph pins direct dependencies and treats the lockfile as reviewed source. The policy is enforced by `scripts/verify-lockfile.mjs`; it is not only a documentation convention.

## Resolution policy

pnpm 11 reads non-registry project settings from `pnpm-workspace.yaml`, so the effective controls live there rather than in `.npmrc`:

- `saveExact: true`: newly saved direct dependencies do not gain `^` or `~` ranges.
- `resolutionMode: time-based`: when transitive ranges have several valid versions, pnpm prefers the version available when the next direct dependency was published.
- `minimumReleaseAge: 1440` with strict mode: registry releases must cool for at least 24 hours; resolution fails instead of silently selecting a too-new release.
- `minimumReleaseAgeIgnoreMissingTime: false`: a registry or mirror that cannot supply publication time fails closed.
- `trustLockfile: false`: normal installs re-apply release-age verification to lockfile entries.
- `blockExoticSubdeps: true`: transitive packages cannot introduce Git or direct-tarball sources.
- `allowBuilds` remains an explicit allowlist for dependency lifecycle scripts.

`.npmrc` contains only `save-exact=true` as a compatibility fallback for accidental npm use. Authentication tokens and machine-specific registries must never be committed there.

The current `minimumReleaseAgeExclude` entries are exact package-version bootstrap exceptions. The guard rejects package-only names, ranges, wildcards, and `||` lists. Each future exception must be an exact version, documented in review, and removed once the release has aged past the window.

The current `overrides.lodash-es` entry is pinned exactly to `4.18.1` to remediate the high-severity advisory found by the blocking audit. It is not an advisory ignore. The guard rejects ranged or exotic-source overrides, so this remediation cannot silently widen during a later install.

## Lockfile and manifest guard

Run:

```bash
node scripts/verify-lockfile.mjs
node --test scripts/verify-lockfile.test.mjs
```

CI deliberately configures `pnpm/setup` with `install: false`, then invokes `node scripts/verify-lockfile.mjs --skip-frozen` directly before `pnpm install --frozen-lockfile`. The guard is not dispatched through `pnpm <script>`, so host-specific package-manager wrappers cannot perform an implicit workspace install first. This preinstall phase checks manifests, project policy, exact pnpm identity, source schemes, catalogs, overrides, and lockfile format without performing an install. After installation, the full `pnpm verify:lockfile` command also runs the offline frozen synchronization check. Dependency lifecycle code therefore does not get to run before the repository-owned manifest policy has passed.

The guard fails non-zero when:

- a production, development, or optional dependency is not an exact semver, an exact catalog reference, or `workspace:*`;
- an internal package does not use `workspace:*`, or a workspace target does not exist;
- any direct or peer dependency uses `git:`, `git+*`, `http:`, `https:`, `file:`, `link:`, or common repository shorthands;
- a catalog reference is missing or resolves to a range;
- a pnpm override is ranged or redirects to an exotic source (exact versions and the dependency-removal marker are the only accepted values);
- the active pnpm differs from the exact root `packageManager` pin;
- pnpm 11 is paired with anything other than the reviewed lockfile format `9.0`;
- required project security settings are absent or weakened;
- `pnpm install --lockfile-only --offline --frozen-lockfile --ignore-scripts --trust-lockfile` detects manifest/lock drift.

The guard's final frozen check uses `--trust-lockfile` only to make synchronization verification deterministic and offline. It does not install packages and does not replace the normal install, whose committed `trustLockfile: false` performs registry-backed release-age verification.

The fixture tests inject every major failure class, including a stale lockfile. Unexpected parser, filesystem, pnpm, timeout, or output failures are errors rather than passes.

## Advisory audit boundary

The CI security gate is:

```bash
pnpm audit --audit-level=high --registry=https://registry.npmjs.org/
```

It covers production and development dependencies and fails for `high` or `critical` advisories. The explicit registry avoids silently inheriting a developer mirror that does not implement npm's audit endpoint; private-registry deployments may substitute an audited endpoint in CI. `low` and `moderate` findings remain visible in the job output but do not block this initial gate. Network, registry, authentication, and malformed-response failures must also fail the job; the command must not be followed by `|| true`.

`pnpm audit` is online and depends on the configured registry's advisory database. A clean audit does not prove that a package is benign or that an unpublished vulnerability does not exist. Exact pins, the 24-hour cooling period, lifecycle-script allowlisting, exotic-source blocking, integrity-bearing lockfile, and review remain independent controls. No advisory ignores are committed; any future exception requires an advisory identifier, owner, reason, expiry date, and separate review.
