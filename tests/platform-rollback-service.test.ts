import { expect, it, vi } from 'vitest';
import { mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import Database from 'better-sqlite3';
import { createFixture } from './support/fixture.js';
import { acquireInstance } from '../apps/server/platform/instance.js';
import { rollbackPlatform } from '../apps/server/platform/updates.js';

// Exercise real rollback, database snapshot and candidate execution. Only the host's
// systemd boundary is substituted; these tests must never control a real unit.
async function rollbackFixture(active = true) {
  const f = await createFixture();
  const installRoot = join(f.root, 'install'), previous = join(installRoot, 'releases/1.2.2');
  const profileFile = join(f.root, 'profile.json'), stateFile = join(f.root, 'service-state');
  const configHome = join(f.root, 'config'), bin = join(f.root, 'bin');
  const config = { ...f.config, installRoot, profileFile, serviceManaged: true,
    serviceName: 'dooknow-rollback-fixture.service', host: '127.0.0.1', port: 0 };
  await mkdir(join(installRoot, 'releases/1.2.3'), { recursive: true });
  await mkdir(join(previous, 'runtime/node/bin'), { recursive: true });
  await mkdir(join(previous, 'dist/server/scripts'), { recursive: true });
  await mkdir(join(configHome, 'systemd/user'), { recursive: true });
  await mkdir(bin);
  for (const version of ['1.2.3', '1.2.2'])
    await writeFile(join(installRoot, 'releases', version, 'release.json'),
      JSON.stringify({ version, databaseCompatibility: 2 }));
  await symlink('releases/1.2.3', join(installRoot, 'current'));
  const installation = JSON.stringify({ current: '1.2.3', previous: '1.2.2', databaseCompatibility: 2 });
  await writeFile(join(installRoot, 'installation.json'), installation);
  await symlink(process.execPath, join(previous, 'runtime/node/bin/node'));
  await writeFile(join(previous, 'dist/server/scripts/manage.js'),
    "console.error('fixture self-check refuses candidate'); process.exit(1);\n");
  await writeFile(join(configHome, 'systemd/user', config.serviceName), '# DooKnow profile: ' + profileFile + '\n');
  await writeFile(stateFile, active ? 'active' : 'inactive');
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}\n` + `
    const fs = require('node:fs');
    const state = ${JSON.stringify(stateFile)}, action = process.argv[3];
    if (action === 'is-active') {
      const value = fs.readFileSync(state, 'utf8'); console.log(value); process.exit(value === 'active' ? 0 : 3);
    }
    if (action === 'show') console.log(${process.pid});
    if (action === 'stop') {
      fs.writeFileSync(state, 'inactive');
      const DB = require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});
      const db = new DB(${JSON.stringify(join(f.dataRoot, 'app.sqlite'))});
      db.prepare('DELETE FROM platform_instance WHERE id=1').run(); db.close();
    }
    if (action === 'start') fs.writeFileSync(state, 'active');
    fs.appendFileSync(${JSON.stringify(join(f.root, 'service-actions'))}, action + '\\n');
  `, { mode: 0o700 });
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  vi.stubEnv('XDG_CONFIG_HOME', configHome);
  const releaseInstance = acquireInstance(config, '1.2.3');
  if (!active) releaseInstance();
  const server = createServer(async (_, response) => {
    if ((await readFile(stateFile, 'utf8')) !== 'active') response.statusCode = 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '1.2.3', phase: 'ready' }));
  });
  await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
  config.port = (server.address() as { port: number }).port;
  const retained = join(f.knowledgeRoot, '00-Inbox/latest.md');
  const source = '# 最新合法写入\r\n\r\n保留表格 | 和尾随空格  \r\n';
  await writeFile(retained, source);
  const db = new Database(join(f.dataRoot, 'app.sqlite'));
  const rows = db.prepare('SELECT * FROM notes ORDER BY id').all();
  return {
    config, previous, installRoot,
    unchanged: async () => {
      expect(await readlink(join(installRoot, 'current'))).toBe('releases/1.2.3');
      expect(await readFile(join(installRoot, 'installation.json'), 'utf8')).toBe(installation);
      expect(await readFile(retained, 'utf8')).toBe(source);
      expect(db.prepare('SELECT * FROM notes ORDER BY id').all()).toEqual(rows);
      expect((db.prepare('SELECT active FROM maintenance WHERE id=1').get() as { active: number }).active).toBe(0);
      expect(await readFile(stateFile, 'utf8')).toBe(active ? 'active' : 'inactive');
    },
    actions: async () => readFile(join(f.root, 'service-actions'), 'utf8').catch(() => ''),
    close: async () => {
      vi.unstubAllEnvs(); releaseInstance(); db.close();
      server.closeAllConnections();
      await new Promise<void>(yes => server.close(() => yes()));
      await f.close();
    },
  };
}

it.each(['runtime/node/bin/node', 'dist/server/scripts/manage.js'])(
  'refuses incomplete rollback artifacts before stopping the current service: %s', async (missing) => {
    const f = await rollbackFixture();
    try {
      await rm(join(f.previous, missing));
      await expect(rollbackPlatform(f.config)).rejects.toThrow(/没有可用的上一发行版本/);
      expect(await f.actions()).not.toMatch(/stop|start/);
      await f.unchanged();
    } finally { await f.close(); }
  },
);

it.each([true, false])('preserves the prior running state when rollback self-check fails: active=%s', async (active) => {
  const f = await rollbackFixture(active);
  try {
    await expect(rollbackPlatform(f.config)).rejects.toThrow(/fixture self-check refuses candidate/);
    await f.unchanged();
    if (active) expect(await f.actions()).toMatch(/stop[\s\S]*start/);
    else expect(await f.actions()).not.toMatch(/stop|start/);
  } finally { await f.close(); }
});
