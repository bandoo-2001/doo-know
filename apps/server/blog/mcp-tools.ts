import { randomUUID } from 'node:crypto';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { BlogMetadata, BlogPost, BlogSettings } from '../../../shared/blog-contracts.js';
import type { McpManagedDomainPort, McpTransferBinding, McpTransferInfo } from '../../../shared/mcp-domain-tools.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { McpDomainContext } from '../plugins/mcp-domain-context.js';
import { blogToolDefinition, blogToolVersionMetadata } from '../../../shared/mcp-blog-tools.js';
import { BlogError } from '../../../packages/core/blog/errors.js';
import { blogHash, authorizeBlogPath } from '../../../packages/core/blog/resources.js';
import { authorizeDomainResource, currentBlogInstanceId } from '../../../packages/core/auth/permissions.js';

function byteSlice(value: string, offset: number, maxBytes: number) {
  const bytes = Buffer.from(value);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new BlogError(400, '文本偏移需要位于 UTF-8 字符边界');
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(offset, end).toString(), end, total: bytes.length };
}
function boundedMetadata(value: BlogMetadata) {
  const truncatedMetadata: ('summary' | 'category' | 'tags' | 'cover')[] = [];
  const bound = (field: 'summary' | 'category' | 'cover', text: string, max: number) => {
    const result = byteSlice(text, 0, max);
    if (result.end < result.total) truncatedMetadata.push(field);
    return result.text;
  };
  const tags = value.tags.map(tag => byteSlice(tag, 0, 80).text);
  if (tags.some((tag, index) => tag !== value.tags[index])) truncatedMetadata.push('tags');
  return { metadata: { ...value, summary: bound('summary', value.summary, 1024), category: bound('category', value.category, 80), tags, cover: value.cover === null ? null : bound('cover', value.cover, 2048) }, truncatedMetadata };
}
function boundedPost(value: BlogPost) {
  const result = boundedMetadata(value);
  return { ...value, ...result.metadata, truncatedMetadata: result.truncatedMetadata };
}
function settingsPage(value: BlogSettings, offset = 0, maxBytes = 4096) {
  const { about, ...settings } = value;
  const page = byteSlice(about, offset, maxBytes);
  return { ...settings, about: page.text, aboutBytes: page.total, aboutHash: blogHash(about), aboutRange: { startByte: offset, endByte: page.end, nextByte: page.end < page.total ? page.end : null } };
}
const transferResult = (value: McpTransferInfo) => value;
export function createBlogToolPort(context: McpDomainContext): McpManagedDomainPort {
  const { runtime, transfers } = context;
  const blog = runtime.blog;
  const auth = (scopes: string[], options?: ServiceCallOptions) => context.authorize(['knowledge:read', 'blog:read', ...scopes], options);
  const currentBinding = (p: Principal, id: string, kind: string, metadata?: McpTransferBinding['metadata']): McpTransferBinding => {
    const post = blog.postMetadata(p, id);
    return { domain: 'blog', kind, id, revision: `${post.version}:${post.sourceHash}`, ...(metadata ? { metadata } : {}) };
  };
  const siteBinding = (p: Principal, kind: string): McpTransferBinding => ({ domain: 'blog', kind, id: currentBlogInstanceId(context.db), revision: String(blog.settings(p).version) });
  function authorizeTransfer(binding: McpTransferBinding, write: boolean, options?: ServiceCallOptions, state?: McpTransferInfo['state']) {
    if (binding.domain !== 'blog' || !['about-upload','about-download','resource-download','content-download','diagram-png'].includes(binding.kind)) throw new BlogError(403, '传输不属于博客');
    const site = binding.kind === 'about-upload' || binding.kind === 'about-download';
    const scopes = write ? [binding.kind === 'about-upload' ? 'blog:manage' : 'blog:publish'] : [];
    const p = auth(scopes, options);
    const expected = site ? siteBinding(p, binding.kind) : currentBinding(p, binding.id, binding.kind);
    if (site) authorizeDomainResource(p, 'blog', write ? 'manage' : 'read');
    else if (write) authorizeDomainResource(p, 'blog', 'publish', binding.id);
    if (expected.id !== binding.id || (state !== 'completed' && expected.revision !== binding.revision)) throw new BlogError(409, '传输关联的文章或设置已变化');
    // Source-resource reads additionally recheck linked attachment/whiteboard grants.
    if (binding.kind === 'resource-download') blog.managedResource(p, binding.id, String(binding.metadata?.hash || ''), typeof binding.metadata?.versionId === 'string' ? binding.metadata.versionId : undefined);
    if (binding.kind === 'content-download') {
      if (binding.metadata?.contentKind === 'preview_html') {
        if (blogHash(blog.postDetail(p, binding.id).previewHtml) !== binding.metadata.contentHash) throw new BlogError(409, '预览资源已变化');
      }
      if (binding.metadata?.contentKind === 'diagram_source') {
        const need = blog.previewSnapshot(p, binding.id).needs.find(item => item.fenceFrom === binding.metadata?.fenceFrom);
        if (!need || need.sourceHash !== binding.metadata.sourceHash) throw new BlogError(409, '图块源版本已变化');
      }
      if (typeof binding.metadata?.versionId === 'string') blog.managedVersion(p, binding.id, binding.metadata.versionId);
    }
    return p;
  }
  return {
    authorizeTransfer,
    async call(name, input, options) {
      const definition = blogToolDefinition(name);
      if (!definition) throw new BlogError(400, '博客工具不存在');
      const parsed = definition.input.safeParse(input);
      if (!parsed.success) throw new BlogError(400, '博客工具参数格式不正确');
      const a: any = parsed.data;
      const p = auth(definition.scope === 'blog:read' ? [] : [definition.scope], options);
      let result: unknown;
      switch (name) {
        case 'list_blog_taxonomy': result = blog.listTaxonomy(p, a); break;
        case 'list_blog_posts': result = blog.listPosts(p, a); break;
        case 'get_blog_post': result = boundedPost(blog.postMetadata(p, a.postId)); break;
        case 'create_blog_draft': result = boundedPost(blog.createPost(p, a)); break;
        case 'update_blog_draft': result = boundedPost(blog.updatePost(p, a.postId, a)); break;
        case 'delete_blog_post': result = blog.deletePost(p, a.postId, a); break;
        case 'get_blog_settings': result = settingsPage(blog.settings(p), a.aboutOffset, a.maxBytes); break;
        case 'update_blog_settings': {
          const replay = blog.replayAction(p, 'settings', a);
          if (replay) { result = settingsPage(replay.result); break; }
          if (a.aboutTransferId && a.settings.about !== undefined) throw new BlogError(400, '关于文本只选择一种提交方式');
          const old = blog.settings(p), binding = siteBinding(p, 'about-upload');
          let about = a.settings.about;
          if (a.aboutTransferId) {
            authorizeTransfer(binding, true, options);
            const upload = transfers.readUpload(p, a.aboutTransferId, binding, a.requestId);
            try { about = new TextDecoder('utf-8', { fatal: true }).decode(upload.bytes); }
            catch { throw new BlogError(400, '关于文本需要有效 UTF-8'); }
          }
          const value = blog.updateSettings(p, { settings: { ...old, ...a.settings, ...(about === undefined ? {} : { about }), version: a.expectedVersion }, requestId: a.requestId }, a);
          result = settingsPage(value);
          if (a.aboutTransferId) transfers.complete(p, a.aboutTransferId, a.requestId, { version: value.version, enabled: value.enabled, aboutBytes: Buffer.byteLength(value.about), aboutHash: blogHash(value.about) });
          break;
        }
        case 'list_blog_versions': result = blog.listVersions(p, a.postId, a); break;
        case 'get_blog_version': {
          const value = blog.managedVersion(p, a.postId, a.versionId), metadata = boundedMetadata(value.metadata);
          result = { version: { id: value.versionId, postId: a.postId, sourceModifiedAt: value.sourceModifiedAt, sourceHash: value.sourceHash, createdAt: value.createdAt, current: value.post.publishedVersionId === a.versionId }, ...metadata, coverResource: value.coverResource, htmlBytes: Buffer.byteLength(value.html), htmlHash: blogHash(value.html), headingCount: value.headings.length };
          break;
        }
        case 'list_blog_resources': {
          const resources = blog.listResources(p, a.postId, a.versionId);
          result = { resources: resources.slice(a.offset, a.offset + a.limit), total: resources.length, nextOffset: a.offset + a.limit < resources.length ? a.offset + a.limit : null };
          break;
        }
        case 'download_blog_resource': {
          const binding = currentBinding(p, a.postId, 'resource-download', { hash: a.hash, ...(a.versionId ? { versionId: a.versionId } : {}) });
          const resource = blog.managedResource(p, a.postId, a.hash, a.versionId);
          result = transferResult(transfers.createDownload(p, { requestId: randomUUID(), binding, name: 'blog-resource', mime: resource.mime, bytes: resource.bytes }));
          break;
        }
        case 'list_blog_diagrams': {
          const post = blog.postMetadata(p, a.postId), snapshot = blog.previewSnapshot(p, a.postId);
          result = { diagrams: snapshot.needs.slice(a.offset, a.offset + a.limit).map(({ code: _code, ...need }) => need), total: snapshot.needs.length, nextOffset: a.offset + a.limit < snapshot.needs.length ? a.offset + a.limit : null, sourceHash: post.sourceHash };
          break;
        }
        case 'download_blog_content': {
          let binding: McpTransferBinding, content: string;
          let diagramSourceHash: string | undefined;
          if (a.kind === 'about') { content = blog.settings(p).about; binding = siteBinding(p, 'about-download'); }
          else {
            if (!a.postId) throw new BlogError(400, '文章 ID 不能为空');
            const post = blog.postMetadata(p, a.postId);
            binding = currentBinding(p, a.postId, 'content-download', { contentKind: a.kind, ...(a.versionId ? { versionId: a.versionId } : {}) });
            if (a.kind === 'metadata') content = JSON.stringify(post);
            else if (a.kind === 'version_html' || a.kind === 'version_metadata') {
              if (!a.versionId) throw new BlogError(400, '发布版本 ID 不能为空');
              const version = blog.managedVersion(p, a.postId, a.versionId);
              content = a.kind === 'version_html' ? version.html : JSON.stringify(blogToolVersionMetadata.parse({ ...version.metadata, coverResource: version.coverResource }));
            } else if (a.kind === 'preview_html') content = blog.postDetail(p, a.postId).previewHtml;
            else {
              const need = blog.previewSnapshot(p, a.postId).needs.find(item => item.fenceFrom === a.fenceFrom);
              if (!need) throw new BlogError(404, '图块不存在或已拥有预览');
              diagramSourceHash = need.sourceHash;
              if (need.whiteboardId) {
                const board = runtime.notes.row(need.whiteboardId); authorizeBlogPath(p, board.path);
                content = runtime.notes.getNote(need.whiteboardId).content;
              } else content = need.code;
            }
          }
          binding = { ...binding, metadata: { ...binding.metadata, contentHash: blogHash(content), ...(diagramSourceHash ? { sourceHash: diagramSourceHash, fenceFrom: a.fenceFrom } : {}) } };
          result = transferResult(transfers.createDownload(p, { requestId: randomUUID(), binding, name: 'blog-content', mime: a.kind.includes('html') ? 'text/html' : a.kind.includes('metadata') ? 'application/json' : 'text/plain', bytes: Buffer.from(content) }));
          break;
        }
        case 'begin_blog_upload': {
          let binding: McpTransferBinding;
          if (a.kind === 'about') {
            const manager = auth(['blog:manage'], options);
            authorizeDomainResource(manager, 'blog', 'manage');
            if (a.postId || a.mime !== 'text/plain' || a.byteLength > 200000) throw new BlogError(400, '关于文本上传参数不正确');
            binding = siteBinding(manager, 'about-upload');
          } else {
            if (!a.postId || a.mime !== 'image/png') throw new BlogError(400, '图块 PNG 上传需要文章 ID');
            const publisher = auth(['blog:publish'], options);
            authorizeDomainResource(publisher, 'blog', 'publish', a.postId);
            binding = currentBinding(publisher, a.postId, 'diagram-png');
          }
          if (Number(binding.revision!.split(':')[0]) !== a.expectedVersion) throw new BlogError(409, '上传关联版本已变化');
          const authorized = authorizeTransfer(binding, true, options);
          result = transferResult(transfers.beginUpload(authorized, { requestId: a.requestId, binding, name: a.kind, mime: a.mime, totalBytes: a.byteLength, sha256: a.sha256 }));
          break;
        }
        case 'publish_blog_post_with_diagrams': {
          const replay = blog.replayAction(p, 'publish', a);
          if (replay) { result = boundedPost(replay.result); break; }
          const post = blog.postMetadata(p, a.postId);
          if (post.sourceNoteId !== a.noteId) throw new BlogError(400, '文章与原文不匹配');
          const binding = currentBinding(p, a.postId, 'diagram-png');
          authorizeDomainResource(p, 'blog', 'publish', a.postId);
          const previewBytes = a.diagrams.reduce((sum: number, item: { transferId: string }) => sum + transfers.info(p, item.transferId).totalBytes, 0);
          if (previewBytes > 20 * 1024 ** 2) throw new BlogError(413, '本次发布的图块预览不能超过 20 MiB');
          const diagrams = a.diagrams.map((item: any) => {
            const { transferId, ...need } = item;
            authorizeTransfer(binding, true, options);
            const upload = transfers.readUpload(p, transferId, binding, a.requestId);
            if (upload.mime !== 'image/png') throw new BlogError(400, '图块预览需要 PNG');
            return { ...need, pngBase64: upload.bytes.toString('base64') };
          });
          result = boundedPost(blog.publishNote(p, { noteId: a.noteId, expectedModifiedAt: a.expectedModifiedAt, expectedContentHash: a.expectedContentHash, expectedPublicationVersion: a.expectedPublicationVersion, requestId: a.requestId, ...(a.metadata ? { metadata: a.metadata } : {}), diagrams }, () => auth(['blog:publish'], options), a));
          for (const item of a.diagrams) transfers.complete(p, item.transferId, a.requestId, { postId: a.postId, version: (result as BlogPost).version });
          break;
        }
        default: throw new BlogError(400, '博客工具不存在');
      }
      const output = definition.output.safeParse(result);
      if (!output.success) throw new BlogError(502, '博客工具结果格式不正确');
      return output.data as Record<string, unknown>;
    },
  };
}
