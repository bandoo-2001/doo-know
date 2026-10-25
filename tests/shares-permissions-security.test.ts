import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixture, loginFixtureOwner, origin, type Fixture } from './support/fixture.js';
import { openDatabase } from '../packages/core/db.js';
import type { PublicShareSource, ShareOptions } from '../shared/share-contracts.js';

// A real durability boundary gives the grant time to change after initial
// authorization, while keeping the writer, history, SQLite and rename real.
const barrier = vi.hoisted(() => ({
  historyRoot: '',
  reached: false,
  run: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      fs.fsyncSync(fd);
      if (barrier.run && fs.readlinkSync(`/proc/self/fd/${fd}`) === barrier.historyRoot) {
        const run = barrier.run;
        barrier.run = undefined;
        barrier.reached = true;
        run();
      }
    },
  };
});

afterEach(() => {
  barrier.historyRoot = '';
  barrier.reached = false;
  barrier.run = undefined;
  vi.restoreAllMocks();
});

type OwnerHeaders = Awaited<ReturnType<typeof loginFixtureOwner>>;
type VisitorHeaders = { origin: string; cookie: string; 'x-csrf-token': string };

async function note(f: Fixture, headers: OwnerHeaders, fileName: string, content: string, folderPath = '00-Inbox') {
  const response = await f.app.inject({
    method: 'POST', url: '/api/notes', headers,
    payload: { folderPath, fileName, content },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; relativePath: string; modifiedAt: string; content: string }>();
}

async function share(f: Fixture, headers: OwnerHeaders, id: string, options: ShareOptions = { permission: 'edit', expiresAt: null }) {
  const response = await f.app.inject({
    method: 'POST', url: `/api/notes/${id}/share`, headers, payload: options,
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().token).toEqual(expect.any(String));
  return `/api/public/shares/${response.json().token}`;
}

async function source(f: Fixture, base: string) {
  const response = await f.app.inject({ url: `${base}/source` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<PublicShareSource>();
}

async function visitor(f: Fixture, base: string): Promise<VisitorHeaders> {
  const response = await f.app.inject({ url: `${base}/csrf` });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().token).toEqual(expect.any(String));
  expect(response.cookies.length).toBeGreaterThan(0);
  return {
    origin,
    cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    'x-csrf-token': response.json().token,
  };
}

function save(f: Fixture, base: string, headers: VisitorHeaders | Record<string, string>, content: string, expectedModifiedAt: string, requestId = randomUUID()) {
  return f.app.inject({
    method: 'PUT', url: `${base}/source`, headers,
    payload: { content, expectedModifiedAt, requestId },
  });
}

async function firstPage(f: Fixture, base: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await f.app.inject({
      method: 'POST', url: `${base}/read`, payload: { maxBytes: 4096 },
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json();
    if (page.kind === 'ready') {
      expect(page.data.nextCursor).toEqual(expect.any(String));
      return page.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('public snapshot did not become ready');
}

const scene = (text: string) => JSON.stringify({
  type: 'excalidraw', version: 2,
  elements: [{ id: 'label', type: 'text', text, x: 0, y: 0, width: 100, height: 20 }],
  appState: {}, files: {},
});
const fence = (id: string) => `\n\n\`\`\`excalidraw\n${id}\n\`\`\`\n`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=', 'base64');

it('requires anonymous CSRF and the same Origin, preserves CAS, and scopes retry receipts to the exact grant', async () => {
  const f = await createFixture();
  try {
    const owner = await loginFixtureOwner(f);
    const a = await note(f, owner, 'public-write-a.md', '# Before');
    const b = await note(f, owner, 'public-write-b.md', '# Other private document');
    const base = await share(f, owner, a.id);
    const initial = await source(f, base);
    expect(initial).toMatchObject({ permission: 'edit', canEdit: true, expiresAt: null, documentType: 'markdown', content: '# Before' });
    expect(initial).not.toHaveProperty('id');
    expect(initial).not.toHaveProperty('relativePath');
    const headers = await visitor(f, base);
    const content = '# Anonymous saved';
    for (const invalid of [
      { origin },
      { ...headers, origin: 'https://attacker.invalid' },
      { ...headers, origin: '' },
      { ...headers, cookie: headers.cookie.replace(/=./, '=x') },
      { ...headers, 'x-csrf-token': 'forged-token' },
    ]) {
      expect((await save(f, base, invalid, content, initial.modifiedAt)).statusCode).toBe(403);
      expect(await readFile(join(f.knowledgeRoot, a.relativePath), 'utf8')).toBe('# Before');
    }
    const requestId = randomUUID();
    const saved = await save(f, base, headers, content, initial.modifiedAt, requestId);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true, modifiedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(saved.json()).not.toHaveProperty('id');
    expect(saved.json()).not.toHaveProperty('relativePath');
    expect(saved.body).not.toContain(a.id);
    expect(saved.body).not.toContain(a.relativePath);
    expect(await readFile(join(f.knowledgeRoot, a.relativePath), 'utf8')).toBe(content);
    expect((await save(f, base, headers, content, initial.modifiedAt, requestId)).json()).toEqual(saved.json());
    expect((await save(f, base, headers, '# Stale overwrite', initial.modifiedAt)).statusCode).toBe(409);
    const ownerWrite = await f.app.inject({
      method: 'PUT', url: `/api/notes/${b.id}`, headers,
      payload: { content: '# Cross-note overwrite', expectedModifiedAt: b.modifiedAt, requestId },
    });
    expect(ownerWrite.statusCode).toBe(401);
    expect(await readFile(join(f.knowledgeRoot, b.relativePath), 'utf8')).toBe('# Other private document');
    const otherBase = await share(f, owner, b.id);
    const otherSource = await source(f, otherBase);
    const otherSaved = await save(f, otherBase, await visitor(f, otherBase), '# Separate grant save', otherSource.modifiedAt, requestId);
    expect(otherSaved.statusCode, otherSaved.body).toBe(200);
    expect(await readFile(join(f.knowledgeRoot, b.relativePath), 'utf8')).toBe('# Separate grant save');
  } finally {
    await f.close();
  }
});

it('denies inserting a known private whiteboard while allowing existing references to be kept, repeated, or removed', async () => {
  const f = await createFixture();
  try {
    const owner = await loginFixtureOwner(f);
    const publicBoard = await note(f, owner, 'existing-board.excalidraw', scene('ALREADY_PUBLIC_BOARD'));
    const privateBoard = await note(f, owner, 'private-board.excalidraw', scene('PRIVATE_BOARD_SECRET'));
    const original = '# Shared explanation' + fence(publicBoard.id);
    const n = await note(f, owner, 'board-parent.md', original);
    const base = await share(f, owner, n.id);
    const headers = await visitor(f, base);
    const initial = await source(f, base);
    expect((await f.app.inject({ url: `${base}/whiteboards/${publicBoard.id}` })).statusCode).toBe(200);
    expect((await f.app.inject({ url: `${base}/whiteboards/${privateBoard.id}` })).statusCode).toBe(404);
    const attack = await save(f, base, headers, original + fence(privateBoard.id), initial.modifiedAt);
    expect(attack.statusCode, attack.body).toBe(403);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(original);
    expect((await f.app.inject({ url: `${base}/whiteboards/${privateBoard.id}` })).statusCode).toBe(404);
    const repeated = '# Edited explanation' + fence(publicBoard.id) + fence(publicBoard.id);
    const kept = await save(f, base, headers, repeated, initial.modifiedAt);
    expect(kept.statusCode, kept.body).toBe(200);
    expect((await f.app.inject({ url: `${base}/whiteboards/${publicBoard.id}` })).statusCode).toBe(200);
    const removed = await save(f, base, headers, '# Board removed', kept.json().modifiedAt);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await f.app.inject({ url: `${base}/whiteboards/${publicBoard.id}` })).statusCode).toBe(404);
    expect(await readFile(join(f.knowledgeRoot, privateBoard.relativePath), 'utf8')).toBe(privateBoard.content);
  } finally {
    await f.close();
  }
});

it('does not let issued anonymous credentials bypass maintenance or a downgrade on the same token', async () => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const owner = await loginFixtureOwner(f);
    const n = await note(f, owner, 'live-policy.md', '# Preserved by current policy');
    const base = await share(f, owner, n.id);
    const initial = await source(f, base);
    const headers = await visitor(f, base);
    db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run();
    const maintained = await save(f, base, headers, '# Maintenance overwrite', initial.modifiedAt);
    expect(maintained.statusCode, maintained.body).toBe(503);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# Preserved by current policy');
    db.prepare('UPDATE maintenance SET active=0 WHERE id=1').run();
    const sameBase = await share(f, owner, n.id, { permission: 'view', expiresAt: null });
    expect(sameBase).toBe(base);
    const meta = await f.app.inject({ url: `${base}/meta` });
    expect(meta.statusCode, meta.body).toBe(200);
    expect(meta.json()).toMatchObject({ permission: 'view', canEdit: false });
    expect((await f.app.inject({ url: base })).statusCode).toBe(200);
    for (const url of [`${base}/source`, `${base}/csrf`]) {
      expect((await f.app.inject({ url })).statusCode, url).toBe(403);
    }
    const downgraded = await save(f, base, headers, '# Downgraded overwrite', initial.modifiedAt);
    expect(downgraded.statusCode, downgraded.body).toBe(403);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe('# Preserved by current policy');
    expect(db.prepare('SELECT id FROM revisions WHERE note_id=?').all(n.id)).toHaveLength(0);
  } finally {
    db.prepare('UPDATE maintenance SET active=0 WHERE id=1').run();
    db.close();
    await f.close();
  }
});

it('blocks new local image and Markdown targets before they can authorize private publicAsset reads', async () => {
  const f = await createFixture();
  try {
    const owner = await loginFixtureOwner(f);
    await mkdir(join(f.knowledgeRoot, '00-Inbox/shared'), { recursive: true });
    await mkdir(join(f.knowledgeRoot, '00-Inbox/private'), { recursive: true });
    await writeFile(join(f.knowledgeRoot, '00-Inbox/private/secret.png'), Buffer.concat([png, Buffer.from('PRIVATE_ATTACHMENT_SECRET')]));
    const privateNote = await note(f, owner, 'private.md', '# PRIVATE_MARKDOWN_SECRET\n\n![secret](secret.png)', '00-Inbox/private');
    const privateAssets = await f.app.inject({ url: `/api/notes/${privateNote.id}/assets`, headers: owner });
    expect(privateAssets.statusCode, privateAssets.body).toBe(200);
    const privateAsset = privateAssets.json().find((asset: { relativePath: string }) => asset.relativePath === '00-Inbox/private/secret.png');
    expect(privateAsset?.id).toEqual(expect.any(String));
    const privateBytes = await f.app.inject({ url: `/api/assets/${privateAsset.id}`, headers: owner });
    expect(privateBytes.statusCode, privateBytes.body).toBe(200);
    expect(privateBytes.body).toContain('PRIVATE_ATTACHMENT_SECRET');
    await writeFile(join(f.knowledgeRoot, '00-Inbox/shared/existing.png'), png);
    const original = '# Existing image\n\n![public](existing.png)\n';
    const n = await note(f, owner, 'attachments.md', original, '00-Inbox/shared');
    const base = await share(f, owner, n.id);
    const headers = await visitor(f, base);
    const initial = await source(f, base);
    const existingUrl = `${base}/asset?source=existing.png`;
    expect((await f.app.inject({ url: existingUrl })).statusCode).toBe(200);
    expect((await f.app.inject({ url: `${base}/assets/${privateAsset.id}` })).statusCode).toBe(404);
    const attacks = [
      '![stolen](../private/secret.png)',
      '[stolen file](../private/secret.png)',
      '![encoded](..%2fprivate%2fsecret.png)',
      '[private note](../private/private.md)',
      '[hidden][secret]\n\n[secret]: ../private/secret.png',
    ];
    for (const addition of attacks) {
      const response = await save(f, base, headers, original + '\n' + addition, initial.modifiedAt);
      expect(response.statusCode, `${addition}: ${response.body}`).toBe(403);
      expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(original);
      expect((await f.app.inject({ url: `${base}/asset?source=${encodeURIComponent('../private/secret.png')}` })).statusCode).toBe(404);
      expect((await f.app.inject({ url: `${base}/assets/${privateAsset.id}` })).statusCode).toBe(404);
    }
    const repeated = '# Reused image\n\n![one](existing.png)\n\n![two](./existing.png)\n';
    const kept = await save(f, base, headers, repeated, initial.modifiedAt);
    expect(kept.statusCode, kept.body).toBe(200);
    expect((await f.app.inject({ url: existingUrl })).statusCode).toBe(200);
    const removed = await save(f, base, headers, '# Removed image', kept.json().modifiedAt);
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await f.app.inject({ url: existingUrl })).statusCode).toBe(404);
  } finally {
    await f.close();
  }
});

it('expires at the exact boundary across metadata, direct reads, cached cursors, assets, boards, source and writes', async () => {
  const f = await createFixture();
  try {
    const owner = await loginFixtureOwner(f);
    const board = await note(f, owner, 'expiry-board.excalidraw', scene('EXPIRING_BOARD'));
    await writeFile(join(f.knowledgeRoot, '00-Inbox/expiring.png'), png);
    const text = '# Expires\n\n![image](expiring.png)' + fence(board.id) + '\nReadable paragraph.\n\n'.repeat(1000);
    const n = await note(f, owner, 'expires.md', text);
    const assets = await f.app.inject({ url: `/api/notes/${n.id}/assets`, headers: owner });
    expect(assets.statusCode, assets.body).toBe(200);
    const assetId = assets.json().find((asset: { relativePath: string }) => asset.relativePath === '00-Inbox/expiring.png')?.id;
    expect(assetId).toEqual(expect.any(String));
    const expires = Date.now() + 60_000;
    const base = await share(f, owner, n.id, { permission: 'edit', expiresAt: new Date(expires).toISOString() });
    const page = await firstPage(f, base);
    const urls = [base, `${base}/meta`, `${base}/asset?source=expiring.png`, `${base}/assets/${assetId}`, `${base}/whiteboards/${board.id}`];
    const now = vi.spyOn(Date, 'now').mockReturnValue(expires - 1);
    for (const url of urls) expect((await f.app.inject({ url })).statusCode, url).toBe(200);
    expect((await f.app.inject({ method: 'POST', url: `${base}/read`, payload: { cursor: page.nextCursor } })).statusCode).toBe(200);
    now.mockReturnValue(expires);
    for (const url of urls) expect((await f.app.inject({ url })).statusCode, url).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: `${base}/read`, payload: { cursor: page.nextCursor } })).statusCode).toBe(404);
    now.mockReturnValue(expires - 1);
    const headers = await visitor(f, base);
    const initial = await source(f, base);
    now.mockReturnValue(expires);
    for (const url of [`${base}/source`, `${base}/csrf`]) expect((await f.app.inject({ url })).statusCode, url).toBe(404);
    expect((await save(f, base, headers, '# Expired overwrite', initial.modifiedAt)).statusCode).toBe(404);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(text);
    const status = await f.app.inject({ url: `/api/notes/${n.id}/share`, headers: owner });
    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({ enabled: false, state: 'expired', permission: 'edit', expiresAt: new Date(expires).toISOString() });
    now.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await f.close();
  }
});

it.each(['reset', 'revoke'] as const)('rejects cached cursors and anonymous save credentials after %s', async (action) => {
  const f = await createFixture();
  try {
    const owner = await loginFixtureOwner(f);
    const original = '# Cached share\n\n' + 'Cached private paragraph.\n\n'.repeat(1000);
    const n = await note(f, owner, `cached-${action}.md`, original);
    const base = await share(f, owner, n.id);
    const initial = await source(f, base);
    const headers = await visitor(f, base);
    const page = await firstPage(f, base);
    const changed = await f.app.inject({
      method: action === 'reset' ? 'POST' : 'DELETE',
      url: `/api/notes/${n.id}/share${action === 'reset' ? '/reset' : ''}`,
      headers: owner,
      ...(action === 'reset' ? { payload: { permission: 'edit', expiresAt: null } } : {}),
    });
    expect(changed.statusCode, changed.body).toBe(200);
    for (const url of [base, `${base}/meta`, `${base}/source`, `${base}/csrf`]) {
      expect((await f.app.inject({ url })).statusCode, url).toBe(404);
    }
    expect((await f.app.inject({ method: 'POST', url: `${base}/read`, payload: { cursor: page.nextCursor } })).statusCode).toBe(404);
    expect((await save(f, base, headers, '# Invalidated save', initial.modifiedAt)).statusCode).toBe(404);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(original);
    if (action === 'reset') {
      const replacement = `/api/public/shares/${changed.json().token}`;
      expect(replacement).not.toBe(base);
      const crossGrantCursor = await f.app.inject({ method: 'POST', url: `${replacement}/read`, payload: { cursor: page.nextCursor } });
      expect(crossGrantCursor.statusCode, crossGrantCursor.body).toBe(403);
      expect(crossGrantCursor.json().code).toBe('FORBIDDEN');
      expect((await source(f, replacement)).content).toBe(original);
    }
  } finally {
    await f.close();
  }
});

it.each(['downgrade', 'expire'] as const)('rechecks the live grant before commit when it changes to %s during durable staging', async (action) => {
  const f = await createFixture();
  const db = openDatabase(f.dataRoot);
  try {
    const owner = await loginFixtureOwner(f);
    const original = '# Original durable document';
    const n = await note(f, owner, `commit-${action}.md`, original);
    const expires = Date.now() + 60_000;
    const base = await share(f, owner, n.id, { permission: 'edit', expiresAt: action === 'expire' ? new Date(expires).toISOString() : null });
    const initial = await source(f, base);
    const headers = await visitor(f, base);
    const now = action === 'expire' ? vi.spyOn(Date, 'now').mockReturnValue(expires - 1) : undefined;
    barrier.historyRoot = join(f.dataRoot, 'history');
    barrier.run = action === 'downgrade'
      ? () => { db.prepare("UPDATE shares SET permission='view' WHERE note_id=?").run(n.id); }
      : () => { now!.mockReturnValue(expires); };
    const requestId = randomUUID();
    const response = await save(f, base, headers, '# Must never reach the original file', initial.modifiedAt, requestId);
    expect(barrier.reached, 'save must reach the real history fsync boundary before the grant changes').toBe(true);
    expect(response.statusCode, response.body).toBe(action === 'downgrade' ? 403 : 404);
    expect(await readFile(join(f.knowledgeRoot, n.relativePath), 'utf8')).toBe(original);
    expect(db.prepare('SELECT id FROM revisions WHERE note_id=?').all(n.id)).toHaveLength(0);
    expect(db.prepare('SELECT status FROM operations WHERE request_id=?').get(requestId)).toMatchObject({ status: 'failed' });
    now?.mockRestore();
  } finally {
    barrier.run = undefined;
    vi.restoreAllMocks();
    db.close();
    await f.close();
  }
});
