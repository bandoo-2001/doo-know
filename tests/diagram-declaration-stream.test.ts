import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasDiagramDeclaration,
  hasDiagramDeclarationSync,
  scanDiagramDeclaration,
} from '../packages/core/knowledge/diagram-declaration';
let root: string;
beforeEach(() => (root = mkdtempSync(join(tmpdir(), 'diagram-header-'))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const marker = '<!-- dooknow:document {"version":1,"type":"flowchart","engine":"mermaid"} -->';
it.each([
  ['# ordinary\n' + marker, false],
  ['```md\n' + marker + '\n```', false],
  ['> ' + marker, false],
  ['    ' + marker, false],
  ['\t' + marker, false],
  [marker, true],
  ['\ufeff' + marker, true],
  ['\n   ' + marker, true],
  ['\ufeff---\r\ntitle: 中文\r\n---\r\n\r\n' + marker, true],
  ['---\n' + marker, false],
  ['---\ntitle: 中文\n...\n' + marker, true],
  ['---\ntitle: 中文\n--- extra\n' + marker, false],
  ['<!-- unrelated -->\n' + marker, false],
  ['<!-- dooknow:documentary {} -->', false],
  ['<!-- dooknow:document', true],
])(
  'classifies only a real header candidate with bounded stream state (%j)',
  async (source, expected) => {
    const chunks = Array.from(Buffer.from(source), (byte) => Buffer.from([byte]));
    expect(
      await scanDiagramDeclaration(
        (async function* () {
          yield* chunks;
        })(),
      ),
    ).toBe(expected);
    const file = join(root, 'sync.md');
    writeFileSync(file, source);
    expect(hasDiagramDeclarationSync(file)).toBe(expected);
  },
);
it('stops reading an ordinary long line as soon as its prefix rules out a declaration', async () => {
  let consumed = 0;
  async function* bytes() {
    consumed++;
    yield Buffer.from('# ordinary');
    consumed++;
    throw Error('ordinary file body should not be read');
  }
  expect(await scanDiagramDeclaration(bytes())).toBe(false);
  expect(consumed).toBe(1);
});
it('recognizes a declaration after very long frontmatter lines without retaining the lines', async () => {
  const file = join(root, 'long.md'),
    fd = openSync(file, 'wx');
  writeSync(fd, '\ufeff---\n');
  for (let i = 0; i < 128; i++) writeSync(fd, 'x'.repeat(65536));
  writeSync(fd, '\n...\n' + marker);
  closeSync(fd);
  expect(await hasDiagramDeclaration(file)).toBe(true);
});
it('does not mistake an indented or unclosed frontmatter example for a declared document', async () => {
  const file = join(root, 'ordinary.md');
  writeFileSync(file, ' ---\nfoo: bar\n---\n' + marker);
  expect(await hasDiagramDeclaration(file)).toBe(false);
});

it.each(['---\n---\r','---\n... \t\r'])('matches shared parser closing delimiters ending at bare CR (%j)',async prefix=>{
 const source=prefix+marker,file=join(root,'bare-cr.md');writeFileSync(file,source);
 expect(await hasDiagramDeclaration(file)).toBe(true);
 expect(hasDiagramDeclarationSync(file)).toBe(true);
});
