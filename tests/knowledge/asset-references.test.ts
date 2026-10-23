import { it, expect, vi } from 'vitest';
import { mkdtemp, open, rm, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as reader from '../../packages/core/knowledge/file-reader.js';
import { hasSavedAssetReference } from '../../packages/core/knowledge/asset-references.js';

const notePath = '00-Inbox/current.md',
  image = '00-Inbox/assets/photo.png',
  pdf = '00-Inbox/assets/book.pdf';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-asset-proof-'));
  return {
    root,
    file: join(root, 'current.md'),
    close: () => rm(root, { recursive: true, force: true }),
  };
}
async function large(file: string, prefix = '', suffix = '', bytes = 2 * 1024 * 1024) {
  const fd = await open(file, 'w'),
    pattern = Buffer.from('ordinary paragraph\n\n'.repeat(2000));
  try {
    await fd.write(prefix);
    let remaining = bytes;
    while (remaining) {
      const size = Math.min(remaining, pattern.length);
      await fd.write(pattern.subarray(0, size));
      remaining -= size;
    }
    await fd.write('\n\n' + suffix);
  } finally {
    await fd.close();
  }
}

it('proves current inline image/PDF in an actual multi-paragraph 2MiB file with 64KiB reads', async () => {
  const f = await fixture(),
    real = reader.readBlocks;
  let biggest = 0;
  vi.spyOn(reader, 'readBlocks').mockImplementation(async function* (...args) {
    for await (const block of real(...args)) {
      biggest = Math.max(biggest, block.length);
      yield block;
    }
  });
  try {
    await large(f.file, '', '![photo](assets/photo.png)\n[PDF](assets/book.pdf "book")');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
    expect(await hasSavedAssetReference(f.file, notePath, pdf)).toBe(true);
    expect(biggest).toBeLessThanOrEqual(65536);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it.each([
  '```markdown\n\n![fake](assets/photo.png)\n\n```\n',
  '~~~\n\n![fake](assets/photo.png)\n\n~~~\n',
  '    ![fake](assets/photo.png)\n    [PDF](assets/book.pdf)\n',
  '`![fake](assets/photo.png)`\n',
  '[unused]: assets/photo.png\n',
])('denies code or unused definition references: %s', async (content) => {
  const f = await fixture();
  try {
    await writeFile(f.file, content);
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
    expect(await hasSavedAssetReference(f.file, notePath, pdf)).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps fenced code state across an actual 2MiB body and blank paragraphs', async () => {
  const f = await fixture();
  try {
    await large(f.file, '```\n', '![fake](assets/photo.png)\n```');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
  } finally {
    await f.close();
  }
});

it.each([
  '![photo][IMG]\n\n[img]: assets/photo.png "title"\n',
  '[img]: assets/photo.png\n\n![photo][img]\n',
  '![image label][]\n\n[image label]: assets/photo.png\n',
  '![image label]\n\n[image label]: assets/photo.png\n',
])('proves reference styles across paragraph boundaries: %s', async (content) => {
  const f = await fixture();
  try {
    await writeFile(f.file, content);
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
  } finally {
    await f.close();
  }
});

it('resolves a PDF definition across 2MiB and honors the first definition', async () => {
  const f = await fixture();
  try {
    await large(f.file, '[Read me][book]\n\n', '[book]: assets/book.pdf');
    expect(await hasSavedAssetReference(f.file, notePath, pdf)).toBe(true);
    await writeFile(
      f.file,
      '[same]: assets/other.png\n\n![photo][same]\n\n[same]: assets/photo.png\n',
    );
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
    await writeFile(f.file, '```\n[label]: assets/photo.png\n```\n\n![fake][label]\n');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
  } finally {
    await f.close();
  }
});

it('does not authorize an asset only referenced in another file or after the current reference is removed', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'other.md'), '![private](assets/photo.png)');
    await writeFile(f.file, 'No saved reference');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
    await writeFile(f.file, '![photo](assets/photo.png)');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
    await writeFile(f.file, 'Reference removed');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
  } finally {
    await f.close();
  }
});

it('rejects an undecidable long single paragraph, but accepts a closed early proof followed by a long body', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, 'x'.repeat(2 * 1024 * 1024) + '![photo](assets/photo.png)');
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'ASSET_REFERENCE_TOO_COMPLEX',
    });
    await writeFile(f.file, '![photo](assets/photo.png)\n\n' + 'x'.repeat(2 * 1024 * 1024));
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
  } finally {
    await f.close();
  }
});

it('validates the entire UTF-8 source after an early hit, and rejects oversize files', async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.file,
      Buffer.concat([Buffer.from('![photo](assets/photo.png)\n\n'), Buffer.from([0xff])]),
    );
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'INVALID_UTF8',
    });
    const fd = await open(f.file, 'w');
    await fd.truncate(20 * 1024 * 1024 + 1);
    await fd.close();
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE',
    });
  } finally {
    await f.close();
  }
});

it('rejects a real external change during the stream instead of returning the previous proof', async () => {
  const f = await fixture(),
    real = reader.readBlocks;
  let changed = false;
  try {
    await large(f.file, '![photo](assets/photo.png)\n\n');
    vi.spyOn(reader, 'readBlocks').mockImplementation(async function* (...args) {
      for await (const bytes of real(...args)) {
        if (!changed) {
          changed = true;
          const fd = await open(f.file, 'r+');
          await fd.write('EXTERNAL_CHANGE', 0, 'utf8');
          await fd.close();
        }
        yield bytes;
      }
    });
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('detects a same-size same-mtime external edit by comparing both complete stream hashes', async () => {
  const f = await fixture(),
    real = reader.readBlocks;
  let changed = false;
  try {
    const prefix = '![photo](assets/photo.png)\n\n';
    await large(f.file, prefix);
    await utimes(f.file, 1700000000, 1700000000);
    const before = await stat(f.file, { bigint: true });
    vi.spyOn(reader, 'readBlocks').mockImplementation(async function* (...args) {
      for await (const bytes of real(...args)) {
        if (!changed) {
          changed = true;
          const fd = await open(f.file, 'r+');
          await fd.write(
            Buffer.alloc(Buffer.byteLength(prefix), 32),
            0,
            Buffer.byteLength(prefix),
            0,
          );
          await fd.close();
          await utimes(f.file, 1700000000, 1700000000);
        }
        yield bytes;
      }
    });
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
    const after = await stat(f.file, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it('refuses nested/container fences and ignores a non-closing indented fence marker', async () => {
  const f = await fixture();
  try {
    for (const content of [
      '> ```\n> ![fake](assets/photo.png)\n> ```',
      '- ```\n\n  ![fake](assets/photo.png)\n  ```',
    ]) {
      await writeFile(f.file, content);
      await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
        code: 'ASSET_REFERENCE_TOO_COMPLEX',
      });
    }
    await writeFile(f.file, '```\n    ```\n![fake](assets/photo.png)\n```');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps display math opaque across a streamed 2MiB body and resumes at its closing line', async () => {
  const f = await fixture();
  try {
    await large(f.file, '$$\n', '![hidden](assets/photo.png)\n\n$$');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
    await large(f.file, '$$\n', '![hidden](assets/photo.png)\n\n$$\n\n![visible](assets/photo.png)');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
  } finally {
    await f.close();
  }
});

it('resolves a footnote across 2MiB and follows only rendered definitions', async () => {
  const f = await fixture();
  try {
    await large(f.file, 'reference[^a]\n\n', '[^a]: first paragraph\n\n    ![photo](assets/photo.png)');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
    await writeFile(f.file, 'reference[^a]\n\n[^a]: see[^b]\n\n[^b]: ![photo](assets/photo.png)\n');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
    await writeFile(f.file, 'reference[^a]\n\n[^a]: see[^b]\n\n[^b]: back[^a]\n');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps complete footnote units within the existing parser budget', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, 'reference[^a]\n\n[^a]: first\n\n' + '    continuation\n\n'.repeat(3000));
    await expect(hasSavedAssetReference(f.file, notePath, image)).rejects.toMatchObject({
      code: 'ASSET_REFERENCE_TOO_COMPLEX',
    });
  } finally {
    await f.close();
  }
});

it('retains a closed direct proof before a footnote and a later complex container', async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, '![photo](assets/photo.png)\n[^a]: explanation\n\n> ```\n> hidden\n> ```\n');
    expect(await hasSavedAssetReference(f.file, notePath, image)).toBe(true);
  } finally {
    await f.close();
  }
});
