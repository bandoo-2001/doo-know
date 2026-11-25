import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { expect, it } from 'vitest';
import { KnowledgeError } from '../packages/core/knowledge/errors.js';
import type {
  KnowledgePort,
  OfficeResearchPort,
  PluginServices,
} from '../packages/plugin-sdk/index.js';
import { createOperations, registerOperations } from '../plugins/mcp/server/operations.js';
import { hostClient } from '../plugins/mcp/server/service.js';

const principal = {
  id: 'owner',
  clientId: 'research-client',
  scopes: ['knowledge:read'],
  allowedPrefixes: ['notes'],
};
const sourceHash = 'b'.repeat(64);
const sourceRevision = 4;
const officeUrl = 'http://localhost:3020/?view=apps&app=office';
const officeMatch = {
  documentId: 'office-ledger',
  segment: 0,
  sourceHash,
  sourceRevision,
  title: 'Ledger.xlsx',
  url: officeUrl,
};
const officeResult = {
  title: officeMatch.title,
  url: officeUrl,
  text: 'Matched fiscal summary',
  metadata: {
    objectType: 'office' as const,
    documentId: officeMatch.documentId,
    fileType: 'xlsx' as const,
    location: '工作表：年度总表',
    sourceHash,
    sourceRevision,
  },
};

function makeRegistry(options: {
  officeResearch?: OfficeResearchPort;
  externalWebOrigin?: string;
}) {
  function noteInfo(noteId: string) {
    return {
      id: noteId,
      title: `Note ${noteId}`,
      relativePath: `notes/${noteId}.md`,
      url: `http://localhost:3020/?note=${noteId}`,
      sizeBytes: 20,
      modifiedAt: '42',
      contentHash: sourceHash,
      sourceRevision,
      editorMode: 'full',
      longestLineBytes: 20,
      readState: 'ready',
    };
  }
  const knowledge = {
    async search() {
      const results = ['one', 'two'].map((noteId) => {
        const { id, title, relativePath, url } = noteInfo(noteId);
        return {
          noteId: id,
          title,
          relativePath,
          url,
          matches: [
            {
              noteId,
              chunkId: 'part-0',
              title,
              relativePath,
              headingPath: [],
              startLine: 1,
              endLine: 1,
              snippet: 'Matched note',
              sourceHash,
              sourceRevision,
              matchedBy: ['text'],
            },
          ],
        };
      });
      return {
        results,
        degraded: false,
        reasons: [],
        index: { checkedAt: null, pending: 0, generation: null },
      };
    },
    async info({ noteId }: { noteId: string }) {
      return noteInfo(noteId);
    },
    async research({ noteId }: { noteId: string }) {
      const note = noteInfo(noteId);
      return {
        id: 'temporary',
        title: note.title,
        text: 'Matched note',
        url: note.url,
        metadata: {
          objectType: 'note',
          noteId,
          sourceHash,
          sourceRevision,
          modifiedAt: note.modifiedAt,
          relativePath: note.relativePath,
        },
      };
    },
  } satisfies Partial<KnowledgePort>;
  const services = {
    knowledge: knowledge as unknown as KnowledgePort,
    officeResearch: options.officeResearch,
    operations: {} as PluginServices['operations'],
  };
  return createOperations(
    { objectIdSecret: 'office-research-fixture-secret-at-least-thirty-two' },
    hostClient(
      () => services,
      () => ({ externalWebOrigin: options.externalWebOrigin }),
    ),
  );
}

it('interleaves office and note ranks and returns both kinds through standard SDK research calls', async () => {
  const registry = makeRegistry({
    externalWebOrigin: 'https://notes.example',
    officeResearch: {
      async search(input) {
        expect(input).toEqual({ query: 'fiscal', limit: 10 });
        return {
          results: [
            officeMatch,
            ...Array.from({ length: 9 }, (_, index) => ({
              ...officeMatch,
              segment: index + 1,
              title: `Ledger section ${index + 1}.xlsx`,
            })),
          ],
          degraded: false,
          reasons: [],
        };
      },
      async fetch(input) {
        expect(input).toEqual({
          documentId: officeMatch.documentId,
          segment: 0,
          sourceHash,
          sourceRevision,
        });
        return officeResult;
      },
    },
  });
  const server = new McpServer({ name: 'office-research', version: '1' });
  registerOperations(server, registry, principal);
  const client = new Client({ name: 'office-research-client', version: '1' });
  const [clientPipe, serverPipe] = InMemoryTransport.createLinkedPair();
  await server.connect(serverPipe);
  try {
    await client.connect(clientPipe);
    await client.listTools();
    const found = await client.callTool({ name: 'search', arguments: { query: 'fiscal' } });
    const { results } = found.structuredContent as {
      results: { id: string; title: string; url?: string }[];
    };
    expect(results).toHaveLength(10);
    expect(results.slice(0, 4).map((item) => item.title)).toEqual([
      'Note one',
      'Ledger.xlsx',
      'Note two',
      'Ledger section 1.xlsx',
    ]);
    expect(results[1].url).toBe('https://notes.example/?view=apps&app=office');
    const office = await client.callTool({ name: 'fetch', arguments: { id: results[1].id } });
    expect(office.structuredContent).toEqual({
      ...officeResult,
      id: results[1].id,
      url: 'https://notes.example/?view=apps&app=office',
    });
    const note = await client.callTool({ name: 'fetch', arguments: { id: results[0].id } });
    expect(note.structuredContent).toMatchObject({
      text: 'Matched note',
      metadata: { objectType: 'note' },
    });
  } finally {
    await client.close();
    await server.close();
  }
});

it('omits internal office links and rechecks version and policy for every signed fetch', async () => {
  let stale = false;
  const registry = makeRegistry({
    officeResearch: {
      async search() {
        return { results: [officeMatch], degraded: false, reasons: [] };
      },
      async fetch() {
        if (stale) throw new KnowledgeError(409, 'RESULT_STALE', 'private old office version');
        return officeResult;
      },
    },
  });
  const found = await registry.execute('search', principal, { query: 'fiscal' });
  const id = (found.results as { id: string }[])[1].id;
  expect(found.reasons).toContain('EXTERNAL_WEB_ORIGIN_REQUIRED');
  expect(JSON.stringify(found)).not.toContain('localhost');
  await expect(registry.execute('fetch', principal, { id })).resolves.not.toHaveProperty('url');
  await expect(
    registry.execute('fetch', { ...principal, clientId: 'other' }, { id }),
  ).rejects.toMatchObject({ code: 'RESULT_STALE' });
  stale = true;
  await expect(registry.execute('fetch', principal, { id })).rejects.toMatchObject({
    code: 'RESULT_STALE',
  });
  await expect(makeRegistry({}).execute('fetch', principal, { id })).rejects.toMatchObject({
    code: 'RESULT_STALE',
  });
});

it('keeps note search working with an older host or a narrower office grant', async () => {
  const search = () => {
    throw new KnowledgeError(403, 'FORBIDDEN', 'private office restriction');
  };
  const old = makeRegistry({ externalWebOrigin: 'https://notes.example' });
  const narrow = makeRegistry({
    externalWebOrigin: 'https://notes.example',
    officeResearch: { search, fetch: search },
  });
  const args = { query: 'fiscal' };
  const plain = await old.execute('search', principal, args);
  const restricted = await narrow.execute('search', principal, args);
  expect(restricted).toMatchObject({ degraded: false, reasons: [], omitted: 0 });
  expect((restricted.results as { title: string }[]).map((item) => item.title)).toEqual(
    (plain.results as { title: string }[]).map((item) => item.title),
  );
});

it('counts office fetch bytes as UTF-8 before returning text', async () => {
  const registry = makeRegistry({
    officeResearch: {
      async search() {
        return { results: [officeMatch], degraded: false, reasons: [] };
      },
      async fetch() {
        return { ...officeResult, text: '账'.repeat(5500) };
      },
    },
  });
  const found = await registry.execute('search', principal, { query: 'fiscal' });
  const id = (found.results as { id: string }[])[1].id;
  await expect(registry.execute('fetch', principal, { id })).rejects.toMatchObject({
    code: 'INVALID_BACKEND_RESPONSE',
  });
});
