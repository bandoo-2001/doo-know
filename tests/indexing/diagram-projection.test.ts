import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase } from '../../packages/core/db.js';
import { chunkService } from '../../packages/core/indexing/chunks.js';
import { textIndexService } from '../../packages/core/indexing/text.js';
import { researchService } from '../../packages/core/search/research.js';
import { webPrincipal } from '../../packages/core/knowledge/core.js';
import { analyzer, chunks as graphChunks } from '../../packages/core/graph/analysis-content.js';
import type { TokenizerClient } from '../../packages/core/indexing/tokenizer-client.js';
import type { AppConfig } from '../../shared/contracts.js';
import type { NoteService } from '../../packages/core/notes.js';
import {
  diagramAnalysisText,
  diagramHeaderCandidate,
  diagramHeaderProbe,
  diagramTextSpans,
} from '../../shared/diagram-text-projection.js';
import { parseDiagramDocument } from '../../shared/diagram-document.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const tokenizer = {
  async split(content: string) {
    return {
      header: '',
      slices: [{ content, startByte: 0, endByte: Buffer.byteLength(content), tokenCount: 100 }],
      carryStartByte: Buffer.byteLength(content),
    };
  },
  async count(text: string[]) {
    return text.map(() => 100);
  },
  async tokenize(text: string[]) {
    return text.map((t) => t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
  },
} as unknown as TokenizerClient;
function document(type: 'whiteboard' | 'mindmap' | 'flowchart') {
  const engine = { whiteboard: 'excalidraw', mindmap: 'mind-elixir', flowchart: 'mermaid' }[type];
  const source = {
    whiteboard: '[原件](_doo-assets/scene.excalidraw)\n\n```text\n知识图谱😀连接检索\n第二行证据\n```',
    mindmap: '- 知识图谱😀\n  - 第二行证据',
    flowchart: '```mermaid\nflowchart TD\n A[知识图谱😀] --> B[第二行证据]\n```',
  }[type];
  return (
    '\ufeff---\nprivate: FRONTMATTER_SENTINEL\n---\n<!-- dooknow:document ' +
    JSON.stringify({
      version: 1,
      type,
      engine,
      render: { renderer: 'RENDERER_SENTINEL', config: {} },
    }) +
    ' -->\n\n# 实际标题\n\n<!-- dooknow:primary:start -->\n\n' +
    source +
    '\n\n![PREVIEW_SENTINEL](_doo-assets/preview.png)\n\n<!-- dooknow:primary-binding {"version":1,"sourceHash":"' +
    'a'.repeat(64) +
    '","renderHash":"' +
    'b'.repeat(64) +
    '","previewHash":"' +
    'c'.repeat(64) +
    '"} -->\n\n<!-- dooknow:primary:end -->\n\n说明中文😀需要原始引用。\n'
  ).replace(/\n/g, '\r\n');
}
async function fixture(body: string, path = 'diagram.md') {
  const root = await mkdtemp(join(tmpdir(), 'diagram-index-')),
    db = openDatabase(join(root, 'data'));
  const file = join(root, path);
  await writeFile(file, body);
  const { stat } = await import('node:fs/promises');
  const physical = await stat(file, { bigint: true });
  const hash = createHash('sha256').update(body).digest('hex');
  db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note', path);
  db.prepare(
    'INSERT INTO document_state(note_id,content_hash,source_revision,size_bytes,mtime_ns,title) VALUES(?,?,1,?,?,?)',
  ).run('note', hash, Buffer.byteLength(body), physical.mtimeNs.toString(), '实际标题');
  db.prepare(
    'INSERT INTO read_snapshots(id,note_id,source_hash,modified_at,path,size_bytes,longest_line_bytes,created_at,expires_at,principal) VALUES(?,?,?,?,?,?,0,0,?,?)',
  ).run(
    'snapshot',
    'note',
    hash,
    physical.mtimeNs.toString(),
    file,
    Buffer.byteLength(body),
    Date.now() + 60000,
    'test',
  );
  cleanup.push(async () => {
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    knowledgeRoot: root,
    dataRoot: join(root, 'data'),
    origin: 'http://test',
  } as AppConfig;
  return {
    db,
    file,
    config,
    version: { noteId: 'note', contentHash: hash, sourceRevision: 1 },
    chunks: chunkService(config, db, tokenizer),
    text: textIndexService(db, tokenizer),
  };
}
it.each(['whiteboard', 'mindmap', 'flowchart'] as const)(
  'indexes only actual %s semantic spans with exact Chinese/emoji CRLF source quotes',
  async (type) => {
    const body = document(type),
      f = await fixture(body),
      list = [];
    for await (const c of f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test'))
      list.push(c);
    const content = list.map((c) => c.content).join('\n');
    expect(content).toContain('知识图谱😀');
    expect(content).toContain('说明中文😀');
    for (const sentinel of [
      'FRONTMATTER_SENTINEL',
      'RENDERER_SENTINEL',
      'PREVIEW_SENTINEL',
      'primary-binding',
      '_doo-assets/',
      'dooknow:',
    ])
      expect(content).not.toContain(sentinel);
    for (const c of list) {
      expect(c.content).toBe(Buffer.from(body).subarray(c.startByte, c.endByte).toString());
      expect(c.startLine).toBe(
        1 +
          Buffer.from(body)
            .subarray(0, c.startByte)
            .filter((b) => b === 10).length,
      );
    }
    await f.text.stage(f.version, '实际标题', 'diagram.md', list);
    expect(f.text.publish(f.version, 'semantic-spans-v1:test')).toBe('published');
    expect(await f.text.search(webPrincipal, 'RENDERER_SENTINEL')).toHaveLength(0);
    const target = list.find((c) => c.content.includes('第二行证据'))!;
    const research = researchService(f.config, f.db, {
      row: () => ({ id: 'note', path: 'diagram.md' }),
    } as unknown as NoteService);
    const result = await research.fetch(webPrincipal, 'note', target.chunkId, {
      sourceHash: f.version.contentHash,
      sourceRevision: '1',
    });
    expect(result.text).toBe(
      Buffer.from(body).subarray(target.startByte, target.endByte).toString(),
    );
    // Chunk storage must never substitute a generated projection for the source range.
    f.db
      .prepare('UPDATE chunks SET content=? WHERE chunk_id=?')
      .run('FORGED_PROJECTION', target.chunkId);
    expect(
      (
        await research.fetch(webPrincipal, 'note', target.chunkId, {
          sourceHash: f.version.contentHash,
          sourceRevision: '1',
        })
      ).text,
    ).toBe(result.text);
  },
);
it.each(['long-yaml', 'multibyte-yaml', 'long-blank-lines'])(
  'keeps semantic exclusion after a %s header exceeds the initial read budget',
  async (kind) => {
    const original = document('flowchart'),
      body =
        kind === 'long-blank-lines'
          ? original.replace(
              '<!-- dooknow:document',
              '\r\n'.repeat(35000) + '<!-- dooknow:document',
            )
          : original.replace(
              'private: FRONTMATTER_SENTINEL',
              'private: FRONTMATTER_SENTINEL' +
                (kind === 'multibyte-yaml' ? '中'.repeat(24000) : 'x'.repeat(70000)),
            );
    expect(parseDiagramDocument(body).status).toBe('diagram');
    expect(diagramTextSpans(body)).toBeDefined();
    expect(diagramAnalysisText(body)).not.toMatch(/SENTINEL|dooknow:|assets\//);
    const f = await fixture(body),
      list = [];
    for await (const c of f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test'))
      list.push(c);
    expect(list.map((c) => c.content).join('')).not.toMatch(/SENTINEL|dooknow:|assets\//);
    expect(list.some((c) => c.content.includes('知识图谱😀'))).toBe(true);
    for (const c of list)
      expect(c.content).toBe(Buffer.from(body).subarray(c.startByte, c.endByte).toString());
    await f.text.stage(f.version, '实际标题', 'diagram.md', list);
    expect(f.text.publish(f.version, 'semantic-spans-v1:test')).toBe('published');
  },
);
it.each([
  ['\ufeff--- \t\r\nkey: value\r\n...\t\r\n\n<!-- dooknow:document {} -->', true],
  ['---\nkey: value\r---\n<!-- dooknow:document {} -->', true],
  ['---\nkey: value\u2028---\n<!-- dooknow:document {} -->', true],
  ['---\nkey: value\r---\rtext\n<!-- dooknow:document {} -->', false],
  ['---\nunterminated ' + 'x'.repeat(70000), false],
  ['---x\n<!-- dooknow:document {} -->', false],
  ['<!-- dooknow:documents {} -->', false],
  ['<!-- dooknow:document', true],
  ['\ufeffordinary ' + 'x'.repeat(70000), false],
] as const)(
  'classifies headers identically across one-character input boundaries (%#)',
  (source, expected) => {
    const probe = diagramHeaderProbe();
    for (const char of source) probe.push(char);
    expect(probe.finish()).toBe(expected);
    expect(diagramHeaderCandidate(source)).toBe(expected);
  },
);
it('requires every semantic chunk as well as a complete byte scan before publishing', async () => {
  const f = await fixture(document('whiteboard')),
    list = [];
  for await (const c of f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test')) list.push(c);
  await f.text.stage(f.version, '实际标题', 'diagram.md', list.slice(0, -1));
  expect(() => f.text.publish(f.version, 'semantic-spans-v1:test')).toThrowError(
    /INDEX_INCOMPLETE/,
  );
  await f.text.stage(f.version, '实际标题', 'diagram.md', list.slice(-1));
  expect(f.text.publish(f.version, 'semantic-spans-v1:test')).toBe('published');
});
it('rejects a snapshot whose ignored machine bytes fail the full original hash', async () => {
  const f = await fixture(document('whiteboard'));
  await writeFile(f.file, document('whiteboard').replace('RENDERER_SENTINEL', 'TAMPERED_SENTINEL'));
  const consume = async () => {
    for await (const _ of f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test')) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toThrowError(/INDEX_VERSION_CONFLICT/);
});
it('does not publish a partially consumed scan even when its staged chunk reaches EOF', async () => {
  const f = await fixture('hello'),
    iterator = f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test');
  const c = (await iterator.next()).value!;
  await f.text.stage(f.version, 'title', 'diagram.md', [c]);
  expect(() => f.text.publish(f.version, 'semantic-spans-v1:test')).toThrowError(
    /INDEX_INCOMPLETE/,
  );
  await iterator.return(undefined);
});
it('indexes a JSON example in Markdown as ordinary source without inventing native scene semantics', async () => {
  const body=JSON.stringify({type:'excalidraw',version:2,elements:[{id:'label',type:'text',text:'Example'}],files:{},appState:{}});
  const f=await fixture(body,'example.md'),list=[];
  for await(const c of f.chunks.chunkDocument('snapshot','semantic-spans-v2:test'))list.push(c);
  expect(list.map(c=>c.content).join('')).toBe(body);
  for(const c of list)expect(c.content).toBe(Buffer.from(body).subarray(c.startByte,c.endByte).toString());
});
it('extracts fenced whiteboard summary concepts with exact original evidence lines', () => {
  const body = document('whiteboard'),
    work = analyzer(body, 'diagram.md', 'note', 'a'.repeat(64), 1);
  for (const part of graphChunks(body, 12000).parts) work.local(part);
  const result = work.result();
  expect(result.entities.some((e) => e.name === '知识')).toBe(true);
  expect(result.terms.join(' ')).not.toMatch(/renderer|sentinel|primary|assets|excalidraw/);
  for (const e of result.entities)
    for (const ev of e.evidence)
      expect(
        body
          .split('\n')
          .slice(ev.startLine - 1, ev.endLine)
          .join('\n'),
      ).toContain(ev.quote);
});
it('reindexes existing diagram projections on startup and retires legacy chunks under the same UUID', async () => {
  const body = document('whiteboard'),
    f = await fixture(body);
  const list = [];
  for await (const c of f.chunks.chunkDocument('snapshot', 'old-diagram-rule')) list.push(c);
  await f.text.stage(f.version, '实际标题', 'diagram.md', list);
  f.text.publish(f.version, 'old-diagram-rule');
  // Simulate the previously shipped broad first chunk, including the machine declaration.
  f.db.prepare('UPDATE chunks SET content=? WHERE ordinal=0').run(body);
  f.db.prepare('UPDATE document_state SET vector_indexed_hash=content_hash').run();
  f.db
    .prepare(
      "INSERT INTO index_jobs(id,note_id,source_revision,source_hash,target,status,checkpoint) VALUES('old','note',1,?,'text','done',99)",
    )
    .run(f.version.contentHash);
  const { indexWorker } = await import('../../packages/core/indexing/worker.js');
  const worker = indexWorker(f.config, f.db, {} as NoteService, {} as any);
  cleanup.push(() => worker.close());
  expect(
    f.db.prepare('SELECT text_indexed_hash,vector_indexed_hash FROM document_state').get(),
  ).toEqual({ text_indexed_hash: null, vector_indexed_hash: null });
  expect(f.db.prepare("SELECT status,checkpoint FROM index_jobs WHERE id='old'").get()).toEqual({
    status: 'pending',
    checkpoint: 0,
  });
  expect((f.db.prepare('SELECT count(*) n FROM chunks WHERE active=1').get() as any).n).toBe(0);
  const next = [];
  for await (const c of f.chunks.chunkDocument('snapshot', 'semantic-spans-v1:test')) next.push(c);
  await f.text.stage(f.version, '实际标题', 'diagram.md', next);
  expect(f.text.publish(f.version, 'semantic-spans-v1:test')).toBe('published');
  expect(
    (
      f.db
        .prepare("SELECT count(*) n FROM chunks WHERE active=1 AND chunker_id='old-diagram-rule'")
        .get() as any
    ).n,
  ).toBe(0);
  expect(f.db.prepare('SELECT id FROM notes').get()).toEqual({ id: 'note' });
});
it('removes metadata and fence delimiters from model input while validating quotes against original lines', () => {
  const body = document('flowchart'),
    work = analyzer(body, 'diagram.md', 'note', 'a'.repeat(64), 1);
  const parts = graphChunks(body, 150),
    input = parts.parts.map((p) => p.text).join('');
  expect(input).toContain('A[知识图谱😀]');
  expect(input).not.toMatch(/SENTINEL|dooknow:|assets\/|```/);
  for (const part of parts.parts)
    work.enhance(
      part,
      {
        entities: [
          { name: '流程节点', kind: 'concept', aliases: [], description: '', quote: '知识图谱😀' },
        ],
        relations: [],
      },
      'test-model',
    );
  const entity = work.result().entities.find((e) => e.name === '流程节点')!;
  expect(entity).toBeDefined();
  expect(entity.evidence[0].startLine).toBe(
    body.slice(0, body.indexOf('知识图谱😀')).split('\n').length,
  );
  expect(entity.evidence[0].quote).toBe('知识图谱😀');
  // Masked spaces must not become fabricated evidence in the source document.
  const first = parts.parts[0];
  work.enhance(
    first,
    {
      entities: [
        {
          name: '虚假实体',
          kind: 'concept',
          aliases: [],
          description: '',
          quote: first.text.slice(0, 30),
        },
      ],
      relations: [],
    },
    'test-model',
  );
  expect(work.result().entities.some((e) => e.name === '虚假实体')).toBe(false);
});
it('requires raw scan proof for arbitrary chunker names instead of permitting a contiguous-coverage bypass', async () => {
  const f = await fixture('hello'),
    rule = 'arbitrary-old-rule';
  const c = {
    chunkId: 'unscanned',
    noteId: 'note',
    sourceHash: f.version.contentHash,
    chunkerId: rule,
    ordinal: 0,
    headingPath: [],
    startLine: 1,
    endLine: 1,
    startByte: 0,
    endByte: 5,
    content: 'hello',
    embeddingInput: 'hello',
    embeddingInputHash: 'input',
    tokenCount: 1,
    embeddingTokenCount: 1,
  };
  await f.text.stage(f.version, 'title', 'diagram.md', [c]);
  expect(() => f.text.publish(f.version, rule)).toThrowError(/INDEX_INCOMPLETE/);
});
it('rejects a full ordinary byte scan when the tokenizer omits searchable source bytes', async () => {
  const f = await fixture('hello world');
  const skipping = {
    ...tokenizer,
    async split(content: string) {
      return {
        header: '',
        slices: [{ content: content.slice(0, 5), startByte: 0, endByte: 5, tokenCount: 1 }],
        carryStartByte: Buffer.byteLength(content),
      };
    },
  } as unknown as TokenizerClient;
  const consume = async () => {
    for await (const _ of chunkService(f.config, f.db, skipping).chunkDocument(
      'snapshot',
      'omitted-semantic',
    )) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toThrowError(/INDEX_INCOMPLETE/);
});
it('resets old chunker resume positions once and preserves subsequent current-version checkpoints', async () => {
  const f = await fixture('ordinary text');
  f.db
    .prepare(
      "INSERT INTO index_jobs(id,note_id,source_revision,source_hash,target,status,checkpoint) VALUES('resume','note',1,?,'text','pending',99)",
    )
    .run(f.version.contentHash);
  const { indexWorker } = await import('../../packages/core/indexing/worker.js');
  const first = indexWorker(f.config, f.db, {} as NoteService, {} as any);
  await first.close();
  expect(f.db.prepare("SELECT checkpoint FROM index_jobs WHERE id='resume'").get()).toEqual({
    checkpoint: 0,
  });
  f.db.prepare("UPDATE index_jobs SET checkpoint=16 WHERE id='resume'").run();
  const second = indexWorker(f.config, f.db, {} as NoteService, {} as any);
  await second.close();
  expect(f.db.prepare("SELECT checkpoint FROM index_jobs WHERE id='resume'").get()).toEqual({
    checkpoint: 16,
  });
});
