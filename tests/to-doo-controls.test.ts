import { h, Fragment } from 'vue';
import { describe, expect, test } from 'vitest';
import {
  prepareToDooSelectOptions,
  toDooSelectKey,
  normalizeToDooDateValue,
  validateToDooDateInput,
  createToDooConfirmation,
} from '../apps/web/to-doo-controls';

describe('typed Ant selection boundary', () => {
  test('nullable, boolean, zero and their string representations remain distinct through grouped options', () => {
    const values = [null, false, true, 0, '0', 'false', ''];
    const prepared = prepareToDooSelectOptions([
      h('optgroup', { label: '范围' }, [
        h(
          Fragment,
          null,
          values.map((value) => h('option', { value }, String(value))),
        ),
      ]),
    ]);
    expect(new Set(values.map(toDooSelectKey)).size).toBe(values.length);
    for (const value of values) expect(prepared.values.get(toDooSelectKey(value))).toBe(value);
    expect(prepared.options[0]).toMatchObject({ label: '范围' });
  });
  test('multiple labels and disabled groups retain the original references without coercion', () => {
    const prepared = prepareToDooSelectOptions([
      h('optgroup', { label: '归档', disabled: true }, [
        h('option', { value: 'work' }, '工作'),
        h('option', { value: 'life' }, '生活'),
      ]),
    ]);
    expect(prepared.options[0].options?.map((option) => option.disabled)).toEqual([true, true]);
    expect(['work', 'life'].map(toDooSelectKey).map((key) => prepared.values.get(key))).toEqual([
      'work',
      'life',
    ]);
  });
});

test('date boundary clears consistently and preserves user-local date and time strings', () => {
  expect(normalizeToDooDateValue(null)).toBe('');
  expect(normalizeToDooDateValue(undefined)).toBe('');
  for (const value of ['2026-10-30', '09:30', '2026-10-30T09:30'])
    expect(normalizeToDooDateValue(value)).toBe(value);
});

test('uncommitted date text preserves required and min/max form validation', () => {
  expect(validateToDooDateInput('', { required: true })).not.toBe('');
  expect(validateToDooDateInput('2026-02-30', {})).not.toBe('');
  expect(validateToDooDateInput('2026-10-30', { max: '2026-10-29' })).not.toBe('');
  expect(validateToDooDateInput('2026-10-29', { min: '2026-10-28', max: '2026-10-30' })).toBe('');
  expect(validateToDooDateInput('09:30', { type: 'time' })).toBe('');
  expect(validateToDooDateInput('2026-10-30 09:30', { type: 'datetime-local' })).toBe('');
});

test('a modal cancellation resolves false and does not replace an outstanding decision', async () => {
  const confirmation = createToDooConfirmation();
  const pending = confirmation.ask('移动到回收站？', { danger: true });
  expect(confirmation.current.value).toMatchObject({ content: '移动到回收站？', danger: true });
  expect(await confirmation.ask('第二次请求')).toBe(false);
  confirmation.finish(false);
  expect(await pending).toBe(false);
  expect(confirmation.current.value).toBeNull();
  const accepted = confirmation.ask('保存？');
  confirmation.finish(true);
  expect(await accepted).toBe(true);
});
