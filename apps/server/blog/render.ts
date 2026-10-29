import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import type { BlogSettings } from '../../../shared/blog-contracts.js';
import type {
  BlogDesign,
  BlogPublicPage,
  BlogPublicPostSummary,
  BlogPublicQuery,
  BlogPublicTaxonomy,
} from '../../../shared/blog-design.js';
import { publicBlogStyles } from './styles.js';

export const esc = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function safeHref(value: string): string {
  if (/^\/blog(?:[/?#]|$)/.test(value) || /^https?:\/\//i.test(value) || /^mailto:/i.test(value))
    return value;
  return '#';
}
const link = (href: string, label: string, attrs = '') =>
  `<a href="${esc(safeHref(href))}"${attrs}>${esc(label)}</a>`;
export type ReaderPost = BlogPublicPostSummary & {
  html: string;
  headings: { id: string; text: string }[];
};
export type PublicPageSource = (query?: BlogPublicQuery) => BlogPublicPage;
export type RenderContext = {
  settings: BlogSettings;
  design: BlogDesign;
  origin: string;
  preview?: boolean;
};
export const publicBlogCsp =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export function documentHtml(
  context: RenderContext,
  title: string,
  body: string,
  path = '/blog',
  post?: ReaderPost,
): string {
  const { settings: s, design: d } = context;
  const base = (s.baseUrl || context.origin).replace(/\/$/, ''),
    canonical = base + path;
  const description = post?.summary || s.description;
  const navigation = [
    { id: 'home', href: '/blog', label: '首页' },
    ...d.navigation,
    { id: 'rss', href: '/blog/rss.xml', label: 'RSS' },
  ]
    .map((n) =>
      link(
        n.href,
        n.label,
        path === n.href
          ? ' aria-current="page"'
          : post && n.href === '/blog/-/articles'
            ? ' aria-current="location"'
            : '',
      ),
    )
    .join('');
  const social = d.socialLinks.length
    ? `<nav aria-label="社交链接">${d.socialLinks.map((n) => link(n.href, n.label)).join('')}</nav>`
    : '';
  const structured = post
    ? `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.summary, datePublished: post.publishedAt, dateModified: post.updatedAt, url: canonical, author: { '@type': 'Person', name: d.profile.name || s.author || s.title }, ...(post.cover ? { image: base + post.cover } : {}) }).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))}</script>`
    : '';
  const accent = /^#[\da-f]{6}$/i.test(d.accent) ? d.accent : '#44684f';
  return `<!doctype html><html lang="zh-CN" data-theme="${esc(s.theme)}" data-template="${esc(d.template)}" data-font="${esc(d.font)}" data-width="${esc(d.width)}" data-cards="${esc(d.cardStyle)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(s.title)}</title><meta name="description" content="${esc(description)}"><link rel="canonical" href="${esc(canonical)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="${esc(base)}/blog/rss.xml"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="${post ? 'article' : 'website'}">${post?.cover ? `<meta property="og:image" content="${esc(base + post.cover)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}<style>${publicBlogStyles}\n:root{--brand-accent:${accent}}</style>${structured}${post ? '<script defer src="/blog/reader.js"></script>' : ''}</head><body>${context.preview ? '<div class="preview-banner" role="status">装修草稿预览 · 仅你可见</div>' : ''}<a class="skip-link" href="#blog-content">跳到正文</a><header class="site-header"><a class="brand" href="/blog">${esc(s.title)}</a><nav aria-label="博客导航">${navigation}</nav></header><main id="blog-content" tabindex="-1">${body}</main><footer>${esc(s.author || s.title)}${social}<a href="/blog/rss.xml">订阅 RSS</a></footer></body></html>`;
}
export function postCards(posts: BlogPublicPostSummary[], empty = '暂无文章'): string {
  return (
    posts
      .map(
        (p) =>
          `<article class="post-card">${p.cover ? `<a class="card-cover-link" href="${esc(p.url)}"><img class="cover" src="${esc(p.cover)}" alt="" loading="lazy"></a>` : ''}<div class="card-copy"><div class="card-meta">${p.pinned ? '<span class="pinned">置顶</span>' : ''}<time datetime="${esc(p.publishedAt)}">${esc(p.publishedAt.slice(0, 10))}</time>${p.category ? ` · ${esc(p.category)}` : ''}</div><h2><a href="${esc(p.url)}">${esc(p.title)}</a></h2>${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}</div></article>`,
      )
      .join('') || `<div class="empty-state"><p>${esc(empty)}</p></div>`
  );
}
function profileIntro(c: RenderContext): string {
  const { profile: p } = c.design;
  return `${p.cover ? `<img class="profile-cover" src="${esc(p.cover)}" alt="">` : ''}<div class="identity">${p.avatar ? `<img class="avatar" src="${esc(p.avatar)}" alt="${esc(p.name || c.settings.author)}的头像">` : ''}<div><p class="eyebrow">${esc(p.tagline || c.settings.description)}</p><h1>${esc(p.name || c.settings.author || c.settings.title)}</h1>${p.bio ? `<p class="profile-bio">${esc(p.bio)}</p>` : ''}${c.design.socialLinks.length ? `<nav aria-label="个人社交链接">${c.design.socialLinks.map((l) => link(l.href, l.label)).join('')}</nav>` : ''}</div></div>`;
}
export function collectionCards(
  context: RenderContext,
  source: PublicPageSource,
  limit = 100,
): string {
  return (
    context.design.collections
      .slice(0, limit)
      .map((c) => {
        const count = c.postIds.length ? source({ postIds: c.postIds, pageSize: 1 }).total : 0;
        return `<article class="collection-card"><p class="eyebrow">专题 · ${count} 篇</p><h2>${link('/blog/-/collections/' + encodeURIComponent(c.slug), c.title)}</h2><p class="summary">${esc(c.description)}</p></article>`;
      })
      .join('') || '<p class="muted">暂无专题合集。</p>'
  );
}
export function homeHtml(context: RenderContext, source: PublicPageSource): string {
  const { design: d } = context;
  const modules = d.modules
    .filter((m) => m.enabled)
    .map((m) => {
      let body = '';
      switch (m.kind) {
        case 'intro':
          body = profileIntro(context);
          break;
        case 'featured':
          body = `<div class="post-grid">${postCards(
            source({ pageSize: 100 })
              .posts.filter((p) => p.pinned)
              .slice(0, m.limit),
            '暂无精选文章。可先浏览最近文章。',
          )}</div>`;
          break;
        case 'latest':
          body = `<div class="post-grid">${postCards(
            allSummaries(source)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
              .slice(0, m.limit),
          )}</div><p>${link('/blog/-/articles', '查看全部文章 →')}</p>`;
          break;
        case 'collections':
          body = `<div class="collection-grid">${collectionCards(context, source, m.limit)}</div>`;
          break;
        case 'projects':
          body = `<div class="project-grid">${
            d.projects
              .slice(0, m.limit)
              .map(
                (p) =>
                  `<article class="project-card"><h3>${link(p.href, p.title)}</h3><p class="summary">${esc(p.description)}</p></article>`,
              )
              .join('') || '<p class="muted">暂无项目。</p>'
          }</div>`;
          break;
        case 'links':
          body = `<ul class="friend-links">${
            d.friendLinks
              .slice(0, m.limit)
              .map((l) => `<li>${link(l.href, l.label)}</li>`)
              .join('') || '<li class="muted">暂无友情链接。</li>'
          }</ul>`;
          break;
      }
      return {
        kind: m.kind,
        html: `<section class="home-module module-${m.kind}" data-module="${m.kind}"><h2 class="module-title">${esc(m.title)}</h2>${body}</section>`,
      };
    });
  // Each preset owns its layout. Module DOM order always follows the author's ordering.
  if (d.template === 'magazine')
    return `<div class="home-magazine"><div class="magazine-masthead"><p class="eyebrow">${esc(d.profile.tagline || '记录 · 发现 · 分享')}</p><p class="display-title">${esc(context.settings.title)}</p></div><div class="magazine-layout">${modules.map((m) => m.html).join('')}</div></div>`;
  if (d.template === 'profile')
    return `<div class="home-profile"><div class="profile-layout">${modules.map((m) => (m.kind === 'intro' ? `<div class="profile-sidebar">${m.html}</div>` : `<div class="profile-section">${m.html}</div>`)).join('')}</div></div>`;
  return `<div class="home-journal"><div class="journal-stream">${modules.map((m) => m.html).join('')}</div></div>`;
}
export function articleListHtml(
  page: BlogPublicPage,
  query: BlogPublicQuery,
  taxonomy: BlogPublicTaxonomy,
  path = '/blog/-/articles',
): string {
  const params = (pageNumber?: number) => {
    const p = new URLSearchParams();
    if (query.query) p.set('q', query.query);
    if (query.category) p.set('category', query.category);
    if (query.tag) p.set('tag', query.tag);
    if (page.pageSize !== 12) p.set('pageSize', String(page.pageSize));
    if (pageNumber) p.set('page', String(pageNumber));
    return path + (p.size ? '?' + p.toString() : '');
  };
  const filtered = !!(query.category || query.tag || query.query);
  const chips =
    `<a class="chip" href="${path}"${!filtered ? ' aria-current="true"' : ''}>全部文章</a>` +
    taxonomy.categories
      .map(
        ({ name }) =>
          `<a class="chip" href="${path}?category=${encodeURIComponent(name)}"${query.category === name ? ' aria-current="true"' : ''}>${esc(name)}</a>`,
      )
      .join('') +
    taxonomy.tags
      .map(
        ({ name }) =>
          `<a class="chip" href="${path}?tag=${encodeURIComponent(name)}"${query.tag === name ? ' aria-current="true"' : ''}>#${esc(name)}</a>`,
      )
      .join('');
  return `<h1>${esc(query.category || query.tag || '全部文章')}</h1><form class="article-search" action="${path}" method="get" role="search"><label for="article-search">搜索公开文章</label><div><input id="article-search" type="search" name="q" value="${esc(query.query || '')}" placeholder="标题、摘要或标签">${query.category ? `<input type="hidden" name="category" value="${esc(query.category)}">` : ''}${query.tag ? `<input type="hidden" name="tag" value="${esc(query.tag)}">` : ''}<button type="submit">搜索</button></div></form><div class="taxonomy" aria-label="文章筛选">${chips}</div><p class="filter-status">${query.category ? '当前分类：' + esc(query.category) + ' · ' : ''}${query.tag ? '当前标签：#' + esc(query.tag) + ' · ' : ''}共 ${page.total} 篇文章</p><div class="article-index">${page.posts.length ? postCards(page.posts) : `<section class="empty-state" aria-label="筛选结果"><h2>${filtered ? '没有匹配的文章' : '暂无文章'}</h2><p>试试其他分类或标签，或查看全部文章。</p><a href="${path}">查看全部文章</a></section>`}</div>${page.totalPages > 1 ? `<nav class="pagination" aria-label="文章分页">${page.page > 1 ? `<a href="${esc(params(page.page - 1))}" rel="prev">← 上一页</a>` : '<span></span>'}<span>第 ${page.page} / ${page.totalPages} 页</span>${page.page < page.totalPages ? `<a href="${esc(params(page.page + 1))}" rel="next">下一页 →</a>` : '<span></span>'}</nav>` : ''}`;
}
export function aboutHtml(markdown: string): string {
  const parser = new MarkdownIt({ html: false, linkify: true });
  const body = sanitizeHtml(parser.render(markdown), {
    allowedTags: sanitizeHtml.defaults.allowedTags,
    allowedAttributes: { a: ['href', 'title'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
  });
  return `<h1>关于</h1><div class="about article-body">${body}</div>`;
}
export function readerHtml(
  context: RenderContext,
  p: ReaderPost,
  source: PublicPageSource,
): string {
  const words = p.html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[^;]+;/g, ' ')
    .trim();
  const minutes = Math.max(
    1,
    Math.ceil((words.match(/[\u3400-\u9fff]|[a-z0-9]+/gi)?.length || 0) / 250),
  );
  const toc = p.headings.length
    ? `<aside class="toc" aria-label="目录"><details open><summary>文章目录</summary>${p.headings.map((h) => `<a href="#${esc(h.id)}">${esc(h.text)}</a>`).join('')}</details></aside>`
    : '';
  const collections = context.design.collections
    .filter((c) => c.postIds.includes(p.id))
    .map((c) => {
      const members = c.postIds.length ? orderedCollectionPosts(source, c.postIds) : [];
      const index = members.findIndex((m) => m.id === p.id),
        prev = members[index - 1],
        next = members[index + 1];
      return `<section class="reader-collection"><h2>${link('/blog/-/collections/' + encodeURIComponent(c.slug), c.title)}</h2><p class="muted">专题第 ${index + 1} / ${members.length} 篇</p><nav aria-label="专题上下篇">${prev ? link(prev.url, '上一篇：' + prev.title, ' rel="prev"') : ''}${next ? link(next.url, '下一篇：' + next.title, ' rel="next"') : ''}</nav></section>`;
    })
    .join('');
  const nearby = allSummaries(source).sort(
    (a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id),
  );
  const current = nearby.findIndex((item) => item.id === p.id);
  const previous = current > 0 ? nearby[current - 1] : undefined,
    next = current >= 0 ? nearby[current + 1] : undefined;
  const adjacent =
    previous || next
      ? `<nav class="adjacent-posts" aria-label="相邻文章">${previous ? link(previous.url, '上一篇：' + previous.title, ' rel="prev"') : ''}${next ? link(next.url, '下一篇：' + next.title, ' rel="next"') : ''}</nav>`
      : '';
  const related = source({
    ...(p.category ? { category: p.category } : p.tags.length ? { tag: p.tags[0] } : {}),
    pageSize: 8,
  })
    .posts.filter((item) => item.id !== p.id)
    .slice(0, 3);
  return `<article class="reader-article"><p class="muted article-meta"><time datetime="${esc(p.publishedAt)}">${esc(p.publishedAt.slice(0, 10))}</time> · ${minutes} 分钟阅读${p.category ? ` · ${link('/blog?category=' + encodeURIComponent(p.category), p.category)}` : ''}</p><h1>${esc(p.title)}</h1>${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}${p.tags.length ? `<div class="taxonomy" aria-label="文章标签">${p.tags.map((t) => `<a class="chip" href="/blog?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>` : ''}${p.cover ? `<img class="cover" src="${esc(p.cover)}" alt="">` : ''}<div class="reader-layout">${toc}<div class="article-body">${p.html}</div></div><div class="reader-actions" aria-label="文章分享"><button type="button" data-copy-link>复制链接</button><button type="button" data-share>分享文章</button><span role="status" aria-live="polite" data-reader-status></span></div>${collections}${adjacent}${related.length ? `<section class="related-posts"><h2>继续阅读</h2>${postCards(related)}</section>` : ''}</article>`;
}
export function orderedCollectionPosts(
  source: PublicPageSource,
  ids: string[],
): BlogPublicPostSummary[] {
  if (!ids.length) return [];
  const first = source({ postIds: ids, pageSize: 100 });
  const posts = [...first.posts];
  for (let page = 2; page <= first.totalPages; page++)
    posts.push(...source({ postIds: ids, pageSize: 100, page }).posts);
  const byId = new Map(posts.map((p) => [p.id, p]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

function allSummaries(source: PublicPageSource): BlogPublicPostSummary[] {
  const first = source({ pageSize: 100 });
  const posts = [...first.posts];
  for (let page = 2; page <= first.totalPages; page++)
    posts.push(...source({ pageSize: 100, page }).posts);
  return posts;
}
