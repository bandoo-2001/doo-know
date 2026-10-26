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
.about { white-space: pre-wrap; }
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
`;
