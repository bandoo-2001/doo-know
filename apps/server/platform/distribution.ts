import { lstatSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { privateFile } from '../../../packages/core/agent/config.js';

export interface DistributionCredential { repository: string; tokenFile: string }
type Configuration = { distribution?: DistributionCredential };
const repositoryPattern = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const part = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,159}$/;
const cdnHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
export function assertDistributionOutsideKnowledge(config: Configuration, knowledgeRoot: string) {
  if (!config.distribution) return;
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const root = canonical(knowledgeRoot), file = canonical(config.distribution.tokenFile);
  if (file === root || file.startsWith(root + sep)) throw Error('GITHUB_CREDENTIAL_INSIDE_KNOWLEDGE_ROOT');
}

export function githubAsset(url: URL) {
  if (url.hostname !== 'github.com') return undefined;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash)
    throw Error('INVALID_GITHUB_ASSET_URL');
  const match = /^\/([^/]+\/[^/]+)\/releases\/(?:download\/([^/]+)|latest\/download)\/([^/]+)$/.exec(url.pathname);
  if (!match || !repositoryPattern.test(match[1]) || (match[2] && !part.test(match[2])) || !part.test(match[3])) throw Error('INVALID_GITHUB_ASSET_URL');
  return { repository: match[1], tag: match[2] || 'latest', asset: match[3] };
}
export function githubUpdateSource(source: string, version?: string) {
  const asset = githubAsset(new URL(source.replace(/\/$/, '') + '/release.json'));
  if (!asset) return source;
  if (version && !/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(version)) throw Error('INVALID_RELEASE_VERSION');
  return `https://github.com/${asset.repository}/releases/${version ? 'download/v' + version : 'latest/download'}/`;
}
function credential(config: Configuration, repository: string) {
  const c = config.distribution;
  if (!c) throw Error('GITHUB_CREDENTIAL_UNAVAILABLE');
  if (!repositoryPattern.test(c.repository) || c.repository.toLowerCase() !== repository.toLowerCase()) throw Error('GITHUB_REPOSITORY_MISMATCH');
  try {
    if (lstatSync(c.tokenFile).uid !== process.getuid?.()) throw Error();
    const token = privateFile(c.tokenFile, 8192).trim();
    if (!/^[A-Za-z0-9_-]{20,4096}$/.test(token)) throw Error();
    return token;
  } catch { throw Error('GITHUB_CREDENTIAL_UNAVAILABLE'); }
}
async function request(url: string | URL, headers: Record<string, string>, signal: AbortSignal) {
  try { return await fetch(url, { headers, signal, redirect: 'manual' }); }
  catch { signal.throwIfAborted(); throw Error('GITHUB_DOWNLOAD_FAILED'); }
}
function check(response: Response) {
  if (response.status === 401) throw Error('GITHUB_AUTHENTICATION_FAILED');
  if (response.status === 403) throw Error('GITHUB_ACCESS_DENIED');
  if (response.status === 404) throw Error('GITHUB_RELEASE_OR_ASSET_NOT_FOUND');
  if (!response.ok) throw Error('GITHUB_DOWNLOAD_FAILED');
}
async function json(response: Response): Promise<any> {
  check(response);
  let size = 0; const chunks: Uint8Array[] = [];
  if (!response.body) throw Error('INVALID_GITHUB_METADATA');
  for await (const chunk of response.body as any) {
    size += chunk.length; if (size > 1024 * 1024) throw Error('GITHUB_METADATA_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Error('INVALID_GITHUB_METADATA'); }
}

/** Credentials are scoped to one repository and never follow an API redirect. */
export async function artifactFetch(config: Configuration, url: URL, signal = AbortSignal.timeout(600000)) {
  const asset = githubAsset(url);
  if (!asset) return fetch(url, { signal, redirect: 'error' });
  const headers = { authorization: 'Bearer ' + credential(config, asset.repository), 'user-agent': 'DooKnow', accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  const api = `https://api.github.com/repos/${asset.repository}/releases`;
  const release = await json(await request(api + (asset.tag === 'latest' ? '/latest' : '/tags/' + encodeURIComponent(asset.tag)), headers, signal));
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.draft !== false) throw Error('INVALID_GITHUB_RELEASE');
  let id: number | undefined;
  for (let page = 1; page <= 16; page++) {
    const assets = await json(await request(`${api}/${release.id}/assets?per_page=100&page=${page}`, headers, signal));
    if (!Array.isArray(assets) || assets.length > 100) throw Error('INVALID_GITHUB_METADATA');
    for (const a of assets) if (a.name === asset.asset) {
      if (id || !Number.isSafeInteger(a.id) || a.id <= 0) throw Error('INVALID_GITHUB_METADATA');
      id = a.id;
    }
    if (assets.length < 100) break;
    if (page === 16) throw Error('GITHUB_TOO_MANY_ASSETS');
  }
  if (!id) throw Error('GITHUB_RELEASE_OR_ASSET_NOT_FOUND');
  const response = await request(`${api}/assets/${id}`, { ...headers, accept: 'application/octet-stream' }, signal);
  if (response.status === 302) {
    let redirect: URL;
    try { redirect = new URL(response.headers.get('location') || ''); } catch { throw Error('GITHUB_ASSET_REDIRECT_REJECTED'); }
    if (redirect.protocol !== 'https:' || redirect.port || redirect.username || redirect.password || !cdnHosts.has(redirect.hostname)) throw Error('GITHUB_ASSET_REDIRECT_REJECTED');
    const downloaded = await request(redirect, {}, signal);
    check(downloaded); return downloaded;
  }
  check(response); return response;
}
