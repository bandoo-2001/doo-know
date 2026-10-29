# Public Blog UI Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. This user has authorized direct execution and deployment.

**Goal:** Deliver and deploy a polished public homepage and reader on desktop and mobile.
**Architecture:** SSR render.ts and inline stylesheet remain the shared public/preview implementation. Existing reader.js provides progressive enhancements only. Work in production-based isolated candidate.
**Tech Stack:** TypeScript, Fastify, native HTML/CSS/JS, Vitest, Playwright.
**Spec:** ../specs/2026-10-30-blog-public-ui-design.md.

## Global Constraints

No new dependencies or production data/settings/plugin changes. Preserve all three templates, module order, safe escaping, published-only recommendations, source HTML, SEO/CSP, and no-JS navigation. Same renderer for preview and public pages. Scope only candidate blog rendering and tests/docs. Keep light/dark palette; mobile 44px controls, no page overflow.

## Review Focus

- Unusually long names/titles/URLs and missing media remain readable at 320px.
- No-heading and short readers have no broken progress or useless TOC.
- Reordered/disabled modules and empty collections retain meaningful layout.
- Preview script-disabled sandbox remains readable and accurate.
- Withdrawn snapshots stay inaccessible; no production site enabling.

### Task 1: Render and reader enhancements

Files: apps/server/blog/render.ts, reader-script.ts, tests/blog-reader.test.ts; add focused reader-script tests if meaningful. Interfaces retain all current exports and signatures, post-card/reader/layout class hooks; coordinate new hooks with CSS worker.
- [ ] Pin new semantic reading behavior with meaningful tests and run failing assertions.
- [ ] Implement common chrome/home hierarchy, reader headings/metadata/breadcrumb/progress/TOC hooks and native top link; progressive script supports active TOC/progress and preserves copy/share.
- [ ] Run reader/render unit tests, report changes/commands and risks.

### Task 2: Coherent responsive styles

File: apps/server/blog/styles.ts only. Consume current CSS hooks and Task 1 additions; no renderer changes.
- [ ] Consolidate stylesheet, strengthen three home layouts and reader typography/spacing/TOC/navigation.
- [ ] Cover 320px through 1440px, dark, serif/wide/bordered, reduced motion, long content and compact empties.
- [ ] Validate via root-owned compiled browser run and address defects.

### Task 3: Integrate, validate, review

Files: tests/e2e/blog-public-redesign.spec.ts, docs/design/blog/public-*.png, docs/验收记录/2026-10-30-blog-public-ui.md.
- [ ] Add actual rendered anonymous scenarios for three themes, long content, keyboard, no-JS and mobile geometry.
- [ ] Candidate typecheck/build, scoped unit and desktop/mobile browser regression suites.
- [ ] Independent reviewer checks diff/spec/quality; fix genuine issues and rerun affected checks.
- [ ] Freeze clean source commit and package immutable rc.54 candidate after checking current formal version.

### Task 4: Release

- [ ] Strict artifact/runtime validation and real-data-copy public reader preflight.
- [ ] Encrypted production backup plus actual restore verification; guarded native update.
- [ ] Verify local/public health/assets and preserved production data/settings/plugins; record source ref and deployment evidence.
