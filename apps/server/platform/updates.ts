import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  symlink,
  realpath,
  rm,
  copyFile,
  open,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { extractArchive } from './archive.js';
import { releaseInfo } from './release.js';
import {
  withQuiesced,
  serviceActive,
  systemctl,
  unitName,
  writeService,
  waitHealthy,
} from './service.js';
import { openDatabase } from '../../../packages/core/db.js';
import { createPlatformBackup } from './backups.js';
import { sealBackup, unsealBackup } from './sealed-backup.js';
import { processIsAlive, workspaceProcess } from '../../../packages/core/workspace/gate.js';
const exec = promisify(execFile);
export async function durableJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp',
    file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const dir = await open(dirname(path), 'r');
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export async function managementLock<T>(config: HostConfig, work: () => Promise<T>) {
  const root = resolve(config.installRoot || join(config.dataRoot, '..'));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, 'management.sqlite')),
    self = workspaceProcess(),
    token = randomUUID();
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS manager(id INTEGER PRIMARY KEY,pid INTEGER,process_start TEXT,token TEXT)',
    );
    db.transaction(() => {
      const old = db.prepare('SELECT * FROM manager WHERE id=1').get() as any;
      if (old && processIsAlive(old.pid, old.process_start)) throw Error('另一个管理操作正在运行');
      db.prepare('INSERT OR REPLACE INTO manager VALUES(1,?,?,?)').run(self.pid, self.start, token);
    }).immediate();
    try {
      return await work();
    } finally {
      db.prepare('DELETE FROM manager WHERE id=1 AND token=?').run(token);
    }
  } finally {
    db.close();
  }
}
function sourceURL(value: string) {
  const url = new URL(value.endsWith('/') ? value : value + '/');
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!['https:', 'file:'].includes(url.protocol) &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw Error('安装源必须为HTTPS或本机受控地址，且不能包含凭据');
  return url;
}
async function download(url: URL, file: string, maxBytes: number) {
  if (url.protocol === 'file:') {
    await copyFile(url, file);
    const f = await open(file);
    try {
      if ((await f.stat()).size > maxBytes) throw Error('下载超出限制');
    } finally {
      await f.close();
    }
    return;
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw Error('下载失败：' + response.status);
  let size = 0;
  const out = await open(file, 'wx', 0o600);
  try {
    for await (const block of response.body as any) {
      size += block.length;
      if (size > maxBytes) throw Error('下载超出限制');
      await out.write(block);
    }
    await out.sync();
  } finally {
    await out.close();
  }
}
async function digest(file: string) {
  const hash = createHash('sha256'),
    input = await open(file, 'r');
  try {
    for await (const data of input.createReadStream()) hash.update(data);
    return hash.digest('hex');
  } finally {
    await input.close();
  }
}
export async function setCurrent(root: string, release: string) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(release)) throw Error('发行版本不正确');
  const tmp = join(root, '.current-' + randomUUID());
  await symlink('releases/' + release, tmp);
  await rename(tmp, join(root, 'current'));
  const directory = await open(root, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
async function candidateCheck(config: HostConfig, candidate: string, clone: string) {
  const db = openDatabase(config.dataRoot);
  try {
    await db.backup(join(clone, 'app.sqlite'));
  } finally {
    db.close();
  }
  await exec(
    join(candidate, 'runtime/node/bin/node'),
    [
      join(candidate, 'dist/server/scripts/manage.js'),
      'self-check',
      '--profile',
      config.profileFile!,
      '--data-root',
      clone,
    ],
    {
      timeout: 60000,
      maxBuffer: 32768,
      env: {
        ...process.env,
        DATA_ROOT: '',
        KNOWLEDGE_ROOT: '',
        DOOKNOW_PROFILE: config.profileFile,
      },
    },
  );
}
async function offlineMigration(config: HostConfig, candidate: string) {
  await exec(
    join(candidate, 'runtime/node/bin/node'),
    [join(candidate, 'dist/server/scripts/manage.js'), 'migrate', '--profile', config.profileFile!],
    {
      timeout: 60000,
      maxBuffer: 32768,
      env: {
        ...process.env,
        DATA_ROOT: '',
        KNOWLEDGE_ROOT: '',
        DOOKNOW_PROFILE: config.profileFile,
      },
    },
  );
}
function maintenance(config: HostConfig, active: boolean) {
  const db = openDatabase(config.dataRoot);
  try {
    db.prepare('UPDATE maintenance SET active=? WHERE id=1').run(active ? 1 : 0);
  } finally {
    db.close();
  }
}
async function snapshotDB(config: HostConfig, path: string, keyFile: string) {
  const plain = path + '.plain-' + randomUUID(),
    db = openDatabase(config.dataRoot);
  try {
    await db.backup(plain);
    const file = await open(plain, 'r');
    let size;
    try {
      size = (await file.stat()).size;
    } finally {
      await file.close();
    }
    await sealBackup(plain, path, keyFile, size);
  } finally {
    db.close();
    await rm(plain, { force: true });
  }
}
async function replaceDB(config: HostConfig, snapshot: string, keyFile: string) {
  const { activeDatabaseProcesses, readInstance } = await import('./instance.js');
  if (readInstance(config.dataRoot) || activeDatabaseProcesses(config.dataRoot).length)
    throw Error('数据库仍在使用，拒绝恢复快照');
  const target = join(config.dataRoot, 'app.sqlite');
  await unsealBackup(snapshot, target + '.restore', keyFile);
  await rm(target + '-wal', { force: true });
  await rm(target + '-shm', { force: true });
  await rename(target + '.restore', target);
}
async function switchRelease(config: HostConfig, candidate: string) {
  await setCurrent(config.installRoot!, basename(candidate));
  if (config.serviceManaged !== false)
    writeService(config, candidate, join(candidate, 'runtime/node/bin/node'));
}
async function startHealthy(config: HostConfig, candidate: string, wasActive: boolean) {
  if (wasActive) {
    systemctl(['start', unitName(config)]);
    await waitHealthy(config, releaseInfo(candidate).version);
  }
}
async function recoverTransaction(config: HostConfig) {
  const journal = join(config.installRoot!, 'update-transaction.json');
  if (!existsSync(journal)) return;
  const state = JSON.parse(await readFile(journal, 'utf8'));
  if (['complete', 'recovered'].includes(state.phase)) return;
  if (state.phase === 'quiescing') {
    if (
      !state.previous ||
      basename(await realpath(join(config.installRoot!, 'current'))) !== state.previous
    )
      throw Error('停写记录与当前版本不一致，请先核对');
    if (serviceActive(config)) systemctl(['stop', unitName(config)]);
    maintenance(config, false);
    if (state.wasActive) {
      systemctl(['start', unitName(config)]);
      await waitHealthy(config, state.previous);
    }
    await durableJson(journal, { ...state, phase: 'recovered' });
    return;
  }
  if (!state.previous || !state.snapshot) throw Error('升级记录不完整，请使用备份恢复');
  if (state.phase === 'accepted') {
    await durableJson(join(config.installRoot!, 'installation.json'), {
      current: state.candidate,
      previous: state.previous,
      databaseCompatibility: releaseInfo(join(config.installRoot!, 'releases', state.candidate))
        .databaseCompatibility,
    });
    maintenance(config, false);
    await durableJson(journal, { ...state, phase: 'complete' });
    return;
  }
  if (serviceActive(config)) systemctl(['stop', unitName(config)]);
  await replaceDB(config, state.snapshot, state.keyFile);
  await switchRelease(config, join(config.installRoot!, 'releases', state.previous));
  maintenance(config, false);
  if (state.wasActive) {
    systemctl(['start', unitName(config)]);
    await waitHealthy(config, state.previous);
  }
  await durableJson(journal, { ...state, phase: 'recovered' });
}
export async function updatePlatform(
  config: HostConfig,
  options: { source?: string; version?: string } = {},
) {
  if (!config.installRoot || !config.profileFile) throw Error('升级需要原生安装目录和配置文件');
  return managementLock(config, async () => {
    await recoverTransaction(config);
    const root = resolve(config.installRoot!),
      current = await realpath(join(root, 'current')),
      old = releaseInfo(current),
      source = sourceURL(options.source || old.source || '');
    if (options.version && !/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(options.version))
      throw Error('发行版本不正确');
    const work = await mkdtemp(join(root, '.update-'));
    try {
      const metadata = join(work, 'release.json');
      await download(
        new URL(options.version ? 'release-' + options.version + '.json' : 'release.json', source),
        metadata,
        65536,
      );
      const info = JSON.parse(await readFile(metadata, 'utf8'));
      if (
        !/^[0-9][a-zA-Z0-9.+-]{0,79}$/.test(info.version) ||
        info.file !== `dooknow-${info.version}-linux-x64.tar.gz` ||
        !/^[a-f0-9]{64}$/.test(info.sha256) ||
        info.platform !== 'linux-x64' ||
        !Number.isInteger(info.databaseCompatibility) ||
        (options.version && info.version !== options.version)
      )
        throw Error('发行元数据不正确');
      if (info.version === old.version) return { version: old.version, unchanged: true };
      const archive = join(work, 'application.tar.gz');
      await download(new URL(info.file, source), archive, 2 * 1024 ** 3);
      if ((await digest(archive)) !== info.sha256) throw Error('发行包校验失败');
      const candidate = join(root, 'releases', info.version);
      if (existsSync(candidate)) {
        if ((await readFile(join(candidate, 'package.sha256'), 'utf8')).trim() !== info.sha256)
          throw Error('同版本发行内容不同');
      } else {
        const unpack = join(work, 'application');
        await mkdir(unpack);
        await extractArchive(archive, unpack);
        const inside = releaseInfo(unpack);
        if (
          inside.version !== info.version ||
          inside.databaseCompatibility !== info.databaseCompatibility
        )
          throw Error('发行内容与清单不一致');
        await writeFile(join(unpack, 'package.sha256'), info.sha256 + '\n', { mode: 0o600 });
        await rename(unpack, candidate);
      }
      const clone = join(work, 'check');
      await mkdir(clone);
      await candidateCheck(config, candidate, clone);
      const wasActive = serviceActive(config),
        stamp = Date.now(),
        backupFile = join(root, 'backups', `before-${info.version}-${stamp}.dooknow`),
        snapshot = join(root, 'backups', `before-${info.version}-${stamp}.sqlite.dooknow`),
        journal = join(root, 'update-transaction.json');
      await durableJson(journal, {
        previous: old.version,
        candidate: info.version,
        wasActive,
        phase: 'quiescing',
      });
      let accepted = false;
      try {
        return await withQuiesced(
          config,
          async () => {
            const sealed = await createPlatformBackup(config, { destination: backupFile });
            await snapshotDB(config, snapshot, sealed.keyFile);
            const state = {
              previous: old.version,
              candidate: info.version,
              snapshot,
              backupFile,
              keyFile: sealed.keyFile,
              wasActive,
              phase: 'prepared',
            };
            await durableJson(journal, state);
            await offlineMigration(config, candidate);
            await durableJson(journal, { ...state, phase: 'migrated' });
            await switchRelease(config, candidate);
            await durableJson(journal, { ...state, phase: 'switched' });
            await startHealthy(config, candidate, wasActive);
            // Durable acceptance is the point after which automatic data restore is forbidden.
            await durableJson(journal, { ...state, phase: 'accepted' });
            accepted = true;
            maintenance(config, false);
            await durableJson(join(root, 'installation.json'), {
              current: info.version,
              previous: old.version,
              databaseCompatibility: info.databaseCompatibility,
              updatedAt: new Date().toISOString(),
            });
            await durableJson(journal, { ...state, phase: 'complete' });
            return {
              version: info.version,
              previous: old.version,
              backup: sealed.file,
              keyFile: sealed.keyFile,
              serviceStarted: wasActive,
            };
          },
          { resume: false, keepMaintenanceOnError: true },
        );
      } catch (error) {
        if (accepted)
          throw Error(
            '新版本已通过检查并接管数据，收尾未完成；不能自动恢复旧数据：' +
              (error as Error).message,
          );
        try {
          await recoverTransaction(config);
          if (wasActive && !serviceActive(config)) {
            maintenance(config, false);
            systemctl(['start', unitName(config)]);
            await waitHealthy(config, old.version);
          }
        } catch (recovery) {
          throw Error('升级失败且自动恢复未完成，维护状态已保留：' + (recovery as Error).message);
        }
        throw Error('升级失败，已恢复上一版本及切换前数据库：' + (error as Error).message);
      }
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}
export async function rollbackPlatform(config: HostConfig) {
  if (!config.installRoot) throw Error('回滚需要原生安装目录');
  const root = resolve(config.installRoot),
    installation = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8'));
  const current = await realpath(join(root, 'current')),
    previous = join(root, 'releases', installation.previous || '');
  if (
    !installation.previous ||
    releaseInfo(current).databaseCompatibility !== releaseInfo(previous).databaseCompatibility
  )
    throw Error('此迁移不支持普通代码回退；请使用明确的数据恢复流程，保留最新原文');
  return managementLock(config, async () => {
    const wasActive = serviceActive(config);
    return withQuiesced(
      config,
      async () => {
        const clone = await mkdtemp(join(root, '.rollback-check-'));
        try {
          await candidateCheck(config, previous, clone);
        } finally {
          await rm(clone, { recursive: true, force: true });
        }
        try {
          await switchRelease(config, previous);
          await startHealthy(config, previous, wasActive);
        } catch (e) {
          if (wasActive) systemctl(['stop', unitName(config)]);
          await switchRelease(config, current);
          await startHealthy(config, current, wasActive);
          throw e;
        }
        await durableJson(join(root, 'installation.json'), {
          ...installation,
          current: releaseInfo(previous).version,
          previous: releaseInfo(current).version,
        });
        return { version: releaseInfo(previous).version, dataPreserved: true };
      },
      { resume: false },
    );
  });
}
