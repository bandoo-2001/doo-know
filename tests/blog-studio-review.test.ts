import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { blogService } from '../packages/core/blog/service';
import { reviewBlogPublication } from '../packages/core/blog/review';
import { blogHash } from '../packages/core/blog/resources';
import type { Principal } from '../shared/knowledge-contracts';
import { currentBlogInstanceId } from '../packages/core/auth/permissions';

const p: Principal = {
  id: 'review-owner',
  clientId: 'browser',
  scopes: ['knowledge:read', 'knowledge:write', 'blog:publish'],
  allowedPrefixes: ['00-Inbox'],
};
let root: string,
  config: any,
  db: ReturnType<typeof openDatabase>,
  notes: ReturnType<typeof noteService>,
  blog: ReturnType<typeof blogService>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dooknow-studio-review-'));
  config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  await mkdir(join(config.knowledgeRoot, '10-Private'), { recursive: true });
  db = openDatabase(config.dataRoot);
  notes = noteService(config, db);
  blog = blogService(config, db, notes);
});
afterEach(async () => {
  db?.close();
  await rm(root, { recursive: true, force: true });
});
const draft = (name: string, content: string) => {
  const note = notes.createNote('00-Inbox', name + '.md', content);
  return { note, post: blog.createPost(p, { sourceNoteId: note.id, requestId: randomUUID() }) };
};
const review = (id: string, principal = p) =>
  reviewBlogPublication(config, db, notes, principal, id, blog);

it('diagnoses real Markdown and wikilinks, ignores code/frontmatter and still previews a missing image', () => {
  draft('unpublished', '# Not public');
  const { post } = draft(
    'article',
    '---\nprivate: SECRET_PROPERTY\n---\n# Article\n\n[[unpublished]]\n\n[Absent](absent.md)\n\n![Missing](assets/absent.png)\n\n`[Code](code.md)`\n\n```md\n![Code](assets/code.png)\n```',
  );
  const result = review(post.id);
  expect(result.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'unpublished-link', target: 'unpublished.md' }),
      expect.objectContaining({ code: 'missing-link', target: 'absent.md' }),
      expect.objectContaining({ code: 'missing-image', target: 'assets/absent.png' }),
    ]),
  );
  expect(result.warnings).toHaveLength(3);
  expect(result.draftHtml).toContain('Article');
  expect(result.draftHtml).not.toContain('SECRET_PROPERTY');
  expect(result.draftHtml).not.toContain('<img');
  expect(result.publishedHtml).toBeNull();
});

it('shows the previous public snapshot beside new source and finds articles needing republication', () => {
  const { note: target, post: targetPost } = draft('target', '# Target original');
  const { note: referring, post } = draft('referring', '# Reader\n\n[Target](target.md)');
  blog.publishNote(p, {
    noteId: referring.id,
    expectedModifiedAt: referring.modifiedAt,
    expectedContentHash: blogHash(referring.content),
    expectedPublicationVersion: post.version,
    requestId: randomUUID(),
  });
  expect(review(targetPost.id).affectedPosts).toEqual([
    expect.objectContaining({ id: post.id, title: 'Reader' }),
  ]);
  blog.publishNote(p, {
    noteId: target.id,
    expectedModifiedAt: target.modifiedAt,
    expectedContentHash: blogHash(target.content),
    expectedPublicationVersion: targetPost.version,
    requestId: randomUUID(),
  });
  notes.saveNote(target.id, '# New unpublished body', target.modifiedAt);
  const result = review(targetPost.id);
  expect(result.publishedHtml).toContain('Target original');
  expect(result.draftHtml).toContain('New unpublished body');
});

it('does not distinguish existence outside directory authorization or expose unauthorized backlinks', () => {
  notes.createNote('10-Private', 'secret.md', '# HIDDEN_TITLE');
  const { post } = draft(
    'source',
    '# Public\n\n[Restricted](../10-Private/secret.md)\n\n[Absent](../10-Private/absent.md)',
  );
  const result = review(post.id);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings[0]?.code).toBe(result.warnings[1]?.code);
  expect(result.warnings[0]?.message).toBe(result.warnings[1]?.message);
  expect(JSON.stringify(result)).not.toContain('HIDDEN_TITLE');
  expect(() => review(post.id, { ...p, allowedPrefixes: ['10-Private'] })).toThrow();
});

it('does not reveal publication state beyond a selected blog article grant', () => {
  const target = draft('restricted-target', '# Other blog draft');
  const { post } = draft('allowed', '# Allowed\n\n[Other](restricted-target.md)');
  const selected: Principal = {
    ...p,
    pluginId: 'mcp',
    policyVersion: 2,
    scopes: ['knowledge:read', 'blog:read'],
    permissionPolicy: {
      version: 2,
      domains: {
        knowledge: {
          enabled: true,
          ownerId: p.id,
          instanceId: 'test-library',
          actions: ['read'],
          resources: { mode: 'all' },
        },
        blog: {
          enabled: true,
          ownerId: p.id,
          instanceId: currentBlogInstanceId(db),
          actions: ['read'],
          resources: { mode: 'selected', resources: [{ kind: 'post', id: post.id }] },
        },
      },
    },
  };
  expect(() => blog.postMetadata(selected, target.post.id)).toThrow();
  const result = review(post.id, selected);
  expect(result.warnings).toEqual([
    expect.objectContaining({
      code: 'missing-link',
      message: '引用不存在或不在授权范围内，发布时将显示为文字。',
    }),
  ]);
});

it('never resolves a published target URL outside source-directory authorization into the diagnostic preview', () => {
  const target = notes.createNote('10-Private', 'target.md', '# Confidential');
  blog.publishNote(
    { ...p, allowedPrefixes: ['00-Inbox', '10-Private'] },
    {
      noteId: target.id,
      expectedModifiedAt: target.modifiedAt,
      expectedContentHash: blogHash(target.content),
      expectedPublicationVersion: 0,
      metadata: { slug: 'private-target-blog-slug' },
      requestId: randomUUID(),
    },
  );
  const { post } = draft('source-only', '# Allowed\n\n[Restricted](../10-Private/target.md)');
  const result = review(post.id);
  expect(result.warnings).toEqual([expect.objectContaining({ code: 'missing-link' })]);
  expect(result.draftHtml).not.toContain('private-target-blog-slug');
});
