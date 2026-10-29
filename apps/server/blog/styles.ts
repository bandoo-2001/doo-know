export const publicBlogStyles = `
:root {
  color-scheme: light;
  --ink: #24312d;
  --muted: #65716b;
  --paper: #fbfaf6;
  --accent: #44684f;
  --line: #dce2d9;
  --surface: #edf1e9;
  --code: #edf0e9;
  --border: #d3dccf;
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] {
    color-scheme: dark;
    --ink: #e5ece5;
    --muted: #afbcaf;
    --paper: #151d19;
    --accent: #9bc8a4;
    --line: #35473a;
    --surface: #24352b;
    --code: #202d25;
    --border: #455a49;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font: 17px/1.85 system-ui, sans-serif;
  overflow-wrap: anywhere;
}
header, main, footer { max-width: 860px; margin: auto; padding: 28px; min-width: 0; }
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 24px;
  border-bottom: 1px solid var(--line);
}
header a { color: var(--ink); text-decoration: none; }
.brand { min-width: 0; font-weight: 700; font-size: 21px; line-height: 1.5; }
nav { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 14px; }
nav a { display: inline-flex; align-items: center; min-height: 44px; }
nav a[aria-current] { color: var(--accent); text-decoration: underline; text-underline-offset: 6px; }
main { min-height: 60vh; padding-top: 44px; padding-bottom: 70px; }
main:focus { outline: none; }
h1, h2, h3, h4, h5, h6 { line-height: 1.4; letter-spacing: -.025em; }
h1 { margin: 0 0 22px; font-size: clamp(1.9rem, 4vw, 2.25rem); }
h2 { font-size: 25px; }
a { color: var(--accent); text-underline-offset: 3px; }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; border-radius: 3px; }
.skip-link {
  position: absolute;
  z-index: 1;
  top: 12px;
  left: 16px;
  padding: 8px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  transform: translateY(-180%);
}
.skip-link:focus { transform: none; }
.muted, time, .filter-status { color: var(--muted); font-size: 14px; }
.article-meta { margin: 0 0 20px; }
.article-meta a { color: inherit; }
.post-card { padding: 28px 0; border-bottom: 1px solid var(--line); }
.post-card h2 { margin: 7px 0 12px; }
.post-card h2 a { text-decoration: none; }
.post-card .summary { margin: 0; }
.pinned { display: inline-block; margin-right: 12px; color: var(--accent); font-size: 13px; }
.taxonomy { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0; }
.chip {
  min-width: 0;
  max-width: 100%;
  padding: 6px 13px;
  background: var(--surface);
  border: 1px solid transparent;
  border-radius: 20px;
  font-size: 13px;
  line-height: 1.6;
  text-decoration: none;
}
.chip[aria-current] { border-color: var(--accent); color: var(--ink); font-weight: 600; }
.summary { color: var(--muted); }
.empty-state { padding: 38px 24px; border: 1px dashed var(--border); border-radius: 12px; margin-top: 28px; }
.empty-state h2 { margin: 0 0 12px; font-size: 22px; }
.empty-state p { margin: 0 0 16px; color: var(--muted); }
.article-body { min-width: 0; }
.article-body :is(h1, h2, h3, h4, h5, h6) { margin-top: 1.7em; margin-bottom: .65em; scroll-margin-top: 24px; }
.article-body > :first-child { margin-top: 0; }
.article-body h1 { font-size: 1.65rem; }
.article-body h2 { font-size: 1.45rem; }
.article-body h3 { font-size: 1.2rem; }
.article-body p { margin: 1.1em 0; }
img { max-width: 100%; height: auto; border-radius: 6px; }
.article-body img { display: block; margin: 22px 0; }
.cover { display: block; width: 100%; max-height: 400px; object-fit: cover; margin-bottom: 30px; }
code { font-family: ui-monospace, monospace; font-size: .88em; }
:not(pre) > code { padding: 2px 6px; border-radius: 4px; background: var(--code); }
pre {
  max-width: 100%;
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--code);
  overflow-x: auto;
  overflow-wrap: normal;
  font-size: 14px;
  line-height: 1.65;
}
pre code { font-size: inherit; white-space: pre; }
blockquote, .markdown-alert { padding: 8px 20px; border-left: 3px solid var(--accent); margin: 24px 0; color: var(--muted); }
table { display: block; width: 100%; max-width: 100%; border-collapse: collapse; overflow-x: auto; margin: 24px 0; font-size: 15px; }
td, th { min-width: 10rem; border: 1px solid var(--border); padding: 10px 12px; vertical-align: top; }
th { background: var(--surface); text-align: left; }
hr { height: 1px; border: 0; background: var(--line); margin: 30px 0; }
.toc { padding: 20px; border: 1px solid var(--line); border-radius: 10px; margin: 30px 0; background: var(--surface); }
.toc h2 { font-size: 14px; margin: 0 0 10px; }
.toc a { display: block; padding: 4px 0; font-size: 14px; }
.about { white-space: normal; }
.archive-list { list-style: none; padding: 0; }
.archive-list li { display: flex; gap: 18px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.archive-list time { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.footnotes { font-size: 14px; }
footer { font-size: 13px; color: var(--muted); border-top: 1px solid var(--line); }
@media (max-width: 600px) {
  header, main, footer { padding-left: 22px; padding-right: 22px; }
  header { align-items: flex-start; flex-direction: column; gap: 8px; padding-top: 22px; padding-bottom: 14px; }
  main { padding-top: 30px; padding-bottom: 48px; }
  nav { gap: 4px 22px; }
  .article-body h1 { font-size: 1.5rem; }
  .article-body h2 { font-size: 1.3rem; }
  .archive-list li { flex-direction: column; gap: 2px; }
  .empty-state { padding: 26px 20px; }
}

:root { --accent: var(--brand-accent, #44684f); --content-width: 960px; }
html[data-width="wide"] { --content-width: 1180px; }
html[data-font="serif"] body { font-family: Georgia, "Noto Serif SC", "Songti SC", serif; }
.site-header, main, footer { max-width: var(--content-width); }
.site-header { padding-top: 32px; padding-bottom: 24px; }
.site-header .brand { letter-spacing: -.04em; }
footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
footer nav { font-size: inherit; }
button, input { font: inherit; }
button { color: var(--ink); border: 1px solid var(--border); background: var(--surface); border-radius: 6px; padding: 9px 16px; cursor: pointer; min-height: 44px; }
button:hover { border-color: var(--accent); }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.eyebrow { color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: .08em; margin: 0 0 12px; }
.home-module { min-width: 0; margin-bottom: 56px; }
.module-title { display: flex; gap: 16px; align-items: center; font-size: 15px; letter-spacing: .04em; margin: 0 0 26px; }
.module-title::after { content: ''; flex: 1; height: 1px; background: var(--line); }
.identity { display: flex; gap: 24px; align-items: flex-start; }
.identity h1 { font-size: clamp(2.2rem, 6vw, 3.4rem); margin-bottom: 20px; }
.identity .eyebrow { font-size: 14px; }
.profile-bio { color: var(--muted); max-width: 56ch; white-space: pre-line; }
.avatar { width: 88px; height: 88px; object-fit: cover; border-radius: 50%; flex: 0 0 88px; }
.profile-cover { display: block; width: 100%; max-height: 280px; object-fit: cover; margin-bottom: 26px; }
.post-card { min-width: 0; }
.card-copy { min-width: 0; }
.post-card h2 { font-size: 23px; }
.post-card .cover { height: 200px; margin-bottom: 20px; }
.card-meta { font-size: 12px; color: var(--muted); }
.post-card .summary { font-size: 15px; }
html[data-cards="bordered"] .post-card { border: 1px solid var(--border); border-radius: 10px; padding: 22px; margin-bottom: 16px; }
.collection-grid, .project-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
.collection-card, .project-card { min-width: 0; padding: 24px; border: 1px solid var(--line); border-radius: 8px; }
.collection-card h2, .project-card h3 { margin: 8px 0; font-size: 20px; }
.collection-card h2 a, .project-card h3 a { text-decoration: none; }
.collection-card p, .project-card p { font-size: 14px; }
.friend-links { display: flex; flex-wrap: wrap; gap: 12px 24px; padding: 0; list-style: none; }
.friend-links a { display: inline-block; min-height: 44px; }
.home-journal { max-width: 760px; margin: 0 auto; }
.home-journal .module-intro { padding: 22px 0 34px; }
.home-journal .post-card { display: flex; flex-direction: row-reverse; gap: 26px; align-items: center; }
.home-journal .card-copy { flex: 1; }
.home-journal .card-cover-link { width: 160px; flex: 0 0 160px; }
.home-journal .post-card .cover { height: 120px; margin: 0; }
.home-magazine .magazine-masthead { border-bottom: 3px solid var(--ink); margin-bottom: 40px; padding: 8px 0 26px; }
.display-title { font-family: Georgia, "Songti SC", serif; font-size: clamp(2.6rem, 7vw, 5.2rem); line-height: 1.1; letter-spacing: -.06em; margin: 8px 0 0; }
.magazine-layout { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 36px; }
.magazine-layout .module-intro, .magazine-layout .module-featured, .magazine-layout .module-latest { grid-column: 1 / -1; }
.home-magazine .post-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
.home-magazine .post-card { border-top: 1px solid var(--line); border-bottom: 0; padding-top: 18px; }
.home-magazine .post-card h2 { font-size: 22px; }
.home-magazine .module-featured .post-card:first-child { grid-column: span 2; }
.home-magazine .module-featured .post-card:first-child h2 { font-size: 30px; }
.home-magazine .module-featured .post-card:first-child .cover { height: 280px; }
.home-magazine .identity h1 { font-size: 2rem; }
.home-magazine .collection-grid, .home-magazine .project-grid { grid-template-columns: 1fr; }
.profile-layout { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 0 50px; }
.profile-sidebar { grid-column: 1; grid-row: span 6; align-self: start; position: sticky; top: 24px; }
.profile-sidebar .identity { flex-direction: column; }
.profile-sidebar .identity h1 { font-size: 2.5rem; }
.profile-sidebar .module-title { display: none; }
.profile-sidebar .avatar { width: 116px; height: 116px; flex-basis: 116px; }
.profile-sidebar nav { flex-direction: column; gap: 0; }
.profile-sidebar .profile-cover { max-height: 120px; }
.profile-section { grid-column: 2; min-width: 0; }
.home-profile .post-card h2 { font-size: 21px; }
.home-profile .module-featured .post-grid { padding: 8px 22px; background: var(--surface); border-radius: 10px; }
.home-profile .post-card .cover { max-height: 200px; }
.article-search { margin: 28px 0; }
.article-search label { display: block; margin-bottom: 8px; font-size: 14px; color: var(--muted); }
.article-search > div { display: flex; gap: 10px; }
.article-search input[type="search"] { min-width: 0; flex: 1; border: 1px solid var(--border); border-radius: 6px; background: var(--paper); color: var(--ink); padding: 10px 14px; }
.article-index .post-card { display: flex; flex-direction: row-reverse; gap: 26px; align-items: center; }
.article-index .card-copy { flex: 1; }
.article-index .card-cover-link { width: 180px; flex: 0 0 180px; }
.article-index .cover { height: 120px; margin: 0; }
.pagination { align-items: center; justify-content: space-between; border-top: 1px solid var(--line); padding-top: 22px; margin-top: 30px; }
.reader-article { max-width: 820px; margin: auto; }
.reader-layout { display: grid; grid-template-columns: minmax(0, 1fr); }
.toc { grid-row: 1; margin-top: 0; }
.toc summary { cursor: pointer; font-size: 14px; font-weight: 600; min-height: 34px; }
.toc details a { padding-left: 8px; }
.article-body pre { position: relative; padding-top: 54px; }
.copy-code { position: absolute; top: 8px; right: 8px; min-height: 32px; padding: 3px 10px; font-size: 12px; }
.reader-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line); margin-top: 40px; padding: 24px 0; }
.reader-actions [role="status"] { font-size: 13px; color: var(--muted); }
.reader-collection { border: 1px solid var(--border); padding: 24px; margin: 24px 0; border-radius: 8px; }
.reader-collection h2 { font-size: 19px; margin: 0; }
.reader-collection nav, .adjacent-posts { justify-content: space-between; }
.adjacent-posts { margin: 24px 0; padding: 20px 0; border-block: 1px solid var(--line); }
.related-posts > h2 { font-size: 20px; margin-top: 40px; }
.preview-banner { padding: 8px 16px; text-align: center; font-size: 12px; background: var(--surface); color: var(--accent); border-bottom: 1px solid var(--line); }
@media (min-width: 1100px) {
  .reader-article { max-width: none; }
  .reader-layout { grid-template-columns: minmax(0, 1fr) 210px; gap: 40px; }
  .reader-layout .toc { grid-column: 2; grid-row: 1; align-self: start; position: sticky; top: 24px; max-height: calc(100vh - 48px); overflow-y: auto; }
  .reader-layout .article-body { grid-column: 1; grid-row: 1; }
}
@media (prefers-color-scheme: dark) {
  :root[data-theme="system"] { --accent: color-mix(in srgb, var(--brand-accent, #44684f), white 38%); }
}
@media (max-width: 760px) {
  .profile-layout { grid-template-columns: minmax(0, 1fr); }
  .profile-sidebar { grid-column: 1; grid-row: auto; position: static; }
  .profile-sidebar .identity { flex-direction: row; }
  .profile-sidebar .avatar { width: 80px; height: 80px; flex-basis: 80px; }
  .profile-sidebar nav { flex-direction: row; gap: 12px; }
  .profile-section { grid-column: 1; }
  .magazine-layout { grid-template-columns: minmax(0, 1fr); }
  .home-magazine .post-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .home-magazine .module-featured .post-card:first-child { grid-column: 1 / -1; }
  .home-module { margin-bottom: 38px; }
  .collection-grid, .project-grid { gap: 16px; }
}
@media (max-width: 500px) {
  .home-magazine .post-grid, .collection-grid, .project-grid { grid-template-columns: minmax(0, 1fr); }
  .identity { gap: 16px; }
  .identity h1 { font-size: 2rem; }
  .avatar { width: 64px; height: 64px; flex-basis: 64px; }
  .home-journal .card-cover-link, .article-index .card-cover-link { width: 90px; flex-basis: 90px; }
  .home-journal .post-card .cover, .article-index .cover { height: 90px; }
  .home-journal .post-card, .article-index .post-card { gap: 16px; }
  .post-card h2, .article-index .post-card h2 { font-size: 20px; }
  .reader-collection, .collection-card, .project-card { padding: 18px; }
}
`;
