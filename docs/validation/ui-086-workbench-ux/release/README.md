# UX-086 Preview release acceptance

[Final immutable archive evidence](attempts/final-archive/README.md) covers SHA256 `41622f1719467850475d583115357d21ba0aa69e8469f27ab8b1e6cf0140298a`: fresh Linux/macOS installs, CLI/private Host smoke, three Runtime proofs, actual installed LIVE Main/Node worker/Seatbelt test, native Preview CUA observation, review screenshots and owned process cleanup.

One first Linux DEMO-080 attempt failed closed with `SessionPathSafetyError: session file changed while opening`; one entirely fresh rerun passed. The failure and full stack remain retained, the cause is unlocated and Core was not changed. See [report.json](attempts/final-archive/report.json) and [cleanup.json](attempts/final-archive/cleanup.json).

All participants were maintainer Agent simulations. This does not claim independent non-maintainer acceptance, signing, public deployment or remote model quality.

Earlier immutable receipts remain preserved:

- [First archive](attempts/first-archive/README.md), `584cabba…`: install/smoke/proofs passed; superseded before native GUI after the source Desktop journey exposed the Electron-versus-Node executable composition defect.
- [Second archive](attempts/second-archive/README.md), `f2de296d…`: install/smoke/proofs and installed LIVE test passed after retained harness corrections and cleanup; superseded before Preview after actual Chinese UI observation found a missing placeholder mapping.

No earlier success was transferred to the final archive. [artifact-delta.json](attempts/final-archive/artifact-delta.json) proves unchanged Main/Host/Core/CSS between the second and final archive; final SDK locale and rebuilt renderer artifacts received fresh installation/native checks.
