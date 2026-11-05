import type { Browser, BrowserContext } from '@playwright/test';
import { realpath } from 'node:fs/promises';
import { dirname, relative, isAbsolute, resolve } from 'node:path';
import type { Fixture, Scene } from './model';
import { boundAPIRequests } from './lifecycle';

/** Allocate an actual new owner/database/app per setup scene; no success is mocked. */
export async function prepareSetupFixture(browser: Browser, config: any, mode: Scene['setupMode'] = 'empty') {
  if (config.setupFixture !== true || typeof config.controlToken !== 'string' || config.controlToken.length < 32)
    throw Error('Dedicated guarded setup factory config required; main fixture is not compatible');
  const control = await browser.newContext({ baseURL: config.origin });
  boundAPIRequests(control.request, Number(config.captureApiTimeoutMs) || 30000);
  const controlHeaders = { authorization: 'Bearer ' + config.controlToken, origin: config.origin };
  const allocated = await control.request.post(config.controlPath, { headers: controlHeaders, data: { mode } });
  if (allocated.status() !== 201) { await control.close(); throw Error('Actual setup fixture allocation failed: ' + allocated.status()); }
  const slot = await allocated.json();
  const root = await realpath(dirname(resolve(config.dataRoot)));
  for (const field of ['dataRoot', 'knowledgeRoot', 'existingRoot', 'libraryParent']) {
    const child = relative(root, await realpath(slot[field]));
    if (!child || child.startsWith('..') || isAbsolute(child)) { await control.close(); throw Error('Allocated setup path escapes guarded fixture root: ' + field); }
  }
  const owner = await browser.newContext({ baseURL: config.origin, extraHTTPHeaders: slot.headers });
  boundAPIRequests(owner.request, Number(config.captureApiTimeoutMs) || 30000);
  await owner.addCookies(slot.cookies);
  const session = await (await owner.request.get('/api/auth/get-session')).json();
  if (!session?.user?.id) throw Error('Actual isolated setup owner session unavailable');
  const csrf = await (await owner.request.get('/api/security/csrf')).json();
  const headers = { origin: config.origin, 'x-csrf-token': csrf.token };
  async function api(path: string, method = 'GET', data?: unknown) {
    const response = await owner.request.fetch(path, { method, headers, data });
    if (!response.ok()) { const detail = await response.json().catch(() => ({})); throw Error(`Setup API ${method} returned ${response.status()} code=${detail.code ?? 'unknown'}`); }
    return response.status() === 204 ? null : response.json();
  }
  const fixture: Fixture = { origin: config.origin, dataRoot: slot.dataRoot, knowledgeRoot: slot.knowledgeRoot,
    userId: session.user.id, noteId: '', secondNoteId: '', noteContent: '', privateNoteId: '', revokedNoteId: '', expiredNoteId: '',
    publicSlug: '', collectionSlug: '', shares: [], api,
    setTemplate: async () => { throw Error('Blog template fixture is not available before library binding'); },
    setup: { fixtureId: slot.id, libraryParent: slot.libraryParent, existingRoot: slot.existingRoot, gitRemoteURL: slot.gitRemoteURL,
      releaseGit: async () => { const response = await control.request.post(config.controlPath + '/' + slot.id + '/release-git', { headers: controlHeaders }); if (!response.ok()) throw Error('Fixture Git transport release failed'); } } };
  return { fixture, cookies: await owner.cookies(), owner, extraHTTPHeaders: slot.headers as Record<string, string>,
    dispose: async () => {
      try {
        await owner.close();
        const closed = await control.request.delete(config.controlPath + '/' + slot.id, { headers: controlHeaders });
        if (!closed.ok()) throw Error('Isolated setup app cleanup failed: ' + closed.status());
      } finally { await control.close(); }
    } };
}
