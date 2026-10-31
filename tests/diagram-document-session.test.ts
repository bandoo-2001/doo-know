import { expect, it } from 'vitest';
import { createDocumentSession } from '../apps/web/diagrams/document-session';
import { renderPreparedDiagramDocument, diagramRendererVersions } from '../shared/diagram-primary';
import { createHash } from 'node:crypto';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const source = 'flowchart TD\nA --> B\n';
function prepared(s: string, title = '流程') {
  return {
    id: 'prep-' + hash(s),
    noteId: 'note',
    type: 'flowchart' as const,
    title,
    renderer: diagramRendererVersions.flowchart,
    config: {},
    documentHash: null,
    baselineSourceHash: null,
    sourceHash: hash(s),
    renderHash: hash('render' + s),
    previewHash: hash('png' + s),
    preview: {
      id: 'asset',
      relativePath: 'assets/p.png',
      markdownPath: 'assets/p.png',
      mime: 'image/png',
    },
    expiresAt: Date.now() + 10000,
  };
}
function fixture(overrides: Record<string, unknown> = {}) {
  const markdown = renderPreparedDiagramDocument({
    prepared: prepared(source),
    title: '流程',
    source,
    description: '说明保持原样。\n',
  });
  let disk = markdown;
  const commits: any[] = [];
  const persisted: any[] = [];
  const session = createDocumentSession(
    {
      noteId: 'note',
      type: 'flowchart',
      markdown,
      source,
      title: '流程',
      documentHash: hash(markdown),
      sourceHash: hash(source),
    },
    {
      hash,
      render: async () => new Blob(['png']),
      prepare: async (snapshot: any) => prepared(snapshot.source, snapshot.title),
      persist: async (state: any) => {
        persisted.push(structuredClone(state));
      },
      commit: async (request: any) => {
        commits.push(request);
        disk = request.markdown;
        return { id: 'note', content: disk };
      },
      resource: async () => ({
        documentHash: hash(disk),
        source: { hash: hash(commits.at(-1)?.source || source) },
      }),
      ...overrides,
    },
  );
  return {
    session,
    commits,
    persisted,
    get disk() {
      return disk;
    },
  };
}
it('keeps input typed while a fixed PNG snapshot awaits and preserves description', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fixture({
    render: async () => {
      await gate;
      return new Blob(['png']);
    },
  });
  const first = source + 'B --> C\n';
  f.session.editSource(first);
  const saving = f.session.save();
  f.session.editSource(source + 'B --> D\n');
  release();
  await saving;
  expect(f.disk).toContain('B --> C');
  expect(f.disk).toContain('说明保持原样。');
  expect(f.session.state.source).toContain('B --> D');
  expect(f.session.dirty()).toBe(true);
  expect(f.persisted.some((s) => s.pending?.markdown === f.commits[0].markdown)).toBe(true);
});
it('retries an unknown main commit with exact durable request while keeping newer input', async () => {
  let count = 0;
  const seen: any[] = [];
  let disk = '';
  const f = fixture({
    commit: async (request: any) => {
      seen.push(structuredClone(request));
      disk = request.markdown;
      if (!count++) throw Error('network');
      return { id: 'note', content: disk };
    },
    resource: async () => ({
      documentHash: hash(disk),
      source: { hash: hash(source + 'B --> C\n') },
    }),
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('network');
  f.session.editSource(source + 'B --> D\n');
  await f.session.save();
  expect(seen[1]).toEqual(seen[0]);
  expect(f.session.state.source).toContain('B --> D');
  expect(f.session.dirty()).toBe(true);
});
it('render failure retains last complete Markdown and recovery input without committing', async () => {
  const f = fixture({
    render: async () => {
      throw Error('render failed');
    },
  });
  const last = f.session.state.markdown;
  f.session.editSource('invalid mermaid');
  await expect(f.session.save()).rejects.toThrow('render failed');
  expect(f.commits).toHaveLength(0);
  expect(f.session.state.markdown).toBe(last);
  expect(f.session.state.source).toBe('invalid mermaid');
});
it('does not accept historical commit receipts as the current disk baseline', async () => {
  const f = fixture({
    resource: async () => ({ documentHash: hash('other writer'), source: { hash: hash('other') } }),
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('其他位置');
  expect(f.session.dirty()).toBe(true);
});
it('reserves creation without activating a stub when initial PNG fails', async () => {
  let commits = 0;
  const session = createDocumentSession(
    {
      noteId: 'reserved',
      intentId: 'intent',
      type: 'flowchart',
      markdown: '',
      source,
      title: '新图',
      documentHash: null,
      sourceHash: null,
    },
    {
      hash,
      render: async () => {
        throw Error('PNG');
      },
      prepare: async () => prepared(source),
      commit: async () => {
        commits++;
        return {};
      },
      persist: async () => {},
      resource: async () => {
        throw Error('not published');
      },
    },
  );
  await expect(session.save()).rejects.toThrow('PNG');
  expect(commits).toBe(0);
  expect(session.state.intentId).toBe('intent');
});

it('persists native bytes before PNG failure and rejects mismatched or legacy JSON recovery', async () => {
  const { documentDraft, restoreDocumentDraft } =
    await import('../apps/web/diagrams/document-draft');
  const state: any = {
    noteId: 'board',
    type: 'whiteboard',
    markdown: 'original Markdown',
    source: '{"type":"excalidraw","version":2,"elements":[{"id":"new"}]}',
    title: '图',
    documentHash: hash('original'),
    sourceHash: hash('old'),
  };
  const envelope = documentDraft(state);
  const record: any = { kind: 'note', content: state.source, diagram: envelope };
  expect(restoreDocumentDraft(record, state).source).toBe(state.source);
  expect(() => restoreDocumentDraft(record, { ...state, type: 'mindmap' })).toThrow('类型不匹配');
  expect(() => restoreDocumentDraft({ ...record, diagram: undefined }, state)).toThrow('旧草稿');
  expect(() => restoreDocumentDraft(record, { ...state, documentHash: hash('external') })).toThrow(
    '其他位置',
  );
});
it('a failed durable write prevents any main commit', async () => {
  let committed = 0;
  const f = fixture({
    persist: async (state: any) => {
      if (state.pending) throw Error('CAS conflict');
    },
    commit: async () => {
      committed++;
    },
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('CAS conflict');
  expect(committed).toBe(0);
  expect(f.session.state.pending?.markdown).toContain('B --> C');
});
it('keeps a title change and unknown metadata without touching description headings', async () => {
  const f = fixture();
  f.session.editMarkdown(
    f.session.state.markdown.replace('"version":1,', '"custom":{"keep":true},"version":1,') +
      '\n# 说明标题\n',
  );
  f.session.editSource(source, '新根');
  await f.session.save();
  expect(f.disk).toContain('# 新根');
  expect(f.disk).toContain('# 说明标题');
  expect(f.disk).toContain('"custom":{"keep":true}');
});
it('can abandon an unknown prepare lease and prepare newer input without main publication', async () => {
  let attempts = 0;
  const preparedSources: string[] = [];
  const f = fixture({
    prepare: async (snapshot: any) => {
      preparedSources.push(snapshot.source);
      if (!attempts++) throw Error('prepare response lost');
      return prepared(snapshot.source, snapshot.title);
    },
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('prepare response lost');
  expect(f.commits).toHaveLength(0);
  expect(f.session.state.pending).toBeUndefined();
  f.session.editSource(source + 'B --> D\n');
  await f.session.save();
  expect(preparedSources[1]).toContain('B --> D');
  expect(f.disk).toContain('B --> D');
});
it('preserves untouched H1 spelling, frontmatter, unknown render fields and prose bytes', async () => {
  const f = fixture();
  const raw =
    '---\ncustom: exact\n---\n' +
    f.session.state.markdown
      .replace('# 流程', '# `流程`')
      .replace('"config":{}', '"customRender":"keep","config":{}');
  f.session.editMarkdown(raw);
  f.session.editSource(source + 'B --> C\n');
  await f.session.save();
  expect(f.disk).toContain('# `流程`');
  expect(f.disk.startsWith('---\ncustom: exact\n---\n')).toBe(true);
  expect(f.disk).toContain('"customRender":"keep"');
  expect(f.disk.endsWith('说明保持原样。\n')).toBe(true);
});
it('a raw source edit is not overwritten when a previous render finishes', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const f = fixture({
    render: async () => {
      await gate;
      return new Blob(['png']);
    },
  });
  f.session.editSource(source + 'B --> C\n');
  const saving = f.session.save();
  const newest = f.session.state.markdown + '\n后续说明。\n';
  f.session.editMarkdown(newest);
  release();
  await saving;
  expect(f.session.state.markdown).toBe(newest);
  expect(f.session.dirty()).toBe(true);
  expect(f.disk).not.toContain('后续说明');
});
it('keeps an unresolvable raw whiteboard source link for recovery instead of replacing it with the old drawing', async () => {
  const native = '{"type":"excalidraw","version":2,"elements":[],"files":{},"appState":{}}';
  const p: any = {
    ...prepared(native),
    type: 'whiteboard',
    renderer: diagramRendererVersions.whiteboard,
    source: {
      id: 'source',
      relativePath: 'assets/source.excalidraw',
      markdownPath: 'assets/source.excalidraw',
      mime: 'application/json',
    },
  };
  const markdown = renderPreparedDiagramDocument({ prepared: p, title: '流程', source: native });
  let commits = 0;
  const session = createDocumentSession(
    {
      noteId: 'board',
      type: 'whiteboard',
      title: '流程',
      source: native,
      markdown,
      documentHash: hash(markdown),
      sourceHash: hash(native),
    },
    {
      hash,
      render: async () => new Blob(['png']),
      prepare: async () => p,
      commit: async () => {
        commits++;
      },
      resource: async () => ({ documentHash: hash(markdown), source: { hash: hash(native) } }),
      persist: async () => {},
    },
  );
  const raw = markdown.replace('assets/source.excalidraw', 'assets/unknown.excalidraw');
  session.editMarkdown(raw);
  await expect(session.save()).rejects.toThrow('原件链接');
  expect(session.state.markdown).toBe(raw);
  expect(commits).toBe(0);
});
it('does not accept a matching main file if its native source changed before the receipt was checked', async () => {
  const f = fixture({
    resource: async () => ({
      documentHash: hash(f.commits.at(-1).markdown),
      source: { hash: hash('changed native file') },
    }),
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('原件');
  expect(f.session.state.pending).toBeDefined();
  expect(f.session.dirty()).toBe(true);
});
it('keeps a known commit failure pending and never substitutes later input into that request', async () => {
  let attempts = 0;
  const seen: any[] = [];
  let disk = '';
  const f = fixture({
    commit: async (request: any) => {
      seen.push(structuredClone(request));
      if (!attempts++) throw Object.assign(Error('temporarily unavailable'), { status: 503 });
      disk = request.markdown;
      return {};
    },
    resource: async () => ({
      documentHash: hash(disk),
      source: { hash: hash(source + 'B --> C\n') },
    }),
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('temporarily unavailable');
  f.session.editSource(source + 'B --> D\n');
  await f.session.save();
  expect(seen[1]).toEqual(seen[0]);
  expect(f.session.state.source).toContain('B --> D');
  expect(f.session.dirty()).toBe(true);
});
it('never discards the only pending commit evidence while its outcome is unknown', async () => {
  const f = fixture({
    commit: async () => {
      throw Error('unknown');
    },
  });
  f.session.editSource(source + 'B --> C\n');
  await expect(f.session.save()).rejects.toThrow('unknown');
  expect(() => f.session.discard()).toThrow('提交');
  expect(f.session.state.pending).toBeDefined();
});
it('recovers the original v2 exact pending Markdown receipt without requiring newer snapshot fields', async () => {
  const { restoreDocumentDraft } = await import('../apps/web/diagrams/document-draft');
  const pendingMarkdown = renderPreparedDiagramDocument({
    prepared: prepared(source),
    title: '流程',
    source,
  });
  const state: any = {
    noteId: 'note',
    type: 'flowchart',
    source: source + 'B --> C\n',
    markdown: pendingMarkdown,
    title: '流程',
    documentHash: hash(pendingMarkdown),
    sourceHash: hash(source),
  };
  const record: any = {
    kind: 'note',
    content: state.source,
    diagram: {
      version: 2,
      documentType: 'flowchart',
      payloadFormat: 'mermaid',
      documentHash: state.documentHash,
      baselineSourceHash: state.sourceHash,
      sourceHash: null,
      payload: state.source,
      pending: {
        requestId: 'original-request',
        preparedId: 'original-prepared',
        markdown: pendingMarkdown,
      },
    },
  };
  const restored = restoreDocumentDraft(record, state);
  expect(restored.pending).toMatchObject({
    requestId: 'original-request',
    preparedId: 'original-prepared',
    markdown: pendingMarkdown,
    title: '流程',
    source,
  });
  expect(restored.source).toContain('B --> C');
});
it('replays an older whiteboard receipt and obtains its original native baseline without losing newer native input', async () => {
  const { restoreDocumentDraft, documentDraft } =
    await import('../apps/web/diagrams/document-draft');
  const native = JSON.stringify({
      type: 'excalidraw',
      version: 2,
      elements: [],
      files: {},
      appState: { viewBackgroundColor: '#ffffff' },
    }),
    latest = native.replace('#ffffff', '#fff3bf');
  const p: any = {
    ...prepared(native),
    type: 'whiteboard',
    renderer: diagramRendererVersions.whiteboard,
    source: {
      id: 'source',
      relativePath: 'assets/source.excalidraw',
      markdownPath: 'assets/source.excalidraw',
      mime: 'application/json',
    },
  };
  const markdown = renderPreparedDiagramDocument({ prepared: p, title: '流程', source: native });
  const baseline: any = {
    noteId: 'board',
    type: 'whiteboard',
    title: '流程',
    source: native,
    markdown,
    documentHash: hash(markdown),
    sourceHash: hash(native),
  };
  const draft = {
    ...documentDraft({ ...baseline, source: latest }),
    pending: { requestId: 'old-commit', preparedId: p.id, markdown },
  };
  const restored = restoreDocumentDraft(
    { kind: 'note', content: latest, diagram: draft } as any,
    baseline,
  );
  const seen: any[] = [];
  const session = createDocumentSession(baseline, {
    hash,
    render: async () => {
      throw Error('must replay without re-render');
    },
    prepare: async () => p,
    commit: async (request) => {
      seen.push(request);
    },
    resource: async () => ({
      documentHash: hash(markdown),
      source: { hash: hash(native), content: native },
    }),
    persist: async () => {},
  });
  session.restore(restored, restored.pending);
  await session.save();
  expect(seen[0]).toMatchObject({ requestId: 'old-commit', preparedId: p.id, markdown });
  expect(session.state.source).toBe(latest);
  expect(session.dirty()).toBe(true);
});
