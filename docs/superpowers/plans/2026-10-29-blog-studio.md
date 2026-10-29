# Blog Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Deliver all four accepted blog improvements, including a working customizable homepage, reader discovery and publication review.

**Architecture:** Keep the existing Vue workbench and SSR reader. Add isolated studio persistence and shared contracts; split core/API, public renderer, workbench and integration ownership so independent changes can run concurrently.

**Tech Stack:** Vue 3, TypeScript, Fastify, SQLite, Vitest, Playwright.

**Spec:** docs/superpowers/specs/2026-10-29-blog-studio-design.md

## Global Constraints

- User explicitly authorized direct comprehensive implementation without more approval questions.
- Preserve all pre-existing uncommitted changes; do not commit unrelated work, publish, deploy or operate production data.
- Keep manual publication and snapshot isolation; public content must be limited to currently published content.
- No new runtime dependency; existing auth/CSRF and blog:read/manage/publish boundaries apply.
- Shared names and JSON shapes are defined in shared/blog-design.ts.
- Design media: PNG/JPEG/WebP, maximum 5 MiB each, maximum 20 MiB referenced per design; design arrays must have explicit bounded validation.

## Review Focus

- Draft media URL guessed by an anonymous caller must not expose private assets.
- An article withdrawn after design publication disappears from collections and reader recommendations.
- Stale saves, retries and changed authorization must not overwrite new drafts or broaden permission.
- Restore/export/reopen must keep design and media while keeping the restored site disabled.
- User edits while requests are pending must survive responses; desktop/mobile preview must use the public renderer.

### Task 1: Core studio, public queries and management API

**Files:** packages/core/blog/{schema,service,studio}.ts, apps/server/blog/studio-routes.ts, tests/blog-studio.test.ts. Core agent owns these; do not edit routes.ts, portable.ts, publication.ts or shared contracts without coordination.

**Interfaces:** Flat BlogService methods: designState(p), saveDesign(p,{design,expectedVersion,requestId}), publishDesign(p,{expectedVersion,requestId}), restoreDesign(p,{revision,expectedVersion,requestId}), publicDesign(), previewDesign(p,design?), uploadDesignMedia(p,{name,mime,base64,requestId}), designMedia(p,hash), publicDesignMedia(hash), publicPostPage(query), previewPostPage(p,query), publicTaxonomy(), publicationReview(p,id). Types come from shared/blog-design.ts. Review helper will be supplied by coordinator; reserve hook.

- [x] Write and run failing tests for draft isolation, stale/replayed requests, media exposure, safe URLs, disabled public routes, publication-only search/pagination, withdrawn collection articles.
- [x] Implement bounded strict validation, transactional versioned draft/publish/history (retain 10 revisions), media persistence with signature checks, and metadata-only paged public queries. Store all public images in SQLite.
- [x] Register authenticated /api/blog/design GET/PATCH, /publish POST, /restore POST; media POST with 8 MiB body limit and private media GET; GET /api/blog/posts/:id/review. Public media and preview routes are public renderer agent ownership. Preview POST must return {html:string} from public renderer agent.
- [x] Run task tests and relevant old core/security tests, report evidence and decisions. Do not commit because shared worktree contains unrelated user changes.

### Task 2: Public site renderer and reader experience

**Files:** apps/server/blog/{routes,styles,render,reader-script}.ts, tests/blog-reader.test.ts. Renderer agent owns these.

**Interfaces:** Consume core flat methods above; registerBlogStudioRoutes(app,config,getBlog) from studio-routes.ts. GET /api/blog/design/preview renders saved draft; POST same URL accepts {design} and returns {html}; authenticated requests use principal matching existing routes. Core normalizes via previewDesign(p,design). previewPostPage works when site disabled and only returns published rows. New routes /blog/articles, /blog/collections, /blog/collections/:slug, /blog/media/:hash, /blog/reader.js. Public summaries have id, slug/title/category/tags/cover/dates/url but no html. All values escaped; only sanitized published body is HTML.

- [x] Write and run failing HTTP tests for three theme layouts, draft preview isolation, collection filtering/order, search/page traversal and share metadata.
- [x] Split reusable pure rendering into render.ts and render full themed homepage/modules plus common chrome. Existing category/tag query URLs remain useful.
- [x] Implement list discovery, safe Markdown about, collection navigation, related/adjacent articles, reading time, code copy and share controls, accessible sticky TOC and OG image/JSON-LD escaping. JS must use self-hosted script under scoped CSP, no inline event handlers.
- [x] Verify relevant reader/security tests; avoid public caches that break immediate withdrawal. Provide screenshots via root browser verification later.

### Task 3: Workbench studio and publication experience

**Files:** apps/web/blog-workbench.ts, apps/web/components/BlogWorkspace.vue, apps/web/components/blog/*, apps/web/blog.css, tests/blog-studio-workbench.test.ts. Frontend agent owns these, preserving pre-existing blog.css changes.

**Interfaces:** API from Task 1. Preview POST /api/blog/design/preview => {html}; put HTML in sandboxed iframe. Media POST /api/blog/design/media => BlogDesignMedia. Existing note attachments GET/POST /api/notes/:id/assets accept multipart and return markdownPath; use api() for CSRF. Review GET /api/blog/posts/:id/review => BlogPublicationReview.

- [x] Write/run failing workbench tests for stale responses, local edits during save, preview generation and error handling.
- [x] Add 装修主页 section without breaking navigation; focused child components for theme/profile/links/modules/collections/projects and preview. Support add/remove/reorder/hide/count, published article selector and order, draft/publish/history restore, all loading/error states and mobile layout.
- [x] Add cover attachment selection/upload/crop (canvas, JPEG/PNG/WebP), first-publication slug editor, online/draft comparison and actionable diagnostics with source jump.
- [x] Run workbench tests and type checks; report actual remaining integration needs. Do not run full shared browser server while others edit.

### Task 4: Publication diagnostics, portability, MCP and final integration

**Files:** packages/core/blog/{review,portable}.ts, shared/mcp-blog-tools.ts, apps/server/blog/mcp-tools.ts, plugins/mcp/server/blog-tools.ts, docs/mcp-blog-coverage.md, tests/blog-studio-{review,portable,integration}.test.ts, tests/e2e/blog-studio.spec.ts. Coordinator owns these and docs.

**Interfaces:** publicationReview helper takes config/db/notes/p/id and authorized snapshot callbacks; coordinate exact helper with core agent. Persist studio rows and media in apps/blog alongside existing portable state; restore to private state. Match existing bounded MCP adapter conventions with blog scopes.

- [x] Write/run failing diagnostics and portable roundtrip tests including private links and restored media.
- [x] Implement review through existing Markdown/reference parsing and permission checks; extend portable serialization and MCP for new functionality with explicit scopes and bounded payloads.
- [x] Run consolidated typecheck, build, blog/MCP/portable unit suite and existing-plus-new desktop/mobile E2E against isolated fixture.
- [x] Dispatch independent code review for changed product/security/persistence paths, resolve material findings and rerun affected checks.
- [x] Record exact verification and screenshot paths in docs/验收记录/2026-10-29-blog-studio.md; final report code completion and deployment state accurately.
