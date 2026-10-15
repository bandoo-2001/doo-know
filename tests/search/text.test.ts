import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { TokenizerClient } from '../../packages/core/indexing/tokenizer-client.js';
import { chunkService } from '../../packages/core/indexing/chunks.js';
import { textIndexService } from '../../packages/core/indexing/text.js';
it('indexes Chinese short terms, phrases and identifiers without permitting query syntax or prefix lookalike escapes', async () => {
  const f = await createFixture({ agent: agentConfig }),
    tokenizer = new TokenizerClient(),
    db = openDatabase(f.dataRoot);
  try {
    for (const folder of ['allowed', 'allowed-other'])
      await mkdir(join(f.knowledgeRoot, '00-Inbox', folder));
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/allowed/a.md'),
      '# 中文全文检索\n\n知识整理方法使用 embedding_space_id 和 RRF 融合。',
    );
    await writeFile(
      join(f.knowledgeRoot, '00-Inbox/allowed-other/secret.md'),
      '# 私人\n越权哨兵 embedding_space_id',
    );
    const notes = (
        await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })
      ).json().data.items,
      writer = textIndexService(db, tokenizer);
    for (const n of notes) {
      const page = (await readyRead(f, n.id)).json().data.data,
        state = db
          .prepare('SELECT source_revision FROM document_state WHERE note_id=?')
          .get(n.id) as any;
      const version = {
        noteId: n.id,
        sourceRevision: state.source_revision,
        contentHash: page.sourceHash,
      };
      const batch = [];
      for await (const chunk of chunkService(f.config, db, tokenizer).chunkDocument(
        page.snapshotId,
        'bge-320-48-v1',
      ))
        batch.push(chunk);
      await writer.stage(version, n.title, n.relativePath, batch);
      expect(writer.publish(version, 'bge-320-48-v1')).toBe('published');
    }
    const p = {
      id: 'reader',
      clientId: 'unit',
      scopes: ['knowledge:read'],
      allowedPrefixes: ['00-Inbox/allowed'],
    };
    for (const query of ['知', '知识', '中文全文', 'embedding_space_id', '"知识整理方法"']) {
      const result = await writer.search(p, query, 50);
      expect(result.length).toBeGreaterThan(0);
      expect(
        result.every(
          (x) => x.noteId === notes.find((x: any) => x.relativePath === '00-Inbox/allowed/a.md').id,
        ),
      ).toBe(true);
      expect(result[0].content).toContain('知识整理');
    }
    expect(await writer.search(p, '" OR * --', 50)).toEqual([]);
    expect(await writer.search(p, '越权哨兵', 50)).toEqual([]);
  } finally {
    db.close();
    await tokenizer.close();
    await f.close();
  }
});
