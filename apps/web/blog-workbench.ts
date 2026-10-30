import { reactive } from 'vue';
import type { TreeEntry } from '../../shared/contracts';
import type {
  BlogDashboard,
  BlogMetadata,
  BlogPost,
  BlogPostDetail,
  BlogSettings,
  BlogDiagramPreview,
} from '../../shared/blog-contracts';
import type {
  BlogDesign,
  BlogDesignState,
  BlogDesignMedia,
  BlogPublicationReview,
} from '../../shared/blog-design';
export type BlogRequest = (url: string, method?: string, body?: any) => Promise<any>;
export type BlogSection = 'overview' | 'articles' | 'taxonomy' | 'settings' | 'design';
export function blogNotePicker(tree: TreeEntry[], query: string) {
  const walk = (items: TreeEntry[]): TreeEntry[] =>
    items.flatMap((item) =>
      item.type === 'folder'
        ? walk(item.children || [])
        : item.documentType !== 'whiteboard' && item.id
          ? [item]
          : [],
    );
  const allNotes = walk(tree);
  const notes = allNotes.filter((note) => note.path.toLowerCase().includes(query.toLowerCase()));
  return { notes, sourcePath: (id: string) => allNotes.find((note) => note.id === id)?.path };
}
export function blogAttachmentPath(notePath: string, assetPath: string) {
  const folder = notePath.split('/').slice(0, -1),
    target = assetPath.split('/');
  while (folder.length && target.length && folder[0] === target[0]) {
    folder.shift();
    target.shift();
  }
  return '../'.repeat(folder.length) + target.join('/');
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function mergeDesign(local: BlogDesign, baseline: BlogDesign, remote: BlogDesign): BlogDesign {
  return {
    ...mergeDraft(local, baseline, remote),
    profile: mergeDraft(local.profile, baseline.profile, remote.profile),
  };
}
function metadata(post: BlogMetadata): BlogMetadata {
  return {
    slug: post.slug,
    title: post.title,
    summary: post.summary,
    category: post.category,
    tags: [...post.tags],
    pinned: post.pinned,
    cover: post.cover,
  };
}
const fingerprint = (value: unknown) => JSON.stringify(value);
function mergeDraft<T extends object>(local: T, baseline: T, remote: T): T {
  return Object.fromEntries(
    Object.keys(remote).map((key) => {
      const field = key as keyof T;
      return [
        key,
        fingerprint(local[field]) === fingerprint(baseline[field]) ? remote[field] : local[field],
      ];
    }),
  ) as T;
}
const errorMessage = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const unwrap = (reply: BlogPost | { post: BlogPost }): BlogPost =>
  'post' in reply ? reply.post : reply;
export function createBlogWorkbench(
  request: BlogRequest,
  prepareDiagrams?: (detail: BlogPostDetail) => Promise<BlogDiagramPreview[]>,
) {
  const state = reactive({
    design: undefined as BlogDesign | undefined,
    designState: undefined as BlogDesignState | undefined,
    designLoading: false,
    designBusy: false,
    designError: '',
    designNotice: '',
    designPreviewHtml: '',
    designPreviewBusy: false,
    designPreviewError: '',
    reviews: {} as Record<string, BlogPublicationReview>,
    reviewLoading: {} as Record<string, boolean>,
    reviewErrors: {} as Record<string, string>,
    selectedId: '',
    forms: {} as Record<string, BlogMetadata>,
    details: {} as Record<string, BlogPostDetail>,
    reading: {} as Record<string, boolean>,
    errors: {} as Record<string, string>,
    dashboard: undefined as BlogDashboard | undefined,
    settings: undefined as BlogSettings | undefined,
    loading: false,
    error: '',
    notice: '',
    busy: {} as Record<string, boolean>,
    creating: false,
    settingsBusy: false,
    settingsError: '',
    settingsNotice: '',
  });
  let designGeneration = 0,
    previewGeneration = 0;
  let savedDesign: BlogDesign | undefined;
  const reviewGeneration: Record<string, number> = {};
  const saved: Record<string, string> = {};
  const removed = new Set<string>();
  const detailGeneration: Record<string, number> = {};
  let loadGeneration = 0;
  let savedSettings: BlogSettings | undefined;
  function dirty(id = state.selectedId) {
    return !!state.forms[id] && fingerprint(state.forms[id]) !== saved[id];
  }
  function adoptPost(post: BlogPost) {
    if (state.dashboard) {
      const index = state.dashboard.posts.findIndex((item) => item.id === post.id);
      if (index < 0) state.dashboard.posts.unshift(post);
      else state.dashboard.posts[index] = post;
    }
    const reviewed = state.details[post.id];
    if (reviewed) {
      // A mutation response has no body. Only read() may replace the source
      // identity together with its complete content, HTML and diagram needs.
      const { sourceNoteId, sourceTitle, sourceModifiedAt, sourceHash } = reviewed.post;
      reviewed.post = { ...post, sourceNoteId, sourceTitle, sourceModifiedAt, sourceHash };
    }
  }
  async function load() {
    const generation = ++loadGeneration;
    state.loading = true;
    state.error = '';
    try {
      const dashboard = (await request('/api/blog')) as BlogDashboard;
      const cursors = new Set<string>();
      while (dashboard.nextCursor) {
        if (generation !== loadGeneration) return;
        const cursor = dashboard.nextCursor;
        if (cursors.has(cursor)) throw Error('文章分页已变化，请刷新重试。');
        cursors.add(cursor);
        const page = (await request(
          '/api/blog?cursor=' + encodeURIComponent(cursor),
        )) as BlogDashboard;
        dashboard.posts.push(...page.posts);
        dashboard.nextCursor = page.nextCursor;
      }
      if (generation !== loadGeneration) return;
      dashboard.posts = dashboard.posts.filter((post) => !removed.has(post.id));
      state.dashboard = dashboard;
      if (!state.settings) {
        state.settings = { ...dashboard.settings };
        savedSettings = { ...dashboard.settings };
      }
    } catch (cause) {
      if (generation === loadGeneration) state.error = errorMessage(cause);
    } finally {
      if (generation === loadGeneration) state.loading = false;
    }
  }
  async function read(id: string) {
    const generation = (detailGeneration[id] || 0) + 1;
    detailGeneration[id] = generation;
    state.reading[id] = true;
    try {
      const detail = (await request('/api/blog/posts/' + encodeURIComponent(id))) as BlogPostDetail;
      if (generation !== detailGeneration[id]) return;
      const preserve = dirty(id);
      const baseline = saved[id] ? (JSON.parse(saved[id]!) as BlogMetadata) : undefined;
      const local = state.forms[id];
      state.details[id] = detail;
      adoptPost(detail.post);
      const remote = metadata(detail.post);
      state.forms[id] =
        preserve && local && baseline ? mergeDraft(local, baseline, remote) : remote;
      saved[id] = fingerprint(remote);
      return detail;
    } finally {
      if (generation === detailGeneration[id]) state.reading[id] = false;
    }
  }
  async function select(id: string) {
    if (state.selectedId !== id) state.notice = '';
    state.selectedId = id;
    state.errors[id] = '';
    const generation = (detailGeneration[id] || 0) + 1;
    try {
      await read(id);
    } catch (cause) {
      if (generation === detailGeneration[id]) state.errors[id] = errorMessage(cause);
    }
  }
  async function create(sourceNoteId: string) {
    if (state.creating) return;
    state.creating = true;
    state.error = '';
    try {
      const post = unwrap(
        await request('/api/blog/posts', 'POST', { sourceNoteId, requestId: crypto.randomUUID() }),
      );
      adoptPost(post);
      await select(post.id);
      return post;
    } catch (cause) {
      state.error = errorMessage(cause);
    } finally {
      state.creating = false;
    }
  }
  async function action(id: string, work: () => Promise<void>) {
    if (state.busy[id]) return;
    state.busy[id] = true;
    state.errors[id] = '';
    state.notice = '';
    try {
      await work();
    } catch (cause) {
      state.errors[id] = errorMessage(cause);
    } finally {
      state.busy[id] = false;
    }
  }
  async function save() {
    const id = state.selectedId,
      detail = state.details[id],
      form = state.forms[id];
    if (!detail || !form) return;
    const snapshot = metadata(form),
      before = fingerprint(snapshot),
      version = detail.post.version;
    await action(id, async () => {
      const post = unwrap(
        await request('/api/blog/posts/' + encodeURIComponent(id), 'PATCH', {
          metadata: snapshot,
          expectedVersion: version,
          requestId: crypto.randomUUID(),
        }),
      );
      adoptPost(post);
      saved[id] = fingerprint(metadata(post));
      if (fingerprint(state.forms[id]) === before) state.forms[id] = metadata(post);
      await read(id);
      if (state.selectedId === id) state.notice = '文章信息已保存，公开版本将在手动发布后更新。';
    });
  }
  async function publish() {
    const id = state.selectedId;
    if (!state.details[id]) return;
    if (dirty(id)) {
      state.errors[id] = '请先保存文章信息，再预览并发布。';
      return;
    }
    const reviewed = { ...state.details[id]!.post };
    await action(id, async () => {
      // Re-read the source after the explicit metadata save; do not write or rewrite the note.
      const detail = await read(id);
      if (!detail) return;
      if (
        detail.post.sourceHash !== reviewed.sourceHash ||
        detail.post.sourceModifiedAt !== reviewed.sourceModifiedAt ||
        detail.post.version !== reviewed.version
      )
        throw Error('原稿或文章信息已变化，已刷新预览，请重新核对后发布。');
      if (state.selectedId !== id) throw Error('文章已切换，请返回原文章确认发布。');
      const diagrams = detail.diagramNeeds.length ? await prepareDiagrams?.(detail) : [];
      if (detail.diagramNeeds.length && !diagrams?.length)
        throw Error('请先生成图形预览，再发布。');
      if (state.selectedId !== id || dirty(id)) throw Error('文章已变化，请重新确认发布。');
      const post = unwrap(
        await request('/api/blog/publish', 'POST', {
          noteId: detail.post.sourceNoteId,
          expectedModifiedAt: detail.post.sourceModifiedAt,
          expectedContentHash: detail.post.sourceHash,
          expectedPublicationVersion: detail.post.version,
          requestId: crypto.randomUUID(),
          ...(diagrams?.length ? { diagrams } : {}),
        }),
      );
      adoptPost(post);
      if (state.selectedId === id) state.notice = '已发布当前快照。后续原稿修改需要手动发布更新。';
    });
  }
  async function withdraw() {
    const id = state.selectedId,
      post = state.details[id]?.post;
    if (!post) return;
    await action(id, async () => {
      adoptPost(
        unwrap(
          await request('/api/blog/unpublish', 'POST', {
            noteId: post.sourceNoteId,
            expectedPublicationVersion: post.version,
            requestId: crypto.randomUUID(),
          }),
        ),
      );
      if (state.selectedId === id) state.notice = '文章已下架，原稿和文章信息仍然保留。';
    });
  }
  async function remove() {
    const id = state.selectedId,
      post = state.details[id]?.post;
    if (!post) return;
    await action(id, async () => {
      await request('/api/blog/posts/' + encodeURIComponent(id), 'DELETE', {
        expectedVersion: post.version,
        requestId: crypto.randomUUID(),
      });
      removed.add(id);
      detailGeneration[id] = (detailGeneration[id] || 0) + 1;
      if (state.dashboard)
        state.dashboard.posts = state.dashboard.posts.filter((item) => item.id !== id);
      delete state.forms[id];
      delete state.details[id];
      delete state.reading[id];
      delete saved[id];
      if (state.selectedId === id) state.selectedId = '';
      state.notice = '已移除博客文章，原笔记仍保留。';
    });
  }
  async function saveSettings() {
    if (!state.settings || state.settingsBusy) return;
    state.settingsBusy = true;
    state.settingsError = '';
    state.settingsNotice = '';
    const snapshot = { ...state.settings };
    try {
      const response = await request('/api/blog/settings', 'PATCH', {
        settings: snapshot,
        requestId: crypto.randomUUID(),
      });
      const settings = (response.settings || response) as BlogSettings;
      state.settings = mergeDraft(state.settings!, snapshot, settings);
      state.settings.version = settings.version;
      savedSettings = { ...settings };
      if (state.dashboard) state.dashboard.settings = settings;
      state.settingsNotice = settings.enabled
        ? '站点已开启，已发布文章可公开访问。'
        : '站点已关闭，公开页面不可访问。';
      await load();
      if (state.selectedId) await read(state.selectedId);
    } catch (cause) {
      state.settingsError = errorMessage(cause);
    } finally {
      state.settingsBusy = false;
    }
  }
  async function reviewSettings() {
    if (!state.settings || state.settingsBusy) return;
    state.settingsBusy = true;
    state.settingsError = '';
    state.settingsNotice = '';
    try {
      const current = (await request('/api/blog/settings')) as BlogSettings;
      state.settings = mergeDraft(state.settings, savedSettings || state.settings, current);
      state.settings.version = current.version;
      savedSettings = { ...current };
      if (state.dashboard) state.dashboard.settings = current;
      state.settingsNotice = '已核对当前版本，并保留你的修改。请检查后再次保存。';
    } catch (cause) {
      state.settingsError = errorMessage(cause);
    } finally {
      state.settingsBusy = false;
    }
  }
  function designDirty() {
    return !!state.design && fingerprint(state.design) !== fingerprint(savedDesign);
  }
  function adoptDesign(remote: BlogDesignState, baseline?: BlogDesign) {
    state.design =
      state.design && baseline
        ? mergeDesign(state.design, baseline, remote.draft)
        : clone(remote.draft);
    savedDesign = clone(remote.draft);
    state.designState = remote;
  }
  async function loadDesign() {
    if (state.designBusy) return;
    const generation = ++designGeneration;
    state.designLoading = true;
    state.designError = '';
    try {
      const remote = (await request('/api/blog/design')) as BlogDesignState;
      if (generation === designGeneration) adoptDesign(remote, savedDesign);
    } catch (cause) {
      if (generation === designGeneration) state.designError = errorMessage(cause);
    } finally {
      if (generation === designGeneration) state.designLoading = false;
    }
  }
  async function designAction(work: () => Promise<void>) {
    if (state.designBusy || !state.designState || !state.design) return;
    ++designGeneration;
    state.designLoading = false;
    state.designBusy = true;
    state.designError = '';
    state.designNotice = '';
    try {
      await work();
    } catch (cause) {
      state.designError = errorMessage(cause);
    } finally {
      state.designBusy = false;
    }
  }
  async function saveDesign() {
    if (!state.design || !state.designState) return;
    const snapshot = clone(state.design),
      version = state.designState.version;
    await designAction(async () => {
      const remote = (await request('/api/blog/design', 'PATCH', {
        design: snapshot,
        expectedVersion: version,
        requestId: crypto.randomUUID(),
      })) as BlogDesignState;
      adoptDesign(remote, snapshot);
      state.designNotice = '装修草稿已保存，发布后才会更新公开主页。';
    });
  }
  async function publishDesign() {
    if (designDirty()) {
      state.designError = '请先保存装修草稿，再确认发布。';
      return;
    }
    const baseline = state.design && clone(state.design);
    await designAction(async () => {
      const remote = (await request('/api/blog/design/publish', 'POST', {
        expectedVersion: state.designState!.version,
        requestId: crypto.randomUUID(),
      })) as BlogDesignState;
      adoptDesign(remote, baseline);
      state.designNotice = '主页装修已发布。';
    });
  }
  async function restoreDesign(revision: number) {
    if (designDirty()) {
      state.designError = '请先保存当前装修草稿，再恢复历史版本。';
      return;
    }
    const baseline = state.design && clone(state.design);
    await designAction(async () => {
      const remote = (await request('/api/blog/design/restore', 'POST', {
        revision,
        expectedVersion: state.designState!.version,
        requestId: crypto.randomUUID(),
      })) as BlogDesignState;
      adoptDesign(remote, baseline);
      state.designNotice = '历史版本已恢复到草稿，预览并发布后生效。';
    });
  }
  async function previewDesign() {
    if (!state.design) return;
    const generation = ++previewGeneration,
      design = clone(state.design);
    state.designPreviewBusy = true;
    state.designPreviewError = '';
    try {
      const result = await request('/api/blog/design/preview', 'POST', { design });
      if (generation === previewGeneration) state.designPreviewHtml = result.html;
    } catch (cause) {
      if (generation === previewGeneration) state.designPreviewError = errorMessage(cause);
    } finally {
      if (generation === previewGeneration) state.designPreviewBusy = false;
    }
  }
  async function uploadDesignMedia(file: File): Promise<BlogDesignMedia> {
    if (file.size > 5 * 1024 ** 2) throw Error('图片不能超过 5 MiB');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    // Bounded chunks avoid overflowing the browser argument stack on large images.
    for (let offset = 0; offset < bytes.length; offset += 32 * 1024)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
    return request('/api/blog/design/media', 'POST', {
      name: file.name,
      mime: file.type,
      base64: btoa(binary),
      requestId: crypto.randomUUID(),
    });
  }
  async function noteAssets(noteId: string) {
    return request('/api/notes/' + encodeURIComponent(noteId) + '/assets') as Promise<
      { id: string; relativePath: string; mime: string; markdownPath?: string }[]
    >;
  }
  function setCover(id: string, cover: string | null) {
    const form = state.forms[id];
    if (form) form.cover = cover;
  }
  async function uploadCover(noteId: string, file: File) {
    const body = new FormData();
    body.append('file', file);
    return request(
      '/api/notes/' + encodeURIComponent(noteId) + '/assets',
      'POST',
      body,
    ) as Promise<{ markdownPath: string }>;
  }
  async function review(id = state.selectedId) {
    if (!id) return;
    const generation = (reviewGeneration[id] || 0) + 1;
    reviewGeneration[id] = generation;
    state.reviewLoading[id] = true;
    state.reviewErrors[id] = '';
    try {
      const result = (await request(
        '/api/blog/posts/' + encodeURIComponent(id) + '/review',
      )) as BlogPublicationReview;
      if (generation === reviewGeneration[id]) state.reviews[id] = result;
    } catch (cause) {
      if (generation === reviewGeneration[id]) state.reviewErrors[id] = errorMessage(cause);
    } finally {
      if (generation === reviewGeneration[id]) state.reviewLoading[id] = false;
    }
  }
  return {
    state,
    loadDesign,
    saveDesign,
    publishDesign,
    restoreDesign,
    previewDesign,
    designDirty,
    uploadDesignMedia,
    noteAssets,
    uploadCover,
    setCover,
    review,
    load,
    select,
    create,
    save,
    publish,
    withdraw,
    remove,
    saveSettings,
    reviewSettings,
    dirty,
  };
}
export type BlogWorkbench = ReturnType<typeof createBlogWorkbench>;
