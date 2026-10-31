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

Media assets support structurally validated MP4/WebM video and MP3/WAV audio, with the shared 128 MiB media bound (existing picture/PDF/native limits stay in effect). Uploads and media snapshots/imports use bounded streams; owner and saved-reference public media downloads support single HTTP byte ranges and recheck the current session/share policy and file version per chunk. The internal asset API exposes `inspect`, `inspectById`, `publicInspect` and `open` descriptors; media never goes through the old bounded `file`/Buffer interface.

Parsed HTML `img`, `video`, `audio` and `source` resources include `src`, `srcset` and video `poster`; Markdown/code source ranges remain distinct. Audio/video originals get standard Markdown file links alongside embeds. App-owned asset URLs resolve through the asset registry. Remote embedded resources are localized outside the workspace lock, using a 30-second deadline, at most three redirects, public-address validation and DNS pinning on every hop, and fresh requests without forwarded credentials. Ordinary external hyperlinks remain external. Typed `data:` media is decoded in bounded chunks and validated as an ordinary asset. A `blob:` source returns `PORTABLE_REQUIRES_PERSISTENCE`; the owner export UI offers to persist browser-owned media, update and save the links, then retry. Expired browser URLs require selecting the file again.

Cancellation, unavailable resources and permission changes abort preparation and reclaim staging. Export callbacks can refresh the principal during acquisition, copies, compression and publication. Import callbacks refresh it for each asset stream/publication, each document publication and the completion receipt; already committed identities retain the existing retry journal.

The MCP tools `export_portable_documents`, `begin_portable_import_upload`, `import_portable_archive` and `get_portable_import_result` use the same core planner and whole-manifest import. MCP uploads/downloads retain bounded transfer chunks; large import identity maps are paged using a cursor, with request-ID recovery after interruption.

Native relative scene links still require a relocation plan and newly matching browser preview, so they fail with structured `DIAGRAM_PREVIEW_REQUIRED` rather than rebinding an old PNG. Primary Markdown diagrams additionally require a retained version or live preparation proving the complete source/render/preview tuple and resource paths.

Legacy inline SVG/Mermaid v1 groups also require their original durable source/PNG receipt for strict export. Package filenames preserve group recognition, so missing receipts cannot silently turn stale previews into ordinary images. Import does not recreate those older receipts; owners must regenerate an imported v1 inline preview before its next strict export. The three primary document types are prepared during import and do not have this limitation.
