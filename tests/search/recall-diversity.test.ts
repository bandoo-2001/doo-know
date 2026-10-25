import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { TokenizerClient } from '../../packages/core/indexing/tokenizer-client.js';
import { textIndexService } from '../../packages/core/indexing/text.js';
import { reconcileService } from '../../packages/core/indexing/reconcile.js';
import { indexJobService } from '../../packages/core/indexing/jobs.js';
import { sha256 } from '../../packages/core/knowledge/operations.js';
import { noteService } from '../../packages/core/notes.js';
import { searchService } from '../../packages/core/search/service.js';
import { indexWorker } from '../../packages/core/indexing/worker.js';
import type { SearchOutput } from '../../shared/knowledge-contracts.js';

it('pages other indexed notes when an exact filename has 550 matching chunks', async () => {
  const directory = '00-Inbox/allowed';
  const f = await createFixture({
    agent: {
      ...agentConfig,
      policies: [{ ...agentConfig.policies[0], allowedPrefixes: [directory] }],
    },
    indexing: { enabled: true, watch: false },
  });
  const db = openDatabase(f.dataRoot);
  try {
    await mkdir(join(f.knowledgeRoot, directory));
    await mkdir(join(f.knowledgeRoot, '00-Inbox/allowed-other'));
    await writeFile(
      join(f.knowledgeRoot, `${directory}/recallneedle.md`),
      Array.from(
        { length: 550 },
        (_, i) => `# Section ${i}\n\nrecallneedle fragment ${i}.\n\n`,
      ).join(''),
    );
    for (let i = 0; i < 27; i++)
      await writeFile(
        join(f.knowledgeRoot, `${directory}/recallneedle-other-${i}.md`),
        '# Small note\nrecallneedle content.\n',
      );
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/allowed-other/recallneedle.md'),
      '# PRIVATE_SENTINEL\nrecallneedle hidden content.\n',
    );
    const search = (cursor?: string, freshness = 'indexed') =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders({ allowedPrefixes: [directory] }),
        payload: {
          query: 'recallneedle',
          mode: 'text',
          freshness,
          limit: 10,
          ...(cursor ? { cursor } : {}),
        },
      });
    const firstReply = await search(undefined, 'strict');
    expect(firstReply.statusCode, firstReply.body).toBe(200);
    expect(
      db
        .prepare(
          'SELECT count(*) n FROM chunks WHERE active=1 AND note_id=(SELECT id FROM notes WHERE path=?)',
        )
        .get(`${directory}/recallneedle.md`),
    ).toEqual({ n: 550 });
    const first = firstReply.json().data;
    expect(first.results).toHaveLength(10);
    expect(first.results[0].relativePath).toBe(`${directory}/recallneedle.md`);
    expect(first.results[0].matches).toHaveLength(3);
    expect(new Set(first.results[0].matches.map((m: any) => m.matchLine)).size).toBe(3);
    expect(first.nextCursor).toBeTruthy();
    expect(first.degraded).toBe(false);
    const secondReply = await search(first.nextCursor);
    expect(secondReply.statusCode, secondReply.body).toBe(200);
    const replay = (await search(first.nextCursor)).json().data;
    expect(replay.results).toEqual(secondReply.json().data.results);
    expect(replay.nextCursor).toBeTruthy();
    const thirdReply = await search(secondReply.json().data.nextCursor);
    expect(thirdReply.statusCode, thirdReply.body).toBe(200);
    const third = thirdReply.json().data;
    expect(third.results).toHaveLength(8);
    expect(third.nextCursor).toBeUndefined();
    expect(third.degraded).toBe(false);
    const results = [...first.results, ...secondReply.json().data.results, ...third.results];
    expect(new Set(results.map((r: any) => r.noteId)).size).toBe(28);
    expect(results.every((r: any) => r.relativePath.startsWith(directory + '/'))).toBe(true);
    expect(JSON.stringify(results)).not.toContain('PRIVATE_SENTINEL');
    const stalePath = first.results[1].relativePath;
    await writeFile(join(f.knowledgeRoot, stalePath), '# Externally changed\nnew content.\n');
    const staleReply = await search();
    expect(staleReply.statusCode, staleReply.body).toBe(200);
    expect(staleReply.json().data.results.some((r: any) => r.relativePath === stalePath)).toBe(
      false,
    );
    expect(staleReply.json().data.reasons).toContain('SOURCE_CHANGED');
  } finally {
    db.close();
    await f.close();
  }
}, 30000);

it('traverses every hybrid result once when notes have multiple matching chunks', async () => {
  const f = await createFixture({ agent: agentConfig });
  const db = openDatabase(f.dataRoot),
    tokenizer = new TokenizerClient(),
    indexing = reconcileService(f.config, db),
    writer = textIndexService(db, tokenizer),
    jobs = indexJobService(db);
  const bodies = new Map<string, string>();
  try {
    for (let i = 0; i < 60; i++) {
      const id = String(i).padStart(3, '0');
      const body = 'needle '.repeat(61 - i) + 'filler '.repeat(i) + '\n';
      const path = `00-Inbox/n${id}.md`;
      bodies.set(path, body);
      await writeFile(join(f.knowledgeRoot, path), body.repeat(3));
    }
    await indexing.reconcile(undefined, true);
    for (;;) {
      const job = jobs.claim('hybrid-page-test', ['text']);
      if (!job) break;
      const path = (db.prepare('SELECT path FROM notes WHERE id=?').get(job.noteId) as any).path;
      const body = bodies.get(path)!;
      const id = path.slice(-6, -3);
      const bytes = Buffer.byteLength(body);
      const count = (await tokenizer.count([body]))[0];
      await writer.stage(
        job,
        '',
        path,
        Array.from({ length: 3 }, (_, ordinal) => ({
          chunkId: `${id}-${ordinal}`,
          noteId: job.noteId,
          sourceHash: job.contentHash,
          chunkerId: 'hybrid-page-fixture',
          ordinal,
          headingPath: [],
          startLine: ordinal + 1,
          endLine: ordinal + 1,
          content: body,
          startByte: ordinal * bytes,
          endByte: (ordinal + 1) * bytes,
          tokenCount: count,
          embeddingInput: body,
          embeddingInputHash: sha256(body),
          embeddingTokenCount: count,
        })),
      );
      expect(writer.publish(job, 'hybrid-page-fixture')).toBe('published');
      jobs.complete(job);
    }
    // Keep the external vector ordering fixed while exercising real SQL recall,
    // fusion, source checks, response budgets and cursor offsets.
    const semantic = Array.from({ length: 40 }, (_, i) => ({
      chunkId: `${String(39 - i).padStart(3, '0')}-0`,
      rank: i + 1,
      score: 0.8,
    }));
    const worker = {
      text: writer,
      client: { query: async () => [1] },
      vectors: {
        current: () => 'fixed',
        search: async (_query: number[], _principal: unknown, limit: number) =>
          semantic.slice(0, limit),
      },
    } as unknown as ReturnType<typeof indexWorker>;
    const search = searchService(f.config, db, noteService(f.config, db), indexing, worker);
    const principal = {
      id: 'hybrid-page-test',
      clientId: 'unit',
      scopes: ['knowledge:read'],
      allowedPrefixes: ['00-Inbox'],
    };
    const all: SearchOutput['results'] = [];
    let cursor: string | undefined,
      pages = 0;
    do {
      const page = await search.search(principal, {
        query: 'needle',
        mode: 'hybrid',
        limit: 30,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.degraded).toBe(false);
      if (cursor) {
        const replay = await search.search(principal, {
          query: 'needle',
          mode: 'hybrid',
          limit: 30,
          cursor,
        });
        expect(replay.results).toEqual(page.results);
      }
      all.push(...page.results);
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(10);
    } while (cursor);
    expect(pages).toBeGreaterThan(1);
    expect(all).toHaveLength(60);
    expect(new Set(all.map((item) => item.noteId)).size).toBe(60);
    expect(new Set(all.map((item) => item.relativePath))).toEqual(new Set(bodies.keys()));
    expect(
      all.some((item) =>
        item.matches.some(
          (hit) => hit.matchedBy.includes('text') && hit.matchedBy.includes('semantic'),
        ),
      ),
    ).toBe(true);
  } finally {
    await indexing.close();
    await tokenizer.close();
    db.close();
    await f.close();
  }
}, 30000);

it('reports bounded recall exhaustion instead of presenting a partial final page as complete', async () => {
  const f = await createFixture({ agent: agentConfig });
  const db = openDatabase(f.dataRoot),
    tokenizer = new TokenizerClient(),
    indexing = reconcileService(f.config, db),
    writer = textIndexService(db, tokenizer),
    jobs = indexJobService(db);
  try {
    const content = '# Bounded search\nboundedneedle content.\n';
    await Promise.all(
      Array.from({ length: 501 }, (_, i) =>
        writeFile(
          join(f.knowledgeRoot, `00-Inbox/bounded-${String(i).padStart(3, '0')}.md`),
          content,
        ),
      ),
    );
    await indexing.reconcile(undefined, true);
    const count = (await tokenizer.count([content]))[0];
    let job;
    // Stage these tiny, whole-file chunks through the actual SQL publisher.
    // Snapshot scheduling is independently covered; this case targets pool exhaustion.
    while ((job = jobs.claim('recall-test', ['text']))) {
      const path = (db.prepare('SELECT path FROM notes WHERE id=?').get(job.noteId) as any).path;
      await writer.stage(job, 'Bounded search', path, [
        {
          chunkId: sha256(job.noteId),
          noteId: job.noteId,
          sourceHash: job.contentHash,
          chunkerId: 'recall-fixture',
          ordinal: 0,
          headingPath: ['Bounded search'],
          startLine: 1,
          endLine: 2,
          content,
          startByte: 0,
          endByte: Buffer.byteLength(content),
          tokenCount: count,
          embeddingInput: content,
          embeddingInputHash: sha256(content),
          embeddingTokenCount: count,
        },
      ]);
      expect(writer.publish(job, 'recall-fixture')).toBe('published');
      jobs.complete(job);
    }
    const search = (cursor?: string, freshness = 'indexed') =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders(),
        payload: {
          query: 'boundedneedle',
          mode: 'text',
          freshness,
          limit: 50,
          ...(cursor ? { cursor } : {}),
        },
      });
    let reply = await search();
    expect(reply.statusCode, reply.body).toBe(200);
    const all = [];
    let last: any;
    for (let page = 0; page < 12; page++) {
      expect(reply.statusCode, reply.body).toBe(200);
      last = reply.json().data;
      all.push(...last.results);
      if (!last.nextCursor) break;
      reply = await search(last.nextCursor);
    }
    expect(all).toHaveLength(500);
    expect(new Set(all.map((r: any) => r.noteId)).size).toBe(500);
    expect(last.nextCursor).toBeUndefined();
    expect(last.degraded).toBe(true);
    expect(last.reasons).toContain('RECALL_LIMIT');
  } finally {
    await indexing.close();
    await tokenizer.close();
    db.close();
    await f.close();
  }
}, 30000);
