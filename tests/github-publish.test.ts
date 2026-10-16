import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { publishGithubRelease } from '../scripts/publish-github.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

it.each([false, true])('uploads a complete private release, recovers a partial draft (%s), and publishes only after binding IDs and hashes', async (resume) => {
  const root = await mkdtemp(join(tmpdir(), 'github-publish-'));
  const source = 'https://github.com/owner/private/releases/download/v1.1.0-rc.3', commit = 'a'.repeat(40);
  const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
  try {
    await writeFile(join(root, 'dooknow-1.1.0-rc.3-linux-x64.tar.gz'), 'application');
    const info = { version: '1.1.0-rc.3', file: 'dooknow-1.1.0-rc.3-linux-x64.tar.gz', sha256: hash('application'), source, sourceCommit: commit, dirty: false };
    await writeFile(join(root, 'release.json'), JSON.stringify(info));
    await writeFile(join(root, 'release-1.1.0-rc.3.json'), JSON.stringify(info));
    await writeFile(join(root, 'release.txt'), `1.1.0-rc.3 dooknow-1.1.0-rc.3-linux-x64.tar.gz ${info.sha256}\n`);
    await writeFile(join(root, 'catalog.json'), '[]');
    await writeFile(join(root, 'install.sh'), '#!/bin/bash\n# __DOOKNOW_GITHUB_APPLICATION_ASSET__ __DOOKNOW_GITHUB_RELEASE_TXT_ASSET__\n');
    const assets: any[] = resume ? [{ id: 99, name: 'catalog.json', size: 2, state: 'uploaded', digest: 'sha256:' + hash('[]') }] : [], writes: any[] = []; let tagExists = resume;
    vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
      const url = new URL(input), method = init.method || 'GET';
      if (method !== 'GET') writes.push({ url: url.pathname, method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined });
      if (url.hostname === 'uploads.github.com') {
        const chunks: Buffer[] = []; for await (const b of init.body) chunks.push(Buffer.from(b));
        const bytes = Buffer.concat(chunks), asset = { id: 100 + assets.length, name: url.searchParams.get('name'), size: bytes.length, state: 'uploaded', digest: 'sha256:' + hash(bytes) }; assets.push(asset); return Response.json(asset, { status: 201 });
      }
      if (url.pathname === '/repos/owner/private') return Response.json({ private: true });
      if (url.pathname.endsWith('/releases') && method === 'GET') return Response.json(resume ? [{ id: 19, draft: true, tag_name: 'v1.1.0-rc.3' }] : []);
      if (url.pathname.includes('/git/ref/tags/')) return tagExists ? Response.json({ object: { type: 'commit', sha: commit } }) : new Response(null, { status: 404 });
      if (url.pathname.endsWith('/git/refs')) { tagExists = true; return Response.json({ object: { sha: commit } }, { status: 201 }); }
      if (url.pathname.includes('/releases/tags/')) return new Response(null, { status: 404 });
      if (url.pathname.endsWith('/releases') && method === 'POST') return Response.json({ id: 19, draft: true, tag_name: 'v1.1.0-rc.3' }, { status: 201 });
      if (url.pathname.endsWith('/19/assets')) return Response.json(assets);
      if (url.pathname.endsWith('/releases/19') && method === 'PATCH') return Response.json({ id: 19, draft: false, html_url: 'https://github.com/owner/private/releases/tag/v1.1.0-rc.3' });
      throw Error('unexpected API request');
    });
    const bootstrap = join(root, 'bootstrap.sh');
    const result = await publishGithubRelease({ directory: root, repository: 'owner/private', tag: 'v1.1.0-rc.3', commit, token: 'fixture_github_012345678901234567890123456789', bootstrap });
    expect(result.assets).toHaveLength(6);
    const created = writes.find(w => w.method === 'POST' && w.url.endsWith('/releases'));
    if (resume) expect(created).toBeUndefined();
    else expect(created.body).toMatchObject({ draft: true, prerelease: true, target_commitish: commit });
    expect(writes.at(-1).body).toMatchObject({ draft: false, make_latest: 'false' });
    const installer = await readFile(join(root, 'install.sh'), 'utf8');
    expect(installer).not.toContain('__DOOKNOW_');
    expect(await readFile(bootstrap, 'utf8')).toContain(hash(installer));
    expect(await readFile(bootstrap, 'utf8')).not.toContain('fixture_github_');
    const bin = join(root, 'bin'), temp = join(root, 'bootstrap-temp'), tokenFile = join(root, 'github.token');
    await mkdir(bin); await mkdir(temp);
    await writeFile(tokenFile, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
    await writeFile(join(bin, 'curl'), `#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2);fs.writeFileSync(a[a.indexOf('--dump-header')+1],'HTTP/1.1 200 OK\\r\\n\\r\\n');fs.writeFileSync(a[a.indexOf('--output')+1],${JSON.stringify(installer)});process.stdout.write('200');`, { mode: 0o700 });
    await promisify(execFile)('bash', [bootstrap], { env: { ...process.env, PATH: bin + ':' + process.env.PATH, TMPDIR: temp, DOOKNOW_GITHUB_TOKEN_FILE: tokenFile } });
    expect(await readdir(temp)).toEqual([]);
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});

it('rejects public repositories, a moved tag, and files changed after the initial manifest check without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-publish-boundary-')), commit = 'a'.repeat(40);
  const hash = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
  try {
    const info = { version: '1.1.0-rc.3', file: 'dooknow-1.1.0-rc.3-linux-x64.tar.gz', sha256: hash('application'), source: 'https://github.com/owner/private/releases/download/v1.1.0-rc.3', sourceCommit: commit, dirty: false };
    await writeFile(join(root, info.file), 'application');
    for (const file of ['release.json', 'release-1.1.0-rc.3.json']) await writeFile(join(root, file), JSON.stringify(info));
    await writeFile(join(root, 'release.txt'), `1.1.0-rc.3 ${info.file} ${info.sha256}\n`);
    await writeFile(join(root, 'catalog.json'), '[]'); await writeFile(join(root, 'install.sh'), '#!/bin/bash\n');
    const options = { directory: root, repository: 'owner/private', tag: 'v1.1.0-rc.3', commit, token: 'fixture_github_012345678901234567890123456789', bootstrap: join(root, 'bootstrap.sh') };
    vi.stubGlobal('fetch', async () => Response.json({ private: false }));
    await expect(publishGithubRelease(options)).rejects.toThrow('PUBLISH_REQUIRES_PRIVATE_REPOSITORY');
    vi.stubGlobal('fetch', async (input: any) => String(input).endsWith('/repos/owner/private') ? Response.json({ private: true }) : Response.json({ object: { type: 'commit', sha: 'b'.repeat(40) } }));
    await expect(publishGithubRelease(options)).rejects.toThrow('GITHUB_TAG_COMMIT_MISMATCH');
    let published = false;
    vi.stubGlobal('fetch', async (input: any, init: any = {}) => {
      const u = new URL(input);
      if (u.pathname === '/repos/owner/private') { await writeFile(join(root, info.file), 'changed concurrently'); return Response.json({ private: true }); }
      if (u.pathname.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: commit } });
      if (u.pathname.endsWith('/releases') && init.method !== 'POST') return Response.json([{ id: 19, draft: true, tag_name: 'v1.1.0-rc.3' }]);
      if (u.pathname.endsWith('/19/assets') && init.method !== 'POST') return Response.json([]);
      if (u.hostname === 'uploads.github.com') {
        const chunks: Buffer[] = []; for await (const b of init.body) chunks.push(Buffer.from(b)); const bytes = Buffer.concat(chunks);
        return Response.json({ id: 100 + bytes.length, name: u.searchParams.get('name'), state: 'uploaded', size: bytes.length, digest: 'sha256:' + hash(bytes) }, { status: 201 });
      }
      if (init.method === 'PATCH') { published = true; return Response.json({ draft: false }); }
      throw Error('unexpected request');
    });
    await expect(publishGithubRelease(options)).rejects.toThrow('LOCAL_PUBLISH_FILES_CHANGED');
    expect(published).toBe(false);
    await writeFile(join(root, info.file), 'application');
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/support/publish-fault-child.ts', root]);
    expect(JSON.parse(child.stdout)).toEqual({ code: 'LOCAL_PUBLISH_FILES_CHANGED', tampered: true, published: false });
  } finally { vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); }
});
