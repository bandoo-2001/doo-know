# Diagram runtime enumeration

Observed the packaged Excalidraw 0.18.1 inside the existing isolated fixture at `http://127.0.0.1:4479`, from source `933d63d942b6499fee964f8a060c7b22b9d299d1`. The guarded `/tmp/dooknow-browser-*` data and knowledge roots share a parent. Existing cookies stayed internal; only the fixture authentication rate-limit table was reset using the browser harness guards.

Created one uniquely named empty whiteboard through **创建与导入 → 新建白板 → 文件名 → 创建**. Its saved native scene still has **0 elements**, and its final status was **已保存**. No product code, dependencies, services, real data, external publication, clipboard contents or OS file pickers were changed or used. Clear-canvas confirmation and Mermaid insertion were dismissed without confirmation/insertion.

The [runtime inventory](../coverage/runtime-diagrams.json) records **25 observed surface families: 6 existing app surfaces plus 19 vendor internal families**, with actual labels, role/count evidence and source references. The **55 PNG/JSON evidence pairs** are under [baseline/diagrams](../baseline/diagrams/). All PNG hashes were read back and verified. The three captures that did not reveal their intended window are explicitly marked `attempt-no-visible-window`; they do not add surfaces. No browser page errors were observed.

| Actual app surface | Existing ID | Runtime widths |
| --- | --- | --- |
| New whiteboard file dialog | WS-013 | 1440 |
| Whiteboard document/canvas shell | WS-068 | 1440, 390; representative 320 |
| Markdown source | WS-072 | 1440, 390 |
| Saved PNG preview | WS-073 | 1440, 390 |
| Reading projection | WS-074 | 1440, 390 |
| More actions: complete document, Markdown, original | WS-075 | 1440, 390; representative 320 |

Actual vendor windows/panels opened: main menu; canvas-background popup; Find sidebar; help; clear-canvas confirmation; extra tools; Mermaid insertion; library empty panel and its local Open menu; empty-canvas context menu; canvas statistics; rectangle properties/mobile Edit sheet; stroke and fill color pickers; arrow properties; start and end arrowhead pickers (including desktop expanded end options); text properties; font search. These are subordinate runtime records under **WS-068**, not invented canonical app IDs. Rectangle, arrow and text tools were selected without drawing.

The most material finding is the **390px sidebar placement**. Both Find and Library mount at `x=-295, width=295`; their Close button is `x=-43, width=31.5`. Find's textbox is `x=-248.5, width=226.5`. A normal Close click fails because it is outside the viewport; the on-screen library trigger can close the sidebar. These captures are `opened-but-content-offscreen`, not visible mobile coverage. Outer document overflow remains zero, so an overflow-only check misses this. See [Find evidence](../baseline/diagrams/390-vendor-find-sidebar.json) and [Library evidence](../baseline/diagrams/390-vendor-library-panel.json). The generic narrow `.sidebar` transform in `apps/web/style.css:1083` is a plausible collision with the vendor's shared class, but this pass did not verify computed-style causation or change CSS.

Two advertised actions did not reveal windows: help lists Command palette, but both `Ctrl+/` and `Ctrl+Shift+P` after canvas focus produced no palette DOM; the 390px **Canvas & Shape properties** context action produced no statistics panel. Desktop statistics did show **Shapes 0**. Both remain explicit gaps with actual unchanged-canvas evidence.

The vendor's native load, active-file save, JSON export and image-export windows are unavailable in this integration: `apps/web/whiteboards/canvas.ts:64` disables all four actions, and they are absent from the actual menu. App-owned HTML/PNG/download controls remain visible in the document header/menu; this pass enumerated their controls and source guards, without executing downloads. External vendor/help/library links were enumerated only. Empty-library **打开** and image insertion would invoke OS pickers and were not followed. The unnamed main-menu trigger, unnamed sidebar tabs and unnamed property radios are preserved as actual accessibility evidence.

At 320px, representative canvas controls, main menu, help and app more-actions were opened with zero outer overflow; the help dialog measured `320 × 844`. This is not complete responsive or touch-device verification. The 390px context-menu capture uses a mouse right-click at a narrow viewport.

Mind-map/flowchart editors and their controls, embedded diagram overlays, inline presentation/source windows, populated-library and selected-element operations, recovery/error/readonly/conflict states, and nonempty-content fit remain outside this empty-whiteboard pass. Their existing WS records remain source references. No redesign, test run, commit or server restart was performed.
