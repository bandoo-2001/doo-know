# Workspace inventory review

Baseline: `933d63d942b6499fee964f8a060c7b22b9d299d1`. Scope is source inventory for the non-ToDoo platform unification. This review does not claim live rendering, test execution, or image-model access. No product code, server, dependency, commit, or generated image was changed/created by this inventory task.

`coverage/workspace.json` contains **124 unique surfaces**: **13 pages**, **38 dialogs**, **5 drawers**, **17 popovers**, and **51 state variants**. Modes, loading/error/recovery states and shared entry windows are counted separately from pages. Every item includes a unique WS ID, concrete source references, route/trigger/parent, implemented fields/actions/guards, source-defined responsive behavior, and a distinct-image requirement. An image requirement is a coverage requirement, not a claim that an image has been produced.

## Page coverage

| ID | Existing page | Entry |
| --- | --- | --- |
| WS-001 | Notebook workspace / root landing | `/` |
| WS-006 | Directory contents page | `/?folder=:path` |
| WS-007 | Recent notes collection | `/?view=recent` |
| WS-008 | Favorite notes collection | `/?view=favorites` |
| WS-024 | Rich document note editor | `/?note=:id` |
| WS-049 | Large-file fragment editor | `/?note=:id` |
| WS-068 | Primary whiteboard editor | `/?note=:primaryDiagramId` |
| WS-069 | Primary mind map editor | `/?note=:primaryDiagramId` |
| WS-070 | Primary Mermaid flowchart editor | `/?note=:primaryDiagramId` |
| WS-084 | Native applications home | `/?view=apps` |
| WS-085 | Knowledge graph canvas page | `/?view=apps&app=graph` |
| WS-107 | Trash workspace | `/?view=trash` |
| WS-124 | Standalone exported reading HTML / print document | Downloaded `.html` / app-created print window |

The tree, mounted Git status decorations, sidebar search, compact navigation, account menu, create/import menu, breadcrumb ancestor popup and tree context menu are recorded independently. Recent/favorite card feeds include summary readiness, virtualization, pagination, source-version updates, initial empty/loading, partial errors and retry states.

The editor inventory includes rich/source/split/reading modes, formatting/heading/table/color controls, custom HEX input, contextual table/image/link tools, image zoom, link form, preserved-source copy/delete, unsupported-paste choice, quick insert, YAML properties, Markdown paste, find/replace, backlinks, popup/docked outline, code-block controls, large-file fragments, metadata-only files, operation receipts, recovery-copy fallback, save conflict/latest original/unsaved leave, attachment queues and temporary-media export.

History includes saved revisions, source pagination, diff loading/fallback, Git-source availability, restore confirmation, uncertain receipts and primary-diagram restore preparation. Diagram coverage includes separate whiteboard/mindmap/flowchart pages, source/reading/PNG modes, resource capabilities, native editor adapters, embedded whiteboard editing, local recovery/close, inline cards/source/expanded states, preview generation and source-only save, unfinished creation, insert-whiteboard picker, mindmap node menu and shortcut help.

App home and graph cover knowledge/note data projections, canvas/list, hosted navigation, filters/path/range, analysis tasks, model config, relationship review, saved views/export, evidence-based question answering, desktop inspector/mobile drawer, and dirty-model close confirmation. Blog and ToDoo interiors are excluded.

## Behavioral boundaries that the designs must preserve

- Browser owner API access requires an authenticated session. Maintenance blocks these routes; state-changing requests require configured Origin and CSRF. Graph rejects share principals and restricts management commands to web-owner. Resource-level diagram capabilities decide editing and original-source download. No new administrator/member role matrix is implied.
- File names are checked by the server in UTF-8 bytes: nonempty, at most 180 bytes, no controls/slashes/backslash/colon, no leading dot/trailing space, no `.`/`..`, no case-insensitive `AGENTS.md`. Root category choices and README-only note creation are existing workspace UI guards. Move/copy/restore/save use actual optimistic baselines and request IDs; uncertain outcomes expose receipt checking.
- Owner workspace rich editing requires build flag `VITE_DOCUMENT_EDITOR_ENABLED=1` and eligibility at most 262144 UTF-8 bytes, 5000 units and depth 32. Ordinary full-note mode has a 1 MiB cutoff and 32768-byte long-line threshold. Large mode loads at most 128 KiB per read, supports bounded fragment patches up to 20 MiB files, and oversized files use metadata-only mode. Rich-editor presence in source does not prove a deployed owner build enables it. The public guest host is separate; PB-026/PB-027 own its document/source pages. WS-045 is the shared find/replace widget, reachable through Ctrl/Cmd+F/H in both guest modes without granting owner toolbar access.
- Offered local recovery blocks editing; changed fragment baselines cannot auto-restore. Unsupported Markdown keeps original source and explicit source/copy/delete actions. Dialog bookmarks, note IDs, epochs and revisions prevent stale insertion or asynchronous uploads from targeting a different note/image.
- Diagram save may require explicit preview generation versus source-only save; failures retain source/draft. Primary diagrams save coherent source+PNG with resource capabilities, and autosave pauses on errors/recovery/parent save/leave windows. Mindmaps remain the implemented plain-text subset: 500 nodes, depth 64, 256 KiB outline, 2000-character topics.
- Upload picker accepts existing image/PDF/video/audio formats. Shared budgets distinguish 128 MiB media from 10 MiB ordinary attachments. Upload completion and insertion are distinct states; successful uploads may need an explicit fresh insertion point.
- Graph model settings retain actual provider/address/secret/remote-content consent and version guards. Model connection tests use synthetic text. Secrets are password fields; no real secrets are included. Evidence-bound answers and similarity clues must keep their distinct existing explanations.
- Graph view names currently allow 100 characters in the UI but only 80 in persistence. Review route accepts offset up to 100000 while service validates 10000. These are source discrepancies for follow-up, not permission to widen limits or add functionality.

## Responsive evidence and capture gaps

The inventory records each surface at320,390,1440 as **source-defined; runtime unverified**. Current CSS/JS breakpoints are evidence, not a visual pass:

| Area | Source-defined behavior | Follow-up |
| --- | --- | --- |
| Workspace | <=720px fixed notebook drawer; compact bottom navigation also applies to short landscape<=960×500, portrait<=1100 and coarse-pointer portrait<=1366; desktop60px rail and240–400px sidebar | Capture open/closed drawer, compact more menu and selected tree at all target widths |
| Note | Document-area container compacts chrome; outline becomes popup when document area <=900px or split; source editor mobile padding/font | Capture rich feature enabled and source-only configuration, toolbar overflow and selected context tools |
| Collections | ResizeObserver virtual grid 1–5 columns, 252px cards; <=600px smaller spacing | Capture empty/load/error/update/card summaries; do not infer columns from viewport without measuring content width |
| History | <=720px nearly full viewport with mobile version select; <=360px compact tabs/diff toolbar | Capture saved/Git/diff/raw/confirm/pending variants, nested restore flow |
| Graph | <800px mobile inspector drawer; <=799px search/form columns stack; GraphOverlay clamps modal/drawer width | Capture model/review/ask long content, nested close prompt, keyboard traps and inspector variants |
| Diagrams | Embedded editor fixed full-screen; flowchart stacks below 700px document-area container | Capture native canvas menus, unavailable resource, preview/source modes and nested overlays |
| Diagram close prompt | Absolute inset 30%, 24px padding, no explicit mobile override | Inspect320/390 fit and action readability before design signoff |
| Ant editor dialogs | Explicit requested widths 460/560/620/640px; some content-height/scroll rules | Verify actual framework shrink, clipping, focus and overlay stacking rather than assuming shared `.dialog-card` rules |

Third-party Excalidraw generated tool/property/main/context panels are not exhaustively enumerable from the app adapter alone. The adapter explicitly disables native load/save/export/saveAsImage and embeddables. Enumerate actual remaining package windows in the isolated runtime before declaring complete image coverage. MindElixir's app-owned node menu and help are inventoried; unsupported native rich clipboard/style behaviors remain blocked.

## Cross-inventory ownership

| Local entry | Interior owner / reconciliation |
| --- | --- |
| WS-022 Markdown import | This inventory includes single-file import and host; platform/settings inventory owns TransferPanel batch steps and portable bundle import |
| WS-064–067 note history | Note history belongs here; GitRemotePanel/cloud-sync management belongs to platform/settings |
| WS-099, WS-114–122 full owner ShareDialog | Workspace owns the complete create/edit/reset/revoke form and lifecycle/custom-expiry/copy/error states; settings owns ShareManagement listing/entry; public owns anonymous reader/editor |
| WS-100 cloud-sync drawer | Host and visibility recorded here; Git panel internals owned by platform/settings |
| WS-097 account menu | Settings entry only; settings interior owned by platform/settings. Trash page, purge confirmation, rename, receipt recovery and results belong here as WS-107–112 |
| WS-101 create linked task, WS-123 reminder host | Workspace bridges/global positioning/navigation guards recorded; completed ToDoo card interior and task schema remain baseline scope |
| WS-023 directory tree selector | Canonical shared visual; settings ST-015 references it. Host-specific allowed directories/root choices/guards stay with each host |
| WS-045 find/replace | Canonical shared widget; public PB-026/PB-027 reference it with guest grant/readOnly host context |
| WS-103 mounted Git decoration | Shared tree widget/state; settings Git management references it, without a new action or duplicate feature |
| WS-124 exported reading/print document | App-owned document included; OS/browser native print dialog explicitly excluded |

## Additional canonical surfaces and constraints

- **Trash WS-107–112:** actual `/?view=trash` page, frozen-scope permanent-file confirmation with exact typed “永久移除”, inline restore rename, loading/empty/unreadable/list errors, account-scoped pending request recovery and per-item results/retry. Folder restore preserves identity and supports rename; folder purge is unavailable. Selection/page operations lock while busy, pending or confirmation open. Purge uses owner-scoped 30-minute snapshot and immutable requestId; it removes selected trash source leaves while retaining history/backups/metadata under their own retention policies.
- **Breadcrumb WS-113:** the concrete NPopover lists all ancestors, closes on path change, focuses first entry and restores trigger on Escape. Deep paths and narrow single-level paths use the popup; it inherits workspace leave/draft/history guards.
- **Share WS-099, WS-114–122:** authoritative form fields are public URL, view/edit permission, 1h/1d/7d/30d/custom/permanent duration, future local expiration and diagram-original opt-in. Private/active/expired/revoked grants each have explicit variants. Unsupported diagram/large/long-line public editing is disabled and explained; edit permission help preserves attachment/whiteboard limits. Reset/revoke are direct actions. Busy disables fields/action buttons, but this component does not explicitly block default modal dismissal; copy has success/manual-selection fallback. Shared URLs are access capabilities, never fixture secrets.
- **Reminder host WS-123:** global teleported placement, missed-summary visibility outside ToDoo, notification-link consumption and retained-note/history navigation guards are platform integration coverage. Existing ToDoo card interior behavior reuses the completed baseline.
- **Export/print document WS-124:** actual standalone script-free HTML contains current authorized note snapshot, escaped properties, static math and embedded approved images; primary diagrams require coherent saved preview proof. Screen main max820px/padding44px24px80px, images fit width; print CSS uses11pt and removes main padding. Missing images/invalid bindings reject export via existing editor errors. Native print dialog/settings are outside app coverage.
- **Shared widget boundaries:** WS-023 owns DirectoryTreeSelect visual, ST-015 keeps host-specific policies; WS-045 owns shared find/replace, PB-026/PB-027 retain guest pages/permissions. Owner rich-editor feature flag is not imposed on guest host. WS-103 includes mounted Git fileDecoration states: conflicts, removed, modified/type-changed, renamed/copied, staged new/untracked and highest-priority folder aggregate; clean entries have no badge.

## Verification performed

- Parsed inventory JSON and checked required surface/field/action keys,124 unique IDs, valid parent references, allowed kinds and exact target-width arrays.
- Verified all `103` referenced source paths and source line bounds, and all `102` referenced test paths exist. Test files were inspected as source evidence, including editor recovery/control/secondary-menu, diagram chrome/portability/mindmap, graph, unified-history, trash, breadcrumb, share options, Git decorations and reading-export scenarios. Tests were not run.
- Product files were not edited; only `coverage/workspace.json` and this review file are owned by this task.

The remaining blockers for design signoff are runtime capture/reconciliation and the root task's exact image-model access check. All GPT Image2 designs and reviews must finish before product implementation. This inventory neither substitutes another image model nor authorizes beginning product code.
