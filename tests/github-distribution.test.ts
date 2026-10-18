import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactFetch, githubAsset, githubUpdateSource } from '../apps/server/platform/distribution.js';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function config() {
  const root = await mkdtemp(join(tmpdir(), 'github-distribution-')); roots.push(root);
  const tokenFile = join(root, 'github.token');
  await writeFile(tokenFile, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
  return { distribution: { repository: 'owner/private', tokenFile } };
}
const url = 'https://github.com/owner/private/releases/download/v1.1.0-rc.3/package.tar.gz';

it('downloads public releases anonymously without consulting credential files or the rate-limited metadata API', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit) => {
    const address = String(input); requests.push(address);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    if (address === url) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/public/object' } });
    expect(address).toBe('https://release-assets.githubusercontent.com/public/object');
    return new Response('public verified bytes');
  });
  expect(await (await artifactFetch({ distribution: { repository: 'owner/private' } }, new URL(url))).text()).toBe('public verified bytes');
  expect(requests).toHaveLength(2);
});

it('rejects public redirects outside the approved CDN and repository mismatches', async () => {
  const network = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/asset' } }));
  vi.stubGlobal('fetch', network);
  await expect(artifactFetch({}, new URL(url))).rejects.toThrow('GITHUB_ASSET_REDIRECT_REJECTED');
  network.mockClear();
  await expect(artifactFetch({distribution:{repository:'other/repo'}}, new URL(url))).rejects.toThrow('GITHUB_REPOSITORY_MISMATCH');
  expect(network).not.toHaveBeenCalled();
});

it('resolves a private asset through the authenticated API and removes authorization on the signed CDN hop', async () => {
  const c = await config(), requests: Array<{ url: string; auth: string | null }> = [];
  vi.stubGlobal('fetch', async (input: any, init: RequestInit = {}) => {
    const address = String(input), auth = new Headers(init.headers).get('authorization');
    requests.push({ url: address, auth });
    expect(init.redirect).toBe('manual');
    if (address.endsWith('/releases/tags/v1.1.0-rc.3')) return Response.json({ id: 17, draft: false });
    if (address.endsWith('/releases/17/assets?per_page=100&page=1')) return Response.json([{ id: 81, name: 'package.tar.gz' }]);
    if (address.endsWith('/releases/assets/81')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/private/object?signature=fixture' } });
    if (address.startsWith('https://release-assets.githubusercontent.com/')) return new Response('verified bytes');
    throw Error('unexpected request');
  });
  expect(await (await artifactFetch(c, new URL(url))).text()).toBe('verified bytes');
  expect(requests.map(r => r.auth)).toEqual([
    'Bearer fixture_github_012345678901234567890123456789',
    'Bearer fixture_github_012345678901234567890123456789',
    'Bearer fixture_github_012345678901234567890123456789',
    null,
  ]);
});

it('refuses a different repository, a public credential file, and a redirect outside GitHub without leaking the token', async () => {
  const c = await config(), network = vi.fn(); vi.stubGlobal('fetch', network);
  await expect(artifactFetch(c, new URL(url.replace('/owner/private/', '/owner/other/')))).rejects.toThrow('GITHUB_REPOSITORY_MISMATCH');
  expect(network).not.toHaveBeenCalled();
  await chmod(c.distribution.tokenFile, 0o644);
  await expect(artifactFetch(c, new URL(url))).rejects.toThrow('GITHUB_CREDENTIAL_UNAVAILABLE');
  expect(network).not.toHaveBeenCalled();
  await chmod(c.distribution.tokenFile, 0o600);
  vi.stubGlobal('fetch', async (input: any) => {
    if (String(input).includes('/tags/')) return Response.json({ id: 17, draft: false });
    if (String(input).includes('/17/assets?')) return Response.json([{ id: 81, name: 'package.tar.gz' }]);
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/object' } });
  });
  await expect(artifactFetch(c, new URL(url))).rejects.toThrow('GITHUB_ASSET_REDIRECT_REJECTED');
});

it('reports revoked or missing access without response bodies and never sends GitHub credentials to a generic artifact source', async () => {
  const c = await config();
  vi.stubGlobal('fetch', async () => new Response('fixture_github_012345678901234567890123456789', { status: 401 }));
  await expect(artifactFetch(c, new URL(url))).rejects.toThrow('GITHUB_AUTHENTICATION_FAILED');
  vi.stubGlobal('fetch', async (_input: any, init: RequestInit) => {
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    return new Response('generic');
  });
  expect(await (await artifactFetch(c, new URL('https://artifacts.example/a'))).text()).toBe('generic');
});

it('pins explicit update versions to their own tag, uses stable latest by default, and rejects ambiguous GitHub URLs', () => {
  expect(githubUpdateSource('https://github.com/owner/private/releases/download/v1.1.0-rc.3', '1.1.0-rc.4')).toBe('https://github.com/owner/private/releases/download/v1.1.0-rc.4/');
  expect(githubUpdateSource('https://github.com/owner/private/releases/download/v1.1.0-rc.3')).toBe('https://github.com/owner/private/releases/latest/download/');
  expect(githubAsset(new URL(url))).toEqual({ repository: 'owner/private', tag: 'v1.1.0-rc.3', asset: 'package.tar.gz' });
  expect(() => githubAsset(new URL(url + '?token=forbidden'))).toThrow();
  expect(() => githubAsset(new URL(url.replace('package.tar.gz', '%2e%2e%2fsecret')))).toThrow();
});
