import { beforeEach, expect, it, vi } from 'vitest';
import { collectCurrentDiagramSaveNeeds } from '../apps/web/diagrams/save-policy';
import { readWhiteboardSource } from '../apps/web/diagrams/prepare-source';
import { hashDiagramCode, serializeDiagramBinding } from '../shared/diagram-portability';
import { hashDiagramSource } from '../apps/web/diagrams/preview-artifact';

vi.mock('../apps/web/diagrams/prepare-source', () => ({ readWhiteboardSource: vi.fn() }));
const id = '10000000-0000-4000-8000-000000000001';
async function bound(source: string) {
  const marker = serializeDiagramBinding({
    kind: 'excalidraw',
    codeHash: await hashDiagramCode(id),
    sourceHash: await hashDiagramSource(source),
  });
  return `![EXCALIDRAW 预览](assets/diagram-${'a'.repeat(64)}.png)\n\n[图形源文件](assets/diagram-${'b'.repeat(64)}.excalidraw)\n\n${marker}\n\n\`\`\`excalidraw\n${id}\n\`\`\`\n`;
}
beforeEach(() => vi.clearAllMocks());
it('detects a changed canonical scene even when the parent fence reference stays the same', async () => {
  const raw = await bound('{"old":true}');
  vi.mocked(readWhiteboardSource).mockResolvedValue('{"new":true}');
  const needs = await collectCurrentDiagramSaveNeeds(raw, raw, 'parent');
  expect(needs).toHaveLength(1);
  expect(needs[0]).toMatchObject({ kind: 'excalidraw', code: id + '\n', reason: 'stale' });
});
it('retains unchanged scene bindings and keeps unconverted legacy references exempt', async () => {
  const raw = await bound('{"same":true}');
  vi.mocked(readWhiteboardSource).mockResolvedValue('{"same":true}');
  expect(await collectCurrentDiagramSaveNeeds(raw, raw, 'parent')).toEqual([]);
  expect(readWhiteboardSource).toHaveBeenCalledOnce();
  vi.mocked(readWhiteboardSource).mockClear();
  const legacy = '```excalidraw\n' + id + '\n```\n';
  expect(await collectCurrentDiagramSaveNeeds(legacy, legacy, 'parent')).toEqual([]);
  expect(readWhiteboardSource).not.toHaveBeenCalled();
});
it('requires an explicit choice when the current canonical scene cannot be verified', async () => {
  const raw = await bound('source');
  vi.mocked(readWhiteboardSource).mockRejectedValue(Error('offline'));
  expect(await collectCurrentDiagramSaveNeeds(raw, raw, 'parent')).toMatchObject([
    { kind: 'excalidraw', reason: 'stale' },
  ]);
});
