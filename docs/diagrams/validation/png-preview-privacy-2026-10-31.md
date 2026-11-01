# PNG preview source privacy

Scope: known Excalidraw `application/vnd.excalidraw+json` text metadata in PNG; source-free diagram presentation, public share assets, immutable blog assets, reading HTML/print. No general EXIF policy, no global PNG rewrite, no stored preview hash rebinding.

## Root cause and RED evidence

`validatePng` accepted structurally bounded PNGs with native Excalidraw scene data. All existing source/preview hash proofs could be valid while the presentation PNG itself contained the editable scene. `publicationPng` duplicated the old structural validator; ordinary shared PNG and already cached blog blobs also returned the source-bearing bytes.

- `.local/markdown-diagrams/png-preview-privacy-red.log`: 7/7 tests failed against baseline for tEXt/zTXt/iTXt, real artifact ingress (201 instead of 400), existing published PG with matching PNG hash (public GET 200), ordinary public image (200 with scene), and immutable correctly hashed cached blog PNG (200).
- `.local/markdown-diagrams/png-preview-privacy-reading-red.log`: after initial server gates, 3 reading export tests failed because Blob/data URL PNG content was embedded in HTML with the native scene intact.

Correction to original suspected canvas defect: actual `scenePng` already calls `parseWhiteboard`, whose appState allowlist drops `exportEmbedScene`; true browser baseline produced no PNG text chunks. SVG contains an empty generic metadata element. Initial browser no-metadata-node expectation was invalid and is not claimed as a real RED reproduction. Explicit `exportEmbedScene:false` now documents the canvas export intent; renderer versions stay unchanged since actual output was already safe.

## Change

- Shared browser/server `pngContainsDiagramSource` inspects PNG text keywords only (max 79 bytes), recognizes all three tEXt/zTXt/iTXt chunk forms, and never decompresses attacker-controlled text. It preserves unrelated PNG text metadata.
- Shared diagram `validatePng` rejects the known source payload. Existing primary prepare, artifact prepare/import, native preview operations, migration, legacy preview, publication policy, and private/public resolver paths already use this validator.
- Blog PNG preview input uses the same diagram validator. Capture rejects source-bearing ordinary PNGs and direct public immutable blob delivery checks existing bytes.
- Public ordinary image asset projection/delivery, including large ordinary parent fallback, rejects the known payload independently of asset role. Owner original downloads retain exact bytes.
- Reading HTML construction rejects source-bearing Blob and data URL PNGs before embedding. Print consumes this same HTML.
- Canvas PNG/SVG export explicitly sets `exportEmbedScene:false` on copied appState and leaves original input unchanged.

## Verification

- Final targeted server command (12 specified files): 142/142 PASS, `.local/markdown-diagrams/png-preview-privacy-final.log`.
- Final `npm run typecheck`: PASS, `.local/markdown-diagrams/png-preview-privacy-typecheck-final.log`.
- `git diff --check`: PASS.
- Isolated browser `npx tsx scripts/e2e.ts --config playwright.png-privacy.config.ts --project desktop --output .local/markdown-diagrams/png-privacy-browser-final`: 1/1 PASS. Real Excalidraw export with input `exportEmbedScene:true`: no PNG text chunks, no SVG scene payload, input object unchanged. Browser harness does not touch shared cookies; port 4198 server stopped.
- Prior related service tests: 81/81 PASS (6 files); native migrations + privacy: 49/49 PASS (4 files); reading + expanded privacy: 19/19 PASS (3 files).
- Scope explicitly excludes full suite, mobile, production data, or service changes. No production knowledge base touched.

## Remaining limitations

Only known Excalidraw text-keyword scene metadata is covered. Other metadata formats are outside this task. Existing unsafe publications are denied until genuinely re-prepared; nothing is silently stripped or relabeled with a new hash. Cached blog HTML can still render the page, while the unsafe image bytes are denied by its resource route. Independent scoped review PASS after the follow-up below.

## Independent review and follow-up

Read-only reviewer `/root/png_preview_privacy/png_gate_review` reviewed `03249bf..78f2324`, confirmed the shared detector, article-resource/HTML gates, hash contract, and owner download semantics, but found one P1: published design avatar bytes at `/blog/media/:hash` bypassed the article resource guard. Reviewer independently reproduced unsafe upload→set avatar→publish→anonymous exact-byte download.

- Added real regression: `.local/markdown-diagrams/png-preview-privacy-design-red.log`: 1 failed / 10 passed, with anonymous design PNG returning 200 unsafe bytes.
- Minimal fix in `packages/core/blog/studio.ts`: public design media performs the same known-key check after authorizing current published references; private `designMedia` retains exact original bytes.
- Privacy + studio + studio portability: 32/32 PASS, `.local/markdown-diagrams/png-preview-privacy-design-green.log`.
- Main commit: `78f2324acee74f3265c1d3b702303b20c2e7fc16`; follow-up: `c07b6dc4116398063d4a682ed30a05da321460e1`.
- Fresh post-follow-up `npm run typecheck`: PASS, `.local/markdown-diagrams/png-preview-privacy-typecheck-reviewed.log`.
- Final independent reviewer: **PASS**, range `03249bf..c07b6dc`, no remaining actionable findings. Its original anonymous design-media reproduction now returns **400**, while authenticated owner media returns **200 with exact original bytes**. Reviewer reran privacy/studio/portable **32/32 PASS**. Reviewer did not independently rerun browser or typecheck.
- Source frozen after `c07b6dc`; report and logs are ignored local audit artifacts, not force-tracked.
