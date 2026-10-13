import { it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFixture, loginFixtureOwner } from '../support/fixture.js';
import { agentConfig, agentHeaders } from '../support/agent.js';
import { openDatabase } from '../../server/db.js';
const exec = promisify(execFile);
it.each(['archive', 'git-conflict'])(
  'rebuilds identical original bytes after %s and strict search cannot report empty-ready',
  async (action) => {
    const f = await createFixture({ agent: agentConfig }),
      db = openDatabase(f.dataRoot);
    const path = '00-Inbox/reactivate.md',
      file = join(f.knowledgeRoot, path);
    const git = (args: string[]) =>
      exec(
        'git',
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          '-c',
          'core.hooksPath=/dev/null',
          ...args,
        ],
        { cwd: f.knowledgeRoot },
      );
    const refresh = (id: string) =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/index/refresh',
        headers: agentHeaders(),
        payload: { scope: '00-Inbox', requestId: id },
      });
    const search = () =>
      f.app.inject({
        method: 'POST',
        url: '/api/agent/v1/search',
        headers: agentHeaders(),
        payload: { query: '知识复活', mode: 'text', freshness: 'strict' },
      });
    try {
      if (action === 'git-conflict') {
        await git(['init', '--initial-branch=main']);
        await writeFile(file, '# 初始正文\n');
        await git(['add', path]);
        await git(['commit', '-m', 'fixture initial']);
        await git(['checkout', '-b', 'incoming']);
        await writeFile(file, '# incoming change\n');
        await git(['commit', '-am', 'fixture incoming']);
        await git(['checkout', 'main']);
      }
      const original = '# 知识复活\n\n同正文恢复后仍然可以找到知识。\n';
      await writeFile(file, original);
      if (action === 'git-conflict') await git(['commit', '-am', 'fixture ours']);
      expect((await refresh('first-version')).statusCode).toBe(200);
      const first = await search();
      expect(first.statusCode).toBe(200);
      expect(first.json().data.results).toHaveLength(1);
      const note = first.json().data.results[0],
        before = db
          .prepare('SELECT source_revision FROM document_state WHERE note_id=?')
          .get(note.noteId) as any;
      if (action === 'archive') {
        const meta = (
          await f.app.inject({ url: `/api/agent/v1/notes/${note.noteId}`, headers: agentHeaders() })
        ).json().data;
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: `/api/agent/v1/notes/${note.noteId}/archive`,
              headers: agentHeaders(),
              payload: { expectedModifiedAt: meta.modifiedAt, requestId: 'archive-version' },
            })
          ).statusCode,
        ).toBe(200);
        const h = await loginFixtureOwner(f);
        expect(
          (
            await f.app.inject({
              method: 'POST',
              url: `/api/notes/${note.noteId}/restore`,
              headers: h,
              payload: {},
            })
          ).statusCode,
        ).toBe(200);
      } else {
        await expect(git(['merge', 'incoming'])).rejects.toThrow();
        await refresh('detect-conflict');
        expect(
          (
            db
              .prepare('SELECT conflict FROM document_state WHERE note_id=?')
              .get(note.noteId) as any
          ).conflict,
        ).toBe(1);
        await git(['checkout', '--ours', '--', path]);
        await git(['add', path]);
        await git(['commit', '-m', 'fixture resolve ours']);
      }
      expect((await refresh('reactivated-version')).statusCode).toBe(200);
      expect(
        (
          db
            .prepare('SELECT source_revision FROM document_state WHERE note_id=?')
            .get(note.noteId) as any
        ).source_revision,
      ).toBeGreaterThan(before.source_revision);
      const result = await search();
      expect(result.statusCode).toBe(200);
      expect(result.json().data.results[0]?.noteId).toBe(note.noteId);
      expect(
        (
          db
            .prepare('SELECT count(*) AS n FROM chunks WHERE note_id=? AND active=1')
            .get(note.noteId) as any
        ).n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
      await f.close();
    }
  },
  30000,
);
