import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import * as publication from '../packages/core/knowledge/diagram-publications';
const h = (v: string) => v.repeat(64);
it('proves the complete render tuple and exact resource context, not only a PNG hash', () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-proof-'));
  const db = openDatabase(root);
  try {
    db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run('note', '00-Inbox/graph.md');
    const manifest = {
      type: 'whiteboard',
      sourceHash: h('a'),
      renderHash: h('b'),
      previewHash: h('c'),
      resources: [
        { role: 'source', path: '00-Inbox/_doo-assets/source.excalidraw', hash: h('a') },
        { role: 'preview', path: '00-Inbox/_doo-assets/view.png', hash: h('c') },
      ],
    };
    db.prepare('INSERT INTO diagram_document_versions VALUES(?,?,?,?,?,?,?,?,?)').run(
      'note',
      h('d'),
      '00-Inbox/graph.md',
      'whiteboard',
      h('a'),
      h('b'),
      h('c'),
      JSON.stringify(manifest),
      Date.now(),
    );
    const check = publication.hasDiagramBindingProof;
    expect(check).toBeTypeOf('function');
    const input = {
      sourceHash: h('a'),
      renderHash: h('b'),
      previewHash: h('c'),
      sourcePath: '00-Inbox/_doo-assets/source.excalidraw',
      previewPath: '00-Inbox/_doo-assets/view.png',
    };
    expect(check(db, 'note', input)).toBe(true);
    for (const bad of [
      { ...input, renderHash: h('e') },
      { ...input, sourceHash: h('e') },
      { ...input, previewHash: h('e') },
      { ...input, previewPath: 'private/view.png' },
      { ...input, sourcePath: undefined },
      { ...input, sourcePath: 'elsewhere/source.excalidraw' },
    ])
      expect(check(db, 'note', bad)).toBe(false);
    expect(check(db, 'other', input)).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('accepts only live same-note preparations with a matching tuple and inline authority context', () => {
  const root = mkdtempSync(join(tmpdir(), 'binding-prep-')),
    db = openDatabase(root);
  try {
    const prepared = {
      id: 'prep',
      noteId: 'note',
      type: 'mindmap',
      sourceHash: h('a'),
      renderHash: h('b'),
      previewHash: h('c'),
      preview: { relativePath: '00-Inbox/_doo-assets/view.png' },
    };
    db.prepare(
      'INSERT INTO operations(id,principal,client_id,request_id,kind,params_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(
      'prep',
      'owner',
      'client',
      'request',
      'diagram-primary.prepare',
      h('d'),
      'succeeded',
      Date.now(),
      Date.now(),
    );
    db.prepare(
      'INSERT INTO diagram_prepared_primaries(id,note_id,principal,client_id,source_hash,render_hash,preview_hash,result,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'prep',
      'note',
      'owner',
      'client',
      h('a'),
      h('b'),
      h('c'),
      JSON.stringify(prepared),
      Date.now(),
      Date.now() + 10000,
    );
    const check = publication.hasDiagramBindingProof;
    expect(check).toBeTypeOf('function');
    const input = {
      sourceHash: h('a'),
      renderHash: h('b'),
      previewHash: h('c'),
      previewPath: '00-Inbox/_doo-assets/view.png',
    };
    expect(check(db, 'note', input)).toBe(true);
    expect(check(db, 'note', { ...input, sourcePath: 'forged.excalidraw' })).toBe(false);
    db.prepare('UPDATE diagram_prepared_primaries SET expires_at=1').run();
    expect(check(db, 'note', input)).toBe(false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
