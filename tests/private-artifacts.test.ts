import { it, expect } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactServer } from '../apps/server/platform/artifacts.js';
it('serves only regular release files on the loopback publisher and rejects other files and methods', async () => {
  const root = await mkdtemp(join(tmpdir(), 'private-artifacts-'));
  let server: ReturnType<typeof createArtifactServer> | undefined;
  try {
    await writeFile(join(root, 'install.sh'), '#!/bin/bash\n');
    await writeFile(join(root, 'private.key'), 'fixture-secret');
    await symlink(join(root, 'private.key'), join(root, 'release.json'));
    server = createArtifactServer(root);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as any).port,
      url = 'http://127.0.0.1:' + port;
    expect(await (await fetch(url + '/install.sh')).text()).toBe('#!/bin/bash\n');
    expect((await fetch(url + '/private.key')).status).toBe(404);
    expect((await fetch(url + '/release.json')).status).toBe(404);
    expect((await fetch(url + '/install.sh', { method: 'POST' })).status).toBe(405);
  } finally {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await rm(root, { recursive: true, force: true });
  }
});
