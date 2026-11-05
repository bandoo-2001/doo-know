# Independent source inventory review

**Original review of the 257-record snapshot.** The three initial inventories contain 257 records against 933d63d. The baseline manifest supplied for this review contains 54 captures of 27 named fixtures at 390 and 1440 CSS pixels. It supplies no 320-pixel capture or exhaustive overlay coverage. Counts refer to the snapshot before reconciliation. The findings below can be closed individually against subsequent inventory revisions.

**Source verdict at review:** changes required. **Design gate:** pending exact GPT Image 2 access, generation and visual review. No configured API key was available to the coordinating task, and the built-in generation route did not establish the model identity. Neither inventory records nor baseline screenshots satisfy this gate. This review inspected source and manifest metadata only.

| Finding | Evidence from repository root | Reconciliation required |
| --- | --- | --- |
| Missing owner trash page, operations and window | `apps/web/navigation.ts:118`, `apps/web/components/Workspace.vue:3488`, `apps/web/components/TrashWorkspace.vue:149,303–382,423–493,510–565,610–669` | Add the direct route, list/availability/paging/selection, original-location rename constraints, file/folder restore, partial failure and request reconciliation. Record the separately focusable permanent-file purge confirmation. UI requires the Chinese phrase 永久移除 and submits a snapshot plus protocol literal PERMANENTLY_DELETE. Folder purge is unavailable. |
| Owner sharing form fell between owners | WS-099 handed the interior to the sharing inventory, whose review allocated it back to workspace. `apps/web/components/ShareDialog.vue:18–91,112–190`, `Workspace.vue:1543–1584` | Give the owner form to workspace, editable/view-only and diagram-original capabilities, private/active/expired/revoked variants, expiry choices and future local datetime validation, clipboard fallback and create/update/reset/revoke. Settings owns aggregate management. PB owns guest consumption. |
| Missing complete-path popup | `apps/web/components/DocumentBreadcrumb.vue:23–39,55–95`, `Workspace.vue:3057`, `DiagramDocumentWorkspace.vue:601` | Register a single shared popup in normal-note and primary-diagram headers with folder navigation, keyboard focus and Escape. |
| Missing global reminder host outside ToDoo | `apps/web/components/Workspace.vue:3578–3582`, `apps/web/components/to-doo/ToDooReminderCards.vue:97–101,129–133,171–203,244–249` | Record host, reminder-link consumption, missed summary and navigation into the completed ToDoo area. Reuse the completed interior reference. |
| Missing standalone reading output | `apps/web/components/Workspace.vue:181–201`, `DiagramDocumentWorkspace.vue:466–488`, `apps/web/reading-export.ts:226–259` | Model app-authored HTML shared by download and print, fallback for stale previews and popup-blocked feedback. Print dialog chrome is browser-owned. |
| Git contribution missed in tree | `apps/web/components/TreeBranch.vue:50–58`, `plugins/git/web/index.ts:185–202`, `plugins/git/web/decoration.ts:4–27` | Record enabled plugin file/folder status markers including conflict, delete, modify, rename/copy, staged/untracked creation, neutral fallback and highest-priority nested change. This is a state of the tree. |
| Shared guest editor windows assigned owner-only roles | `apps/web/components/PublicShareEditor.vue:175–208,224–245`, `NoteEditorHost.vue:266–276,449–475`, `DiagramPreview.vue:42–43,127,299–339` | Cross-reference guest Ctrl/Cmd-F/H find/replace in both editor modes and guest-reachable document context tools. Map preview/expand and board source/download capability separately from owner edit/generate and upload actions. No guest slash-insert listener is wired here. |
| Owner vs public rich-mode availability differs | `apps/web/components/Workspace.vue:318–321,3184–3190`, `apps/web/editor/compatibility.ts:2–20`, `PublicShareEditor.vue:20,224–243`, `NoteEditorHost.vue:161–170`, `apps/web/editor/source-codec.ts:156–166` | Owner rich mode is gated by VITE_DOCUMENT_EDITOR_ENABLED=1. Public editor initializes document mode and shares parser eligibility with enabled=true. Trace the real guest fallback independently for syntax, size, units and depth. |
| Ambiguous or redundant fields and image ownership | WS-023 and ST-015 point to the same `apps/web/components/DirectoryTreeSelect.vue:118–144`. PB-026/PB-027 mark draft required. `PublicShareEditor.vue:35–43,92–115`, `packages/core/notes.ts:366–373`, `packages/core/errors.ts:10–14` | Use a shared directory-popup design reference with host variants. Preserve required API content property but permit an empty string in the editor. WS-022/PB-014 legitimately reuse SetupImport in different outer contexts. |
| Direct preview HTML and compact menu conditions | `apps/server/blog/routes.ts:151–167`, `apps/web/components/WorkspaceMainMenu.vue:35–38` | Map authenticated GET /api/blog/design/preview to PB-046 and distinguish POST preview JSON. WS-098 compact mode also covers short landscape, portrait tablet and coarse-pointer portrait queries. |

## Scope and remaining evidence

App.vue:317–396 dispatches public sharing, bootstrap errors, OAuth, login, workspace, setup and reauthentication. navigation.ts:69–135 decodes owner views and aliases. Public blog route handlers in apps/server/blog/routes.ts:195–341 include a trailing-slash redirect, two reserved indices, legacy index/slug precedence, canonical and legacy collection-detail paths, about and archives. RSS, sitemap, JS and media are payload endpoints. PB-060 must retain transport-error semantics until a real rendered error surface is demonstrated. Public query parameter pageSize is not an input control. Blog owner title/summary UI limits at BlogWorkspace.vue:592–598 differ from the persistence limits already documented. Graph saved view names accept 100 characters in GraphWorkspace.vue:1252 and persist at maximum 80 in packages/core/graph/knowledge-state.ts:234.

The initial window scan lists 63 matching source lines and the route scan lists 17. These aid discovery but omit dynamic roles, native dialog.showModal(), imperative print windows, CSS-disclosed selectors, registered contributions and package-generated UI. The five dormant settings/plugin records and the setup owner-required branch need separate reachability classifications; component registration and template existence alone do not establish a live fixture. No new role, password gate, registration route or Git history mount was established by this review.

The Excalidraw adapter rejects embeddables and disables native loadScene, saveToActiveFile, export and saveAsImage in apps/web/whiteboards/canvas.ts:63–70. Enumerate the remaining reachable main/tool/selection/context panels and nested windows against the installed package in a running isolated fixture. Record trigger, selection state, actual caption, viewport and capability restrictions. Exercise owner builds with the rich flag enabled and disabled, then compare the guest document/source host and degraded resources. Primary captures, source-only role assignments and this audit leave those checks open.

## Recheck of the reconciled source inventory

The reconciled registers contain 124 workspace, 91 settings/plugin and 60 public/blog records. They comprise 51 page presentations, 55 dialogs, 10 drawers, 24 popovers and 135 states. A source-reference check found all 275 IDs unique, all parent references valid and every cited source path and line in range. Of the 275 records, 269 request separate design images. Five dormant records and the settings use of the canonical directory selector account for the other six.

| Initial finding | Reconciled records |
| --- | --- |
| Trash page, confirmation, rename, result and recovery | WS-107–112 |
| Complete owner share form and lifecycle states | WS-099, WS-114–122 |
| Ancestor path popover in both headers | WS-113 |
| Global reminder host, consumed links and missed summary | WS-123 with ToDoo interior ownership retained |
| Downloaded and printed app-authored HTML | WS-124 |
| Git file and folder status markers | WS-103 |
| Guest editor search, contextual windows and board capability | WS-045, PB-022, PB-026 and PB-027, with the shared WS-034–041 interiors |
| Independent owner rich-mode flag and guest eligibility | WS-105, PB-026 and PB-027 |
| Shared selector ownership and guest blank Markdown payload | WS-023 is canonical, ST-015 links to it, PB-026/027 distinguish property presence from nonempty input |
| Private direct preview GET and compact menu conditions | PB-046 and WS-098 |

**Final source verdict.** The ten findings from the initial review are closed for the examined application-owned source. The shared search action guards now cover both owner and guest hosts. This verdict covers the registered source surfaces and their documented limits.

Runtime enumeration of package-rendered Excalidraw windows, feature-switch variants and responsive states remains a separate acceptance step. The exact GPT Image 2 generation and review gate is pending. This recheck did not run the application, invoke tests or inspect images.
