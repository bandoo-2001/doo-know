import { expect, test } from 'vitest';
import {
  normalizeToDooDisplayFields, readToDooDisplayFields,
  writeToDooDisplayFields, toDooDisplayFieldsKey,
} from '../apps/web/to-doo-display-preferences';

test('missing, corrupt and unsupported preferences keep existing task metadata visible', () => {
  const all = { list: true, priority: true, recurrence: true, resources: true };
  expect(readToDooDisplayFields({ getItem: () => null })).toEqual(all);
  expect(readToDooDisplayFields({ getItem: () => '{broken' })).toEqual(all);
  expect(normalizeToDooDisplayFields(['list'])).toEqual(all);
  expect(normalizeToDooDisplayFields({ list: 'false', priority: 0, resources: null })).toEqual(all);
});

test('partial browser preferences disable only explicit fields and cannot disable dates or state', () => {
  const result = normalizeToDooDisplayFields({ list: false, resources: false, due: false, plan: false, status: false });
  expect(result).toEqual({ list: false, priority: true, recurrence: true, resources: false });
  expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['due', 'plan', 'status']));
  result.priority = false;
  expect(normalizeToDooDisplayFields(null).priority).toBe(true);
});

test('display choices survive a read/write round trip without modifying the supplied preference', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const preference = { list: false, priority: false, recurrence: true, resources: false };
  expect(writeToDooDisplayFields(preference, storage)).toBe(true);
  expect(values.has(toDooDisplayFieldsKey)).toBe(true);
  expect(readToDooDisplayFields(storage)).toEqual(preference);
  expect(preference).toEqual({ list: false, priority: false, recurrence: true, resources: false });
});

test('denied browser storage does not prevent current-session display choices', () => {
  const storage = { getItem: () => { throw new Error('storage denied'); }, setItem: () => { throw new Error('storage denied'); } };
  expect(readToDooDisplayFields(storage).list).toBe(true);
  const preference = { list: false, priority: true, recurrence: true, resources: true };
  expect(writeToDooDisplayFields(preference, storage)).toBe(false);
  expect(preference.list).toBe(false);
});
