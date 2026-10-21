import { it, expect } from 'vitest';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createFixture } from '../support/fixture.js';
import { readyRead } from '../support/read.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../packages/core/db.js';
import { TokenizerClient } from '../../packages/core/indexing/tokenizer-client.js';
import { chunkService } from '../../packages/core/indexing/chunks.js';
it('covers a real 20 MiB UTF-8 long line with bounded incremental chunks and exact head/tail bytes', async () => {
  const f = await createFixture({ agent: agentConfig }),
    db = openDatabase(f.dataRoot),
    tokenizer = new TokenizerClient();
  try {
    const file = await open(join(f.knowledgeRoot, '00-Inbox/chunks-20m.md'), 'wx'),
      source = createHash('sha256'),
      size = 20 * 1024 * 1024;
    let written = 0;
    const header = Buffer.from('\ufeff# 二十兆字节\nBEGIN\n');
    await file.write(header);
    source.update(header);
    written += header.length;
    const block = Buffer.from('中文😀'.repeat(6553));
    const tail = Buffer.from('\nEND_EXACT_TAIL');
    while (written + block.length + tail.length < size) {
      await file.write(block);
      source.update(block);
      written += block.length;
    }
    const padding = Buffer.alloc(size - written - tail.length, 120);
    await file.write(padding);
    source.update(padding);
    await file.write(tail);
    source.update(tail);
    await file.close();
    const n = (await f.app.inject({ url: '/api/agent/v1/notes', headers: agentHeaders() })).json()
        .data.items[0],
      page = (await readyRead(f, n.id)).json().data.data;
    expect(page.sourceHash).toBe(source.digest('hex'));
    const baselineMemory = process.memoryUsage(),
      baseline = baselineMemory.rss,
      actual = createHash('sha256');
    let covered = 0,
      count = 0,
      peak = baseline,
      peakMemory = baselineMemory,
      lastMemory = baselineMemory,
      peakChunk = 0,
      first = '',
      last = '';
    for await (const chunk of chunkService(f.config, db, tokenizer).chunkDocument(
      page.snapshotId,
      'bge-320-48-v1',
    )) {
      const bytes = Buffer.from(chunk.content);
      expect(chunk.startByte).toBeLessThanOrEqual(covered);
      expect(chunk.endByte - chunk.startByte).toBe(bytes.length);
      expect(chunk.tokenCount).toBeLessThanOrEqual(320);
      expect(chunk.embeddingTokenCount).toBeLessThanOrEqual(512);
      if (chunk.endByte > covered) {
        actual.update(bytes.subarray(covered - chunk.startByte));
        covered = chunk.endByte;
      }
      if (!count) first = chunk.content;
      last = chunk.content;
      count++;
      lastMemory = process.memoryUsage();
      if (lastMemory.rss > peak) {
        peak = lastMemory.rss;
        peakMemory = lastMemory;
        peakChunk = count;
      }
    }
    expect(covered).toBe(size);
    expect(actual.digest('hex')).toBe(page.sourceHash);
    expect(first).toContain('BEGIN');
    expect(last).toContain('END_EXACT_TAIL');
    expect(count).toBeGreaterThan(100);
    expect(
      peak - baseline,
      'QA013_MEMORY_CONTEXT ' + JSON.stringify({
        node: process.version, chunks: count, peakChunk,
        baseline: baselineMemory, peak: peakMemory, last: lastMemory,
      }),
    ).toBeLessThanOrEqual(64 * 1024 * 1024);
  } finally {
    await tokenizer.close();
    db.close();
    await f.close();
  }
}, 180000);
