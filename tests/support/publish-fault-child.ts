import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.argv[2], commit = 'a'.repeat(40), realWrite = fs.writeFile;
let tampered = false, published = false;
(fs as any).writeFile = async (path: string, bytes: any, ...options: any[]) => {
  await (realWrite as any)(path, bytes, ...options);
  if (path === join(root, 'install.sh')) { tampered = true; await realWrite(path, '#'.repeat(Buffer.byteLength(bytes) - 1) + '\n'); }
};
syncBuiltinESMExports();
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = new URL(input);
  if (u.pathname === '/repos/owner/private') return Response.json({ private: true });
  if (u.pathname.includes('/git/ref/')) return Response.json({ object: { type: 'commit', sha: commit } });
  if (u.pathname.endsWith('/releases') && init.method !== 'POST') return Response.json([{ id: 19, draft: true, tag_name: 'v1.1.0-rc.3' }]);
  if (u.pathname.endsWith('/19/assets') && init.method !== 'POST') return Response.json([]);
  if (u.hostname === 'uploads.github.com') {
    const h = createHash('sha256'); let size = 0;
    for await (const b of init.body) { h.update(b); size += b.length; }
    return Response.json({ id: 100 + size, name: u.searchParams.get('name'), state: 'uploaded', size, digest: 'sha256:' + h.digest('hex') }, { status: 201 });
  }
  if (init.method === 'PATCH') { published = true; return Response.json({ draft: false }); }
  throw Error('unexpected request');
}) as typeof fetch;
try {
  const { publishGithubRelease } = await import('../../scripts/publish-github.js');
  let code = 'succeeded';
  try { await publishGithubRelease({ directory: root, repository: 'owner/private', tag: 'v1.1.0-rc.3', commit, token: 'fixture_github_012345678901234567890123456789', bootstrap: join(root, 'bootstrap.sh'), verification: root + '.verification.json' }); }
  catch (e) { code = (e as Error).message; }
  console.log(JSON.stringify({ code, tampered, published }));
} finally { fs.writeFile = realWrite; syncBuiltinESMExports(); }
