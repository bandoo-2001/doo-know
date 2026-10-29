import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'diff2html';
import { h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import type { FileOperation, ReadInput, ReadPage } from '../shared/knowledge-contracts';
import {
  createRevisionDiff,
  HISTORY_COMPARE_MAX_BYTES,
  HISTORY_READ_SESSION_MAX_PAGES,
  nextRevisionReadInput,
  readRevisionPage,
  readRevisionList,
  type HistoryApi,
} from '../apps/web/note-history';

afterEach(() => vi.useRealTimers());

describe('saved-history refresh after a Git write', () => {
  it('retries only an explicitly retryable workspace read lock with the same cursor', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const call: HistoryApi = async <T>(url: string) => {
      requests.push(url);
      if (requests.length === 1)
        throw { status: 503, data: { code: 'WORKSPACE_BUSY', retryable: true } };
      return { items: [], nextCursor: 'older' } as T;
    };
    const pending = readRevisionList(call, 'note /一', 'cursor /二');
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toEqual({ items: [], nextCursor: 'older' });
    expect(requests).toEqual(
      Array(2).fill('/api/notes/note%20%2F%E4%B8%80/revisions?cursor=cursor%20%2F%E4%BA%8C'),
    );
  });

  it('does not retry other read errors or continue a stale selection', async () => {
    const failure = new Error('not authorized');
    const denied: HistoryApi = async () => {
      throw failure;
    };
    await expect(readRevisionList(denied, 'note')).rejects.toBe(failure);
    vi.useFakeTimers();
    let active = true,
      calls = 0;
    const busy: HistoryApi = async () => {
      calls++;
      throw { status: 503, data: { code: 'WORKSPACE_BUSY', retryable: true } };
    };
    const pending = readRevisionList(busy, 'note', undefined, () => active);
    await vi.advanceTimersByTimeAsync(0);
    active = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBeUndefined();
    expect(calls).toBe(1);
  });
});

describe('complete revision comparison', () => {
  it('produces a real parseable Chinese patch with inert HTML and safe filenames', async () => {
    const result = await createRevisionDiff(
      '标题\n旧内容\n结尾\n',
      '标题\n<img src=x onerror="bad()"> 中文\n结尾\n',
    );
    expect(result.status).toBe('ready');
    expect(result.diff).toContain('--- note.md\t历史版本');
    expect(result.diff).toContain('+++ note.md\t当前已保存版本');
    const files = parse(result.diff);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      oldName: 'note.md\t历史版本',
      newName: 'note.md\t当前已保存版本',
      addedLines: 1,
      deletedLines: 1,
    });
    expect(files[0].blocks[0].lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ content: '-旧内容', oldNumber: 2 }),
        expect.objectContaining({ content: '+<img src=x onerror="bad()"> 中文', newNumber: 2 }),
      ]),
    );
    const { DiffBody, readDiff } = await import('../packages/plugin-ui/diff-view');
    const document = await readDiff({ diff: result.diff });
    expect(document.status).toBe('ready');
    const html = await renderToString(h(DiffBody, { document, diff: result.diff }));
    expect(html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt; 中文');
    expect(html).not.toContain('<img');
  });

  it.each([
    ['末尾', '末尾\n'],
    ['', '新增\n'],
    ['删除\n', ''],
    ['a\r\n', 'a\n'],
  ])('compares newline and empty-file changes: %j -> %j', async (previous, current) => {
    const result = await createRevisionDiff(previous, current);
    expect(result.status).toBe('ready');
    expect(parse(result.diff)[0].blocks.length).toBeGreaterThan(0);
    if (previous === '末尾') expect(result.diff).toContain('\\ No newline at end of file');
  });

  it.each(['', '未改变\n'])('returns no patch for identical text %j', async (text) => {
    expect(await createRevisionDiff(text, text)).toEqual({ status: 'empty', diff: '' });
  });

  it('enforces each input byte limit using UTF-8 rather than character count', async () => {
    const tooLarge = '中'.repeat(Math.floor(HISTORY_COMPARE_MAX_BYTES / 3) + 1);
    expect(await createRevisionDiff(tooLarge, '')).toEqual({ status: 'too-large', diff: '' });
    expect(await createRevisionDiff('', tooLarge)).toEqual({ status: 'too-large', diff: '' });
    const boundary = 'a'.repeat(HISTORY_COMPARE_MAX_BYTES);
    expect(await createRevisionDiff(boundary, boundary)).toEqual({ status: 'empty', diff: '' });
  });

  it('suppresses an oversized generated patch without emitting a truncated comparison', async () => {
    const result = await createRevisionDiff('a'.repeat(140_000), 'b'.repeat(140_000));
    expect(result).toEqual({ status: 'too-large', diff: '' });
  });

  it('bounds algorithm work and suppresses aborted results', async () => {
    const previous = Array.from({ length: 6000 }, (_, i) => `旧行${i}\n`).join('');
    const current = Array.from({ length: 6000 }, (_, i) => `新行${i}\n`).join('');
    expect(await createRevisionDiff(previous, current)).toEqual({
      status: 'too-complex',
      diff: '',
    });
  });
});

const page: ReadPage = {
  snapshotId: 'snapshot',
  sourceHash: 'hash',
  modifiedAt: '123',
  content: '历史内容\n',
  startLine: 1,
  endLine: 1,
  startByte: 0,
  endByte: 13,
  bytesReturned: 13,
  hasMore: true,
  nextCursor: 'next',
  budgetRemainingBytes: 1000,
  rangeHash: 'range',
  lineByteOffset: 0,
};
const operation = (status: FileOperation['status']): FileOperation => ({
  operationId: 'prepare /一',
  requestId: 'request',
  kind: 'prepare_snapshot',
  status,
});
function apiFixture(replies: unknown[]) {
  const requests: { url: string; method?: string; body?: unknown }[] = [];
  const call: HistoryApi = async <T>(url: string, method?: string, body?: unknown) => {
    requests.push({ url, method, body });
    if (!replies.length) throw new Error('Unexpected API request');
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply as T;
  };
  return { call, requests };
}

describe('immutable revision read session renewal', () => {
  it('keeps the cursor through page 199 and renews at the 200-page session boundary', () => {
    expect(nextRevisionReadInput(page, 199)).toEqual({ cursor: 'next', maxBytes: 128 * 1024 });
    expect(nextRevisionReadInput(page, HISTORY_READ_SESSION_MAX_PAGES)).toEqual({
      snapshotId: 'snapshot',
      maxBytes: 128 * 1024,
      range: { startLine: 2, lineByteOffset: 0 },
    });
    expect(nextRevisionReadInput(page, 200)).toEqual({
      snapshotId: 'snapshot',
      maxBytes: 128 * 1024,
      range: { startLine: 2, lineByteOffset: 0 },
    });
  });

  it('does not schedule another read for the final page', () => {
    expect(
      nextRevisionReadInput({ ...page, hasMore: false, nextCursor: undefined }, 199),
    ).toBeUndefined();
    expect(
      nextRevisionReadInput({ ...page, hasMore: false, nextCursor: undefined }, 200),
    ).toBeUndefined();
  });

  it('reports a missing continuation cursor before the session boundary', () => {
    expect(() => nextRevisionReadInput({ ...page, nextCursor: undefined }, 199)).toThrow(
      /游标|分页/,
    );
  });

  it.each([
    {
      content: '长行中文🙂',
      lineByteOffset: 40,
      endLine: 7,
      startLine: 7,
      wantLine: 7,
      wantOffset: 56,
    },
    {
      content: '旧行\r\n中文🙂',
      lineByteOffset: 40,
      endLine: 8,
      startLine: 7,
      wantLine: 8,
      wantOffset: 10,
    },
    {
      content: '旧行\r\n',
      lineByteOffset: 40,
      endLine: 7,
      startLine: 7,
      wantLine: 8,
      wantOffset: 0,
    },
    { content: '\n', lineByteOffset: 40, endLine: 7, startLine: 7, wantLine: 8, wantOffset: 0 },
  ])(
    'renews at the exact UTF-8 byte position for $content',
    ({ wantLine, wantOffset, ...input }) => {
      expect(nextRevisionReadInput({ ...page, ...input, nextCursor: undefined }, 200)).toEqual({
        snapshotId: 'snapshot',
        maxBytes: 128 * 1024,
        range: { startLine: wantLine, lineByteOffset: wantOffset },
      });
    },
  );
});

describe('revision read boundary', () => {
  it('encodes identifiers and preserves the supplied cursor and range', async () => {
    const fixture = apiFixture([{ kind: 'ready', data: page }]);
    const input: ReadInput = {
      snapshotId: 'snapshot',
      cursor: 'cursor /一',
      maxBytes: 128,
      range: { startLine: 20, endLine: 30 },
    };
    expect(await readRevisionPage(fixture.call, 'note /一', 'rev /二', input)).toEqual(page);
    expect(fixture.requests).toEqual([
      {
        url: '/api/notes/note%20%2F%E4%B8%80/revisions/rev%20%2F%E4%BA%8C/read',
        method: 'POST',
        body: input,
      },
    ]);
  });

  it('polls each active status at one second and retries with the original cursor', async () => {
    vi.useFakeTimers();
    const fixture = apiFixture([
      { kind: 'accepted', operation: operation('queued') },
      operation('running'),
      operation('committing'),
      operation('succeeded'),
      { kind: 'ready', data: page },
    ]);
    const input = { cursor: 'original', maxBytes: 77 };
    const pending = readRevisionPage(fixture.call, 'n', 'r', input);
    await vi.advanceTimersByTimeAsync(999);
    expect(fixture.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toEqual(page);
    expect(fixture.requests.slice(1, 4)).toEqual(
      Array(3).fill({
        url: '/api/operations/prepare%20%2F%E4%B8%80',
        method: 'GET',
        body: undefined,
      }),
    );
    expect(fixture.requests[4]).toEqual({
      url: '/api/notes/n/revisions/r/read',
      method: 'POST',
      body: input,
    });
  });

  it.each([
    ['failed', /失败/],
    ['cancelled', /取消/],
    ['needs_reconciliation', /核对|恢复/],
  ] as const)(
    'surfaces terminal snapshot state %s without another read',
    async (status, message) => {
      vi.useFakeTimers();
      const fixture = apiFixture([
        { kind: 'accepted', operation: operation('running') },
        operation(status),
      ]);
      const assertion = expect(readRevisionPage(fixture.call, 'n', 'r')).rejects.toThrow(message);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(fixture.requests).toHaveLength(2);
    },
  );

  it('stops without requests when already stale', async () => {
    const fixture = apiFixture([]);
    expect(await readRevisionPage(fixture.call, 'n', 'r', {}, () => false)).toBeUndefined();
    expect(fixture.requests).toHaveLength(0);
  });

  it('discards a ready read completed after selection changed', async () => {
    let active = true;
    const call: HistoryApi = async <T>() => {
      active = false;
      return { kind: 'ready', data: page } as T;
    };
    expect(await readRevisionPage(call, 'n', 'r', {}, () => active)).toBeUndefined();
  });

  it('stops before the next poll when selection becomes stale during the delay', async () => {
    vi.useFakeTimers();
    let active = true;
    const fixture = apiFixture([{ kind: 'accepted', operation: operation('queued') }]);
    const pending = readRevisionPage(fixture.call, 'n', 'r', {}, () => active);
    await vi.advanceTimersByTimeAsync(1);
    active = false;
    await vi.advanceTimersByTimeAsync(999);
    expect(await pending).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
  });

  it('times out after at most 60 snapshot polls', async () => {
    vi.useFakeTimers();
    const fixture = apiFixture([
      { kind: 'accepted', operation: operation('queued') },
      ...Array.from({ length: 60 }, () => operation('running')),
    ]);
    const assertion = expect(readRevisionPage(fixture.call, 'n', 'r')).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fixture.requests).toHaveLength(61);
  });

  it('bounds repeated accepted replies even when each operation already succeeded', async () => {
    const fixture = apiFixture(
      Array.from({ length: 61 }, () => ({ kind: 'accepted', operation: operation('succeeded') })),
    );
    await expect(readRevisionPage(fixture.call, 'n', 'r')).rejects.toThrow(/超时|重试/);
    expect(fixture.requests.length).toBeLessThanOrEqual(61);
  });

  it('preserves API rejections for the local retry UI', async () => {
    const failure = new Error('读取失败，请重试');
    const fixture = apiFixture([failure]);
    await expect(readRevisionPage(fixture.call, 'n', 'r')).rejects.toBe(failure);
  });
});
