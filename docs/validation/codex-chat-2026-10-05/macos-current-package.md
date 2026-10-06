# Current-source macOS package and isolated smoke

Date: 2026-10-05 · Apple Silicon · product build `90cf6f5c78e99ed84693294dcec87f81982ea6d1a14f4d7a1bdb6eb8d043f21a`

The package was built from the current workspace after the chat, memory, media and product-workbench changes. Its DMG/ZIP output was in `../../../_tmp_release/product-workbench-macos-current/artifacts/` and has been removed in the 2026-10-06 cleanup. `SHA256SUMS` had validated all four delivered container files; DMG SHA-256: `de4ce9b61bf8693f959005e2763517643479cad30a4972444b2662350b4add45`. Historical packaged smoke receipts remain below. The latest installed app and preserved package inventory are documented in the [2026-10-06 install record](../desktop-install-2026-10-06/README.md).

The actual packaged Electron app was launched with a temporary `OUTLIVE_PROFILE_ROOT`, temporary Electron user data and a restricted system `PATH`. The deterministic loopback fixture was explicitly isolated and is not a real provider-quality claim. All 13 packaged checks passed, including the actual app window, model save/test, CLI seeing the same settings, bundled Node/PTY, project creation, window-close background completion, owner reuse and idle settings restart/rebind. The smoke stopped its own temporary Host, exited both app processes with code 0 and removed its temporary Profile. See [the full smoke report](checks/macos-installed-smoke-current/report.json), [process log](checks/macos-installed-smoke-current/app-process.log), [window screenshot](checks/macos-installed-smoke-current/first-window.png) and [command output](checks/macos-installed-smoke-current.log).

This is a build and isolated runtime acceptance, not a replacement of the user's installed application. `/Users/cain/Applications/Outlive Agent.app` and its default Profile remained untouched; the old app was still running and its Host PID `50247` owned `/Users/cain/.outlive/profiles/default` during inspection. The current package is explicitly unsigned (`signature_status=not-requested`, `TeamIdentifier=not set`); both `codesign --verify --deep --strict` and Gatekeeper `spctl --assess` reject it because the bundle is not sealed. The environment has no Developer ID/notarization credentials, so this artifact must not be presented as a normal install-ready update. macOS Accessibility/Input Monitoring permissions were not granted or tested, and no Windows evidence is included.

## Related current-source checks

- [Full repository build, unit tests, snapshots and engineering gates](checks/mac-full-test-current.log)
- [Workspace build and type checks](checks/mac-typecheck-current.log)
- [V2 roadmap/document manifest](checks/mac-verify-v2-docs-current.log)
- [Generated reference catalog check](checks/mac-docs-check-current.log)
- [Translation registration](checks/mac-verify-i18n-current.log)
- [B Current asset verification](checks/mac-brand-check-current.log)
- [Whitespace/error check](checks/mac-diff-check-current.log)

The full UI matrix at 1440×900, 1280×800 and 1024×768 in both themes, normal user Profile migration, real DeepSeek chat from this newly built package, macOS Accessibility permissions, Windows native acceptance, signing and notarization remain open.
