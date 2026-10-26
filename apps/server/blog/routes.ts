import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../../shared/contracts.js';
import type {
  BlogCreateInput,
  BlogPublishInput,
  BlogSettings,
  BlogUnpublishInput,
  BlogUpdateInput,
} from '../../../shared/blog-contracts.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { BlogService } from '../../../packages/core/blog/service.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';
import { HttpError } from '../../../packages/core/errors.js';
import { KnowledgeError } from '../../../packages/core/knowledge/errors.js';

const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const css = `:root{color-scheme:light;--ink:#24312d;--muted:#65716b;--paper:#fbfaf6;--accent:#44684f}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.85 system-ui,sans-serif}header,main,footer{max-width:860px;margin:auto;padding:28px}header{display:flex;justify-content:space-between;gap:24px;align-items:center;border-bottom:1px solid #dce2d9}header a,nav a{color:var(--ink);text-decoration:none}nav{display:flex;gap:20px;font-size:14px}.brand{font-weight:700;font-size:21px}main{min-height:60vh;padding-top:44px;padding-bottom:70px}h1,h2,h3{line-height:1.4;letter-spacing:-.025em}h1{font-size:36px}h2{font-size:25px}a{color:var(--accent)}.muted,time{color:var(--muted);font-size:14px}.post-card{padding:26px 0;border-bottom:1px solid #dce2d9}.post-card h2{margin:5px 0 12px}.post-card h2 a{text-decoration:none}.taxonomy{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0}.chip{font-size:13px;background:#edf1e9;padding:3px 12px;border-radius:20px;text-decoration:none}.summary{color:var(--muted)}img{max-width:100%;height:auto;border-radius:5px}pre{padding:18px;border-radius:8px;background:#edf0e9;overflow:auto;font-size:14px;line-height:1.65}code{font-family:ui-monospace,monospace}blockquote,.markdown-alert{padding:8px 20px;border-left:3px solid #78977c;margin:22px 0;color:var(--muted)}table{border-collapse:collapse;width:100%;display:block;overflow:auto}td,th{border:1px solid #d3dccf;padding:8px 12px}.toc{padding:16px 20px;border:1px solid #dce2d9;border-radius:8px;margin:30px 0}.toc a{display:block;font-size:14px}.cover{width:100%;max-height:400px;object-fit:cover}.about{white-space:pre-wrap}footer{font-size:13px;color:var(--muted);border-top:1px solid #dce2d9}@media(max-width:600px){header,main,footer{padding:22px}header{align-items:flex-start;flex-direction:column;gap:8px}h1{font-size:30px}}`;
export function registerBlogRoutes(
  app: FastifyInstance,
  config: AppConfig,
  getBlog: () => BlogService,
) {
  const principal = (req: FastifyRequest): Principal => ({
    ...webPrincipal,
    id: (req as any).ownerId || 'web-owner',
    scopes: [...webPrincipal.scopes, 'blog:publish'],
  });
  app.get('/api/blog', (req) => getBlog().dashboard(principal(req), req.query as any));
  app.get('/api/blog/settings', (req) => getBlog().settings(principal(req)));
  app.patch('/api/blog/settings', (req) =>
    getBlog().updateSettings(
      principal(req),
      req.body as { settings: BlogSettings; requestId: string },
    ),
  );
  app.post('/api/blog/posts', (req) =>
    getBlog().createPost(principal(req), req.body as BlogCreateInput),
  );
  app.get<{ Params: { id: string } }>('/api/blog/posts/:id', (req) =>
    getBlog().postDetail(principal(req), req.params.id),
  );
  app.patch<{ Params: { id: string } }>('/api/blog/posts/:id', (req) =>
    getBlog().updatePost(principal(req), req.params.id, req.body as BlogUpdateInput),
  );
  app.delete<{ Params: { id: string } }>('/api/blog/posts/:id', (req) =>
    getBlog().deletePost(
      principal(req),
      req.params.id,
      req.body as { expectedVersion: number; requestId: string },
    ),
  );
  app.post('/api/blog/publish', { bodyLimit: 32 * 1024 ** 2 }, (req) =>
    getBlog().publishNote(principal(req), req.body as BlogPublishInput),
  );
  app.post('/api/blog/unpublish', (req) =>
    getBlog().unpublishNote(principal(req), req.body as BlogUnpublishInput),
  );
  app.get<{ Params: { id: string; hash: string } }>(
    '/api/blog/posts/:id/assets/:hash',
    (req, reply) =>
      sendResource(
        reply,
        getBlog().previewResource(principal(req), req.params.id, req.params.hash),
      ),
  );
  function sendResource(reply: FastifyReply, a: { mime: string; bytes: Buffer }) {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    if (a.mime === 'image/svg+xml')
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    if (a.mime === 'application/pdf')
      reply.header('Content-Disposition', 'attachment; filename="document.pdf"');
    return reply.type(a.mime).send(a.bytes);
  }
  function publicService() {
    try {
      return getBlog();
    } catch (error) {
      if (error instanceof KnowledgeError && error.code !== 'SETUP_REQUIRED') throw error;
      throw new HttpError(404, '博客页面不存在');
    }
  }
  function page(
    reply: FastifyReply,
    title: string,
    body: string,
    options: { url?: string; description?: string; post?: boolean } = {},
  ) {
    const blog = publicService(),
      s = blog.settings();
    if (!s.enabled) throw new HttpError(404, '博客页面不存在');
    const base = s.baseUrl || config.origin,
      canonical = base + (options.url || '/blog');
    reply
      .header('Cache-Control', 'no-store')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      );
    return reply
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · ${esc(s.title)}</title><meta name="description" content="${esc(options.description || s.description)}"><link rel="canonical" href="${esc(canonical)}"><link rel="alternate" type="application/rss+xml" title="RSS" href="${esc(base)}/blog/rss.xml"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(options.description || s.description)}"><meta property="og:url" content="${esc(canonical)}"><meta property="og:type" content="${options.post ? 'article' : 'website'}"><style>${css}</style></head><body><header><a class="brand" href="/blog">${esc(s.title)}</a><nav><a href="/blog">文章</a><a href="/blog/archive">归档</a><a href="/blog/about">关于</a><a href="/blog/rss.xml">RSS</a></nav></header><main>${body}</main><footer>${esc(s.author || s.title)} · <a href="/blog/rss.xml">RSS</a></footer></body></html>`,
      );
  }
  app.get('/blog', (req, reply) => {
    const blog = publicService(),
      query = req.query as { category?: string; tag?: string },
      posts = blog.publicPosts(query),
      s = blog.settings();
    const all = blog.publicPosts(),
      categories = [...new Set(all.map((p) => p.category).filter(Boolean))],
      tags = [...new Set(all.flatMap((p) => p.tags))];
    const chips =
      categories
        .map((c) => `<a class="chip" href="/blog?category=${encodeURIComponent(c)}">${esc(c)}</a>`)
        .join('') +
      tags
        .map((t) => `<a class="chip" href="/blog?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`)
        .join('');
    return page(
      reply,
      s.title,
      `<h1>${esc(query.category || query.tag || s.title)}</h1><p class="summary">${esc(s.description)}</p><div class="taxonomy">${chips}</div>${posts.map((p) => `<article class="post-card">${p.pinned ? '<span class="muted">置顶</span>' : ''}<time datetime="${esc(p.publishedAt)}">${esc(p.publishedAt.slice(0, 10))}</time><h2><a href="${esc(p.url)}">${esc(p.title)}</a></h2><p class="summary">${esc(p.summary)}</p>${p.cover ? `<a href="${esc(p.url)}"><img src="${esc(p.cover)}" alt=""></a>` : ''}</article>`).join('') || '<p class="muted">暂无文章</p>'}`,
    );
  });
  app.get('/blog/', (_req, reply) => {
    if (!publicService().settings().enabled) throw new HttpError(404, '博客页面不存在');
    return reply.redirect('/blog');
  });
  app.get('/blog/about', (_req, reply) => {
    const s = publicService().settings();
    return page(
      reply,
      '关于',
      `<h1>关于</h1><div class="about">${esc(s.about || s.description)}</div>`,
      { url: '/blog/about' },
    );
  });
  app.get('/blog/archive', (_req, reply) => {
    const posts = publicService().publicPosts();
    return page(
      reply,
      '归档',
      `<h1>文章归档</h1>${posts.map((p) => `<p><time>${esc(p.publishedAt.slice(0, 10))}</time> · <a href="${esc(p.url)}">${esc(p.title)}</a></p>`).join('')}`,
      { url: '/blog/archive' },
    );
  });
  app.get('/blog/rss.xml', (_req, reply) => {
    const blog = publicService(),
      posts = blog.publicPosts(),
      s = blog.settings(),
      base = s.baseUrl || config.origin;
    return reply
      .type('application/rss+xml; charset=utf-8')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(s.title)}</title><link>${esc(base)}/blog</link><description>${esc(s.description)}</description>${posts.map((p) => `<item><title>${esc(p.title)}</title><link>${esc(base + p.url)}</link><guid isPermaLink="true">${esc(base + p.url)}</guid><pubDate>${esc(new Date(p.publishedAt).toUTCString())}</pubDate><description>${esc(p.summary)}</description>${p.category ? `<category>${esc(p.category)}</category>` : ''}</item>`).join('')}</channel></rss>`,
      );
  });
  app.get('/blog/sitemap.xml', (_req, reply) => {
    const blog = publicService(),
      posts = blog.publicPosts(),
      base = blog.settings().baseUrl || config.origin;
    return reply
      .type('application/xml; charset=utf-8')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(base)}/blog</loc></url><url><loc>${esc(base)}/blog/about</loc></url><url><loc>${esc(base)}/blog/archive</loc></url>${posts.map((p) => `<url><loc>${esc(base + p.url)}</loc><lastmod>${esc(p.updatedAt)}</lastmod></url>`).join('')}</urlset>`,
      );
  });
  app.get<{ Params: { post: string; version: string; hash: string } }>(
    '/blog/assets/:post/:version/:hash',
    (req, reply) =>
      sendResource(
        reply,
        publicService().publicResource(req.params.post, req.params.version, req.params.hash),
      ),
  );
  app.get<{ Params: { slug: string } }>('/blog/:slug', (req, reply) => {
    const p = publicService().publicPost(req.params.slug),
      toc =
        p.headings.length > 2
          ? `<aside class="toc" aria-label="目录">${p.headings.map((h) => `<a href="#${esc(h.id)}">${esc(h.text)}</a>`).join('')}</aside>`
          : '';
    return page(
      reply,
      p.title,
      `<article><p class="muted"><time datetime="${esc(p.publishedAt)}">${esc(p.publishedAt.slice(0, 10))}</time>${p.category ? ' · ' + esc(p.category) : ''}</p><h1>${esc(p.title)}</h1>${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ''}<div class="taxonomy">${p.tags.map((t) => `<a class="chip" href="/blog?tag=${encodeURIComponent(t)}">#${esc(t)}</a>`).join('')}</div>${p.cover ? `<img class="cover" src="${esc(p.cover)}" alt="">` : ''}${toc}<div class="article-body">${p.html}</div></article>`,
      { url: p.url, description: p.summary, post: true },
    );
  });
}
