import { expect, it } from 'vitest';
import {
  assertPortableResourceBudget,
  portableResourceLimits,
} from '../shared/portable-resource-limits';
const MiB = 1024 * 1024;
it('accepts a portable instance package that is larger than the legacy JSON import budget', () => {
  expect(() =>
    assertPortableResourceBudget({
      kind: 'media',
      fileBytes: 128 * MiB,
      totalBytes: 256 * MiB,
      files: 10000,
      documents: 1000,
      stagedBytes: 512 * MiB,
    }),
  ).not.toThrow();
});
it.each([
  { kind: 'media', fileBytes: 128 * MiB + 1 },
  { kind: 'png', fileBytes: 10 * MiB + 1 },
  { kind: 'whiteboard', fileBytes: 8 * MiB + 1 },
  { kind: 'attachment', fileBytes: 10 * MiB + 1 },
  { totalBytes: 256 * MiB + 1 },
  { files: 10001 },
  { documents: 1001 },
  { stagedBytes: 512 * MiB + 1 },
  { files: -1 },
  { fileBytes: Infinity },
  { files: 1.2 },
])('rejects exceeding or malformed budget measurements (%j)', (changed) => {
  expect(() =>
    assertPortableResourceBudget({
      kind: 'media',
      fileBytes: 1,
      totalBytes: 1,
      files: 1,
      documents: 1,
      stagedBytes: 1,
      ...changed,
    } as Parameters<typeof assertPortableResourceBudget>[0]),
  ).toThrow();
});
it('allows an instance to tighten the shared budget without bypassing media checks', () => {
  expect(() =>
    assertPortableResourceBudget(
      { kind: 'media', fileBytes: 21 * MiB },
      { ...portableResourceLimits, mediaBytes: 20 * MiB },
    ),
  ).toThrow();
});
