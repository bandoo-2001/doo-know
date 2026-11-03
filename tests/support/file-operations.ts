import { expect, test, type APIResponse, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { FileOperation } from '../../shared/knowledge-contracts';

type FileReceipt = Pick<APIResponse, 'ok' | 'json'>;
const pendingStatuses = ['queued', 'running', 'committing'];
const caseStarts = new WeakMap<TestInfo, number>();

/** The browser fixture records monotonic case time; this does not change any case timeout. */
export function trackFileOperationCase(info: TestInfo) {
  caseStarts.set(info, performance.now());
  return () => { caseStarts.delete(info); };
}
export function remainingFileOperationTime() {
  const info = test.info(), started = caseStarts.get(info);
  if (started === undefined) throw Error('File operation waits require the browser case-budget fixture');
  const remaining = info.timeout - (performance.now() - started);
  if (info.timeout <= 0 || remaining <= 0)
    throw Error('File operation did not finish inside the current test case budget');
  return Math.max(1, Math.floor(remaining));
}
export async function withinFileOperationCase<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    const check = () => {
      try { timer = setTimeout(check, remainingFileOperationTime()); }
      catch (error) { reject(error); }
    };
    check();
  });
  try { return await Promise.race([work, expired]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Observe the accepted identity until its terminal state, within the enclosing scenario's budget. */
export async function waitForFileOperation(page: Page, receipt: FileReceipt) {
  expect(receipt.ok()).toBe(true);
  const reply = await receipt.json();
  expect(reply.kind).toBe('accepted');
  let operation = reply.operation as FileOperation;
  const operationId = operation.operationId;
  expect(typeof operationId).toBe('string');
  const requestId = operation.requestId, kind = operation.kind;
  expect(typeof requestId).toBe('string');
  expect(requestId.length).toBeGreaterThan(0);
  while (pendingStatuses.includes(operation.status)) {
    const response = await page.request.get('/api/operations/' + encodeURIComponent(operationId), {
      timeout: remainingFileOperationTime(),
    });
    expect(response.status()).toBe(200);
    operation = await response.json();
    expect(operation.operationId).toBe(operationId);
    expect(operation.requestId).toBe(requestId);
    expect(operation.kind).toBe(kind);
    if (pendingStatuses.includes(operation.status))
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  expect(operation.status, operation.error?.code).toBe('succeeded');
  return operation;
}

/** Reconcile an existing successful receipt through the same controls available to the owner. */
export async function completeFileSave(
  page: Page,
  receipt: FileReceipt,
  controls?: { saved: Locator; recheck: Locator },
) {
  const operation = await waitForFileOperation(page, receipt);
  const saved = controls?.saved ?? page.getByText('片段已保存', { exact: true });
  const recheck = controls?.recheck ?? page.getByRole('button', { name: '核对保存结果', exact: true });
  await expect.poll(async () => {
    if (await saved.isVisible()) return 'saved';
    return await recheck.isVisible() && await recheck.isEnabled() ? 'recheck' : 'pending';
  }).not.toBe('pending');
  if (!(await saved.isVisible())) await recheck.click();
  await expect(saved).toBeVisible();
  return operation;
}
