import { it, expect } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pluginFixture } from './support/plugin-fixture.js';
import { pluginRuntimeFixture } from './support/plugin-runtime.js';
import { pluginHost } from '../server/plugins/host.js';
import { pluginServices } from '../server/plugins/services.js';
it('rejects new calls during stopping while letting an owner request already committing finish its write', async () => {
  const f = await pluginRuntimeFixture(),
    entry = await pluginFixture(f.root);
  entry.capabilities = ['knowledge:read', 'knowledge:write'];
  await writeFile(join(f.root, 'counter-source/manifest.json'), JSON.stringify(entry));
  await writeFile(
    join(f.root, 'counter-source/server/index.mjs'),
    `export function activate(ctx){ctx.registerCommand('counter.commit',async c=>{const op=c.services.operations.begin('drain','drain-request',{});c.services.operations.committing(op.operation.id);ctx.storage.set('entered',true);while(!ctx.storage.get('release'))await new Promise(r=>setTimeout(r,5));const result=await c.services.knowledge.create({directory:'00-Inbox',fileName:'drain.md',content:'# committed',requestId:'drain-note'});c.services.operations.finish(op.operation.id,result);return result;});}`,
  );
  const file = join(f.root, 'counter.tar.gz');
  execFileSync('tar', ['--format=ustar', '-czf', file, '-C', join(f.root, 'counter-source'), '.']);
  entry.artifact.sha256 = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  const host = pluginHost({ ...f.config, pluginCatalog: [entry] }, f.db, (id, caps, context) =>
    pluginServices(f.platform, f.db, id, caps, context),
  );
  try {
    await host.install('counter');
    await host.enable('counter');
    const call = host.call(
      'counter',
      { kind: 'command', id: 'counter.commit', input: {} },
      { ownerId: f.principal.id, channel: 'web' },
    );
    for (let i = 0; i < 100 && !host.storage('counter').get('entered'); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(host.storage('counter').get('entered')).toBe(true);
    const disabled = host.disable('counter');
    await new Promise((r) => setTimeout(r, 5));
    expect(host.list()[0].state).toBe('stopping');
    await expect(
      host.call(
        'counter',
        { kind: 'command', id: 'counter.commit', input: {} },
        { ownerId: f.principal.id, channel: 'web' },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_DISABLED' });
    host.storage('counter').set('release', true);
    const result = (await call) as { id: string };
    await disabled;
    expect(f.platform.get().notes.getNote(result.id).content).toBe('# committed');
    expect(host.list()[0].state).toBe('disabled');
  } finally {
    host.storage('counter').set('release', true);
    await host.close();
    await f.close();
  }
});
