import { it, expect } from 'vitest';
import { validName } from '../packages/core/files.js';
it('rejects filenames beyond the existing 180-byte component budget before filesystem writes', () => {
  expect(validName('中'.repeat(59) + '.md')).toBe(true);
  expect(validName('中'.repeat(60) + '.md')).toBe(false);
});
