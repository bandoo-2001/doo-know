import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixture, loginFixtureOwner, type Fixture } from './support/fixture';
import { backlinkService } from '../packages/core/knowledge/backlinks';
import { noteService } from '../packages/core/notes';
import { openDatabase } from '../packages/core/db';

describe('bounded authenticated backlinks lookup', () => {
  let f: Fixture;
  let headers: Awaited<ReturnType<typeof loginFixtureOwner>>;
  let serial = 0;
  beforeAll(async () => { f = await createFixture(); headers = await loginFixtureOwner(f); });
  afterAll(async () => f?.close());
  async function folder() {
    const path = `00-Inbox/backlinks-${++serial}`;
    await mkdir(join(f.knowledgeRoot, path));
    return path;
  }
  async function note(folderPath: string, fileName: string, content = '# fixture') {
    const response = await f.app.inject({ method: 'POST', url: '/api/notes', headers, payload: { folderPath, fileName, content } });
    expect(response.statusCode, response.body).toBe(201);
    return response.json();
  }
  async function lookup(id: string, cursor?: string) {
    const response = await f.app.inject({ url: `/api/notes/${id}/backlinks${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`, headers });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }

  it('finds parsed Wiki aliases, relative ordinary links and rendered footnotes while excluding hidden syntax and selflinks', async () => {
    const path = await folder();
    const target = await note(path, '知识 & 测试.md', '# Target\n\n[[知识 & 测试]]');
    const encoded = encodeURIComponent('知识 & 测试.md');
    const wiki = await note(path, 'wiki.md', '# Wiki source\n\n[[知识 & 测试#段落|显示别名]]\n\n[[知识 & 测试]]');
    await mkdir(join(f.knowledgeRoot, path, 'nested'));
    const ordinary = await note(path + '/nested', 'ordinary.md', `# Ordinary source\n\n[显示别名](../${encoded}#fragment)`);
    const footnote = await note(path, 'footnote.md', `# Footnote source\n\nref[^a]\n\n[^a]: [source](${encoded})`);
    const reference = await note(path, 'reference.md', `# Reference source\n\n[read][ref]\n\n[ref]: ${encoded}`);
    for (const [name, content] of [
      ['fence', '```md\n[[知识 & 测试]]\n```'],
      ['inline', '`[[知识 & 测试]]`'],
      ['math', '$$\nx\n\n[[知识 & 测试]]\n\n$$'],
      ['unused-footnote', '[^unused]: [[知识 & 测试]]'],
      ['image', `![image](${encoded})`],
      ['external', `[remote](https://example.invalid/${encoded})`],
      ['properties', '--- \nrelated: "[[知识 & 测试]]"\n---\n\nBody'],
    ]) await note(path, name + '.md', content);
    const found = await lookup(target.id);
    expect(found.matches).toEqual([wiki, ordinary, footnote, reference].map(source => ({
      id: source.id, title: source.title, relativePath: source.relativePath,
    })));
    expect(found.nextCursor).toBeUndefined();
    expect(found.incomplete).toBe(false);
  });

  it('reads at most 50 catalog candidates per page and explicitly continues a fixed catalog snapshot', async () => {
    const path = await folder(), target = await note(path, 'target.md');
    const expected: string[] = [];
    for (let index = 0; index < 53; index++) expected.push((await note(path, `source-${index}.md`, '[[target]]')).id);
    const first = await lookup(target.id);
    expect(first.checked + first.skipped).toBeLessThanOrEqual(50);
    expect(first.incomplete).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    const late = await note(path, 'late.md', '[[target]]');
    const matches = [...first.matches];
    let page = first;
    for (let count = 0; page.nextCursor && count < 10; count++) {
      page = await lookup(target.id, page.nextCursor);
      expect(page.checked + page.skipped).toBeLessThanOrEqual(50);
      matches.push(...page.matches);
    }
    expect(page.nextCursor).toBeUndefined();
    expect(page.incomplete).toBe(false);
    expect(matches.map((source: any) => source.id)).toEqual(expected);
    expect(matches.map((source: any) => source.id)).not.toContain(late.id);
    const other = await note(path, 'other.md');
    expect((await f.app.inject({ url: `/api/notes/${other.id}/backlinks?cursor=${encodeURIComponent(first.nextCursor)}`, headers })).statusCode).toBe(400);
    expect((await f.app.inject({ url: `/api/notes/${target.id}/backlinks?cursor=invalid`, headers })).statusCode).toBe(400);
  });

  it('skips oversized, missing, linked and invalid UTF-8 sources without loading large notes', async () => {
    const path = await folder(), target = await note(path, 'target.md');
    const valid = await note(path, 'valid.md', '# Valid\n\n[[target]]');
    const oversized = await note(path, 'oversized.md');
    await writeFile(join(f.knowledgeRoot, oversized.relativePath), 'x'.repeat(256 * 1024) + '\n[[target]]');
    const invalid = await note(path, 'invalid.md');
    await writeFile(join(f.knowledgeRoot, invalid.relativePath), Buffer.from([0xff]));
    const missing = await note(path, 'missing.md');
    await unlink(join(f.knowledgeRoot, missing.relativePath));
    const linked = await note(path, 'linked.md');
    const outside = join(f.root, 'outside.md');
    await writeFile(outside, '[[target]]');
    await unlink(join(f.knowledgeRoot, linked.relativePath));
    await symlink(outside, join(f.knowledgeRoot, linked.relativePath));
    // Earlier test folders remain catalog rows; consume their bounded pages too.
    let page = await lookup(target.id), checked = page.checked, skipped = page.skipped;
    const matches = [...page.matches];
    while (page.nextCursor) {
      page = await lookup(target.id, page.nextCursor);
      checked += page.checked; skipped += page.skipped; matches.push(...page.matches);
    }
    expect(matches.map((source: any) => source.id)).toEqual([valid.id]);
    expect(checked).toBeGreaterThan(0);
    expect(skipped).toBe(4);
    expect(page.incomplete).toBe(true);
  });

  it('requires authenticated knowledge access and never exposes private backlinks through a share', async () => {
    const path = await folder(), target = await note(path, 'target.md');
    const share = await f.app.inject({ method: 'POST', url: `/api/notes/${target.id}/share`, headers, payload: {} });
    const token = share.json().token;
    expect((await f.app.inject({ url: `/api/notes/${target.id}/backlinks` })).statusCode).toBe(401);
    expect((await f.app.inject({ url: `/api/notes/${target.id}/backlinks?share=${token}` })).statusCode).toBe(401);
    expect((await f.app.inject({ url: `/api/public/shares/${token}/backlinks` })).statusCode).toBe(404);
    expect((await f.app.inject({ url: '/api/notes/missing/backlinks', headers })).statusCode).toBe(404);
  });

  it('needs only read scope and filters unauthorized source notes before paging, including Unicode prefixes', async () => {
    const allowed = `00-Inbox/allowed-😀-${++serial}`, privatePath = await folder();
    await mkdir(join(f.knowledgeRoot, allowed));
    const target = await note(allowed, 'target.md');
    const visible = await note(allowed, 'visible.md', '[[target]]');
    await note(privatePath, 'private.md', `[[../allowed-😀-${serial - 1}/target]]`);
    const db = openDatabase(f.dataRoot);
    try {
      const notes = noteService(f.config, db);
      const principal = { id: 'read-only', clientId: 'fixture', scopes: ['knowledge:read'], allowedPrefixes: [allowed] };
      expect(backlinkService(f.config, db, notes, principal).page(target.id)).toEqual({
        matches: [{ id: visible.id, title: visible.title, relativePath: visible.relativePath }],
        checked: 1, skipped: 0, incomplete: false,
      });
      expect(() => backlinkService(f.config, db, notes, { ...principal, scopes: [] }).page(target.id)).toThrow();
      expect(() => backlinkService(f.config, db, notes, { ...principal, id: 'share:fixture' }).page(target.id)).toThrow();
    } finally { db.close(); }
  });
});
