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
import type { BlogDesign, BlogPublicQuery } from '../../../shared/blog-design.js';
import { registerBlogStudioRoutes } from './studio-routes.js';
import {
  aboutHtml,
  articleListHtml,
  collectionCards,
  documentHtml,
  esc,
  homeHtml,
  orderedCollectionPosts,
  postCards,
  publicBlogCsp,
  readerHtml,
  type RenderContext,
  type PublicPageSource,
} from './render.js';
import { blogReaderScript } from './reader-script.js';

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
  registerBlogStudioRoutes(app, getBlog);
  function context(preview = false, design?: BlogDesign): RenderContext {
    const blog = preview ? getBlog() : publicService();
    const settings = blog.settings();
    if (!preview && !settings.enabled) throw new HttpError(404, '博客页面不存在');
    return { settings, design: design || blog.publicDesign(), origin: config.origin, preview };
  }
  function sendPage(
    reply: FastifyReply,
    ctx: RenderContext,
    title: string,
    body: string,
    path = '/blog',
    post?: Parameters<typeof documentHtml>[4],
  ) {
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header(
        'Content-Security-Policy',
        ctx.preview
          ? publicBlogCsp.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
          : publicBlogCsp,
      )
      .type('text/html; charset=utf-8')
      .send(documentHtml(ctx, title, body, path, post));
  }
  const source: PublicPageSource = (query) => publicService().publicPostPage(query);
  function allPosts() {
    const first = source({ pageSize: 100 }),
      posts = [...first.posts];
    for (let page = 2; page <= first.totalPages; page++)
      posts.push(...source({ page, pageSize: 100 }).posts);
    return posts;
  }
  function articleQuery(req: FastifyRequest): BlogPublicQuery {
    const q = req.query as Record<string, unknown>;
    if (
      ['q', 'query', 'category', 'tag', 'page', 'pageSize'].some(
        (key) => q[key] !== undefined && typeof q[key] !== 'string',
      )
    )
      throw new HttpError(400, '文章查询格式不正确');
    return {
      query: (q.q ?? q.query) as string | undefined,
      category: q.category as string | undefined,
      tag: q.tag as string | undefined,
      page: q.page === undefined ? 1 : Number(q.page),
      pageSize: q.pageSize === undefined ? 12 : Number(q.pageSize),
    };
  }
  app.get('/api/blog/design/preview', (req, reply) => {
    const p = principal(req),
      blog = getBlog();
    const design = previewMedia(blog.previewDesign(p));
    const ctx = context(true, design);
    return sendPage(reply, ctx, ctx.settings.title, homeHtml(ctx, previewSource(blog, p)));
  });
  app.post('/api/blog/design/preview', (req, reply) => {
    const body = req.body as { design?: BlogDesign } | null;
    if (!body || !body.design) throw new HttpError(400, '需要装修配置');
    const p = principal(req),
      blog = getBlog(),
      design = previewMedia(blog.previewDesign(p, body.design));
    const ctx = context(true, design);
    return reply.header('Cache-Control', 'no-store').send({
      html: documentHtml(ctx, ctx.settings.title, homeHtml(ctx, previewSource(blog, p))),
    });
  });
  function previewSource(blog: BlogService, p: Principal): PublicPageSource {
    return (query) => {
      const page = blog.previewPostPage(p, query);
      return {
        ...page,
        posts: page.posts.map((post) => ({
          ...post,
          cover:
            post.cover?.replace(
              /^\/blog\/assets\/([^/]+)\/([^/]+)\/([a-f0-9]{64})$/,
              '/api/blog/posts/$1/versions/$2/assets/$3',
            ) || null,
        })),
      };
    };
  }
  function previewMedia(design: BlogDesign): BlogDesign {
    // Draft-only media never becomes public merely by being previewed.
    const copy = structuredClone(design);
    for (const key of ['avatar', 'cover'] as const)
      copy.profile[key] = copy.profile[key].replace(
        /^\/blog\/media\/([a-f0-9]{64})$/,
        '/api/blog/design/media/$1',
      );
    return copy;
  }
  app.get('/blog', (req, reply) => {
    const ctx = context(),
      query = articleQuery(req);
    if (query.category || query.tag || query.query || (req.query as any).page)
      return sendPage(
        reply,
        ctx,
        '文章',
        articleListHtml(source(query), query, publicService().publicTaxonomy(), '/blog'),
      );
    return sendPage(reply, ctx, ctx.settings.title, homeHtml(ctx, source));
  });
  app.get('/blog/', (_req, reply) => {
    context();
    return reply.redirect('/blog');
  });
  function legacyArticle(slug: string, reply: FastifyReply, ctx: RenderContext) {
    let post: ReturnType<BlogService['publicPost']>;
    try {
      post = publicService().publicPost(slug);
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 404) return undefined;
      throw error;
    }
    return sendPage(reply, ctx, post.title, readerHtml(ctx, post, source), post.url, post);
  }
  function articleIndex(req: FastifyRequest, reply: FastifyReply) {
    const ctx = context(),
      query = articleQuery(req);
    return sendPage(
      reply,
      ctx,
      '全部文章',
      articleListHtml(source(query), query, publicService().publicTaxonomy()),
      '/blog/-/articles',
    );
  }
  app.get('/blog/-/articles', articleIndex);
  app.get(
    '/blog/articles',
    (req, reply) => legacyArticle('articles', reply, context()) || articleIndex(req, reply),
  );
  app.get('/blog/about', (_req, reply) => {
    const ctx = context();
    return sendPage(
      reply,
      ctx,
      '关于',
      aboutHtml(ctx.settings.about || ctx.design.profile.bio || ctx.settings.description),
      '/blog/about',
    );
  });
  function collectionIndex(_req: FastifyRequest, reply: FastifyReply) {
    const ctx = context();
    return sendPage(
      reply,
      ctx,
      '专题合集',
      `<h1>专题合集</h1><div class="collection-grid">${collectionCards(ctx, source)}</div>`,
      '/blog/-/collections',
    );
  }
  app.get('/blog/-/collections', collectionIndex);
  app.get(
    '/blog/collections',
    (req, reply) => legacyArticle('collections', reply, context()) || collectionIndex(req, reply),
  );
  function collectionDetail(
    req: FastifyRequest<{ Params: { slug: string } }>,
    reply: FastifyReply,
  ) {
    const ctx = context(),
      collection = ctx.design.collections.find((c) => c.slug === req.params.slug);
    if (!collection) throw new HttpError(404, '专题不存在');
    const posts = orderedCollectionPosts(source, collection.postIds);
    return sendPage(
      reply,
      ctx,
      collection.title,
      `<p class="eyebrow"><a href="/blog/-/collections">全部专题</a> / ${posts.length} 篇文章</p><h1>${esc(collection.title)}</h1><p class="summary">${esc(collection.description)}</p><div class="collection-articles">${postCards(posts, '此专题暂无已发布文章。')}</div>`,
      '/blog/-/collections/' + encodeURIComponent(collection.slug),
    );
  }
  app.get<{ Params: { slug: string } }>('/blog/-/collections/:slug', collectionDetail);
  app.get<{ Params: { slug: string } }>('/blog/collections/:slug', collectionDetail);
  app.get('/blog/archive', (_req, reply) => {
    const ctx = context(),
      posts = allPosts().sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return sendPage(
      reply,
      ctx,
      '归档',
      `<h1>文章归档</h1>${posts.length ? `<ol class="archive-list">${posts.map((p) => `<li><time datetime="${esc(p.publishedAt)}">${esc(p.publishedAt.slice(0, 10))}</time><a href="${esc(p.url)}">${esc(p.title)}</a></li>`).join('')}</ol>` : '<div class="empty-state"><p>暂无已发布文章。</p><a href="/blog">返回文章列表</a></div>'}`,
      '/blog/archive',
    );
  });
  app.get('/blog/rss.xml', (_req, reply) => {
    const ctx = context(),
      posts = allPosts(),
      s = ctx.settings,
      base = (s.baseUrl || config.origin).replace(/\/$/, '');
    return reply
      .header('Cache-Control', 'no-store')
      .type('application/rss+xml; charset=utf-8')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(s.title)}</title><link>${esc(base)}/blog</link><description>${esc(s.description)}</description>${posts.map((p) => `<item><title>${esc(p.title)}</title><link>${esc(base + p.url)}</link><guid isPermaLink="true">${esc(base + p.url)}</guid><pubDate>${esc(new Date(p.publishedAt).toUTCString())}</pubDate><description>${esc(p.summary)}</description>${p.category ? `<category>${esc(p.category)}</category>` : ''}</item>`).join('')}</channel></rss>`,
      );
  });
  app.get('/blog/sitemap.xml', (_req, reply) => {
    const ctx = context(),
      posts = allPosts(),
      base = (ctx.settings.baseUrl || config.origin).replace(/\/$/, '');
    const paths = [
      '/blog',
      '/blog/-/articles',
      '/blog/-/collections',
      '/blog/about',
      '/blog/archive',
      ...ctx.design.collections.map((c) => '/blog/-/collections/' + encodeURIComponent(c.slug)),
    ];
    return reply
      .header('Cache-Control', 'no-store')
      .type('application/xml; charset=utf-8')
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map((path) => `<url><loc>${esc(base + path)}</loc></url>`).join('')}${posts.map((p) => `<url><loc>${esc(base + p.url)}</loc><lastmod>${esc(p.updatedAt)}</lastmod></url>`).join('')}</urlset>`,
      );
  });
  app.get('/blog/reader.js', (_req, reply) => {
    context();
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .type('application/javascript; charset=utf-8')
      .send(blogReaderScript);
  });
  app.get<{ Params: { hash: string } }>('/blog/media/:hash', (req, reply) =>
    sendResource(reply, publicService().publicDesignMedia(req.params.hash)),
  );
  app.get<{ Params: { post: string; version: string; hash: string } }>(
    '/blog/assets/:post/:version/:hash',
    (req, reply) =>
      sendResource(
        reply,
        publicService().publicResource(req.params.post, req.params.version, req.params.hash),
      ),
  );
  app.get<{ Params: { slug: string } }>('/blog/:slug', (req, reply) => {
    const ctx = context(),
      post = publicService().publicPost(req.params.slug);
    return sendPage(reply, ctx, post.title, readerHtml(ctx, post, source), post.url, post);
  });
}
