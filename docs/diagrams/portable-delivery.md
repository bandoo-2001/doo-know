# Local portable delivery protocol

The owner endpoint `POST /api/portable-deliveries` accepts a stable `requestId` and one selection:

```json
{"selection":{"kind":"single","noteId":"<uuid>"},"requestId":"<stable-id>"}
```

`multiple` accepts `noteIds`; `directory` accepts a knowledge-relative `path` (empty means the library). A single document with no file/document dependencies returns Markdown. Explicit multiple/directory selections always return an archive, including a one-document directory. Existing raw document download and legacy administrative/MCP bundle endpoints retain their contracts.

The result contains `id`, `kind` (`markdown` or `archive`), `fileName`, `mime`, `sizeBytes`, `sha256`, and `downloadUrl`; archives also contain `manifestVersion: 1`. Download the returned filename and MIME from `GET /api/portable-deliveries/:id/download`. Owner-session, Origin and CSRF protection apply. Receipts bind the calling principal/client; they expire after 24 hours. Reusing a request ID with a different selection fails.

Local Markdown navigation follows independently authorized document dependencies, with bounded cycle handling. Parsed links, reference definitions, images and wiki links are rewritten using original source ranges; code examples are preserved. Wiki navigation and legacy whiteboard embeds become standard Markdown. Documents retain their logical hierarchy; byte-identical attachments share a content-addressed package `assets/` path. Legacy `.excalidraw` documents become Markdown wrappers plus native source and a verified prepared PNG. Export never updates knowledge files.

Application-owned `/?note=<uuid>` navigation on the configured origin, including root/query-relative forms, resolves the current independently authorized note and becomes an ordinary relative document link with its fragment preserved. Other websites' `note` query parameters remain external hyperlinks. An own-origin autolink without a safe destination source range is rejected explicitly; it cannot become a false dependency-free Markdown delivery. Native scene links to application note URLs require the same relocation/preview plan as other native local navigation.

Primary diagrams require a ready semantic resource with matching source/render/PNG versions. Download creation and later chunks recheck the fixed document and asset closure. Missing local dependencies fail with `PORTABLE_DEPENDENCY_UNAVAILABLE` and authorized source/resource diagnostics; changed inputs fail with `PORTABLE_VERSION_CONFLICT`. Incomplete packages are not returned as successful Markdown downloads.

An archive contains `dooknow-portable.json`:

```json
{"format":"dooknow-portable","version":1,"files":[{"path":"00-Inbox/note.md","kind":"document","sizeBytes":8,"sha256":"<sha256>"}],"selected":["00-Inbox/note.md"]}
```

The owner can upload the **whole archive including this manifest** to `POST /api/portable-deliveries/import` as multipart fields `archive`, `folderPath`, and `requestId`. Results contain an import `id`, `notes` (`sourcePath`, new `relativePath`, new `noteId`) and asset count. The service also accepts an extracted complete directory through `importDirectory`; no HTTP endpoint accepts machine-local filesystem paths. Target collisions fail rather than overwriting existing notes. Completed/recovered requests retain their new identities. Each imported primary gets freshly prepared immutable resource paths, while preserving source bytes, unknown machine fields and ordinary prose.

Import verifies manifest version, exact file membership and SHA-256 before note creation; absolute/escaping paths, symlinks, hardlinks, duplicate entries and case/Unicode aliases are rejected. Export/import use shared limits: 256 MiB package, 10,000 files, 1,000 documents, existing per-file limits and 512 MiB tracked staging. Capture/validation are bounded local work; compression and download run outside the workspace lock. Archives/uploads are streamed and resources are staged individually; no archive-sized Buffer or Base64 result is returned. Import progress is durable and can resume using the same input/request ID; it is not a cross-filesystem atomic batch transaction.

Portable import accepts an ordinary Markdown file up to the export's 20 MiB document bound through an internal manifest-import mutation capability. The existing public ordinary-create API retains its 1 MiB bound. The internal capability still uses the normal path authorization, write intent, filesystem publication and recovery gates. Rewritten path segments escape Markdown-sensitive parentheses and preserve literal percent names, so inline/reference links and generated legacy document links survive offline parsing and reimport.

Remaining scope is explicit: remote/data/blob media, MP4/WebM/MP3/WAV, and HTML media are rejected with `PORTABLE_RESOURCE_UNSUPPORTED`. Native relative scene links require a relocation plan and newly matching browser preview, so they fail with structured `DIAGRAM_PREVIEW_REQUIRED` rather than rebinding an old PNG. A new MCP portable-delivery wrapper and browser upload for an extracted directory are not included in this protocol implementation. These remain acceptance blockers for the full approved design.

Legacy inline SVG/Mermaid v1 groups also require their original durable source/PNG receipt for strict export. Package filenames preserve group recognition, so missing receipts cannot silently turn stale previews into ordinary images. Import does not recreate those older receipts; owners must regenerate an imported v1 inline preview before its next strict export. The three primary document types are prepared during import and do not have this limitation.
