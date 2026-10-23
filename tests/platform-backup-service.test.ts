import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createFixture, loginFixtureOwner } from './support/fixture.js';
import { acquireInstance } from '../apps/server/platform/instance.js';
import { restorePlatformBackup } from '../apps/server/platform/backups.js';

const execute = promisify(execFile);

// Only the service boundary is simulated. The CLI, backup encryption, SQLite
// snapshot, source files and restore all use their actual implementations.
async function runningBackupFixture() {
  const f = await createFixture();
  const headers = await loginFixtureOwner(f);
  const source = '# 合成备份\r\n\r\n保留原文字节和末尾空白  \r\n';
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers,
    payload: {
      folderPath: '00-Inbox',
      fileName: 'online-backup.md',
      content: source,
      requestId: 'online-backup-note',
    },
  });
  expect(created.statusCode).toBe(201);
  const note = created.json();
  await f.app.close();
  const profileFile = join(f.root, 'profile.json');
  const secretFile = join(f.root, 'auth.key');
  const installRoot = join(f.root, 'install');
  const configHome = join(f.root, 'config');
  const bin = join(f.root, 'bin');
  const stateFile = join(f.root, 'service-state');
  const actionsFile = join(f.root, 'service-actions');
  const mainPidFile = join(f.root, 'main-pid');
  const serviceName = 'dooknow-online-backup-fixture.service';
  const profile = {
    dataRoot: f.dataRoot,
    knowledgeRoot: f.knowledgeRoot,
    installRoot,
    secretFile,
    origin: 'http://127.0.0.1:15177',
    port: 15177,
    serviceName,
    indexing: { enabled: false, watch: false },
    fileTasks: { embedded: false },
  };
  await mkdir(installRoot);
  await mkdir(join(configHome, 'systemd/user'), { recursive: true });
  await mkdir(bin);
  await writeFile(secretFile, f.config.secret, { mode: 0o600 });
  await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
  await writeFile(
    join(configHome, 'systemd/user', serviceName),
    '# DooKnow profile: ' + profileFile + '\n',
  );
  await writeFile(stateFile, 'active');
  await writeFile(actionsFile, '');
  await writeFile(mainPidFile, String(process.pid));
  const release = acquireInstance({ ...f.config, ...profile, profileFile }, '1.1.0-test');
  const db = new Database(join(f.dataRoot, 'app.sqlite'));
  const instance = db.prepare('SELECT * FROM platform_instance').all();
  await writeFile(
    join(bin, 'systemctl'),
    `#!${process.execPath}\n` +
      `
    const fs = require('node:fs');
    const action = process.argv[3], name = process.argv[4];
    if (process.argv[2] !== '--user' || name !== ${JSON.stringify(serviceName)}) process.exit(2);
    if (action === 'is-active') {
      const state = fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8');
      console.log(state); process.exit(state === 'active' ? 0 : 3);
    }
    if (action === 'show') { console.log(fs.readFileSync(${JSON.stringify(mainPidFile)}, 'utf8')); process.exit(0); }
    if (!['start','stop'].includes(action)) process.exit(2);
    fs.appendFileSync(${JSON.stringify(actionsFile)}, action + '\\n');
    fs.writeFileSync(${JSON.stringify(stateFile)}, action === 'stop' ? 'inactive' : 'active');
    if (action === 'stop') {
      const DB = require(${JSON.stringify(resolve('node_modules/better-sqlite3'))});
      const db = new DB(${JSON.stringify(join(f.dataRoot, 'app.sqlite'))});
      db.prepare('DELETE FROM platform_instance WHERE id=1').run(); db.close();
    }
  `,
    { mode: 0o700 },
  );
  const environment: NodeJS.ProcessEnv = {
    PATH: bin + ':' + process.env.PATH,
    HOME: f.root,
    XDG_CONFIG_HOME: configHome,
    TMPDIR: process.env.TMPDIR,
    LANG: 'C.UTF-8',
  };
  const destination = join(f.root, 'snapshot.dkb');
  const keyFile = join(f.root, 'recovery.pem');
  return {
    ...f,
    source,
    note,
    profileFile,
    destination,
    keyFile,
    db,
    backup: (preload?: string) =>
      execute(
        process.execPath,
        [
          ...(preload ? ['--import', preload] : []),
          '--import',
          'tsx',
          'scripts/manage.ts',
          'backup',
          '--profile',
          profileFile,
          '--destination',
          destination,
          '--key-file',
          keyFile,
        ],
        { env: environment, timeout: 15000 },
      ),
    assertServiceUntouched: async (maintenance = 0) => {
      expect(await readFile(actionsFile, 'utf8')).toBe('');
      expect(await readFile(stateFile, 'utf8')).toBe('active');
      expect(db.prepare('SELECT * FROM platform_instance').all()).toEqual(instance);
      expect(db.prepare('SELECT active FROM maintenance WHERE id=1').get()).toEqual({
        active: maintenance,
      });
      expect(await readFile(join(f.knowledgeRoot, note.relativePath), 'utf8')).toBe(source);
    },
    setForeignUnit: () =>
      writeFile(
        join(configHome, 'systemd/user', serviceName),
        '# DooKnow profile: another-profile\n',
      ),
    setDifferentMainPid: () => writeFile(mainPidFile, String(process.pid + 1)),
    close: async () => {
      release();
      db.close();
      await f.close();
    },
  };
}

it('backs up a running managed library without stopping its service or replacing its instance', async () => {
  const f = await runningBackupFixture();
  try {
    const preload = join(f.root, 'backup-import-guard.mjs');
    await writeFile(
      preload,
      `import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) {
  const result = next(specifier, context);
  const parts = new URL(result.url).pathname.split('/');
  const server = parts.findIndex((part, index) => part === 'apps' && parts[index + 1] === 'server');
  const tail = parts.slice(server + 2).join('/');
  if (server >= 0 && ['app.ts', 'app.js', 'auth.ts', 'auth.js', 'plugins/host.ts', 'plugins/host.js'].includes(tail))
    throw Error('BACKUP_IMPORTED_UNRELATED_HTTP_OR_ACCOUNT_RUNTIME');
  return result;
}});
`,
      { mode: 0o600 },
    );
    const reply = await f.backup(preload);
    expect(JSON.parse(reply.stdout.slice(0, reply.stdout.lastIndexOf('}') + 1))).toMatchObject({
      file: f.destination,
    });
    await f.assertServiceUntouched();
    const target = {
      dataRoot: join(f.root, 'restored-data'),
      knowledgeRoot: join(f.root, 'restored-knowledge'),
      profileFile: join(f.root, 'restored-config/profile.json'),
    };
    await restorePlatformBackup({ source: f.destination, keyFile: f.keyFile, target });
    expect(await readFile(join(target.knowledgeRoot, f.note.relativePath), 'utf8')).toBe(f.source);
    const restored = new Database(join(target.dataRoot, 'app.sqlite'), { readonly: true });
    try {
      expect(restored.prepare('SELECT id,path FROM notes').all()).toEqual(
        f.db.prepare('SELECT id,path FROM notes').all(),
      );
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      restored.close();
    }
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('keeps the running service and current original untouched when backup validation fails', async () => {
  const f = await runningBackupFixture();
  try {
    const outside = join(f.root, 'outside-synthetic');
    await mkdir(outside);
    await writeFile(join(outside, 'source.md'), 'Synthetic excluded file\n');
    await symlink(outside, join(f.knowledgeRoot, 'refuse-link'));
    await expect(f.backup()).rejects.toMatchObject({ code: 1 });
    await f.assertServiceUntouched();
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.root)).some((name) => name.startsWith('.backup-'))).toBe(false);
  } finally {
    await f.close();
  }
});

it('still refuses another profile service before producing a backup', async () => {
  const f = await runningBackupFixture();
  try {
    await f.setForeignUnit();
    await expect(f.backup()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('用户服务不属于此配置'),
    });
    await f.assertServiceUntouched();
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

it('refuses an already maintained library without controlling its service or clearing maintenance', async () => {
  const f = await runningBackupFixture();
  try {
    f.db.prepare('UPDATE maintenance SET active=1 WHERE id=1').run();
    await expect(f.backup()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('工作区已处于维护状态'),
    });
    await f.assertServiceUntouched(1);
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});

it('still refuses a foreground instance that does not match the managed service PID', async () => {
  const f = await runningBackupFixture();
  try {
    await f.setDifferentMainPid();
    await expect(f.backup()).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('前台运行中的应用需要先正常停止'),
    });
    await f.assertServiceUntouched();
    await expect(readFile(f.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
