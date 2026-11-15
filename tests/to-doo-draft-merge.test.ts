import { describe, expect, test } from 'vitest';
import { toDooEntitySchemas } from '../shared/to-doo-contracts';
import { mergeToDooTaskDraft } from '../apps/web/to-doo-draft-merge';
import type { ToDooTaskDraft } from '../apps/web/to-doo-workbench';

const stamp = { revision: 'r1', createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' };
function fixture(): ToDooTaskDraft {
  return {
    task: toDooEntitySchemas.task.parse({ ...stamp, id: 'task', title: '准备资料' }),
    occurrence: toDooEntitySchemas.occurrence.parse({ ...stamp, id: 'occurrence', taskId: 'task',
      cycleKey: 'once', scheduleRevision: 'schedule1', due: { date: '2026-11-16' } }),
    blocks: [toDooEntitySchemas.timeBlock.parse({ ...stamp, id: 'plan', occurrenceId: 'occurrence',
      start: { date: '2026-11-16' }, durationMinutes: 30 })],
  };
}
describe('three-way task editing', () => {
  test('keeps local text and plan fields while adopting independent remote edits and revisions', () => {
    const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
    local.task.description = '本地说明';
    local.blocks[0].start.date = '2026-11-17';
    remote.task.priority = 'high';
    remote.task.revision = 'remote-task';
    remote.occurrence!.due!.date = '2026-11-18';
    remote.blocks[0].durationMinutes = 60;
    remote.blocks[0].revision = 'remote-plan';
    const merged = mergeToDooTaskDraft('task@occurrence', local, base, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.task).toMatchObject({ description: '本地说明', priority: 'high', revision: 'remote-task' });
    expect(merged.draft.occurrence?.due?.date).toBe('2026-11-18');
    expect(merged.draft.blocks[0]).toMatchObject({ start: { date: '2026-11-17' }, durationMinutes: 60, revision: 'remote-plan' });
  });
  test('identifies same-field conflicts across task, execution and time block without replacing local input', () => {
    const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
    local.task.title = '本地标题'; remote.task.title = '远端标题';
    local.occurrence!.due!.date = '2026-11-17'; remote.occurrence!.due!.date = '2026-11-18';
    local.blocks[0].durationMinutes = 40; remote.blocks[0].durationMinutes = 50;
    const merged = mergeToDooTaskDraft('task@occurrence', local, base, remote);
    expect(merged.conflicts.map(({ kind, field }) => [kind, field])).toEqual([
      ['timeBlock', 'durationMinutes'], ['task', 'title'], ['occurrence', 'due'],
    ]);
    expect(merged.draft.task.title).toBe('本地标题');
    expect(merged.draft.blocks[0].durationMinutes).toBe(40);
  });
  test.each(['local', 'remote'] as const)('%s deletion conflicts with a changed plan instead of losing the edit', (side) => {
    const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
    if (side === 'local') { local.blocks = []; remote.blocks[0].start.date = '2026-11-18'; }
    else { remote.blocks[0].deletedAt = '2026-11-15T02:00:00Z'; remote.blocks[0].revision = 'deleted'; local.blocks[0].start.date = '2026-11-17'; }
    const merged = mergeToDooTaskDraft('task@occurrence', local, base, remote);
    expect(merged.conflicts).toMatchObject([{ kind: 'timeBlock', entityId: 'plan', field: '$entity' }]);
    if (side === 'remote') expect(merged.draft.blocks[0]).toMatchObject({ start: { date: '2026-11-17' }, revision: 'deleted', deletedAt: null });
  });
  test('retains independent new blocks and turns local removal into a versioned tombstone', () => {
    const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
    local.blocks = [{ ...structuredClone(base.blocks[0]), id: 'new-local', revision: '' }];
    remote.blocks.push({ ...structuredClone(base.blocks[0]), id: 'new-remote' });
    const merged = mergeToDooTaskDraft('task@occurrence', local, base, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.blocks.find((block) => block.id === 'plan')).toMatchObject({ revision: 'r1', deletedAt: expect.any(String) });
    expect(merged.draft.blocks.map((block) => block.id)).toEqual(['plan', 'new-local', 'new-remote']);
  });
  test('matching edits and deletions require no artificial conflict', () => {
    const base = fixture(), local = structuredClone(base), remote = structuredClone(base);
    local.task.title = remote.task.title = '相同标题';
    local.blocks[0].deletedAt = '2026-11-15T01:00:00Z'; remote.blocks[0].deletedAt = '2026-11-15T02:00:00Z';
    const merged = mergeToDooTaskDraft('task@occurrence', local, base, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.draft.blocks[0].deletedAt).toBe(remote.blocks[0].deletedAt);
  });
});
