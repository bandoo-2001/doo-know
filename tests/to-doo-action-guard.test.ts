import { describe, expect, test, vi } from 'vitest';
import { guardToDooTaskAction } from '../apps/web/to-doo-action-guard';
import type { ToDooWorkbench } from '../apps/web/to-doo-workbench';

function fixture() {
  const blockers = [{ key: 'task@occ', taskId: 'task', occurrenceId: 'occ', title: '任务', kind: 'task' as const }];
  const model = {
    state: { selectedTaskId: 'task', selectedOccurrenceId: 'occ', error: '' },
    prepareTaskAction: vi.fn().mockResolvedValue([]),
    saveTask: vi.fn().mockResolvedValue(true), dirty: vi.fn().mockReturnValue(false),
  };
  return { model, typed: model as unknown as ToDooWorkbench, blockers, confirm: vi.fn().mockResolvedValue(true) };
}
describe('task actions preserve affected editing contexts', () => {
  test('clean actions do not ask to save and unavailable scope cannot proceed', async () => {
    const f = fixture();
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    f.model.prepareTaskAction.mockResolvedValue(null);
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
  });
  test('cancel keeps the draft and makes no save request', async () => {
    const f = fixture(); f.model.prepareTaskAction.mockResolvedValue(f.blockers); f.confirm.mockResolvedValue(false);
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
    expect(f.model.saveTask).not.toHaveBeenCalled();
  });
  test('a hidden occurrence or child draft is never implicitly saved', async () => {
    for (const context of [{ occurrenceId: 'another-period' }, { taskId: 'child' }, { kind: 'new' }]) {
      const f = fixture(); f.model.prepareTaskAction.mockResolvedValue([{ ...f.blockers[0], ...context }]);
      expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
      expect(f.model.state.error).toContain('任务草稿');
      expect(f.confirm).not.toHaveBeenCalled(); expect(f.model.saveTask).not.toHaveBeenCalled();
    }
  });
  test('saving rechecks the scope and does not continue after a failure or remaining edits', async () => {
    const f = fixture();
    f.model.prepareTaskAction.mockResolvedValueOnce(f.blockers).mockResolvedValueOnce([]);
    const explicitSave = vi.fn().mockResolvedValue(true);
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm, { save: explicitSave })).toBe(true);
    expect(explicitSave).toHaveBeenCalledOnce(); expect(f.model.prepareTaskAction).toHaveBeenCalledTimes(2);
    f.model.prepareTaskAction.mockResolvedValue(f.blockers); f.model.saveTask.mockResolvedValue(false);
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
  });
  test('changing selection while confirmation is open cancels the delayed action', async () => {
    const f = fixture(); f.model.prepareTaskAction.mockResolvedValue(f.blockers);
    f.confirm.mockImplementation(async () => { f.model.state.selectedTaskId = 'other'; return true; });
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
    expect(f.model.saveTask).not.toHaveBeenCalled();
  });
  test('a new affected draft discovered after save blocks the action', async () => {
    const f = fixture(); f.model.prepareTaskAction.mockResolvedValueOnce(f.blockers).mockResolvedValueOnce([{ ...f.blockers[0], taskId: 'child' }]);
    expect(await guardToDooTaskAction(f.typed, ['task'], f.confirm)).toBe(false);
  });
});
