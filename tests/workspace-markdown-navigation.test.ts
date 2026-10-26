import { readFileSync } from 'node:fs';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../apps/web/api';
import * as navigation from '../apps/web/navigation';
import * as markdownLinks from '../apps/web/markdown-links';
import * as imageRequests from '../apps/web/image-requests';
import * as preferences from '../apps/web/preferences';
import * as settings from '../apps/web/settings';
import * as format from '../apps/web/markdown-format';
import * as drafts from '../apps/web/drafts';
import * as search from '../apps/web/search-results';
import * as outline from '../apps/web/document-outline';
import { previewSource } from '../apps/web/preview-source';
import * as collectionFeed from '../apps/web/collection-feed';
import * as blogWorkbench from '../apps/web/blog-workbench';
import * as blogDiagrams from '../apps/web/blog-diagrams';
import { markdownStyles } from '../shared/markdown-styles';
import { markdownTasks } from '../shared/markdown-tasks';
import { diagramFences } from '../shared/diagram-fences';
import * as whiteboard from '../shared/whiteboard';
import * as editorCompatibility from '../apps/web/editor/compatibility';
import * as assetBookmarks from '../apps/web/editor/asset-bookmark';
import * as keyboardShortcuts from '../apps/web/editor/keyboard-shortcuts';
import * as viewTransitions from '../apps/web/editor/view-transitions';
import * as knowledgeMarkdown from '../shared/knowledge-markdown';
import * as editorSnippets from '../shared/editor-snippets';
import * as diagramEdits from '../apps/web/editor/diagram-edits';
import * as uploadQueue from '../apps/web/editor/upload-queue';
import * as diagramPortability from '../shared/diagram-portability';
import * as portableFigure from '../shared/portable-figure';
import * as frontmatterRange from '../shared/frontmatter-range';
import * as diagramSavePolicy from '../apps/web/diagrams/save-policy';
import { useNoteDraft as realNoteDraft } from '../apps/web/useNoteDraft';

const mockApi = vi.fn();
let parseCount = 0;
let sanitizeCount = 0;
let parseMs = 0;
function AuditMarkdown(...args: any[]) {
  const md = new (MarkdownIt as any)(...args);
  const parse = md.parse.bind(md);
  md.parse = (...input: any[]) => {
    const started = performance.now();
    parseCount++;
    const result = parse(...input);
    parseMs += performance.now() - started;
    return result;
  };
  return md;
}

const cleanups: (() => void)[] = [];
const original = {
  id: 'note-one',
  relativePath: '00-Inbox/one.md',
  title: 'One',
  content: '# Old',
  modifiedAt: 'base-one',
};
const meta = { ...original, editorMode: 'full', sizeBytes: 5 };
let state: any;
let realDraftLifecycle = false;
let flush: ReturnType<typeof vi.fn>, clearSaved: ReturnType<typeof vi.fn>;
const descriptor = parse(
  readFileSync(new URL('../apps/web/components/Workspace.vue', import.meta.url), 'utf8'),
).descriptor;
const compiled = compileScript(descriptor, { id: 'workspace-save-recovery' });
const source = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
async function mount(waitForNote = true) {
  const output: { exports: any } = { exports: {} };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id.endsWith('.css')) return {};
      if (id === '../../../shared/diagram-fences') return { diagramFences };
      if (id === '../../../shared/knowledge-markdown') return knowledgeMarkdown;
      if (id === '../../../shared/editor-snippets') return editorSnippets;
      if (id === '../../../shared/diagram-portability') return diagramPortability;
      if (id === '../../../shared/portable-figure') return portableFigure;
      if (id === '../../../shared/frontmatter-range') return frontmatterRange;
      if (id === '../editor/diagram-edits') return diagramEdits;
      if (id === '../editor/upload-queue') return uploadQueue;
      if (id === '../diagrams/save-policy') return diagramSavePolicy;
      if (id === '../../../shared/whiteboard') return whiteboard;
      if (id === '../whiteboards/diagrams')
        return { syncDiagrams: vi.fn(), clearDiagrams: vi.fn() };
      if (id === 'markdown-it') return { default: AuditMarkdown, __esModule: true };
      if (id === 'dompurify')
        return {
          default: {
            sanitize: (value: string) => {
              sanitizeCount++;
              return value;
            },
          },
          __esModule: true,
        };
      if (id === '../../../shared/markdown-styles') return { markdownStyles };
      if (id === '../../../shared/markdown-tasks') return { markdownTasks };
      if (id === '../editor/compatibility') return editorCompatibility;
      if (id === '../editor/asset-bookmark') return assetBookmarks;
      if (id === '../editor/keyboard-shortcuts') return keyboardShortcuts;
      if (id === '../editor/view-transitions') return viewTransitions;
      if (id === '../editor/toolbar-state') return format;
      if (id === '../api') return { api: mockApi, ApiError, resetCsrf: vi.fn() };
      if (id === '../navigation') return navigation;
      if (id === '../markdown-links') return markdownLinks;
      if (id === '../image-requests') return imageRequests;
      if (id === '../preferences') return preferences;
      if (id === '../settings') return settings;
      if (id === '../markdown-format') return format;
      if (id === '../drafts') return drafts;
      if (id === '../search-results') return search;
      if (id === '../document-outline') return outline;
      if (id === '../preview-source') return { previewSource };
      if (id === '../collection-feed') return collectionFeed;
      if (id === '../blog-workbench') return blogWorkbench;
      if (id === '../blog-diagrams') return blogDiagrams;
      if (id === '../plugins')
        return {
          refreshPlugins: async () => {},
          disposePluginUIs: async () => {},
          pluginRegistry: Vue.ref([]),
        };
      if (id === '../git-sync') return { gitUnsaved: Vue.ref(false) };
      if (id === '../plugin-drafts') return { clearPluginDrafts: vi.fn() };
      if (id === '../useNoteDraft')
        return {
          useNoteDraft: (context: any, restore: any) =>
            realDraftLifecycle
              ? realNoteDraft(context, restore)
              : {
                  scope: Vue.ref(),
                  recovered: Vue.ref(),
                  loading: Vue.ref(false),
                  busy: Vue.ref(false),
                  error: Vue.ref(''),
                  savedAt: Vue.ref(),
                  setup: vi.fn(),
                  prepare: vi.fn(),
                  load: async () => {},
                  flush,
                  clearSaved,
                  discard: vi.fn(),
                  restore: vi.fn(),
                  logout: vi.fn(),
                },
        };
      if (id.endsWith('.vue')) return { default: {}, __esModule: true };
      if (id === 'naive-ui' || id === 'ant-design-vue') return {};
      throw Error('Unexpected Workspace dependency: ' + id);
    },
    output,
    output.exports,
  );
  const component = output.exports.default,
    setup = component.setup;
  component.setup = (props: any, ctx: any) => {
    state = setup(props, ctx);
    return state;
  };
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp() {},
  });
  const app = renderer.createApp(component);
  app.mount({});
  cleanups.push(() => app.unmount());
  if (!waitForNote) return;
  await vi.waitFor(() => expect(state.note.value?.id).toBe(original.id));
  state.draft.value = '# Submitted';
  await Vue.nextTick();
}
beforeEach(() => {
  realDraftLifecycle = false;
  mockApi.mockReset();
  clearSaved = vi.fn(async () => {});
  flush = vi.fn(async () => 'current-local-version');
  const location = {
    href: 'http://isolated.invalid/?note=note-one',
    search: '?note=note-one',
    hash: '',
  };
  vi.stubGlobal('location', location);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  vi.stubGlobal('history', { state: {}, replaceState: vi.fn(), pushState: vi.fn() });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  mockApi.mockImplementation(async (url: string, method = 'GET') => {
    if (method === 'PUT') throw new TypeError('Failed to fetch');
    if (url === '/api/auth/get-session') return { user: { id: 'owner' } };
    if (url === '/api/platform/status') return { knowledgeRoot: '/isolated', bindingVersion: 1 };
    if (url.endsWith('/meta')) return { ...meta };
    if (url === '/api/notes/note-one') return { ...original };
    if (url === '/api/tree' || url.endsWith('/assets')) return [];
    return {};
  });
});

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  vi.unstubAllGlobals();
});

function notes() {
  state.tree.value = [
    { id: 'note-one', type: 'note', path: '00-Inbox/one.md', name: 'one.md' },
    { id: 'note-two', type: 'note', path: '00-Inbox/two.md', name: 'two.md' },
  ];
}

it('keeps real footnote anchors and external URL identity when their path matches a note', async () => {
  await mount();
  notes();
  state.mode.value = 'preview';
  state.draft.value =
    '[查看脚注](#fn1)\n\n正文[^1]\n\n[^1]: 有效目标\n\n[external](https://example.org/00-Inbox/two.md#chapter)\n\n[protocol relative](//example.org/00-Inbox/two.md)';
  await Vue.nextTick();
  expect(state.preview.value).toContain('href="#fn1"');
  expect(state.preview.value).toContain('id="fn1"');
  expect(state.preview.value).not.toContain('#note-note-one');
  expect(state.preview.value).toContain('href="https://example.org/00-Inbox/two.md#chapter"');
  expect(state.preview.value).toContain('href="//example.org/00-Inbox/two.md"');
  expect(state.preview.value).toContain('rel="noopener noreferrer"');
});

it('retains encoded cross-note fragments and renders unique heading destinations', async () => {
  await mount();
  notes();
  state.mode.value = 'preview';
  state.draft.value = '[local](two.md#%E7%AB%A0%E8%8A%82)\n\n## 章节\n\n## 章节';
  await Vue.nextTick();
  expect(state.preview.value).toContain('href="?note=note-two#%E7%AB%A0%E8%8A%82"');
  expect(state.preview.value).toContain('id="章节"');
  expect(state.preview.value).toContain('id="章节-1"');
});

it('document editor opens an external URL even when its pathname matches a local note', async () => {
  await mount();
  notes();
  const open = vi.fn();
  Object.assign(window, { open });
  state.openEditorLink('https://example.org/00-Inbox/two.md#chapter');
  expect(open).toHaveBeenCalledWith(
    'https://example.org/00-Inbox/two.md#chapter',
    '_blank',
    'noopener,noreferrer',
  );
  expect(state.note.value.id).toBe('note-one');
});

it('does no hidden preview parsing for 25 edits of a 200KiB draft and renders the latest draft on reveal', async () => {
  await mount();
  state.mode.value = 'edit';
  let content = '# Benchmark\n\n';
  while (Buffer.byteLength(content) < 200 * 1024)
    content +=
      'A paragraph with **bold**, *italic* and [external](https://example.org). '.repeat(5) +
      '\n\n';
  state.draft.value = content;
  await Vue.nextTick();
  parseCount = sanitizeCount = parseMs = 0;
  for (let i = 0; i < 25; i++) {
    state.draft.value += 'x';
    await Vue.nextTick();
  }
  console.log(
    JSON.stringify({
      mode: state.mode.value,
      bytes: Buffer.byteLength(content),
      parseCount,
      sanitizeCount,
      parseMs,
    }),
  );
  expect(parseCount).toBe(0);
  expect(sanitizeCount).toBe(0);
  state.mode.value = 'split';
  await Vue.nextTick();
  expect(state.preview.value).toContain('x'.repeat(25));
  expect(parseCount).toBe(1);
  expect(sanitizeCount).toBe(1);
  state.draft.value += 'CURRENT';
  await Vue.nextTick();
  expect(state.preview.value).toContain('CURRENT');
  expect(parseCount).toBe(2);
  expect(sanitizeCount).toBe(2);
  state.mode.value = 'edit';
  await Vue.nextTick();
  state.draft.value += 'LATEST';
  await Vue.nextTick();
  expect(parseCount).toBe(2);
  expect(sanitizeCount).toBe(2);
  state.mode.value = 'preview';
  await Vue.nextTick();
  expect(state.preview.value).toContain('LATEST');
  expect(parseCount).toBe(3);
  expect(sanitizeCount).toBe(3);
});

it('preserves encoded Markdown fragments in routes without changing line citation routes', () => {
  expect(
    navigation.readWorkspaceRoute('http://isolated.invalid/?note=note-two#%E7%AB%A0%E8%8A%82'),
  ).toEqual({ note: 'note-two', fragment: '#%E7%AB%A0%E8%8A%82' });
  expect(navigation.readWorkspaceRoute('http://isolated.invalid/?note=note-two#L12')).toEqual({
    note: 'note-two',
    line: 12,
  });
  const nav = navigation.createWorkspaceNavigation({
    dirty: () => false,
    guard: async (apply) => apply(),
    apply: async () => {},
    error: () => {},
  });
  nav.commit({ note: 'note-two', fragment: '#%E7%AB%A0%E8%8A%82' } as any);
  expect(history.pushState).toHaveBeenCalledWith(
    expect.anything(),
    '',
    'http://isolated.invalid/?note=note-two#%E7%AB%A0%E8%8A%82',
  );
  nav.dispose();
});

function targetNotes() {
  const existing = mockApi.getMockImplementation()!;
  mockApi.mockImplementation(async (url: string, method?: string) => {
    const id = /^\/api\/notes\/(note-two|note-three)(?:\/meta)?$/.exec(url)?.[1];
    if (id)
      return {
        ...original,
        id,
        relativePath: `00-Inbox/${id}.md`,
        content: '# Target\n\n## 章节\n\nDestination',
        editorMode: 'full',
        sizeBytes: 60,
      };
    return existing(url, method);
  });
}

it('same-note encoded fragment positions the current unsaved draft without reopening or asking to leave', async () => {
  await mount();
  notes();
  state.draft.value = '# Draft\n\n## 章节\n\nunsaved';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  await state.openMarkdownNote('note-one', '#%E7%AB%A0%E8%8A%82');
  expect(goToLine).toHaveBeenCalledWith(3);
  expect(state.leaveOpen.value).toBe(false);
  expect(state.draft.value).toContain('unsaved');
});

it('retains the cross-note fragment through the unsaved-draft leave confirmation', async () => {
  await mount();
  notes();
  targetNotes();
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, flush: async () => {}, cancelPendingFocus: () => {} };
  await state.openMarkdownNote('note-two', '#%E7%AB%A0%E8%8A%82');
  expect(state.leaveOpen.value).toBe(true);
  expect(state.note.value.id).toBe('note-one');
  expect(goToLine).not.toHaveBeenCalled();
  await state.leave('discard');
  expect(state.note.value.id).toBe('note-two');
  expect(goToLine).toHaveBeenCalledWith(3);
  expect(history.pushState).toHaveBeenLastCalledWith(
    expect.anything(),
    '',
    'http://isolated.invalid/?note=note-two#%E7%AB%A0%E8%8A%82',
  );
});

it('does not scroll a new note when an earlier fragment reveal resumes after a view change', async () => {
  await mount();
  state.draft.value = '# Draft\n\n## 章节';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  const pending = state.revealFragment('#%E7%AB%A0%E8%8A%82');
  state.note.value = { ...original, id: 'note-three' };
  await pending;
  expect(goToLine).not.toHaveBeenCalled();
});

it('returning within the same note route preserves an unsaved draft instead of reopening it', async () => {
  await mount();
  state.draft.value = '# Unsaved draft';
  await state.applyRoute({ note: 'note-one' });
  expect(state.leaveOpen.value).toBe(false);
  expect(state.draft.value).toBe('# Unsaved draft');
});

it('keeps the current reading pane when following a cross-note Markdown chapter', async () => {
  await mount();
  targetNotes();
  state.draft.value = state.savedContent.value;
  state.mode.value = 'preview';
  await state.openMarkdownNote('note-two', '#%E7%AB%A0%E8%8A%82');
  expect(state.mode.value).toBe('preview');
});

it('preview pure fragments commit the encoded destination without leaving or reopening the unsaved note', async () => {
  await mount();
  state.draft.value = '# Draft\n\n## 章节\n\nunsaved';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  const a = { getAttribute: () => '#%E7%AB%A0%E8%8A%82', dataset: {} };
  state.clickPreview({ target: { closest: () => a }, preventDefault: vi.fn() });
  await Vue.nextTick();
  expect(history.pushState).toHaveBeenCalledWith(
    expect.anything(),
    '',
    'http://isolated.invalid/?note=note-one#%E7%AB%A0%E8%8A%82',
  );
  expect(goToLine).toHaveBeenCalledWith(3);
  expect(state.leaveOpen.value).toBe(false);
  expect(state.draft.value).toContain('unsaved');
});

it('editor pure fragments commit the encoded destination without leaving or reopening the unsaved note', async () => {
  await mount();
  state.draft.value = '# Draft\n\n## 章节\n\nunsaved';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  state.openEditorLink('#%E7%AB%A0%E8%8A%82');
  await Vue.nextTick();
  expect(history.pushState).toHaveBeenCalledWith(
    expect.anything(),
    '',
    'http://isolated.invalid/?note=note-one#%E7%AB%A0%E8%8A%82',
  );
  expect(goToLine).toHaveBeenCalledWith(3);
  expect(state.leaveOpen.value).toBe(false);
  expect(state.draft.value).toContain('unsaved');
});

it('restores a retained unsaved note chapter after returning from settings without reloading it', async () => {
  await mount();
  state.draft.value = '# Draft\n\n## 章节\n\nunsaved';
  state.panel.value = 'settings';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  const calls = mockApi.mock.calls.length;
  await state.applyRoute({ note: 'note-one', fragment: '#%E7%AB%A0%E8%8A%82' });
  expect(state.panel.value).toBe('note');
  expect(goToLine).toHaveBeenCalledWith(3);
  expect(state.draft.value).toContain('unsaved');
  expect(state.leaveOpen.value).toBe(false);
  expect(
    mockApi.mock.calls.slice(calls).filter((call) => String(call[0]).startsWith('/api/notes/')),
  ).toEqual([]);
});

it('editor navigation distinguishes colliding heading names from the genuine footnote definition and reference', async () => {
  await mount();
  state.draft.value = '# fn1\n\n# fnref1\n\nText[^a]\n\n[^a]: Definition';
  const goToLine = vi.fn();
  state.editorRef.value = { goToLine, cancelPendingFocus: () => {} };
  await state.revealFragment('#fn1-1');
  expect(goToLine).toHaveBeenLastCalledWith(1);
  await state.revealFragment('#fnref1-1');
  expect(goToLine).toHaveBeenLastCalledWith(3);
  await state.revealFragment('#fn1');
  expect(goToLine).toHaveBeenLastCalledWith(7);
  await state.revealFragment('#fnref1');
  expect(goToLine).toHaveBeenLastCalledWith(5);
});

it('applies the editable opening state before focusing a cross-note chapter', async () => {
  await mount();
  targetNotes();
  state.draft.value = state.savedContent.value;
  const openingStates: boolean[] = [];
  state.editorRef.value = {
    goToLine: () => openingStates.push(state.noteOpening.value),
    flush: async () => {},
    cancelPendingFocus: () => {},
  };
  await state.openMarkdownNote('note-two', '#%E7%AB%A0%E8%8A%82');
  expect(openingStates).toEqual([false]);
});
