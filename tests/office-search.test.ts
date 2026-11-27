import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase } from '../packages/core/db.js';
import { writeKnowledgeDataFile } from '../packages/core/knowledge-data.js';
import { officeSearchIndex } from '../packages/core/office/search.js';

const ocr = vi.hoisted(() => ({ available: false }));
vi.mock('../packages/core/office/pdf-ocr.js', () => ({
  pdfOcrConfiguration: () => ({ available: ocr.available, cacheKey: String(ocr.available) }),
}));
vi.mock('../packages/core/office/extract.js', () => ({
  extractIndexedOfficeText: async (
    bytes: Buffer,
    type: string,
    options?: { ocrConfiguration?: { available: boolean } },
  ) => {
    const segments = JSON.parse(bytes.toString('utf8'));
    if (type === 'pdf' && !options?.ocrConfiguration?.available)
      return { segments: segments.slice(0, 1), ocrPending: true };
    return { segments };
  },
}));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'dooknow-office-index-'));
  const knowledgeRoot = join(directory, 'knowledge');
  mkdirSync(knowledgeRoot);
  const config = { knowledgeRoot, origin: 'http://localhost:8080' };
  const db = openDatabase(join(directory, 'data'));
  const indexes: ReturnType<typeof officeSearchIndex>[] = [];
  const index = () => {
    const service = officeSearchIndex(config, db);
    indexes.push(service);
    return service;
  };
  const relative = (id: string) => 'apps/onlyoffice/documents/' + id;
  function source(id: string, body: string | string[]) {
    const rows = (Array.isArray(body) ? body : [body]).map((text, part) => ({
      heading: '工作表 ' + (part + 1),
      text,
    }));
    writeKnowledgeDataFile(
      knowledgeRoot,
      relative(id) + '/metadata.json',
      JSON.stringify({ format: 1, name: '维修记录.xlsx' }),
    );
    writeKnowledgeDataFile(knowledgeRoot, relative(id) + '/document.xlsx', JSON.stringify(rows));
  }
  return {
    config,
    directory,
    relative,
    index,
    source,
    async close() {
      await Promise.all(indexes.map((service) => service.close()));
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function find(service: ReturnType<typeof officeSearchIndex>, query: string, id: string) {
  await expect
    .poll(async () => (await service.search({ query })).results.map((hit) => hit.documentId))
    .toContain(id);
  return (await service.search({ query })).results.find((hit) => hit.documentId === id)!;
}

it('refreshes previously indexed native PDF text when local OCR becomes available', async () => {
  const f = fixture();
  ocr.available = false;
  try {
    const id = randomUUID();
    const base = f.relative(id);
    writeKnowledgeDataFile(
      f.config.knowledgeRoot,
      `${base}/metadata.json`,
      JSON.stringify({ format: 1, name: '巡检.pdf' }),
    );
    writeKnowledgeDataFile(
      f.config.knowledgeRoot,
      `${base}/document.pdf`,
      JSON.stringify([
        { heading: '第 1 页', text: 'nativeheader' },
        { heading: '第 2 页', text: '检查备用电源' },
      ]),
    );
    const first = f.index();
    first.schedule();
    const native = await find(first, 'nativeheader', id);
    expect(await first.search({ query: '备用电源' })).toMatchObject({
      results: [],
      reasons: ['OFFICE_OCR_UNAVAILABLE'],
    });
    await first.close();

    ocr.available = true;
    const next = f.index();
    next.schedule();
    const hit = await find(next, '备用电源', id);
    expect(hit.url).toBe(`${f.config.origin}/api/office/documents/${id}/view#page=2`);
    expect(await next.fetch(hit)).toMatchObject({
      text: '检查备用电源',
      metadata: { location: '第 2 页', fileType: 'pdf' },
    });
    await expect(next.fetch(native)).rejects.toMatchObject({ code: 'RESULT_STALE' });
    expect((await find(next, 'nativeheader', id)).url).toMatch(/#page=1$/);
  } finally {
    ocr.available = false;
    await f.close();
  }
});

it('finds Chinese terms and returns one bounded location per original', async () => {
  const f = fixture();
  try {
    const service = f.index();
    service.schedule();
    expect(await service.search({ query: '维修' })).toEqual({
      results: [],
      degraded: false,
      reasons: [],
    });
    const first = randomUUID();
    const second = randomUUID();
    f.source(first, Array<string>(140).fill('叉车维修记录及注意事项'));
    f.source(second, '叉车维修记录及每日检查\n' + '测'.repeat(5000));
    service.schedule();
    for (const query of ['维修', '叉车维修记录']) {
      await find(service, query, second);
      const found = await service.search({ query });
      expect(found.results.map((hit) => hit.documentId).sort()).toEqual([first, second].sort());
    }
    const secondHit = await find(service, '叉车维修记录', second);
    const selected = await service.fetch(secondHit);
    expect(Buffer.byteLength(selected.text)).toBeLessThanOrEqual(8 * 1024);
    expect(selected).toMatchObject({
      title: '维修记录.xlsx',
      url: f.config.origin + '/api/office/documents/' + second + '/download',
      metadata: { objectType: 'office', location: '工作表 1', fileType: 'xlsx' },
    });
    expect(
      await service.search({
        query: Array.from({ length: 33 }, (_, index) => 'word' + index).join(' '),
      }),
    ).toMatchObject({ results: [], degraded: true, reasons: ['OFFICE_SEARCH_LIMIT'] });
  } finally {
    await f.close();
  }
});

it('preserves references for identical saves and rejects old references after changes and deletion', async () => {
  const f = fixture();
  try {
    const service = f.index();
    const id = randomUUID();
    f.source(id, 'startermarker');
    service.schedule(id);
    const first = await find(service, 'startermarker', id);
    f.source(id, 'startermarker');
    service.schedule(id);
    expect((await service.fetch(first)).text).toBe('startermarker');
    expect((await find(service, 'startermarker', id)).sourceRevision).toBe(first.sourceRevision);

    f.source(id, 'updatedmarker');
    expect((await service.search({ query: 'startermarker' })).results).toEqual([]);
    await expect(service.fetch(first)).rejects.toMatchObject({ code: 'RESULT_STALE' });
    const updated = await find(service, 'updatedmarker', id);
    expect(updated.sourceRevision).toBeGreaterThan(first.sourceRevision);

    f.source(id, 'startermarker');
    service.schedule(id);
    await expect(service.fetch(first)).rejects.toMatchObject({ code: 'RESULT_STALE' });
    const restored = await find(service, 'startermarker', id);
    expect(restored.sourceHash).toBe(first.sourceHash);
    expect(restored.sourceRevision).toBeGreaterThan(updated.sourceRevision);

    rmSync(join(f.config.knowledgeRoot, '_doo-data', f.relative(id)), { recursive: true });
    expect((await service.search({ query: 'startermarker' })).results).toEqual([]);
    await expect(service.fetch(restored)).rejects.toMatchObject({ code: 'RESULT_STALE' });
  } finally {
    await f.close();
  }
});

it('does not reuse cache references when the native library directory is replaced', async () => {
  const f = fixture();
  try {
    const prior = f.index();
    const id = randomUUID();
    f.source(id, 'rootmarker');
    prior.schedule(id);
    const first = await find(prior, 'rootmarker', id);
    renameSync(f.config.knowledgeRoot, join(f.directory, 'former-library'));
    mkdirSync(f.config.knowledgeRoot);
    f.source(id, 'rootmarker');
    expect(await prior.search({ query: 'rootmarker' })).toEqual({
      results: [],
      degraded: true,
      reasons: ['OFFICE_INDEX_UNAVAILABLE'],
    });
    await expect(prior.fetch(first)).rejects.toMatchObject({ code: 'RESULT_STALE' });
    const next = f.index();
    next.schedule();
    const replacement = await find(next, 'rootmarker', id);
    expect(replacement.sourceRevision).toBeGreaterThan(first.sourceRevision);
    await expect(next.fetch(first)).rejects.toMatchObject({ code: 'RESULT_STALE' });
  } finally {
    await f.close();
  }
});
