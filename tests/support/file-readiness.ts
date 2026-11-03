import { expect, type Request, type Response, type Page } from '@playwright/test';
import type { FileReply, NoteInfo, ReadPage } from '../../shared/knowledge-contracts';
import { waitForFileOperation, withinFileOperationCase } from './file-operations';

type ReadTarget = Pick<NoteInfo, 'id'> & Partial<Pick<NoteInfo, 'editorMode'>>;

/** Follow the UI's actual read/preparation replies before asserting on the rendered editor. */
export async function completeFileRead(
  page: Page,
  target: ReadTarget | Promise<ReadTarget>,
  action: () => Promise<unknown>,
): Promise<ReadPage | undefined> {
  const note = Promise.resolve(target);
  let firstResolve!: (value: { response: Response; reply?: FileReply<ReadPage> }) => void;
  let firstReject!: (reason: unknown) => void;
  let readyResolve!: (value: ReadPage | undefined) => void;
  let readyReject!: (reason: unknown) => void;
  const first = new Promise<{ response: Response; reply?: FileReply<ReadPage> }>((resolve, reject) => {
    firstResolve = resolve; firstReject = reject;
  });
  const ready = new Promise<ReadPage | undefined>((resolve, reject) => {
    readyResolve = resolve; readyReject = reject;
  });
  // An action can fail before its read replies; retain their errors for the owning workflow.
  void first.catch(() => {});
  void ready.catch(() => {});
  const reads = new WeakSet<Request>();
  const requested = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if ((request.method() === 'POST' && /\/api\/notes\/[^/]+\/read$/.test(path)) ||
        (request.method() === 'GET' && /\/api\/notes\/[^/]+(?:\/outline)?$/.test(path)))
      reads.add(request);
  };
  const received = async (response: Response) => {
    const request = response.request();
    if (!reads.has(request)) return;
    try {
      const current = await note;
      const path = new URL(response.url()).pathname, base = '/api/notes/' + current.id;
      if (![base, base + '/read', base + '/outline'].includes(path)) return;
      expect(response.status()).toBe(200);
      if (path === base) {
        // Unknown small notes can be classified as full after their outline preparation.
        const document = await response.json();
        expect(document.id).toBe(current.id);
        firstResolve({ response });
        readyResolve(undefined);
        return;
      }
      const reply = await response.json() as FileReply<ReadPage>;
      expect(['accepted', 'ready']).toContain(reply.kind);
      if (path.endsWith('/outline')) {
        if (reply.kind === 'accepted') firstResolve({ response, reply });
        return;
      }
      firstResolve({ response, reply });
      if (reply.kind === 'ready') readyResolve(reply.data);
    } catch (error) {
      firstReject(error); readyReject(error);
    }
  };
  page.on('request', requested);
  page.on('response', received);
  try {
    const workflow = (async () => {
      await action();
      const current = await note;
      if (current.editorMode === 'metadata') return;
      const initial = await first;
      let snapshotId: string | undefined;
      if (initial.reply?.kind === 'accepted') {
        expect(initial.reply.operation.kind).toBe('prepare_snapshot');
        const operation = await waitForFileOperation(page, initial.response);
        expect(typeof operation.snapshotId).toBe('string');
        snapshotId = operation.snapshotId;
      }
      const data = await ready;
      if (data) {
        expect(typeof data.snapshotId).toBe('string');
        if (snapshotId) expect(data.snapshotId).toBe(snapshotId);
      }
      return data;
    })();
    return await withinFileOperationCase(workflow);
  } finally {
    page.off('request', requested);
    page.off('response', received);
  }
}
