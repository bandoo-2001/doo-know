export const publicBlogStyles = `
:root {
  color-scheme: light;
  --ink: #24312d;
  --muted: #65716b;
  --paper: #fbfaf6;
  --accent: var(--brand-accent, #44684f);
  --line: #dce2d9;
  --surface: #edf1e9;
  --code: #edf0e9;
  --border: #d3dccf;
  --content-width: 1120px;
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    color-scheme: dark;
    --ink: #e5ece5;
    --muted: #afbcaf;
    --paper: #151d19;
    --accent: color-mix(in srgb, var(--brand-accent, #44684f), white 38%);
    --line: #35473a;
    --surface: #24352b;
    --code: #202d25;
    --border: #455a49;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { scroll-behavior: smooth; scroll-padding-top: 28px; }
html[data-width="wide"] { --content-width: 1280px; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 17px/1.8 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
  -webkit-text-size-adjust: 100%;
}
html[data-font="serif"] body { font-family: Georgia, "Noto Serif SC", "Songti SC", serif; }
.site-header, main, .site-footer {
  width: 100%;
  max-width: var(--content-width);
  margin-inline: auto;
  padding-inline: 40px;
  min-width: 0;
}
.site-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px 48px;
  padding-block: 28px;
  border-bottom: 1px solid var(--line);
}
.site-identity { min-width: 0; flex: 1; }
.site-header a { color: var(--ink); text-decoration: none; }
.brand {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  min-width: 0;
  max-width: 100%;
  font-size: 21px;
  font-weight: 750;
  line-height: 1.4;
  letter-spacing: -.04em;
}
.site-nav { justify-content: flex-end; flex-shrink: 0; max-width: 65%; }
nav { display: flex; flex-wrap: wrap; gap: 4px 22px; font-size: 14px; min-width: 0; }
nav a { display: inline-flex; align-items: center; min-height: 44px; max-width: 100%; }
.site-nav a { border-bottom: 2px solid transparent; }
.site-nav a[aria-current] { color: var(--accent); border-bottom-color: var(--accent); }
main { min-height: 60vh; padding-block: 56px 88px; }
main:focus { outline: none; }
h1, h2, h3, h4, h5, h6 { line-height: 1.35; letter-spacing: -.035em; text-wrap: pretty; }
h1 { margin: 0 0 24px; font-size: clamp(2rem, 4vw, 3rem); }
h2 { font-size: 26px; }
a { color: var(--accent); text-underline-offset: 4px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, button:focus-visible, input:focus-visible, summary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
  border-radius: 3px;
}
button, input { font: inherit; }
button {
  min-height: 44px;
  max-width: 100%;
  padding: 9px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink);
  line-height: 1.5;
  cursor: pointer;
  overflow-wrap: anywhere;
}
button:hover { border-color: var(--accent); }
.skip-link {
  position: absolute;
  z-index: 5;
  top: 12px;
  left: 16px;
  min-height: 44px;
  padding: 8px 16px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  transform: translateY(-200%);
}
.skip-link:focus { transform: none; }
.muted, time, .filter-status { color: var(--muted); font-size: 14px; }
.summary { color: var(--muted); }
.eyebrow { margin: 0 0 12px; color: var(--accent); font-size: 12px; font-weight: 650; letter-spacing: .1em; line-height: 1.6; }
.site-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 20px 40px; padding-block: 28px 40px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
.footer-identity { min-width: 0; max-width: 45ch; }
.footer-identity p { margin: 0; }
.site-description { margin: 6px 0 0; font-size: 13px; color: var(--muted); }
.footer-links { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 24px; }
.site-footer nav { font-size: inherit; }
.site-footer a { display: inline-flex; align-items: center; min-height: 44px; }
.home-module { min-width: 0; margin-bottom: 64px; }
.journal-stream > .home-module:last-child,
.magazine-layout > .home-module:last-child,
.profile-layout > :last-child > .home-module { margin-bottom: 0; }
.module-heading { display: flex; align-items: center; gap: 20px; margin-bottom: 26px; }
.module-title { display: flex; flex: 1; align-items: center; gap: 18px; margin: 0 0 26px; font-size: 14px; font-weight: 650; letter-spacing: .08em; line-height: 1.6; }
.module-heading .module-title { margin-bottom: 0; }
.module-title::after { content: ''; flex: 1; min-width: 24px; height: 1px; background: var(--line); }
.module-footer { margin: 24px 0 0; }
.text-link, .intro-actions a { display: inline-flex; align-items: center; min-height: 44px; font-size: 14px; font-weight: 600; }
.identity { display: flex; align-items: flex-start; gap: 28px; }
.identity > div { min-width: 0; }
.identity h1 { margin: 0 0 20px; font-size: clamp(2.3rem, 5vw, 3.5rem); line-height: 1.2; }
.identity .eyebrow { margin-bottom: 18px; font-size: 13px; }
.profile-bio { max-width: 56ch; margin: 0 0 20px; color: var(--muted); white-space: pre-line; }
.avatar { width: 88px; height: 88px; flex: 0 0 88px; object-fit: cover; border-radius: 50%; }
.profile-cover { display: block; width: 100%; max-height: 300px; object-fit: cover; aspect-ratio: 3 / 1; margin-bottom: 32px; border-radius: 8px; }
.intro-actions { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 18px; }
.post-grid, .card-copy, .post-card { min-width: 0; }
.post-card { padding: 28px 0; border-bottom: 1px solid var(--line); }
.post-card h2 { margin: 10px 0 12px; font-size: 24px; line-height: 1.45; }
.post-card h2 a { display: block; min-height: 44px; text-decoration: none; }
.post-card h2 a:hover { text-decoration: underline; }
.post-card .summary { margin: 0; font-size: 15px; line-height: 1.85; }
.card-meta, .card-meta time { color: var(--muted); font-size: 12px; line-height: 1.8; }
.pinned { display: inline-block; margin-right: 12px; color: var(--accent); font-size: 12px; font-weight: 600; }
.card-cover-link { display: block; min-width: 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
.cover { display: block; width: 100%; max-height: 460px; object-fit: cover; margin-bottom: 32px; }
.post-card .cover { aspect-ratio: 3 / 2; margin-bottom: 22px; }
html[data-cards="bordered"] .post-card { padding: 24px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 18px; }
.collection-grid, .project-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.collection-card, .project-card { min-width: 0; padding: 26px; border: 1px solid var(--line); border-radius: 8px; }
.collection-card h2, .project-card h3 { margin: 4px 0 10px; font-size: 21px; }
.collection-card h2 a, .project-card h3 a { display: block; min-height: 44px; text-decoration: none; }
.collection-card h2 a:hover, .project-card h3 a:hover { text-decoration: underline; }
.collection-card p, .project-card p { margin: 0; font-size: 14px; }
.collection-card .eyebrow { margin-bottom: 12px; font-size: 11px; }
.friend-links { display: flex; flex-wrap: wrap; gap: 4px 28px; margin: 0; padding: 0; list-style: none; }
.friend-links li { min-width: 0; max-width: 100%; }
.friend-links a { display: inline-flex; align-items: center; min-height: 44px; }
.empty-state { grid-column: 1 / -1; margin: 0; padding: 22px 24px; border: 1px dashed var(--border); border-radius: 8px; }
.empty-state h2 { margin: 0 0 12px; font-size: 22px; }
.empty-state p { margin: 0; color: var(--muted); }
.empty-state p + a { display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; }
.collection-grid > .muted, .project-grid > .muted { grid-column: 1 / -1; margin: 0; }
.home-journal { max-width: 840px; margin-inline: auto; }
.home-journal .module-intro { padding-block: 12px 24px; }
.home-journal .post-card, .article-index .post-card { display: flex; flex-direction: row-reverse; align-items: center; gap: 32px; }
.home-journal .card-copy, .article-index .card-copy { flex: 1; }
.home-journal .card-cover-link, .article-index .card-cover-link { width: 176px; flex: 0 0 176px; }
.home-journal .post-card .cover, .article-index .cover { height: 132px; margin: 0; }
.home-journal .post-card-featured { padding-block: 30px; }
.home-journal .post-card-featured h2 { font-size: 29px; }
.home-magazine .magazine-masthead { margin-bottom: 46px; padding: 4px 0 32px; border-bottom: 3px solid var(--ink); }
.display-title { margin: 8px 0 0; font-family: Georgia, "Songti SC", serif; font-size: clamp(3rem, 7vw, 6rem); line-height: 1.08; letter-spacing: -.065em; }
.magazine-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 36px; }
.magazine-layout .module-intro, .magazine-layout .module-featured, .magazine-layout .module-latest { grid-column: 1 / -1; }
.home-magazine .identity h1 { font-size: 2rem; }
.home-magazine .profile-bio { max-width: 72ch; }
.home-magazine .post-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; align-items: start; }
.home-magazine .post-card { padding-top: 18px; border-top: 1px solid var(--line); border-bottom: 0; }
.home-magazine .post-card h2 { font-size: 22px; }
.home-magazine .post-card-featured { grid-column: span 2; }
.home-magazine .post-card-featured h2 { font-size: clamp(1.7rem, 3vw, 2.2rem); }
.home-magazine .post-card-featured .cover { aspect-ratio: 16 / 9; }
.home-magazine .collection-grid, .home-magazine .project-grid { grid-template-columns: minmax(0, 1fr); }
html[data-cards="bordered"] .home-magazine .post-card { margin-bottom: 0; }
.profile-layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 0 56px; }
.profile-sidebar { grid-column: 1; grid-row: span 7; align-self: start; position: sticky; top: 28px; }
.profile-sidebar .identity { flex-direction: column; gap: 24px; }
.profile-sidebar .identity h1 { font-size: 2.5rem; }
.profile-sidebar .module-title { font-size: 12px; }
.profile-sidebar .avatar { width: 104px; height: 104px; flex-basis: 104px; }
.profile-sidebar .profile-cover { max-height: 140px; aspect-ratio: 16 / 9; }
.profile-sidebar nav { gap: 0 18px; }
.profile-sidebar .profile-bio { font-size: 15px; }
.profile-sidebar .intro-actions { margin-top: 14px; }
.profile-section { grid-column: 2; min-width: 0; }
.home-profile.no-intro .profile-layout { display: block; max-width: 840px; margin-inline: auto; }
.home-profile .module-featured .post-grid { padding: 4px 24px; border-radius: 10px; background: var(--surface); }
.home-profile .post-card h2 { font-size: 23px; }
.home-profile .post-card .cover { max-height: 300px; aspect-ratio: 16 / 9; }
.home-profile .module-featured .post-card:last-child { border-bottom: 0; }
html[data-cards="bordered"] .home-profile .module-featured .post-grid { padding: 0; background: transparent; }
html[data-cards="bordered"] .home-profile .module-featured .post-card:last-child { border-bottom: 1px solid var(--border); }
.article-search { max-width: 760px; margin: 28px 0; }
.article-search label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 14px; }
.article-search > div { display: flex; gap: 10px; }
.article-search input[type="search"] { flex: 1; min-width: 0; min-height: 44px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 6px; background: var(--paper); color: var(--ink); }
.taxonomy { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
.chip { display: inline-flex; align-items: center; min-width: 0; min-height: 44px; max-width: 100%; padding: 8px 15px; border: 1px solid transparent; border-radius: 24px; background: var(--surface); font-size: 13px; line-height: 1.6; text-decoration: none; }
.chip[aria-current] { border-color: var(--accent); color: var(--ink); font-weight: 600; }
.pagination { align-items: center; justify-content: space-between; margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line); }
.reader-article { max-width: 100%; margin-inline: auto; }
.reader-breadcrumb { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 32px; color: var(--muted); font-size: 13px; }
.reader-breadcrumb a { display: inline-flex; align-items: center; min-height: 44px; }
.reader-header { max-width: 820px; margin-bottom: 36px; }
.reader-header h1 { margin-bottom: 24px; font-size: clamp(2.2rem, 4.6vw, 3.5rem); line-height: 1.24; letter-spacing: -.045em; }
.article-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin: 0 0 20px; color: var(--muted); font-size: 13px; }
.article-meta time { font-size: inherit; }
.article-meta a { color: inherit; }
.reader-deck { max-width: 64ch; margin: 0 0 24px; font-size: 19px; line-height: 1.85; }
.reader-header .taxonomy { margin-bottom: 0; }
.reader-article > .cover { max-height: 520px; aspect-ratio: 16 / 8; margin-bottom: 48px; }
.reader-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; min-width: 0; }
.article-body { min-width: 0; max-width: 68ch; width: 100%; font-size: 18px; line-height: 1.95; }
.reader-layout > .article-body { margin-inline: auto; }
.article-body :is(h1, h2, h3, h4, h5, h6) { margin-top: 1.9em; margin-bottom: .75em; scroll-margin-top: 28px; }
.article-body > :first-child { margin-top: 0; }
.article-body h1 { font-size: 1.8rem; }
.article-body h2 { font-size: 1.6rem; }
.article-body h3 { font-size: 1.3rem; }
.article-body :is(h4, h5, h6) { font-size: 1.1rem; }
.article-body p { margin: 1.25em 0; }
.article-body :is(ul, ol) { padding-left: 1.65em; }
.article-body li { padding-left: .2em; }
.article-body li + li { margin-top: .3em; }
.article-body img { display: block; margin: 30px 0; }
.article-body :is(video, iframe, svg) { max-width: 100%; }
code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .86em; }
:not(pre) > code { padding: 2px 6px; border-radius: 4px; background: var(--code); }
pre { max-width: 100%; margin: 28px 0; padding: 22px; border: 1px solid var(--border); border-radius: 8px; background: var(--code); overflow-x: auto; overflow-wrap: normal; font-size: 14px; line-height: 1.75; tab-size: 2; }
pre code { font-size: inherit; white-space: pre; }
.article-body pre { position: relative; padding-top: 66px; }
.copy-code { position: absolute; top: 10px; right: 10px; min-height: 44px; padding: 8px 12px; font-family: system-ui, sans-serif; font-size: 12px; }
blockquote, .markdown-alert { margin: 30px 0; padding: 4px 24px; border-left: 3px solid var(--accent); color: var(--muted); }
.article-body blockquote p { margin-block: .65em; }
table { display: block; width: 100%; max-width: 100%; overflow-x: auto; margin: 28px 0; border-collapse: collapse; font-size: 15px; line-height: 1.7; }
td, th { min-width: 10rem; padding: 12px 14px; border: 1px solid var(--border); vertical-align: top; }
th { background: var(--surface); text-align: left; }
hr { height: 1px; margin: 36px 0; border: 0; background: var(--line); }
.toc { grid-row: 1; min-width: 0; margin: 0 auto 36px; width: 100%; max-width: 68ch; padding: 14px 20px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface); }
.toc summary { min-height: 44px; padding-block: 9px; font-size: 14px; font-weight: 650; line-height: 1.8; cursor: pointer; }
.toc-links { display: block; padding-top: 8px; }
.toc-links a { display: flex; min-height: 44px; padding: 10px 0 10px 14px; border-left: 2px solid var(--border); color: var(--muted); font-size: 13px; line-height: 1.65; text-decoration: none; }
.toc-links a:hover, .toc-links a[aria-current] { border-left-color: var(--accent); color: var(--accent); }
.toc-links a[aria-current] { font-weight: 650; }
.reading-progress { position: fixed; inset: 0 0 auto; z-index: 4; width: 100%; height: 3px; border: 0; border-radius: 0; background: transparent; color: var(--accent); appearance: none; }
.reading-progress::-webkit-progress-bar { background: transparent; }
.reading-progress::-webkit-progress-value { background: var(--accent); }
.reading-progress::-moz-progress-bar { background: var(--accent); }
.reading-progress[hidden] { display: none; }
.reader-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 48px; padding: 28px 0; border-top: 1px solid var(--line); }
.reader-actions [role="status"] { color: var(--muted); font-size: 13px; }
.back-to-top { display: inline-flex; align-items: center; min-height: 44px; margin-left: auto; font-size: 14px; }
.reader-collection { margin: 24px 0; padding: 28px; border: 1px solid var(--border); border-radius: 8px; }
.reader-collection h2 { margin: 0; font-size: 21px; }
.reader-collection nav, .adjacent-posts { justify-content: space-between; gap: 12px 32px; }
.reader-collection nav a, .adjacent-posts a { flex: 1 1 220px; align-items: flex-start; padding-block: 10px; }
.adjacent-posts { margin: 28px 0; padding-block: 20px; border-block: 1px solid var(--line); }
.related-posts { margin-top: 48px; }
.related-posts > h2 { margin: 0 0 12px; font-size: 21px; }
.related-posts .post-card { padding-block: 24px; }
.related-posts .cover { max-width: 260px; aspect-ratio: 16 / 9; }
.about { white-space: normal; }
.archive-list { padding: 0; list-style: none; }
.archive-list li { display: flex; gap: 18px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.archive-list time { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.footnotes { font-size: 14px; }
.preview-banner { padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--surface); color: var(--accent); text-align: center; font-size: 12px; }
@media (min-width: 1100px) {
  .reader-layout:has(.toc) { grid-template-columns: minmax(0, 1fr) 220px; gap: 56px; }
  .reader-layout .toc { grid-column: 2; grid-row: 1; align-self: start; position: sticky; top: 28px; max-height: calc(100vh - 56px); overflow-y: auto; padding: 0 0 0 20px; border: 0; border-left: 1px solid var(--line); border-radius: 0; background: transparent; }
  .reader-layout .article-body { grid-column: 1; grid-row: 1; margin-inline: 0; }
  .toc summary { display: block; list-style: none; cursor: default; }
  .toc summary::-webkit-details-marker { display: none; }
  .toc details::details-content { content-visibility: visible; }
  .toc details > .toc-links { display: block; }
  .reader-article:has(.toc) .reader-header { max-width: 760px; }
}
@media (max-width: 900px) {
  .site-header { gap: 18px 32px; }
  .site-nav { max-width: 62%; }
  .profile-layout { grid-template-columns: 200px minmax(0, 1fr); gap: 0 36px; }
  .profile-sidebar .identity h1 { font-size: 2rem; }
  .home-profile .collection-grid, .home-profile .project-grid { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 760px) {
  .site-header, main, .site-footer { padding-inline: 24px; }
  .site-header { align-items: flex-start; flex-direction: column; gap: 12px; padding-block: 22px 16px; }
  .site-nav { justify-content: flex-start; max-width: 100%; width: 100%; gap: 4px 22px; }
  main { padding-block: 36px 64px; }
  .home-module { margin-bottom: 44px; }
  .module-heading, .module-title { margin-bottom: 22px; }
  .home-journal .module-intro { padding-block: 0 10px; }
  .profile-layout { display: block; }
  .profile-sidebar { position: static; }
  .profile-sidebar .identity { flex-direction: row; }
  .profile-sidebar .avatar { width: 80px; height: 80px; flex-basis: 80px; }
  .profile-sidebar .profile-cover { max-height: 260px; aspect-ratio: 3 / 1; }
  .profile-sidebar .profile-bio { font-size: 16px; }
  .home-profile .collection-grid, .home-profile .project-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .magazine-layout { grid-template-columns: minmax(0, 1fr); }
  .home-magazine .post-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; }
  .home-magazine .post-card-featured { grid-column: 1 / -1; }
  .home-magazine .magazine-masthead { margin-bottom: 32px; padding-bottom: 24px; }
  .home-magazine .collection-grid, .home-magazine .project-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .reader-header { margin-bottom: 30px; }
  .reader-deck { font-size: 17px; }
  .reader-breadcrumb { margin-bottom: 24px; }
  .reader-article > .cover { margin-bottom: 32px; }
  .collection-grid, .project-grid { gap: 16px; }
  .site-footer { align-items: flex-start; flex-direction: column; gap: 12px; padding-block: 24px 32px; }
}
@media (max-width: 500px) {
  .site-header, main, .site-footer { padding-inline: 20px; }
  .brand { font-size: 20px; }
  .identity { gap: 16px; }
  .identity h1 { font-size: 2.1rem; }
  .avatar, .profile-sidebar .avatar { width: 64px; height: 64px; flex-basis: 64px; }
  .profile-cover { margin-bottom: 24px; }
  .home-magazine .post-grid, .collection-grid, .project-grid, .home-magazine .collection-grid, .home-magazine .project-grid, .home-profile .collection-grid, .home-profile .project-grid { grid-template-columns: minmax(0, 1fr); }
  .home-journal .post-card, .article-index .post-card { gap: 18px; padding-block: 24px; align-items: flex-start; }
  .home-journal .card-cover-link, .article-index .card-cover-link { width: 88px; flex-basis: 88px; }
  .home-journal .post-card .cover, .article-index .cover { height: 88px; }
  .home-journal .post-card-featured { flex-direction: column; }
  .home-journal .post-card-featured .card-cover-link { width: 100%; flex-basis: auto; }
  .home-journal .post-card-featured .cover { height: auto; aspect-ratio: 16 / 9; }
  .post-card h2, .article-index .post-card h2 { margin-top: 7px; font-size: 20px; }
  .home-journal .post-card-featured h2 { font-size: 25px; }
  .post-card .summary { font-size: 14px; }
  html[data-cards="bordered"] .post-card { padding: 18px; }
  html[data-cards="bordered"] .home-journal .post-card, html[data-cards="bordered"] .article-index .post-card { flex-direction: column; }
  html[data-cards="bordered"] .home-journal .card-cover-link, html[data-cards="bordered"] .article-index .card-cover-link { width: 100%; flex-basis: auto; }
  html[data-cards="bordered"] .home-journal .post-card .cover, html[data-cards="bordered"] .article-index .cover { height: auto; aspect-ratio: 16 / 9; }
  .reader-header h1 { font-size: 2.2rem; }
  .article-body { font-size: 17px; line-height: 1.95; }
  .article-body h1 { font-size: 1.65rem; }
  .article-body h2 { font-size: 1.45rem; }
  .article-body h3 { font-size: 1.2rem; }
  .article-body pre { padding-inline: 16px; }
  .toc { padding: 10px 16px; }
  .reader-collection, .collection-card, .project-card { padding: 20px; }
  .home-profile .module-featured .post-grid { padding-inline: 18px; }
  .back-to-top { margin-left: 0; }
  .reader-actions { gap: 10px; margin-top: 36px; }
  .reader-actions [role="status"] { flex-basis: 100%; }
  .archive-list li { flex-direction: column; gap: 2px; }
  .footer-links { gap: 4px 20px; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
