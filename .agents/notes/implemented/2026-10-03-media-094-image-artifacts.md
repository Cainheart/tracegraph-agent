---
id: 2026-10-03-media-094-image-artifacts
title: Verified image output through typed media tools and scoped Artifacts
status: implemented
owners: [media-runtime]
created: 2026-10-03
last_reviewed: 2026-10-03
affects: [contracts, core, evidence, tool, host, sdk, cli, workbench]
supersedes: []
---

# Agent Note: Verified image output through typed media tools and scoped Artifacts

## Problem and previous state

G-18 supplied uploaded PNG/JPEG/PDF inputs. Generated output lacked a typed provider/tool path and scoped binary content API; prose or code claiming an image existed was not a media receipt.

## Implemented decision

MEDIA-094 registers trusted Core tools `generate_image`, `render_diagram` and `render_chart` with closed bounded inputs. Runtime-owned binary publication writes verified bytes and contributes refs to the existing canonical Tool → Receipt → Observation → Ledger chain. Host-only one-shot dispatch follows normal Run/session admission, policy, cancellation and receipts without requiring a chat model. Human task titles show operation and prompt/title summary; the complete typed intent hash binds command retries and rejects changed arguments.

Dedicated settings explicitly select OpenAI-compatible Images, OpenAI Responses image tool, or a compatible native Chat image-output convention. Credential references resolve at the provider boundary; per-Run executor binding freezes configuration and retains old credentials until terminal/cancel. Binding must preserve the registered descriptor and authority. Public clients cannot supply executors or change this authority.

Generated raster output is PNG only: complete CRC/header/IDAT validation, bounded decoded rows, non-interlaced 8-bit grayscale/RGB/alpha, 20 MiB, side ≤8192 and ≤16,777,216 pixels. JPEG/WebP generation fails with an explicit unsupported-format error. Local diagram/bar/line chart output is escaped self-contained SVG with bounded labels, valid XML characters and finite numeric ranges; no arbitrary SVG, scripts, shell or external assets execute.

Explicit media Runs carry trusted `background_model_derivation:false` in canonical `run.created`. The Memory worker respects that fact during settlement and recovery, preventing hidden post-run model requests for local rendering. Ordinary chat/task extraction remains unchanged. Internal adapter decision events do not prove network provider requests.

## Invariants and boundaries

Success requires verified stored bytes, project/Run scope, SHA-256 and matching canonical receipt/Event refs. Public events and observations contain metadata, not bytes, base64, credentials or provider response prose. Live content reads enforce canonical relation and hash/MIME/length again; SDK validates the received digest. Replay cannot read bytes or write. Plain Chat media publication does not grant project filesystem or command authority.

Malformed/prose/remote-URL-only responses fail closed. Authentication errors are safe failures; after-dispatch timeout/network uncertainty and server errors remain unknown without automatic retry. Same command plus typed intent returns the same accepted Run and does not dispatch again. Explicit cancellation records no output success, although remote charge cancellation is not guaranteed. Policy deny/Plan Mode dispatch zero requests. Generic non-Patch ask requires the existing trusted one-time answerer; unavailable UI manual approval remains fail closed and is not claimed complete.

## Migration, rollback and deferred scope

Existing text Artifacts and attachment input behavior remain supported. Binary MIME kinds, APIs and tool seams are additive. Removing the media extension disables future generation while scoped historical refs remain readable. Image editing, JPEG/WebP generation, arbitrary imported SVG, audio/video, external provider quality/access/billing and independent outside-user acceptance are deferred. No native/media dependency was added.

## Acceptance and evidence

- [x] Three explicit image protocols return actual external fixture PNG bytes and matching canonical Artifact hashes.
- [x] Diagram/chart render with neither chat nor image configuration; a configured chat-provider chart also sends zero chat/image/post-run requests.
- [x] Malformed base64, prose/empty/invalid responses, size bounds, auth, timeout/unknown, cancellation and exact retry cannot yield false output success.
- [x] Scope mismatch, corruption, replay, body/key leakage, remote URLs, hostile XML and numeric overflow fail closed.
- [x] Current documentation distinguishes controlled API validation from unverified external model quality/access/billing.

[Evidence and capability matrix](../../../docs/validation/media-094/README.md): real detached authenticated Host and production CLI, `PATH=/usr/bin:/bin`, temporary private-file credential profile, 20 CLI calls / 94 assertions / 6 actual files; [independent verification](../../../docs/validation/media-094/evidence/source-final/independent-verification.json) passes 666 checks, including hashes of 12 loaded production modules. Fixture images are algorithm-generated protocol bytes, not AI quality evidence. The initial fixture enum failure and first full pass remain preserved.

Core media/Memory tests: 3 files / 50 tests; Host protocol integration: 2 tests; SDK: 2; CLI: 16. Related types and targeted builds passed. The real DMG-installed Mac application then passed the same [20 CLI / 94 assertions / 6 files](../../../docs/validation/media-094/evidence/installed-mac-final/report.json) and [666 independent checks](../../../docs/validation/media-094/evidence/installed-mac-final/independent-verification.json), using only its bundled Node and installed dependencies with no source-import fallback; resources were cleaned. Web/Desktop UI and packaged installer evidence remain separately owned release checks.

Official reference checked on 2026-10-03: [Images API](https://developers.openai.com/api/reference/resources/images/methods/generate), [image generation](https://developers.openai.com/api/docs/guides/image-generation), [Responses image tool](https://developers.openai.com/api/docs/guides/tools-image-generation). Compatible Chat is an explicit response convention, not a claim that every service implements it.
