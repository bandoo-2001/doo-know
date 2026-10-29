import { expect, test } from 'vitest';
import { createBlogWorkbench } from '../apps/web/blog-workbench';
import { defaultBlogDesign, type BlogDesignState } from '../shared/blog-design';
const snapshot = (version = 1): BlogDesignState => ({
  version,
  draft: defaultBlogDesign(),
  published: defaultBlogDesign(),
  publishedRevision: 0,
  publishedAt: null,
  hasUnpublishedChanges: false,
  history: [],
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
test('design save retains profile edits typed while saving and adopts the new version', async () => {
  const pending = deferred<BlogDesignState>();
  const model = createBlogWorkbench(async (_url, method) =>
    method === 'PATCH' ? pending.promise : snapshot(),
  );
  await model.loadDesign();
  model.state.design!.profile.name = 'Saved';
  const saving = model.saveDesign();
  model.state.design!.profile.bio = 'Typed while saving';
  const remote = snapshot(2);
  remote.draft.profile.name = 'Saved';
  pending.resolve(remote);
  await saving;
  expect(model.state.design!.profile.bio).toBe('Typed while saving');
  expect(model.state.designState!.version).toBe(2);
  expect(model.designDirty()).toBe(true);
});
test('newer design reads own pending state and preserve local edits', async () => {
  const old = deferred<BlogDesignState>(),
    fresh = deferred<BlogDesignState>();
  let reads = 0;
  const model = createBlogWorkbench(async () =>
    ++reads === 1 ? snapshot() : reads === 2 ? old.promise : fresh.promise,
  );
  await model.loadDesign();
  model.state.design!.profile.name = 'Local';
  const a = model.loadDesign(),
    b = model.loadDesign();
  old.resolve(snapshot(2));
  await a;
  expect(model.state.designLoading).toBe(true);
  fresh.resolve(snapshot(3));
  await b;
  expect(model.state.design!.profile.name).toBe('Local');
  expect(model.state.designState!.version).toBe(3);
});
test('preview sends the unsaved design and ignores superseded HTML and failures', async () => {
  const old = deferred<{ html: string }>(),
    fresh = deferred<{ html: string }>();
  let previews = 0;
  const inputs: any[] = [];
  const model = createBlogWorkbench(async (url, _method, body) => {
    if (url.endsWith('/preview')) {
      inputs.push(body);
      return ++previews === 1 ? old.promise : fresh.promise;
    }
    return snapshot();
  });
  await model.loadDesign();
  model.state.design!.profile.name = 'Unsaved';
  const a = model.previewDesign();
  model.state.design!.profile.name = 'Newest';
  const b = model.previewDesign();
  fresh.resolve({ html: '<h1>Newest</h1>' });
  await b;
  old.reject(Error('Old failure'));
  await a;
  expect(inputs[0].design.profile.name).toBe('Unsaved');
  expect(inputs[1].design.profile.name).toBe('Newest');
  expect(model.state.designPreviewHtml).toContain('Newest');
  expect(model.state.designPreviewError).toBe('');
  expect(model.designDirty()).toBe(true);
});
test('failed design writes retain edits, expose errors and never publish automatically', async () => {
  let writes = 0;
  const model = createBlogWorkbench(async (_url, method) => {
    if (method !== 'GET' && method) {
      writes++;
      throw Error('版本冲突');
    }
    return snapshot();
  });
  await model.loadDesign();
  model.state.design!.accent = '#123456';
  await model.saveDesign();
  expect(model.state.designError).toBe('版本冲突');
  expect(model.state.design!.accent).toBe('#123456');
  expect(writes).toBe(1);
  await model.publishDesign();
  expect(writes).toBe(1);
  expect(model.state.designError).toContain('保存');
});

test('history restores only to draft and preserves edits made during the request', async () => {
  const pending = deferred<BlogDesignState>();
  const writes: { url: string; body: any }[] = [];
  const model = createBlogWorkbench(async (url, method, body) => {
    if (method === 'POST') {
      writes.push({ url, body });
      return pending.promise;
    }
    return snapshot();
  });
  await model.loadDesign();
  const restoring = model.restoreDesign(3);
  model.state.design!.profile.name = 'Still typing';
  const restored = snapshot(2);
  restored.draft.profile.bio = 'Historical bio';
  pending.resolve(restored);
  await restoring;
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    url: '/api/blog/design/restore',
    body: { revision: 3, expectedVersion: 1 },
  });
  expect(model.state.design!.profile.name).toBe('Still typing');
  expect(model.state.design!.profile.bio).toBe('Historical bio');
  expect(model.designDirty()).toBe(true);
});
test('preview failure exposes retry state while retaining the last successful HTML', async () => {
  let fails = false;
  const model = createBlogWorkbench(async (url) => {
    if (url.endsWith('/preview')) {
      if (fails) throw Error('预览失败');
      return { html: '<p>Reviewed</p>' };
    }
    return snapshot();
  });
  await model.loadDesign();
  await model.previewDesign();
  fails = true;
  await model.previewDesign();
  expect(model.state.designPreviewHtml).toBe('<p>Reviewed</p>');
  expect(model.state.designPreviewError).toBe('预览失败');
  expect(model.state.designPreviewBusy).toBe(false);
});
test('publication review ignores an older failure after the latest successful review', async () => {
  const old = deferred<any>();
  let reads = 0;
  const result = {
    publishedHtml: '<p>Online</p>',
    draftHtml: '<p>Draft</p>',
    warnings: [],
    affectedPosts: [],
  };
  const model = createBlogWorkbench(async () => (++reads === 1 ? old.promise : result));
  const first = model.review('a');
  await model.review('a');
  old.reject(Error('Stale error'));
  await first;
  expect(model.state.reviews.a).toEqual(result);
  expect(model.state.reviewErrors.a).toBe('');
  expect(model.state.reviewLoading.a).toBe(false);
});
test('ordinary note cover uploads retain multipart transport', async () => {
  const calls: { url: string; method?: string; body: any }[] = [];
  const model = createBlogWorkbench(async (url, method, body) => {
    calls.push({ url, method, body });
    return { markdownPath: 'assets/cover.webp' };
  });
  const file = new File(['image'], 'cover.webp', { type: 'image/webp' });
  expect((await model.uploadCover('note/a', file)).markdownPath).toBe('assets/cover.webp');
  expect(calls.map((call) => call.url)).toEqual(['/api/notes/note%2Fa/assets']);
  expect(calls[0]!.method).toBe('POST');
  expect(calls[0]!.body).toBeInstanceOf(FormData);
  expect(calls[0]!.body.get('file')).toBe(file);
});

test('design media sends the exact JSON contract and preserves binary bytes across encoding chunks', async () => {
  const bytes = Uint8Array.from({ length: 70001 }, (_, index) => index % 256);
  let requests = 0;
  const model = createBlogWorkbench(async (url, method, body) => {
    requests++;
    expect(url).toBe('/api/blog/design/media');
    expect(method).toBe('POST');
    expect(body).toEqual({
      name: '头像.png',
      mime: 'image/png',
      base64: Buffer.from(bytes).toString('base64'),
      requestId: expect.stringMatching(/^[a-zA-Z0-9_-]{8,128}$/),
    });
    expect(Uint8Array.from(Buffer.from(body.base64, 'base64'))).toEqual(bytes);
    return {
      hash: 'hash',
      mime: 'image/png',
      url: '/blog/media/hash',
      previewUrl: '/api/blog/design/media/hash',
      size: bytes.length,
    };
  });
  expect(
    (await model.uploadDesignMedia(new File([bytes], '头像.png', { type: 'image/png' }))).url,
  ).toBe('/blog/media/hash');
  expect(requests).toBe(1);
});

test('design media rejects files over 5 MiB before issuing a request', async () => {
  let requests = 0;
  const model = createBlogWorkbench(async () => {
    requests++;
    return {};
  });
  const file = new File([new Uint8Array(5 * 1024 ** 2 + 1)], 'large.webp', { type: 'image/webp' });
  await expect(model.uploadDesignMedia(file)).rejects.toThrow('5 MiB');
  expect(requests).toBe(0);
});

test('nested article cover paths are independent of a previous note-picker search', async () => {
  const { blogNotePicker, blogAttachmentPath } = await import('../apps/web/blog-workbench');
  const tree = [
    {
      name: '00-Inbox',
      path: '00-Inbox',
      type: 'folder' as const,
      children: [
        { id: 'a', name: 'Alpha.md', path: '00-Inbox/Alpha.md', type: 'note' as const },
        { id: 'b', name: 'Beta.md', path: '00-Inbox/Beta.md', type: 'note' as const },
      ],
    },
  ];
  const picker = blogNotePicker(tree, 'Alpha');
  expect(picker.notes.map((note) => note.id)).toEqual(['a']);
  expect(picker.sourcePath('b')).toBe('00-Inbox/Beta.md');
  expect(blogAttachmentPath(picker.sourcePath('b')!, '00-Inbox/assets/cover.png')).toBe(
    'assets/cover.png',
  );
  expect(blogAttachmentPath('00-Inbox/Beta.md', 'Other/assets/cover.png')).toBe(
    '../Other/assets/cover.png',
  );
});

test('a cover upload completing after selection changes only updates its owning article', async () => {
  const pending = deferred<{ markdownPath: string }>();
  const model = createBlogWorkbench(async () => pending.promise);
  model.state.forms.a = {
    slug: 'a',
    title: 'A',
    summary: '',
    category: '',
    tags: [],
    pinned: false,
    cover: null,
  };
  model.state.forms.b = { ...model.state.forms.a, slug: 'b', title: 'B', cover: 'assets/b.png' };
  model.state.selectedId = 'a';
  const upload = model
    .uploadCover('note-a', new File(['image'], 'a.png', { type: 'image/png' }))
    .then((result) => model.setCover('a', result.markdownPath));
  model.state.selectedId = 'b';
  pending.resolve({ markdownPath: 'assets/a.png' });
  await upload;
  expect(model.state.forms.a.cover).toBe('assets/a.png');
  expect(model.state.forms.b.cover).toBe('assets/b.png');
  expect(model.state.selectedId).toBe('b');
});
