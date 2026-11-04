# ToDoo card and guidance polish

**Goal:** Address the three screenshot review requests: customizable artistic anniversary cards, a bottom anchored focus timer, and persistent dismissal of explanatory alerts.

**Architecture:** Keep the existing Vue/Ant Design controls and server entity storage. Anniversary appearance is optional structured entity data so older records remain valid; new/edit forms show a live preview. A shared hint component owns account scoped browser persistence. Focus layout fills its existing container before applying sticky positioning.

**Choices:** Four CSS drawn themes (花间、远山、星轨、留白) and five curated palettes are the initial implementation choice; no new image dependency. Appearance saves with the anniversary and follows its existing sync/export behavior. Dismissal is per explanatory hint, with separate keys for create/edit contexts; dynamic validation, errors and operational state remain visible.

## Tasks

- [x] Anniversary: verify appearance survives schema validation and create/edit saving; add appearance controls and preview; preserve lunar dates, details, mobile widths and dark mode.
- [x] Focus: reproduce the short content gap; fill the container; check short and overflowing content, desktop and mobile navigation clearance.
- [x] Guidance: introduce a dismissible Alert wrapper with safe persistent storage; migrate explanatory banners; test reload/remount and independent hints.
- [x] Verify relevant unit and browser suites, typecheck and build. Review integration and capture updated desktop/mobile evidence with a Tailscale preview link.

**Review focus:** Existing anniversaries without appearance; separately styled cards; unsaved editor changes; restricted/unavailable storage; small screens and dark themes; timer overlap with long content; explanatory hints versus transient errors.
