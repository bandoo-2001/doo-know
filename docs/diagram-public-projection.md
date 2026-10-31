# Diagram public projection protocol

Dedicated diagram documents and legacy `.excalidraw` notes are always read-only through public shares. Their semantic type comes from the actual readable document, not a cached type or the `.md` extension. Ordinary Markdown public editing keeps its existing protocol.

Owner diagram reads use `GET /api/notes/:id/diagram` for both formats. Legacy `documentHash` and `source.hash` cover the exact native file bytes, and `source.content` contains the native JSON. A legacy note may have no preview. Bounded private callers can supply the existing source-handle callback.

Legacy opaque source handles identify the exact logical native note path, so each transfer chunk can recheck that same note grant and version without adding an attachment-directory grant.

The owner can register a legacy preview with `POST /api/notes/:id/diagram/legacy-preview`:

```json
{
  "expectedDocumentHash": "<sha256>",
  "expectedSourceHash": "<sha256>",
  "pngBase64": "<PNG>",
  "renderer": "excalidraw@0.18.1+dooknow@1",
  "config": {},
  "requestId": "<unique actor request>"
}
```

The receipt and immutable PNG bind the native file, title, renderer and configuration. This operation neither migrates the document nor rewrites the scene. Changing the PNG for an already fixed source/render version returns `DIAGRAM_PREVIEW_CONFLICT`; changing the source returns `DIAGRAM_SOURCE_CONFLICT`. Missing or changed previews remain visible to the owner as `missing` or `stale`.

Share options, share status and public access include `allowDiagramSource`, defaulting to `false`. Only the owner changes it. This capability permits native source reads and never grants editing. Resetting or changing a share policy advances its persistent policy revision.

Public resource endpoints return the safe `DiagramResource` DTO:

- `GET /api/public/shares/:token/diagram` resolves the shared primary diagram or legacy whiteboard.
- `GET /api/public/shares/:token/whiteboards/:reference` resolves an actual UUID/path embed in the current parent, including a Markdown whiteboard. Unrelated documents remain inaccessible.
- Without a source grant, `source` contains only `format` and `hash`, both edit/download capabilities are false, and renderer/configuration are omitted.
- With a source grant, authorized source content and applicable source paths are included; `canEdit` stays false.
- `preview.path` is relative to the shared parent. Load it through this share's `/asset?source=...` route.

Public HTML and segmented Markdown remove the declaration and complete managed primary region using parser ranges. They retain the title and author explanation and insert the fixed PNG. Generated whiteboard summaries, outlines, Mermaid source and renderer configuration are not part of that projection. Ordinary inline SVG/Mermaid behavior is preserved.

A malformed or unsupported declared diagram is rejected on public reads and public editing; it cannot fall back to exposing ordinary source. Private Markdown recovery remains available. Raw public snapshots also refuse declared candidates, including large invalid documents, before loading their managed source.

Both `/assets/:assetId` and `/asset?source=...` enforce the same semantic resource inventory, roles and byte hashes. A repeated source link cannot add a capability. Existing legacy portable bindings can supply a PNG only after matching their code/source/kind binding, actual native scene, and a durable artifact receipt proving the original PNG bytes. Bindings without that receipt need an owner-prepared legacy preview. They cannot upgrade a stale primary render. Low-level saved-asset helpers also refuse Excalidraw/Mermaid native originals; authorized originals go through the projection facade.

Large ordinary parents use the existing bounded saved-reference scanner for attachments after an actual-file declaration check. PNG/PDF reads therefore keep working beyond the small-document byte/line limits. This path still refuses native originals and rechecks the current share policy epoch after asynchronous reference/file IO.

Absent or stale fixed PNGs return structured `DIAGRAM_PREVIEW_REQUIRED` with the pending document/version information. Public routes never fall back to native JSON. The server does not render diagrams.

Public pagination uses signed `public-projection` cursors and `public:<fingerprint>` snapshot identities. The fingerprint binds the current grant revision, document, source, render and PNG versions. Each page rebuilds and checks that immutable logical projection before applying the existing public byte/page/rate budgets and expiry. Grant tightening followed by re-enabling cannot revive an older cursor. Owner raw snapshot identities cannot be substituted; raw snapshot services refuse diagram reads by a share principal. Large ordinary Markdown retains its existing raw paging path.

Blog primary capture uses the same semantic resource resolution and fixed PNG proof, removes the managed source/summary, and freezes only public PNG/description resources. It revalidates the primary source/render/preview before publication and returns `BLOG_PREVIEW_REQUIRED` for stale or missing primary previews, including whiteboards without a fenced diagram block. Existing ordinary embedded-diagram publication remains supported.
