import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { scanFiles, safePath, validateRelative } from '../packages/core/files';
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
test('an ordinary _data source folder never supplies or receives application state', () => {
  const path = root();
  mkdirSync(join(path, '_data/library'), { recursive: true });
  writeFileSync(
    join(path, '_data/manifest.json'),
    JSON.stringify({ format: 1, id: 'legacy-library' }),
  );
  writeFileSync(join(path, '_data/library/state.json'), 'old-state');
  expect(knowledgeDataDirectory(path)).toBe(join(path, '_doo-data'));
  expect(readKnowledgeDataFile(path, 'library/state.json')).toBeUndefined();
  writeKnowledgeDataFile(path, 'library/state.json', 'current-state');
  expect(readKnowledgeDataFile(path, 'library/state.json')?.toString()).toBe('current-state');
});
test('ordinary _data and current application state coexist independently', () => {
  const path = root();
  for (const dir of ['_data', '_doo-data']) {
    mkdirSync(join(path, dir));
    writeFileSync(join(path, dir, 'manifest.json'), JSON.stringify({ format: 1, id: dir }));
  }
  expect(knowledgeDataDirectory(path)).toBe(join(path, '_doo-data'));
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
  expect(scanFiles(path).notes.sort()).toEqual(['_data/apps/README.md', 'frontend/assets/README.md']);
  expect(() => validateRelative('frontend/assets/README.md', 'note')).not.toThrow();
  expect(() => validateRelative('notes/_doo-assets/group/source.excalidraw', 'note')).toThrow();
  expect(() => validateRelative('_doo-data/apps/state.md', 'asset')).toThrow();
});

test('only Markdown is discovered as a document; native sources remain attachments', async () => {
 const { isImportDocument }=await import('../apps/server/platform/transfer-import');
 expect(isImportDocument('assets/diagram-'+ 'a'.repeat(64) + '.excalidraw')).toBe(false);
 expect(isImportDocument('notes/board.excalidraw')).toBe(false);
 expect(isImportDocument('notes/_doo-assets/source.excalidraw')).toBe(false);
 expect(isImportDocument('frontend/assets/README.md')).toBe(true);
 const path=root();
 writeFileSync(join(path,'board.excalidraw'),'{}');
 expect(scanFiles(path).notes).toEqual([]);
 expect(()=>validateRelative('board.excalidraw','note')).toThrow();
});

test('asset reads use the actual path and never redirect through a migration alias file', () => {
 const path=root();
 mkdirSync(join(path,'_doo-assets'));
 writeFileSync(join(path,'_doo-assets','image.png'),'current');
 mkdirSync(join(path,'_doo-data/library'),{recursive:true});
 writeFileSync(join(path,'_doo-data/library/asset-aliases.json'),JSON.stringify({version:1,aliases:[{from:'assets/image.png',to:'_doo-assets/image.png',sha256:'a'.repeat(64)}]}));
 expect(safePath(path,'_doo-assets/image.png','asset')).toBe(join(path,'_doo-assets/image.png'));
 expect(()=>safePath(path,'assets/image.png','asset')).toThrow();
});
