import { expect, it } from 'vitest';
import { toDooEntitySchemas, type ToDooEntityMap } from '../shared/to-doo-contracts';
import { nextAnniversary } from '../packages/core/to-doo/recurrence';
import { toDooAnniversaryDate as nextToDooAnniversary } from '../shared/to-doo-anniversaries';
const anniversary = (values: Partial<ToDooEntityMap['anniversary']>) =>
  toDooEntitySchemas.anniversary.parse({
    id: 'anniversary',
    revision: 'r1',
    createdAt: '2026-10-30T00:00:00Z',
    updatedAt: '2026-10-30T00:00:00Z',
    name: '纪念日',
    ...values,
  });
function expectDate(values: Partial<ToDooEntityMap['anniversary']>, from: string, date: string) {
  const value = anniversary(values);
  expect(nextAnniversary(value, from).date).toBe(date);
  expect(nextToDooAnniversary(value, from)).toBe(date);
}
it('finds the previous lunar year December occurrence during the solar new year', () => {
  expectDate({ calendar: 'lunar', date: '2024-12-15' }, '2026-01-01', '2026-02-02');
});
it.each(['previous_day', 'next_day'] as const)(
  'keeps the existing %s missing-leap-month rule consistent in UI and scheduler',
  (leapPolicy) => {
    expectDate(
      { calendar: 'lunar', date: '2023-02-01', lunarLeapMonth: true, leapPolicy },
      '2026-01-01',
      '2026-03-19',
    );
  },
);
it('can skip a missing leap month and keep a nonrepeating lunar original date', () => {
  expectDate(
    { calendar: 'lunar', date: '2023-02-01', lunarLeapMonth: true, leapPolicy: 'skip' },
    '2026-01-01',
    '2042-03-22',
  );
  expectDate(
    { calendar: 'lunar', date: '2024-02-30', repeatYearly: false },
    '2026-10-30',
    '2024-04-08',
  );
});
it.each([
  ['previous_day', '2026-02-28'],
  ['next_day', '2026-03-01'],
  ['skip', '2028-02-29'],
] as const)('preserves the Gregorian %s leap-day policy', (leapPolicy, date) => {
  expectDate({ date: '2024-02-29', leapPolicy }, '2026-01-01', date);
});

it('preserves a saved card appearance while accepting older anniversaries', () => {
  expect(anniversary({ date: '2026-11-04' }).name).toBe('纪念日');
  const styled = toDooEntitySchemas.anniversary.parse({
    ...anniversary({ date: '2026-11-04' }),
    appearance: { style: 'landscape', palette: 'sage' },
  });
  expect(styled).toMatchObject({ appearance: { style: 'landscape', palette: 'sage' } });
});

it('rejects unknown card styles and arbitrary CSS as palette data', () => {
  const entity = anniversary({ date: '2026-11-04' });
  expect(
    toDooEntitySchemas.anniversary.safeParse({
      ...entity,
      appearance: { style: 'unknown', palette: 'rose' },
    }).success,
  ).toBe(false);
  expect(
    toDooEntitySchemas.anniversary.safeParse({
      ...entity,
      appearance: { style: 'bloom', palette: 'url(https://example.invalid)' },
    }).success,
  ).toBe(false);
});
