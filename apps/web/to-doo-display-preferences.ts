/** Browser-only presentation preferences; never part of task entities or commands. */
export type ToDooDisplayFields = {
  list: boolean;
  priority: boolean;
  recurrence: boolean;
  resources: boolean;
};

export const toDooDisplayFieldsKey = 'dooknow.to-doo.display-fields.v1';
const defaults: ToDooDisplayFields = { list: true, priority: true, recurrence: true, resources: true };

export function normalizeToDooDisplayFields(value: unknown): ToDooDisplayFields {
  const result = { ...defaults };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of Object.keys(result) as (keyof ToDooDisplayFields)[]) {
    const selected = (value as Record<string, unknown>)[key];
    if (typeof selected === 'boolean') result[key] = selected;
  }
  return result;
}

export function readToDooDisplayFields(storage?: Pick<Storage, 'getItem'>): ToDooDisplayFields {
  try {
    const source = storage ?? globalThis.localStorage;
    return normalizeToDooDisplayFields(JSON.parse(source.getItem(toDooDisplayFieldsKey) || 'null'));
  } catch {
    return normalizeToDooDisplayFields(null);
  }
}

export function writeToDooDisplayFields(
  value: ToDooDisplayFields,
  storage?: Pick<Storage, 'setItem'>,
): boolean {
  try {
    const source = storage ?? globalThis.localStorage;
    source.setItem(toDooDisplayFieldsKey, JSON.stringify(normalizeToDooDisplayFields(value)));
    return true;
  } catch {
    return false;
  }
}
