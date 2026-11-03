import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../apps/web/api', () => ({
  api: async () => {
    throw Error('offline');
  },
}));
import { createPrimaryDocument, pendingCreation } from '../apps/web/diagrams/primary-creation';
afterEach(() => vi.unstubAllGlobals());
it('does not replace the frozen creation target when a failed dialog is edited before retry', async () => {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  });
  const scope = { ownerId: 'owner', knowledgeId: 'kb' },
    original = {
      path: '00-Inbox/original.md',
      type: 'whiteboard' as const,
      title: '原图',
      requestId: 'stable-request',
    };
  await expect(createPrimaryDocument(scope, original)).rejects.toThrow('offline');
  await expect(
    createPrimaryDocument(scope, { ...original, path: '00-Inbox/changed.md', title: '新图' }),
  ).rejects.toThrow('创建内容已固定');
  expect(pendingCreation(scope)).toMatchObject(original);
  expect(pendingCreation({ ...scope, ownerId: 'other' })).toBeUndefined();
});
