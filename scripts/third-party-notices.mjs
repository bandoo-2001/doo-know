import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// Include licenses for all build inputs, including code bundled into browser/plugin assets.
export async function thirdPartyNotices(root = resolve('node_modules')) {
  const records = [];
  async function packages(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith('@')) {
        await packages(path);
        continue;
      }
      let metadata;
      try {
        metadata = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
      } catch {
        continue;
      }
      const texts = [];
      for (const name of await readdir(path))
        if (/^(licen[sc]e|copying|notice)([.-].*)?$/i.test(name)) {
          const file = join(path, name),
            info = await lstat(file);
          if (info.isFile() && !info.isSymbolicLink())
            texts.push(name + '\n' + (await readFile(file, 'utf8')));
        }
      records.push(
        `${metadata.name}@${metadata.version}\nLicense: ${metadata.license || 'See package source'}\n${texts.join('\n\n')}`,
      );
      try {
        await packages(join(path, 'node_modules'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  await packages(root);
  return records.sort().join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
}
