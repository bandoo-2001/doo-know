import { it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import * as history from '../packages/core/knowledge/revision-context';
import { beginOperation } from '../packages/core/knowledge/operations';
import { rebaseRevisionMarkdown } from '../packages/core/knowledge/revision-relocation';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
it('preserves a rewritten wiki link label and navigation rather than replacing its whole syntax with a URL', () => {
  const result = rebaseRevisionMarkdown(
    'before [[target#part|标签 *literal*]] after',
    '00-Inbox/original.md',
    '10-Projects/current.md',
  );
  expect(result).toBe('before [标签 \\*literal\\*](<../00-Inbox/target.md#part>) after');
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'revision-context-'));
  const dataRoot = join(root, 'data'),
    knowledgeRoot = join(root, 'knowledge');
  mkdirSync(join(dataRoot, 'history'), { recursive: true });
  mkdirSync(knowledgeRoot);
  const db = openDatabase(dataRoot);
  const config = { dataRoot, knowledgeRoot } as any;
  const id = randomUUID();
  db.prepare('INSERT INTO notes(id,path) VALUES(?,?)').run(id, '00-Inbox/original.md');
  function intent(content: string, kind = 'update') {
    const revision_id = randomUUID(),
      history_file = revision_id + '.md';
    writeFileSync(join(dataRoot, 'history', history_file), content);
    return {
      id: randomUUID(),
      note_id: id,
      path: '10-Projects/新文档.md',
      kind,
      revision_id,
      history_file,
      original_hash: hash(content),
      original_mtime: '1234',
    };
  }
  return {
    db,
    config,
    id,
    intent,
    close() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it('records the original Markdown context before an identity-preserving path switch', () => {
  const f = fixture();
  try {
    const source = '# Original Markdown',
      intent = f.intent(source);
    history.recordRevisionContext(f.config, f.db, intent);
    f.db.prepare('UPDATE notes SET path=? WHERE id=?').run(intent.path, f.id);
    const context = history.revisionContext(f.config, f.db, f.id, intent.revision_id);
    expect(context).toMatchObject({
      documentType: 'markdown',
      payloadFormat: 'markdown',
      logicalPath: '00-Inbox/original.md',
      contentHash: hash(source),
      resources: [],
    });
    // Replaying a recorded write cannot reinterpret JSON using the new .md identity.
    history.recordRevisionContext(f.config, f.db, intent);
    expect(history.revisionContext(f.config, f.db, f.id, intent.revision_id)).toEqual(context);
    expect(() =>
      history.revisionContext(f.config, f.db, randomUUID(), intent.revision_id),
    ).toThrow();
  } finally {
    f.close();
  }
});

it('uses the historical path and fixed resource manifest, not the current directory', () => {
  const f = fixture();
  try {
    const original = '# Ordinary JSON example\n```json\n{"type":"excalidraw"}\n```';
    f.db.prepare('UPDATE notes SET path=? WHERE id=?').run('00-Inbox/原笔记.md', f.id);
    const intent = f.intent(original, 'move');
    const resources = [{ role: 'preview', path: '00-Inbox/_doo-assets/old.png', hash: hash('png') }];
    f.db
      .prepare('INSERT INTO diagram_document_versions VALUES(?,?,?,?,?,?,?,?,?)')
      .run(
        f.id,
        hash(original),
        '00-Inbox/原笔记.md',
        'mindmap',
        hash('s'),
        hash('r'),
        hash('png'),
        JSON.stringify({ type: 'mindmap', resources }),
        Date.now(),
      );
    history.recordRevisionContext(f.config, f.db, intent);
    f.db.prepare('UPDATE notes SET path=? WHERE id=?').run(intent.path, f.id);
    expect(history.revisionContext(f.config, f.db, f.id, intent.revision_id)).toMatchObject({
      payloadFormat: 'markdown',
      logicalPath: '00-Inbox/原笔记.md',
      resources,
    });
    writeFileSync(join(f.config.dataRoot, 'history', intent.history_file), 'tampered');
    expect(() => history.revisionContext(f.config, f.db, f.id, intent.revision_id)).toThrow(
      /REVISION_CONTENT_CONFLICT/,
    );
  } finally {
    f.close();
  }
});

it('backfills an untyped revision from its write intent without inventing a current-path context', () => {
  const f = fixture();
  try {
    const source = '# Original Markdown',
      intent = f.intent(source, 'update');
    f.db
      .prepare('INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)')
      .run(intent.revision_id, f.id, intent.history_file, 'now', '1234');
    const op = beginOperation(
      f.db,
      { id: 'owner', clientId: 'test', scopes: [], allowedPrefixes: [] },
      'update',
      'backfill',
      {},
    );
    f.db
      .prepare(
        'INSERT INTO write_intents(id,note_id,path,kind,original_hash,original_mtime,revision_id,history_file,status) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        op.operation.id,
        f.id,
        '00-Inbox/original.md',
        'update',
        hash(source),
        '1234',
        intent.revision_id,
        intent.history_file,
        'recorded',
      );
    f.db.prepare('UPDATE notes SET path=? WHERE id=?').run('10-Projects/new.md', f.id);
    expect(history.revisionContext(f.config, f.db, f.id, intent.revision_id)).toMatchObject({
      payloadFormat: 'markdown',
      logicalPath: '00-Inbox/original.md',
    });
    const orphan = f.intent('# no retained original path');
    f.db
      .prepare('INSERT INTO revisions(id,note_id,file,created_at,modified_at) VALUES(?,?,?,?,?)')
      .run(orphan.revision_id, f.id, orphan.history_file, 'now', '1234');
    expect(history.revisionContext(f.config, f.db, f.id, orphan.revision_id)).toMatchObject({
      payloadFormat: 'markdown',
      logicalPath: null,
      resources: [],
    });
  } finally {
    f.close();
  }
});

it('rebases ordinary historical destinations while preserving source spelling and code', () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE notes SET path=? WHERE id=?').run('00-Inbox/original.md', f.id);
    const content =
      '正文不变\r\n![图](_doo-assets/a.png)\r\n<img src="_doo-assets/b.png">\r\n`_doo-assets/a.png`\r\n';
    const ordinary = f.intent(content, 'update');
    history.recordRevisionContext(f.config, f.db, ordinary);
    expect(
      history.revisionRestoreSource(
        f.config,
        f.db,
        f.id,
        ordinary.revision_id,
        '10-Projects/current.md',
      ).content,
    ).toBe(
      '正文不变\r\n![图](../00-Inbox/_doo-assets/a.png)\r\n<img src="../00-Inbox/_doo-assets/b.png">\r\n`_doo-assets/a.png`\r\n',
    );
  } finally {
    f.close();
  }
});
