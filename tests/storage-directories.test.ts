import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { scanFiles, validateRelative } from '../packages/core/files';
import { writeKnowledgeDataFile, readKnowledgeDataFile } from '../packages/core/knowledge-data';
import { knowledgeDataDirectory } from '../packages/core/knowledge-data-path';
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(tmpdir(), 'doo-storage-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});
test('new application state is written to _doo-data and roundtrips', () => {
  const path = root();
  writeKnowledgeDataFile(path, 'library/state.json', '{"test":true}');
  expect(existsSync(join(path, '_doo-data/library/state.json'))).toBe(true);
  expect(existsSync(join(path, '_data'))).toBe(false);
  expect(readKnowledgeDataFile(path, 'library/state.json')?.toString()).toBe('{"test":true}');
});
test('legacy application roots remain readable before an explicit migration', () => {
  const path = root();
  mkdirSync(join(path, '_data/library'), { recursive: true });
  writeFileSync(
    join(path, '_data/manifest.json'),
    JSON.stringify({ format: 1, id: 'legacy-library' }),
  );
  writeFileSync(join(path, '_data/library/state.json'), 'old-state');
  expect(knowledgeDataDirectory(path)).toBe(join(path, '_data'));
  expect(readKnowledgeDataFile(path, 'library/state.json')?.toString()).toBe('old-state');
});
test('two application data roots cannot be silently merged or overwritten', () => {
  const path = root();
  for (const dir of ['_data', '_doo-data']) {
    mkdirSync(join(path, dir));
    writeFileSync(join(path, dir, 'manifest.json'), JSON.stringify({ format: 1, id: dir }));
  }
  expect(() => knowledgeDataDirectory(path)).toThrow();
});
test('frontend assets is ordinary source; namespaced application assets and data are excluded', () => {
  const path = root();
  for (const dir of [
    'frontend/assets',
    'notes/_doo-assets/group',
    '_doo-data/apps',
    '_data/apps',
  ]) {
    mkdirSync(join(path, dir), { recursive: true });
    writeFileSync(join(path, dir, 'README.md'), '# Source');
  }
  expect(scanFiles(path).notes).toEqual(['frontend/assets/README.md']);
  expect(() => validateRelative('frontend/assets/README.md', 'note')).not.toThrow();
  expect(() => validateRelative('notes/_doo-assets/group/source.excalidraw', 'note')).toThrow();
  expect(() => validateRelative('_doo-data/apps/state.md', 'asset')).toThrow();
});

test('legacy native snapshots remain assets while frontend Markdown is a normal document', async () => {
 const { isImportDocument }=await import('../apps/server/platform/transfer-import');
 expect(isImportDocument('assets/diagram-'+ 'a'.repeat(64) + '.excalidraw')).toBe(false);
 expect(isImportDocument('frontend/assets/README.md')).toBe(true);
});
