import { toDooPriorityLabels, toDooStatusLabels } from './to-doo-workbench';

export type ToDooTaskValueKind = 'status' | 'priority';
export type ToDooTaskValueOption = { value: string; label: string };

export function toDooTaskValueOptions(kind: ToDooTaskValueKind): ToDooTaskValueOption[] {
  if (kind === 'status')
    return Object.entries(toDooStatusLabels).map(([value, label]) => ({ value, label }));
  return (['high', 'normal', 'low', 'none'] as const).map((value) => ({
    value,
    label: toDooPriorityLabels[value] + (value === 'none' ? '' : '优先级'),
  }));
}

const statusPaths: Record<string, string> = {
  todo: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17',
  doing: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17 M10 8.5l5.5 3.5-5.5 3.5z',
  blocked: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17 M9 8.5v7 M15 8.5v7',
  done: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17 m-4 8.5 2.7 2.7 5.4-5.4',
  cancelled: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17 m-3 5.5 6 6 M15 9l-6 6',
  skipped: 'm6 5 9 7-9 7z M18 5v14',
};
const flagPath =
  'M5 21V4.5c2.7-1.5 4.8-1.4 7.1 0 2.3 1.4 4.2 1.4 6.9-.1v9.3c-2.7 1.5-4.6 1.5-6.9.1-2.3-1.4-4.4-1.5-7.1 0';

export function toDooTaskValue(kind: ToDooTaskValueKind, value: string) {
  const option = toDooTaskValueOptions(kind).find((option) => option.value === value);
  return {
    label: option?.label || value,
    path: kind === 'priority' ? flagPath : statusPaths[value] || statusPaths.todo,
  };
}

/** Domain Selects only emit their real stored values, never rendered labels or unknown keys. */
export function isToDooTaskValue(kind: ToDooTaskValueKind, value: unknown): value is string {
  return (
    typeof value === 'string' &&
    toDooTaskValueOptions(kind).some((option) => option.value === value)
  );
}
