import { it, expect, vi } from 'vitest';
import { restoreHistory } from '../apps/web/diagrams/history-restore';
const note = { id: 'note', relativePath: '00-Inbox/note.md', documentType: 'whiteboard' as const };
const plan = {
  id: 'plan',
  type: 'whiteboard',
  source: 'final rebased scene',
  sourceHash: 'a'.repeat(64),
  title: 'Historical',
};
it('renders the server-fixed scene and retries a prepared or committed plan without rendering again', async () => {
  let prepared = false,
    committed = false;
  const call = vi.fn(async (url: string, _method?: string, body?: any) => {
    if (url.endsWith('/diagram-restore')) {
      expect(body.requestId).not.toBe('same-request');
      return plan;
    }
    if (url === '/api/diagram-history-restores/plan')
      return { ...plan, ...(prepared ? { preparedId: 'prepared' } : {}) };
    if (url.endsWith('/prepare')) {
      expect(body.sourceHash).toBe(plan.sourceHash);
      prepared = true;
      return { preparedId: 'prepared' };
    }
    if (url.endsWith('/commit')) {
      committed = true;
      return { id: 'note', content: 'Markdown restored' };
    }
    throw Error(url);
  });
  const render = vi.fn(async (_type: any, snapshot: any) => {
    expect(snapshot.source).toBe(plan.source);
    return new Blob(['PNG']);
  });
  const first = await restoreHistory(call as any, note, 'rev', '1', 'same-request', render);
  expect(committed).toBe(true);
  expect(render).toHaveBeenCalledTimes(1);
  expect(await restoreHistory(call as any, note, 'rev', '1', 'same-request', render)).toEqual(
    first,
  );
  expect(render).toHaveBeenCalledTimes(1);
});
it('keeps ordinary history on the existing restore endpoint and makes no rendering request', async () => {
  const call = vi.fn(async () => ({ id: 'ordinary' })),
    render = vi.fn();
  await restoreHistory(
    call as any,
    { ...note, documentType: 'markdown' },
    'rev',
    '2',
    'request',
    render,
  );
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0]).toEqual([
    '/api/notes/note/revisions/rev/restore',
    'POST',
    { expectedModifiedAt: '2', requestId: 'request' },
  ]);
  expect(render).not.toHaveBeenCalled();
});
