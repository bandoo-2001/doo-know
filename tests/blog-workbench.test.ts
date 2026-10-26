import { describe, expect, test } from 'vitest';
import { readWorkspaceRoute } from '../apps/web/navigation';
import { createBlogWorkbench } from '../apps/web/blog-workbench';
import type {
  BlogMetadata,
  BlogPost,
  BlogPostDetail,
  BlogSettings,
} from '../shared/blog-contracts';
const metadata: BlogMetadata = {
  slug: 'a',
  title: 'Article A',
  summary: '',
  category: '',
  tags: [],
  pinned: false,
  cover: null,
};
const settings: BlogSettings = {
  version: 0,
  enabled: false,
  title: 'My blog',
  description: '',
  author: '',
  baseUrl: '',
  about: '',
  theme: 'system',
};
function detail(id = 'a', version = 1): BlogPostDetail {
  const post: BlogPost = {
    ...metadata,
    id,
    sourceNoteId: 'note-' + id,
    sourceTitle: 'Source ' + id,
    sourceModifiedAt: 'mtime-' + version,
    sourceHash: 'hash-' + version,
    version,
    state: 'draft',
    publishedVersionId: null,
    publishedAt: null,
    updatedAt: '',
    hasUnpublishedChanges: false,
    url: null,
  };
  return {
    post,
    sourceContent: '# Source',
    previewHtml: '<h1>Source</h1>',
    headings: [],
    diagramNeeds: [],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

test('a first detail read exposes pending and retryable failure states without inventing a reviewed body', async () => {
  const pending = deferred<BlogPostDetail>();
  let reads = 0;
  const model = createBlogWorkbench(async () => (++reads === 1 ? pending.promise : detail()));
  const selecting = model.select('a');
  expect(model.state.reading?.a).toBe(true);
  expect(model.state.details.a).toBeUndefined();
  pending.reject(Error('Temporary detail failure'));
  await selecting;
  expect(model.state.reading.a).toBe(false);
  expect(model.state.errors.a).toBe('Temporary detail failure');
  expect(model.state.details.a).toBeUndefined();
  await model.select('a');
  expect(model.state.reading.a).toBe(false);
  expect(model.state.errors.a).toBe('');
  expect(model.state.details.a?.post.sourceHash).toBe('hash-1');
});

test('an older detail completion cannot clear the newer read indicator or relabel its preview', async () => {
  const old = deferred<BlogPostDetail>(),
    latest = deferred<BlogPostDetail>();
  let reads = 0;
  const model = createBlogWorkbench(async () => (++reads === 1 ? old.promise : latest.promise));
  const first = model.select('a'),
    second = model.select('a');
  old.resolve(detail('a', 1));
  await first;
  expect(model.state.reading?.a).toBe(true);
  expect(model.state.details.a).toBeUndefined();
  latest.resolve(detail('a', 2));
  await second;
  expect(model.state.reading.a).toBe(false);
  expect(model.state.details.a?.post.sourceHash).toBe('hash-2');
});

test('an older failed selection cannot replace the latest successful read with a stale error', async () => {
  const pending = deferred<BlogPostDetail>();
  let reads = 0;
  const model = createBlogWorkbench(async () => (++reads === 1 ? pending.promise : detail('a', 2)));
  const first = model.select('a');
  await model.select('a');
  pending.reject(Error('Old failure'));
  await first;
  expect(model.state.errors.a).toBe('');
  expect(model.state.details.a?.post.sourceHash).toBe('hash-2');
});
describe('blog routes', () => {
  test('restores a blog tab without consuming the editor note route', () => {
    expect(readWorkspaceRoute('https://local/?view=apps&app=blog&appSection=articles')).toEqual({
      view: 'apps',
      app: 'blog',
      appSection: 'articles',
    });
    expect(readWorkspaceRoute('https://local/?view=apps&app=unknown&appSection=anything')).toEqual({
      view: 'apps',
    });
  });
});
describe('blog ownership and publication', () => {
  test('an older detail response cannot replace a newer selection or its unsaved form', async () => {
    const a = deferred<BlogPostDetail>();
    const model = createBlogWorkbench(async (url: string) =>
      url.endsWith('/a') ? a.promise : detail('b'),
    );
    const first = model.select('a');
    await model.select('b');
    model.state.forms.b!.title = 'Unsaved B';
    a.resolve(detail('a'));
    await first;
    expect(model.state.selectedId).toBe('b');
    expect(model.state.forms.b!.title).toBe('Unsaved B');
    await model.select('a');
    await model.select('b');
    expect(model.state.forms.b!.title).toBe('Unsaved B');
  });
  test('a publication requires an explicit metadata save and uses fresh source and record versions', async () => {
    const writes: { url: string; body: any }[] = [];
    const model = createBlogWorkbench(async (url: string, method = 'GET', body?: any) => {
      if (method !== 'GET') writes.push({ url, body });
      if (url === '/api/blog')
        return {
          settings,
          posts: [detail().post],
          total: 1,
          nextCursor: null,
          taxonomy: { categories: [], tags: [] },
        };
      if (method === 'PATCH') return detail('a', 2).post;
      if (url === '/api/blog/publish') return { ...detail('a', 3).post, state: 'published' };
      return detail('a', writes.length ? 2 : 1);
    });
    await model.load();
    await model.select('a');
    model.state.forms.a!.title = 'Edited';
    await model.publish();
    expect(writes).toHaveLength(0);
    expect(model.state.errors.a).toContain('保存');
    await model.save();
    await model.publish();
    expect(writes.map((x) => x.url)).toEqual(['/api/blog/posts/a', '/api/blog/publish']);
    expect(writes[1]!.body).toMatchObject({
      noteId: 'note-a',
      expectedModifiedAt: 'mtime-2',
      expectedContentHash: 'hash-2',
      expectedPublicationVersion: 2,
    });
    expect(writes[1]!.body.requestId).toBeTypeOf('string');
    expect(writes.some((x) => x.url.startsWith('/api/notes'))).toBe(false);
  });
  test('version conflict retains the selected article form and never automatically retries publication', async () => {
    let writes = 0;
    const model = createBlogWorkbench(async (_url: string, method = 'GET') => {
      if (method !== 'GET') {
        writes++;
        throw Error('版本冲突，请重新核对');
      }
      return detail();
    });
    await model.select('a');
    model.state.forms.a!.summary = 'Keep this draft';
    await model.save();
    expect(model.state.forms.a!.summary).toBe('Keep this draft');
    expect(model.state.errors.a).toContain('版本冲突');
    expect(writes).toBe(1);
  });
  test('a save response preserves text typed while the request was in flight', async () => {
    const pending = deferred<BlogPost>();
    const model = createBlogWorkbench(async (_url: string, method = 'GET') =>
      method === 'PATCH' ? pending.promise : detail(),
    );
    await model.select('a');
    model.state.forms.a!.title = 'First edit';
    const saving = model.save();
    model.state.forms.a!.title = 'Second edit';
    pending.resolve({ ...detail('a', 2).post, title: 'First edit' });
    await saving;
    expect(model.state.forms.a!.title).toBe('Second edit');
    expect(model.dirty('a')).toBe(true);
  });
});

test('the article collection includes subsequent dashboard pages', async () => {
  const model = createBlogWorkbench(async (url: string) => ({
    settings,
    posts: [detail(url.includes('cursor=') ? 'b' : 'a').post],
    total: 2,
    nextCursor: url.includes('cursor=') ? null : 'next-page',
    taxonomy: { categories: [], tags: [] },
  }));
  await model.load();
  expect(model.state.dashboard?.posts.map((post) => post.id)).toEqual(['a', 'b']);
});

test('a newly discovered source change is presented for review without publishing it', async () => {
  let reads = 0,
    writes = 0;
  const model = createBlogWorkbench(async (_url: string, method = 'GET') => {
    if (method !== 'GET') {
      writes++;
      return detail('a', 3).post;
    }
    return detail('a', ++reads);
  });
  await model.select('a');
  await model.publish();
  expect(writes).toBe(0);
  expect(model.state.errors.a).toContain('预览');
  expect(model.state.details.a?.post.sourceHash).toBe('hash-2');
});

test('enabling a site refreshes a selected published article public link', async () => {
  let enabled = false;
  const published = { ...detail().post, state: 'published' as const };
  const model = createBlogWorkbench(async (url: string, method = 'GET', body?: any) => {
    if (method === 'PATCH') {
      enabled = body.settings.enabled;
      return { ...settings, enabled, version: 1 };
    }
    if (url === '/api/blog')
      return {
        settings: { ...settings, enabled },
        posts: [{ ...published, url: enabled ? '/blog/a' : null }],
        total: 1,
        nextCursor: null,
        taxonomy: { categories: [], tags: [] },
      };
    return { ...detail(), post: { ...published, url: enabled ? '/blog/a' : null } };
  });
  await model.load();
  await model.select('a');
  model.state.settings!.enabled = true;
  await model.saveSettings();
  expect(model.state.details.a!.post.url).toBe('/blog/a');
});

test('switching article while PNG generation is pending cancels the pending publication intent', async () => {
  const pending = deferred<any[]>();
  let publishes = 0;
  const a = detail();
  a.diagramNeeds = [
    {
      kind: 'mermaid',
      fenceFrom: 0,
      code: 'graph TD\nA-->B',
      codeHash: 'code',
      sourceHash: 'source',
    },
  ];
  const model = createBlogWorkbench(
    async (url: string, method = 'GET') => {
      if (method === 'POST') {
        publishes++;
        return a.post;
      }
      return url.endsWith('/b') ? detail('b') : a;
    },
    () => pending.promise,
  );
  await model.select('a');
  const publication = model.publish();
  await Promise.resolve();
  await model.select('b');
  pending.resolve([
    { fenceFrom: 0, kind: 'mermaid', codeHash: 'code', sourceHash: 'source', pngBase64: 'png' },
  ]);
  await publication;
  expect(publishes).toBe(0);
  expect(model.state.selectedId).toBe('b');
  expect(model.state.errors.a).toMatch(/切换|变化/);
});

test('saving metadata refreshes source content before the next preview', async () => {
  let saved = false;
  const model = createBlogWorkbench(async (_url: string, method = 'GET') => {
    if (method === 'PATCH') {
      saved = true;
      return { ...detail('a', 2).post, title: 'Saved title' };
    }
    return {
      ...detail('a', saved ? 2 : 1),
      sourceContent: saved ? '# Updated source' : '# Original',
      post: { ...detail('a', saved ? 2 : 1).post, title: saved ? 'Saved title' : 'Article A' },
    };
  });
  await model.select('a');
  model.state.forms.a!.title = 'Saved title';
  await model.save();
  expect(model.state.details.a!.sourceContent).toBe('# Updated source');
});

test('settings conflict review preserves typed fields while explicitly adopting the current version', async () => {
  const model = createBlogWorkbench(async (url: string) =>
    url === '/api/blog/settings'
      ? { ...settings, version: 4 }
      : { settings, posts: [], total: 0, nextCursor: null, taxonomy: { categories: [], tags: [] } },
  );
  await model.load();
  model.state.settings!.title = 'Keep my settings draft';
  await model.reviewSettings();
  expect(model.state.settings!.version).toBe(4);
  expect(model.state.settings!.title).toBe('Keep my settings draft');
});

test('rechecking an article merges untouched remote fields while preserving local edits', async () => {
  let reads = 0;
  const model = createBlogWorkbench(async () => ({
    ...detail('a', ++reads),
    post: { ...detail('a', reads).post, summary: reads === 1 ? 'Old summary' : 'Remote summary' },
  }));
  await model.select('a');
  model.state.forms.a!.title = 'My local title';
  await model.select('a');
  expect(model.state.forms.a!.title).toBe('My local title');
  expect(model.state.forms.a!.summary).toBe('Remote summary');
});

test('a detail read started before removal cannot resurrect a removed article', async () => {
  const pending = deferred<BlogPostDetail>();
  let reads = 0;
  const model = createBlogWorkbench(async (url: string, method = 'GET') => {
    if (method === 'DELETE') return { deleted: true };
    if (url === '/api/blog')
      return {
        settings,
        posts: [detail().post],
        total: 1,
        nextCursor: null,
        taxonomy: { categories: [], tags: [] },
      };
    return ++reads === 1 ? detail() : pending.promise;
  });
  await model.load();
  await model.select('a');
  const reading = model.select('a');
  await model.remove();
  pending.resolve(detail());
  await reading;
  expect(model.state.dashboard?.posts).toHaveLength(0);
  expect(model.state.details.a).toBeUndefined();
});

test('a dashboard read started before removal cannot reinsert a removed list row', async () => {
  const pending = deferred<any>();
  let loads = 0;
  const dashboard = () => ({
    settings,
    posts: [detail().post],
    total: 1,
    nextCursor: null,
    taxonomy: { categories: [], tags: [] },
  });
  const model = createBlogWorkbench(async (url: string, method = 'GET') =>
    method === 'DELETE'
      ? { deleted: true }
      : url === '/api/blog'
        ? ++loads === 1
          ? dashboard()
          : pending.promise
        : detail(),
  );
  await model.load();
  await model.select('a');
  const loading = model.load();
  await model.remove();
  pending.resolve(dashboard());
  await loading;
  expect(model.state.dashboard?.posts).toHaveLength(0);
});

test('a saved metadata response cannot advance the reviewed source when its detail refresh fails', async () => {
  let reads = 0;
  const publishes: any[] = [];
  const old = {
    ...detail(),
    sourceContent: 'OLD REVIEWED BODY',
    previewHtml: '<p>OLD REVIEWED BODY</p>',
  };
  const fresh = {
    ...detail('a', 2),
    sourceContent: 'NEW UNREVIEWED BODY',
    previewHtml: '<p>NEW UNREVIEWED BODY</p>',
    post: { ...detail('a', 2).post, title: 'Saved metadata title' },
  };
  const model = createBlogWorkbench(async (url, method = 'GET', body?: any) => {
    if (method === 'PATCH') return fresh.post;
    if (url === '/api/blog/publish') {
      publishes.push(body);
      return { ...fresh.post, state: 'published', version: 3 };
    }
    if (++reads === 1) return old;
    if (reads === 2) throw Error('Preview refresh network error');
    return fresh;
  });
  await model.select('a');
  model.state.forms.a!.title = 'Saved metadata title';
  await model.save();
  expect(model.dirty('a')).toBe(false);
  expect(model.state.forms.a!.title).toBe('Saved metadata title');
  expect(model.state.errors.a).toContain('Preview refresh network error');
  expect(model.state.details.a).toMatchObject({
    sourceContent: 'OLD REVIEWED BODY',
    previewHtml: '<p>OLD REVIEWED BODY</p>',
    post: { sourceHash: 'hash-1', sourceModifiedAt: 'mtime-1', version: 2 },
  });
  await model.publish();
  expect(publishes).toHaveLength(0);
  expect(model.state.details.a).toMatchObject({
    sourceContent: 'NEW UNREVIEWED BODY',
    post: { sourceHash: 'hash-2' },
  });
  expect(model.state.errors.a).toContain('预览');
  await model.publish();
  expect(publishes).toHaveLength(1);
  expect(publishes[0]).toMatchObject({
    expectedContentHash: 'hash-2',
    expectedModifiedAt: 'mtime-2',
    expectedPublicationVersion: 2,
  });
});

test('a successful metadata save and failed refresh preserve edits typed after the save started', async () => {
  const saving = deferred<BlogPost>();
  let reads = 0;
  const model = createBlogWorkbench(async (_url, method = 'GET') => {
    if (method === 'PATCH') return saving.promise;
    if (++reads === 1) return detail();
    throw Error('Preview refresh network error');
  });
  await model.select('a');
  model.state.forms.a!.title = 'Saved title';
  const operation = model.save();
  model.state.forms.a!.summary = 'Later local edit';
  saving.resolve({ ...detail('a', 2).post, title: 'Saved title' });
  await operation;
  expect(model.state.forms.a).toMatchObject({ title: 'Saved title', summary: 'Later local edit' });
  expect(model.dirty('a')).toBe(true);
  expect(model.state.details.a!.post).toMatchObject({
    version: 2,
    sourceHash: 'hash-1',
    sourceModifiedAt: 'mtime-1',
  });
});

test('withdrawal updates publication state without relabeling an older reviewed body with a newer source identity', async () => {
  const old = {
    ...detail(),
    sourceContent: 'OLD REVIEWED BODY',
    post: { ...detail().post, state: 'published' as const },
  };
  const model = createBlogWorkbench(async (_url, method = 'GET') =>
    method === 'POST' ? { ...detail('a', 2).post, state: 'withdrawn' } : old,
  );
  await model.select('a');
  await model.withdraw();
  expect(model.state.details.a).toMatchObject({
    sourceContent: 'OLD REVIEWED BODY',
    post: { state: 'withdrawn', version: 2, sourceHash: 'hash-1', sourceModifiedAt: 'mtime-1' },
  });
});
