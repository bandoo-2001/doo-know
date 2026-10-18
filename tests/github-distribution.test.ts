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

it('resolves a public latest download through the same repository and asset pinned tag before the CDN', async () => {
  const latest='https://github.com/owner/private/releases/latest/download/package.tar.gz';
  const requests:string[]=[];
  vi.stubGlobal('fetch',async (input:any,init:RequestInit)=>{
    const address=String(input); requests.push(address);
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    if(address===latest)return new Response(null,{status:302,headers:{location:url}});
    if(address===url)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/public/object'}});
    expect(address).toBe('https://release-assets.githubusercontent.com/public/object');
    return new Response('latest bytes');
  });
  expect(await(await artifactFetch({},new URL(latest))).text()).toBe('latest bytes');
  expect(requests).toEqual([latest,url,'https://release-assets.githubusercontent.com/public/object']);
});

it.each([
  'https://github.com/other/repo/releases/download/v1/package.tar.gz',
  'https://github.com/owner/private/releases/download/v1/other.tar.gz',
  'https://github.com/owner/private/releases/latest/download/package.tar.gz',
])('refuses a mismatched or looping latest public redirect: %s',async location=>{
  const network=vi.fn(async()=>new Response(null,{status:302,headers:{location}}));vi.stubGlobal('fetch',network);
  await expect(artifactFetch({},new URL('https://github.com/owner/private/releases/latest/download/package.tar.gz'))).rejects.toThrow('GITHUB_ASSET_REDIRECT_REJECTED');
  expect(network).toHaveBeenCalledTimes(1);
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

it('pins explicit update versions without querying release metadata and rejects ambiguous GitHub URLs', async () => {
  expect(await githubUpdateSource('https://github.com/owner/private/releases/download/v1.1.0-rc.3', '1.1.0-rc.4')).toBe('https://github.com/owner/private/releases/download/v1.1.0-rc.4/');
  expect(githubAsset(new URL(url))).toEqual({ repository: 'owner/private', tag: 'v1.1.0-rc.3', asset: 'package.tar.gz' });
  expect(() => githubAsset(new URL(url + '?token=forbidden'))).toThrow();
  expect(() => githubAsset(new URL(url.replace('package.tar.gz', '%2e%2e%2fsecret')))).toThrow();
});


it('selects the highest published version including RCs, ignoring drafts and unrelated tags', async () => {
  vi.stubGlobal('fetch', async (input: any) => {
    expect(String(input)).toBe('https://api.github.com/repos/owner/private/releases?per_page=100&page=1');
    return Response.json([
      { tag_name: 'v1.0.0', draft: false, prerelease: false },
      { tag_name: 'v1.1.0-rc.9', draft: false, prerelease: true },
      { tag_name: 'v1.1.0-rc.12', draft: false, prerelease: true },
      { tag_name: 'v9.0.0', draft: true, prerelease: false },
      { tag_name: 'search-runtime-v99', draft: false, prerelease: false },
    ]);
  });
  expect(await githubUpdateSource('https://github.com/owner/private/releases/download/v1.0.0'))
    .toBe('https://github.com/owner/private/releases/download/v1.1.0-rc.12/');
});

it('continues paginated discovery and prefers a final version over its RC', async () => {
  vi.stubGlobal('fetch', async (input: any) => Response.json(String(input).endsWith('page=1')
    ? Array.from({ length: 100 }, () => ({ tag_name: 'v1.1.0-rc.12', draft: false }))
    : [{ tag_name: 'v1.1.0', draft: false }]));
  expect(await githubUpdateSource('https://github.com/owner/private/releases/download/v1.0.0'))
    .toBe('https://github.com/owner/private/releases/download/v1.1.0/');
});

it('keeps generic update sources unchanged and reports missing releases clearly', async () => {
  expect(await githubUpdateSource('file:///controlled/releases')).toBe('file:///controlled/releases');
  vi.stubGlobal('fetch', async () => Response.json([]));
  await expect(githubUpdateSource('https://github.com/owner/private/releases/download/v1.0.0'))
    .rejects.toThrow('GITHUB_NO_PUBLISHED_RELEASE');
});

it('uses explicit private credentials for discovery but keeps them off public requests', async () => {
  const c = await config();
  vi.stubGlobal('fetch', async (_: any, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture_github_012345678901234567890123456789');
    return Response.json([{ tag_name: 'v1.2.0-rc.1', draft: false }]);
  });
  expect(await githubUpdateSource('https://github.com/owner/private/releases/download/v1.0.0', undefined, c))
    .toBe('https://github.com/owner/private/releases/download/v1.2.0-rc.1/');
});

it('preserves network causes for safe CLI hints and distinguishes rate limits from missing assets', async () => {
  vi.stubGlobal('fetch', async () => { throw Object.assign(new Error('private diagnostic'), { code: 'ECONNREFUSED' }); });
  await expect(artifactFetch({}, new URL(url))).rejects.toMatchObject({
    message: 'GITHUB_DOWNLOAD_FAILED', cause: { code: 'ECONNREFUSED' },
  });
  for (const [status, headers, error] of [
    [429, {}, 'GITHUB_RATE_LIMITED'],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED'],
    [403, {}, 'GITHUB_ACCESS_DENIED'],
    [404, {}, 'GITHUB_RELEASE_OR_ASSET_NOT_FOUND'],
    [503, {}, 'GITHUB_HTTP_503'],
  ] as const) {
    vi.stubGlobal('fetch', async () => new Response(null, { status, headers }));
    await expect(artifactFetch({}, new URL(url))).rejects.toThrow(error);
  }
});
