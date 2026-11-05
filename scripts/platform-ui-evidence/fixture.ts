import { expect, type Browser, type BrowserContext } from '@playwright/test';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import type { Fixture } from './model';
import { boundAPIRequests } from './lifecycle';

export async function isolatedConfig(path: string) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  const root = await realpath(dirname(resolve(config.dataRoot)));
  if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith('dooknow-browser-'))
    throw Error('Refusing capture: expected a dedicated /tmp/dooknow-browser-* fixture.');
  for (const key of ['dataRoot', 'knowledgeRoot']) {
    const actual = await realpath(config[key]);
    const child = relative(root, actual);
    if (child.startsWith('..') || isAbsolute(child) || !child) throw Error('Fixture path escapes temporary root: ' + key);
  }
  const origin = new URL(config.origin);
  if (origin.hostname !== '127.0.0.1' || origin.protocol !== 'http:') throw Error('Loopback HTTP fixture origin required.');
  return config;
}

// The fixture's real auth throttle is reset between independent contexts only.
// No production/config path is accepted above, and no cookies are written to evidence.
export function authBudget(config: { dataRoot: string }) {
  const db = new Database(resolve(config.dataRoot, 'app.sqlite'), { fileMustExist: true, timeout: 30000 });
  try { db.prepare('DELETE FROM "rateLimit"').run(); } finally { db.close(); }
}

export async function prepareFixture(browser: Browser, config: any, cookiePath: string): Promise<{
  fixture: Fixture; cookies: Awaited<ReturnType<BrowserContext['cookies']>>; owner: BrowserContext;
}> {
  authBudget(config);
  const cookies = JSON.parse(await readFile(cookiePath, 'utf8'));
  const owner = await browser.newContext({ baseURL: config.origin });
  boundAPIRequests(owner.request, Number(config.captureApiTimeoutMs) || 30000);
  await owner.addCookies(cookies);
  const session = await (await owner.request.get('/api/auth/get-session')).json();
  if (!session?.user?.id) throw Error('Isolated owner session unavailable.');
  const csrf = await (await owner.request.get('/api/security/csrf')).json();
  const headers = { origin: config.origin, 'x-csrf-token': csrf.token };
  async function api(path: string, method = 'GET', data?: unknown) {
    const response = await owner.request.fetch(path, { method, headers, data });
    if (!response.ok()) { const detail = await response.json().catch(() => ({})); throw Error(`Fixture API ${method} ${path.replace(/[a-f0-9-]{30,}/g, '<fixture-id>')} returned ${response.status()} code=${detail.code ?? detail.error ?? 'unknown'}`); }
    return response.status() === 204 ? null : response.json();
  }
  const noteContent = '# 知识与行动\n\n仅用于最终界面取证的隔离示例，不包含真实用户资料。\n\n## 记录方法\n\n- 收集想法\n- 保留下一步\n\nDocker 依赖 Linux 内核。Docker 和 Linux 用于容器运行。\n\n| 项目 | 状态 |\n| --- | --- |\n| 界面核验 | 进行中 |\n\n[参考链接](https://example.invalid/)\n\n```js\nconsole.log("fixture");\n```\n';
  async function note(label: string) {
    return api('/api/notes', 'POST', { folderPath: '00-Inbox', fileName: label + '-' + randomUUID() + '.md', content: noteContent, requestId: randomUUID() });
  }
  const notes: any[] = [];
  for (const label of ['最终界面取证', '访客编辑样例', '私有笔记', '已撤销分享', '到期分享']) notes.push(await note(label));
  const shares = [];
  for (const [index, permission] of ['view', 'edit'].entries()) {
    const value = await api(`/api/notes/${notes[index].id}/share`, 'POST', { permission, expiresAt: null, allowDiagramSource: false });
    shares.push(new URL(value.url, config.origin).toString());
  }
  await api(`/api/notes/${notes[3].id}/share`, 'POST', { permission: 'view' });
  await api(`/api/notes/${notes[3].id}/share`, 'DELETE');
  const revokedStatus = await api(`/api/notes/${notes[3].id}/share`);
  if (revokedStatus.state !== 'revoked' || revokedStatus.enabled !== false) throw Error('Actual share revoke did not produce the required fixture state');
  await api(`/api/notes/${notes[4].id}/share`, 'POST', { permission: 'view', expiresAt: new Date(Date.now() + 1500).toISOString() });
  const blog = await api('/api/blog/settings');
  await api('/api/blog/settings', 'PATCH', { settings: { ...blog, title: '隔离示例手记', author: '示例作者',
    description: '真实接口驱动的最终界面核验。', enabled: true }, requestId: randomUUID() });
  const publicSlug = 'runtime-' + randomUUID().slice(0, 8), collectionSlug = 'runtime-series';
  const post = await api('/api/blog/publish', 'POST', { noteId: notes[0].id, expectedModifiedAt: notes[0].modifiedAt,
    expectedContentHash: createHash('sha256').update(noteContent).digest('hex'), expectedPublicationVersion: 0,
    requestId: randomUUID(), metadata: { slug: publicSlug, title: '让知识保持可用', summary: '隔离发布快照，用于核验真实内容约束。',
      category: '方法', tags: ['记录'], pinned: true } });
  async function setTemplate(template: string) {
    const current = await api('/api/blog/design');
    const saved = await api('/api/blog/design', 'PATCH', { expectedVersion: current.version, requestId: randomUUID(),
      design: { ...current.draft, template, profile: { ...current.draft.profile, name: '示例作者', tagline: '记录、连接与行动' },
        collections: [{ id: collectionSlug, slug: collectionSlug, title: '记录的方法', description: '隔离示例合集', postIds: [post.id] }] } });
    await api('/api/blog/design/publish', 'POST', { expectedVersion: saved.version, requestId: randomUUID() });
  }
  await setTemplate('journal');
  let oauthPath: string | undefined;
  const registration = await owner.request.post('/api/auth/oauth2/register', { headers, data: {
    client_name: '隔离界面核验客户端', redirect_uris: ['https://runtime.invalid/callback'], token_endpoint_auth_method: 'none', scope: 'knowledge:read' } });
  if (registration.status() === 201) {
    const client = await registration.json();
    oauthPath = '/api/auth/oauth2/authorize?' + new URLSearchParams({ client_id: client.client_id,
      redirect_uri: 'https://runtime.invalid/callback', response_type: 'code', scope: 'knowledge:read', resource: config.origin + '/mcp',
      state: 'runtime-state', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url') });
  }
  // Observe genuine wall-clock expiry through the actual status API; no private
  // note, DB edit, swallowed setup error or status substitution counts as expiry.
  await expect.poll(async () => (await api(`/api/notes/${notes[4].id}/share`)).state,
    { timeout: 6000, intervals: [100, 200, 300, 500] }).toBe('expired');
  return { fixture: { ...config, userId: session.user.id, noteId: notes[0].id, secondNoteId: notes[1].id,
    privateNoteId: notes[2].id, revokedNoteId: notes[3].id, expiredNoteId: notes[4].id, noteContent,
    publicSlug, collectionSlug, shares, oauthPath, api, setTemplate }, cookies: await owner.cookies(), owner };
}
