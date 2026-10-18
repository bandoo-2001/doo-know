import { describe, expect, it } from 'vitest';
import { importPath, encodeImportFile } from '../apps/web/components/settings/transfer-files';
describe('browser transfer boundaries', () => {
  it('preserves nested attachment paths and strips only a picker root when requested', () => {
    expect(importPath('notes/assets/picture.png')).toBe('notes/assets/picture.png');
    expect(importPath('Collection/notes/a.md', true)).toBe('notes/a.md');
  });
  it.each([
    '/etc/passwd',
    '../private.md',
    'folder/../private.md',
    'C:\\private.md',
    'a//b.md',
    'a/./b.md',
  ])('rejects unsafe relative path %s', (value) => {
    expect(() => importPath(value)).toThrow();
  });
  it('rejects Markdown that cannot be decoded without losing bytes', async () => {
    await expect(encodeImportFile(new Blob([new Uint8Array([0xff])]), 'bad.md')).rejects.toThrow(
      'UTF-8',
    );
  });
  it('encodes attachments losslessly and Markdown as UTF-8', async () => {
    expect(await encodeImportFile(new Blob(['# 中文']), 'nested/a.md')).toEqual({
      path: 'nested/a.md',
      encoding: 'utf8',
      content: '# 中文',
    });
    expect(
      await encodeImportFile(new Blob([new Uint8Array([0, 255, 127])]), 'assets/a.png'),
    ).toEqual({ path: 'assets/a.png', encoding: 'base64', content: 'AP9/' });
  });
});
