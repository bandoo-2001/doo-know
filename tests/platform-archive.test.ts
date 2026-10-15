import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from 'tar';
import { validateArchive, extractArchive } from '../server/platform/archive.js';
it('streams and extracts regular PAX archives with long UTF-8 filenames, rejecting links and expansion beyond limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-archive-'));
  try {
    const source = join(root, 'source'),
      target = join(root, 'target');
    await mkdir(source);
    await mkdir(target);
    const name = '测试'.repeat(25) + '.md';
    await writeFile(join(source, name), '# intact');
    const archive = join(root, 'valid.tar.gz');
    await create({ file: archive, cwd: source, gzip: true, portable: true }, ['.']);
    expect((await validateArchive(archive)).files).toBe(1);
    await extractArchive(archive, target);
    expect(await readFile(join(target, name), 'utf8')).toBe('# intact');
    await expect(validateArchive(archive, { maxBytes: 2 })).rejects.toMatchObject({
      code: 'ARCHIVE_LIMIT_EXCEEDED',
    });
    await symlink('/etc/passwd', join(source, 'bad-link'));
    const invalid = join(root, 'links.tar.gz');
    await create({ file: invalid, cwd: source, gzip: true }, ['.']);
    await expect(validateArchive(invalid)).rejects.toMatchObject({ code: 'INVALID_ARCHIVE_ENTRY' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
