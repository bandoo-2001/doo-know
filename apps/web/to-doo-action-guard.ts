import type { ToDooWorkbench } from './to-doo-workbench';

type ConfirmTaskAction = (message: string, options?: { title?: string; danger?: boolean }) => Promise<boolean>;

/** An action may commit only after every affected editing context is accounted for. */
export async function guardToDooTaskAction(
  model: ToDooWorkbench,
  taskIds: string[],
  confirm: ConfirmTaskAction,
  options: { includeDescendants?: boolean; current?: () => boolean; save?: () => Promise<unknown> } = {},
): Promise<boolean> {
  const affectedIds = [...taskIds];
  const scopeKey = () => {
    const ids = new Set(affectedIds);
    if (options.includeDescendants !== false) {
      let added = true;
      while (added) {
        added = false;
        for (const task of model.taskDefinitions())
          if (!task.deletedAt && task.parentTaskId && ids.has(task.parentTaskId) && !ids.has(task.id)) {
            ids.add(task.id); added = true;
          }
      }
    }
    return [...ids].sort().join('\0');
  };
  const taskId = model.state.selectedTaskId;
  const occurrenceId = model.state.selectedOccurrenceId;
  const current = () => model.state.selectedTaskId === taskId &&
    model.state.selectedOccurrenceId === occurrenceId && (options.current?.() ?? true);
  if (!current()) return false;
  const blockers = await model.prepareTaskAction(affectedIds, options.includeDescendants ?? true);
  if (!blockers || !current()) return false;
  if (scopeKey().split('\0').includes(taskId) && !model.validateTaskDraft()) return false;
  if (!blockers.length) return true;
  const originalScope = scopeKey();
  const only = blockers[0];
  if (blockers.length !== 1 || only.kind !== 'task' ||
      only.taskId !== taskId || only.occurrenceId !== occurrenceId) {
    model.state.error = `请先从“任务草稿”处理${blockers.length}份未保存内容：${
      blockers.slice(0, 3).map(value => value.title || '未命名任务').join('、')
    }${blockers.length > 3 ? '等' : ''}。这次操作尚未执行。`;
    return false;
  }
  if (!(await confirm(`「${only.title || '这份任务'}」有未保存的修改。保存成功后再继续这次操作？`, {
    title: '保存并继续',
  })) || !current()) return false;
  const result = await (options.save ? options.save() : model.saveTask());
  if (!result || !current() || model.dirty()) return false;
  // The save can change both revisions and the affected subtree. Resolve again
  // rather than executing an action against the pre-save editing snapshot.
  const remaining = await model.prepareTaskAction(affectedIds, options.includeDescendants ?? true);
  if (remaining && scopeKey() !== originalScope) {
    model.state.error = '子任务范围已改变，请重新发起操作并确认。';
    return false;
  }
  return !!remaining && !remaining.length && current();
}
