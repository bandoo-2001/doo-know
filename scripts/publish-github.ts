import { createReadStream, constants, readFileSync } from 'node:fs';
import { readFile, writeFile, readdir, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { curlGithubUpload } from './github-upload.js';

type Options = { directory: string; repository: string; tag: string; commit: string; token: string; bootstrap: string; upload?: typeof curlGithubUpload };
type Asset = { id: number; name: string; size: number; state: string; digest: string };
const names = /^(?:install\.sh|release(?:-[0-9A-Za-z.+-]{1,80})?\.(?:txt|json)|catalog\.json|dooknow-[0-9A-Za-z.+-]{1,120}\.tar\.gz)$/;
async function digest(file: string) { const h = createHash('sha256'); for await (const b of createReadStream(file)) h.update(b); return h.digest('hex'); }
export async function publishGithubRelease(o: Options) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(o.repository) || !/^v[0-9][A-Za-z0-9.+-]{0,79}$/.test(o.tag) || !/^[a-f0-9]{40}$/.test(o.commit) || !/^[A-Za-z0-9_-]{20,4096}$/.test(o.token)) throw Error('INVALID_PUBLISH_ARGUMENTS');
  const directory = resolve(o.directory), paths = (await readdir(directory)).sort();
  const local = new Map<string, { sha: string; bytes: number }>();
  for (const name of paths) {
    const st = await lstat(join(directory, name));
    if (!names.test(name) || !st.isFile() || st.nlink !== 1) throw Error('UNEXPECTED_PUBLISH_FILE');
    local.set(name, { sha: await digest(join(directory, name)), bytes: st.size });
  }
  const info = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
  if (info.version !== o.tag.slice(1) || info.sourceCommit !== o.commit || info.dirty !== false || info.source !== `https://github.com/${o.repository}/releases/download/${o.tag}` || local.get(info.file)?.sha !== info.sha256 || !local.has('install.sh') || !local.has('release.txt')) throw Error('PUBLISH_METADATA_MISMATCH');
  if ((await readFile(join(directory, 'release.txt'), 'utf8')).trim() !== `${info.version} ${info.file} ${info.sha256}` ||
      JSON.stringify(JSON.parse(await readFile(join(directory, `release-${info.version}.json`), 'utf8'))) !== JSON.stringify(info)) throw Error('PUBLISH_METADATA_MISMATCH');
  const catalog = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8'));
  if (!Array.isArray(catalog)) throw Error('INVALID_PLUGIN_CATALOG');
  for (const plugin of catalog) {
    const artifact = plugin.artifact, name = typeof artifact?.url === 'string' && artifact.url.startsWith(info.source + '/') ? artifact.url.slice(info.source.length + 1) : '';
    if (!names.test(name) || local.get(name)?.sha !== artifact.sha256) throw Error('PUBLISH_PLUGIN_CHECKSUM_MISMATCH');
  }
  const api = `https://api.github.com/repos/${o.repository}`;
  const headers = { authorization: 'Bearer ' + o.token, accept: 'application/vnd.github+json', 'user-agent': 'DooKnow-publisher', 'x-github-api-version': '2022-11-28' };
  async function request(path: string, method = 'GET', body?: unknown, missing = false): Promise<any> {
    const response = await fetch(api + path, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (response.status === 404 && missing) return undefined;
    if (!response.ok) throw Error(`GITHUB_PUBLISH_HTTP_${response.status}`);
    return response.json();
  }
  if ((await request('')).private !== true) throw Error('PUBLISH_REQUIRES_PRIVATE_REPOSITORY');
  async function checkTag() {
    let object = (await request('/git/ref/tags/' + encodeURIComponent(o.tag), 'GET', undefined, true))?.object;
    if (!object) return false;
    for (let i = 0; object.type === 'tag' && i < 5; i++) object = (await request('/git/tags/' + object.sha)).object;
    if (object.type !== 'commit' || object.sha !== o.commit) throw Error('GITHUB_TAG_COMMIT_MISMATCH');
    return true;
  }
  if (!await checkTag()) await request('/git/refs', 'POST', { ref: 'refs/tags/' + o.tag, sha: o.commit });
  // The by-tag REST endpoint does not find unpublished drafts. List with the
  // publishing credential so retries recover the existing draft and asset IDs.
  let release: any;
  for (let page = 1; page <= 16; page++) {
    const releases = await request(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(releases) || releases.length > 100) throw Error('INVALID_GITHUB_RELEASES');
    for (const r of releases) if (r.tag_name === o.tag) {
      if (release) throw Error('AMBIGUOUS_GITHUB_RELEASE');
      release = r;
    }
    if (releases.length < 100) break;
    if (page === 16) throw Error('GITHUB_TOO_MANY_RELEASES');
  }
  if (!release) release = await request('/releases', 'POST', { tag_name: o.tag, target_commitish: o.commit, name: 'DooKnow ' + info.version, draft: true, prerelease: o.tag.includes('-'), make_latest: 'false', body: '私有原生发行：Linux x86_64，systemd 用户服务；含独立 MCP/Git 与可选离线检索制品。安装方法见仓库 README。' });
  if (!Number.isSafeInteger(release.id) || release.id <= 0 || release.tag_name !== o.tag) throw Error('INVALID_GITHUB_RELEASE');
  const assets: Asset[] = [];
  for (let page = 1; page <= 16; page++) {
    const items = await request(`/releases/${release.id}/assets?per_page=100&page=${page}`);
    if (!Array.isArray(items) || items.length > 100) throw Error('INVALID_GITHUB_ASSETS');
    assets.push(...items); if (items.length < 100) break;
    if (page === 16) throw Error('GITHUB_TOO_MANY_ASSETS');
  }
  async function upload(name: string) {
    const file = join(directory, name), sha = await digest(file), bytes = (await lstat(file)).size;
    if (local.get(name)?.sha !== sha || local.get(name)?.bytes !== bytes) throw Error('LOCAL_PUBLISH_FILES_CHANGED');
    let a = assets.find(a => a.name === name);
    if (assets.filter(a => a.name === name).length > 1) throw Error('DUPLICATE_GITHUB_ASSET');
    if (!a) {
      if (release.draft !== true) throw Error('PUBLISHED_RELEASE_IS_IMMUTABLE');
      const stream = o.upload ? undefined : createReadStream(file);
      try {
        const url = `https://uploads.github.com/repos/${o.repository}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`;
        const uploadHeaders = { ...headers, 'content-type': name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream', 'content-length': String(bytes) };
        const response = o.upload ? await o.upload(url, uploadHeaders, file, bytes) : await fetch(url, { method: 'POST', headers: uploadHeaders, body: stream, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(1800000) } as any);
        if (!response.ok) throw Error('GITHUB_UPLOAD_HTTP_' + response.status);
        a = await response.json() as Asset;
      } finally { stream?.destroy(); }
      assets.push(a);
    }
    if (!Number.isSafeInteger(a.id) || a.id <= 0 || a.name !== name || a.state !== 'uploaded' || a.size !== bytes || a.digest !== 'sha256:' + sha) throw Error('GITHUB_ASSET_CONTENT_CONFLICT');
    return a;
  }
  for (const name of paths.filter(n => n !== 'install.sh')) await upload(name);
  const app = assets.find(a => a.name === info.file)!, manifest = assets.find(a => a.name === 'release.txt')!;
  const originalInstaller = await readFile(join(directory, 'install.sh'));
  if (createHash('sha256').update(originalInstaller).digest('hex') !== local.get('install.sh')?.sha) throw Error('LOCAL_PUBLISH_FILES_CHANGED');
  let installer = originalInstaller.toString('utf8');
  installer = installer.replaceAll('__DOOKNOW_GITHUB_APPLICATION_ASSET__', String(app.id)).replaceAll('__DOOKNOW_GITHUB_RELEASE_TXT_ASSET__', String(manifest.id));
  if (/__DOOKNOW_/.test(installer)) throw Error('UNRESOLVED_INSTALLER_TEMPLATE');
  const installSha = createHash('sha256').update(installer).digest('hex');
  await writeFile(join(directory, 'install.sh'), installer, { mode: 0o700 });
  local.set('install.sh', { sha: installSha, bytes: Buffer.byteLength(installer) });
  const install = await upload('install.sh');
  if (!await checkTag()) throw Error('GITHUB_TAG_MISSING');
  if (release.draft) release = await request('/releases/' + release.id, 'PATCH', { draft: false, prerelease: o.tag.includes('-'), make_latest: o.tag.includes('-') ? 'false' : 'true' });
  const helper = await readFile(new URL('../deploy/github-fetch.sh', import.meta.url), 'utf8');
  const bootstrap = `#!/usr/bin/env bash\n# Generated pinned private release bootstrap; contains no credentials.\nmain() {\n  set +x\n  set -euo pipefail\n  umask 077\n${helper}\n  local work cleanup_path\n  work="$(mktemp -d "\${TMPDIR:-/tmp}/dooknow-bootstrap.XXXXXXXX")"\n  printf -v cleanup_path '%q' "$work"\n  trap "rm -rf -- $cleanup_path" EXIT\n  github_fetch '${o.repository}' '${install.id}' "$work/install.sh"\n  printf '%s  %s\\n' '${installSha}' "$work/install.sh" | sha256sum -c - >/dev/null\n  bash "$work/install.sh" "$@"\n}\nmain "$@"\n`;
  await writeFile(o.bootstrap, bootstrap, { mode: 0o700 });
  return { url: release.html_url || `https://github.com/${o.repository}/releases/tag/${o.tag}`, private: true, tag: o.tag, commit: o.commit, installerAssetId: install.id, installerSha256: installSha, assets: assets.map(({ id, name, size, digest }) => ({ id, name, size, digest })) };
}

async function main() {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, repository: { type: 'string' }, tag: { type: 'string' }, commit: { type: 'string' }, bootstrap: { type: 'string' }, 'token-file': { type: 'string' }, 'token-fd': { type: 'string' } } });
  if (!values.directory || !values.repository || !values.tag || !values.commit || !values.bootstrap || (!values['token-file'] && !values['token-fd'])) throw Error('发布需要 directory/repository/tag/commit/bootstrap 与外部私有 token-file 或 token-fd');
  let token: string;
  if (values['token-fd']) {
    if (!/^[0-9]+$/.test(values['token-fd']) || Number(values['token-fd']) < 3) throw Error('INVALID_TOKEN_FD');
    token = readFileSync(Number(values['token-fd']), 'utf8');
  } else {
    const file = await open(values['token-file']!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const st = await file.stat(); if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid?.() || st.mode & 0o077 || st.size > 8192) throw Error('PRIVATE_TOKEN_FILE_REQUIRED'); token = await file.readFile('utf8'); }
    finally { await file.close(); }
  }
  console.log(JSON.stringify(await publishGithubRelease({ directory: values.directory, repository: values.repository, tag: values.tag, commit: values.commit, bootstrap: values.bootstrap, token: token.trim(), upload: curlGithubUpload }), null, 2));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch(() => { console.error('私有 GitHub 发布失败；未发布的草稿保留，重试前核对版本、仓库权限和附件摘要。'); process.exitCode = 1; });
