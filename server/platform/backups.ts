import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  readdir,
  lstat,
  rename,
  statfs,
  realpath,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { create as createTar } from 'tar';
import type { HostConfig } from '../../shared/platform-contracts.js';
import { openDatabase } from '../db.js';
import { backup, restore, checksums, inventory, independent, emptyTarget } from '../backup.js';
import { platformSettings } from './settings.js';
import { workspaceExclusive } from '../workspace/gate.js';
import { sealBackup, unsealBackup } from './sealed-backup.js';
import { validateArchive, extractArchive } from './archive.js';
import { resetRestoredState } from './restore-state.js';
async function copyIfPresent(source: string, target: string) {
  let info;
  try {
    info = await lstat(source);
  } catch (e) {
    if ((e as any).code === 'ENOENT') return;
    throw e;
  }
  if (info.isDirectory() && existsSync(target)) {
    for (const name of await readdir(source))
      await cp(join(source, name), join(target, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        dereference: false,
      });
  } else
    await cp(source, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
}
async function safeTarget(path: string) {
  let current = resolve(path);
  for (;;) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw Error('恢复目标及父目录必须为真实目录');
    } catch (e) {
      if ((e as any).code !== 'ENOENT') throw e;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function createPlatformBackup(
  config: HostConfig,
  options: { destination: string; keyFile?: string },
) {
  const destination = resolve(options.destination),
    keyFile = resolve(
      options.keyFile ||
        join(
          config.profileFile ? dirname(config.profileFile) : dirname(config.dataRoot),
          'secrets/backup-key.pem',
        ),
    );
  independent(destination, config.dataRoot);
  independent(keyFile, destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) throw Error('备份文件已存在，拒绝覆盖');
  const stage = await mkdtemp(join(dirname(destination), '.backup-')),
    db = openDatabase(config.dataRoot);
  try {
    return await workspaceExclusive(db, { kind: 'platform.backup' }, async () => {
      const business = platformSettings(config, db).configured();
      if (business) independent(destination, business.knowledgeRoot);
      const empty = join(stage, 'empty');
      await mkdir(empty);
      const snapshot = join(stage, 'snapshot');
      await backup({ ...config, knowledgeRoot: business?.knowledgeRoot || empty }, snapshot);
      const pluginRoot = config.pluginRoot || join(config.dataRoot, '..', 'plugins');
      await copyIfPresent(pluginRoot, join(snapshot, 'plugin-packages'));
      await copyIfPresent(join(config.dataRoot, 'plugins'), join(snapshot, 'data/plugins'));
      const secrets = join(snapshot, 'secrets');
      await mkdir(secrets, { mode: 0o700 });
      await writeFile(join(secrets, 'auth.key'), config.secret, { mode: 0o600 });
      const originalSecrets = config.secretFile
        ? dirname(config.secretFile)
        : join(config.dataRoot, 'secrets');
      await copyIfPresent(join(originalSecrets, 'plugins'), join(secrets, 'plugins'));
      await copyIfPresent(join(originalSecrets, 'vector.key'), join(secrets, 'vector.key'));
      const rawProfile =
        config.profileFile && existsSync(config.profileFile)
          ? JSON.parse(await readFile(config.profileFile, 'utf8'))
          : {};
      // Only portable configuration is re-applied. Executable/source/runtime paths are
      // selected by the installed release and the explicit restore targets.
      const portable = {
        origin: config.origin,
        port: config.port || 5173,
        host: config.host || '127.0.0.1',
        indexing: config.indexing,
        fileTasks: config.fileTasks,
        allowedKnowledgeBases: rawProfile.allowedKnowledgeBases,
      };
      await writeFile(
        join(snapshot, 'platform-backup.json'),
        JSON.stringify(
          { version: 1, bound: !!business, createdAt: new Date().toISOString(), portable },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      );
      const files = await checksums(snapshot);
      delete files['manifest.json'];
      await writeFile(
        join(snapshot, 'manifest.json'),
        JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2) + '\n',
        { mode: 0o600 },
      );
      const archive = join(stage, 'snapshot.tar.gz');
      await createTar({ cwd: snapshot, file: archive, gzip: true, portable: true, noMtime: true }, [
        '.',
      ]);
      const stats = await validateArchive(archive, {
          maxBytes: Number.MAX_SAFE_INTEGER,
          maxEntries: 500000,
        }),
        partial = destination + '.part-' + randomUUID();
      try {
        const key = await sealBackup(archive, partial, keyFile, stats.bytes);
        await rename(partial, destination);
        const directory = await import('node:fs/promises').then((fs) =>
          fs.open(dirname(destination), 'r'),
        );
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return {
          file: destination,
          keyFile: key.keyFile,
          keyFingerprint: key.fingerprint,
          knowledgeIncluded: !!business,
          files: stats.files,
        };
      } finally {
        await rm(partial, { force: true });
      }
    });
  } finally {
    db.close();
    await rm(stage, { recursive: true, force: true });
  }
}
export async function restorePlatformBackup(options: {
  source: string;
  keyFile: string;
  target: { dataRoot: string; knowledgeRoot?: string; profileFile: string; pluginRoot?: string };
  origin?: string;
}) {
  const source = resolve(options.source),
    dataRoot = resolve(options.target.dataRoot),
    profileFile = resolve(options.target.profileFile),
    pluginRoot = resolve(options.target.pluginRoot || join(dataRoot, '..', 'plugins'));
  const knowledgeRoot = options.target.knowledgeRoot && resolve(options.target.knowledgeRoot),
    secretRoot = join(dirname(profileFile), 'secrets');
  for (const path of [
    dataRoot,
    pluginRoot,
    secretRoot,
    dirname(profileFile),
    ...(knowledgeRoot ? [knowledgeRoot] : []),
  ]) {
    await safeTarget(path);
    independent(source, path);
  }
  independent(dataRoot, pluginRoot);
  independent(dataRoot, dirname(profileFile));
  independent(pluginRoot, dirname(profileFile));
  if (knowledgeRoot) {
    independent(dataRoot, knowledgeRoot);
    independent(pluginRoot, knowledgeRoot);
    independent(dirname(profileFile), knowledgeRoot);
  }
  if (existsSync(profileFile)) throw Error('恢复目标配置已存在，拒绝覆盖');
  await mkdir(dirname(profileFile), { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(dirname(profileFile), '.restore-'));
  let receiptFile: string | undefined;
  try {
    const archive = join(stage, 'snapshot.tar.gz'),
      header = await unsealBackup(source, archive, resolve(options.keyFile));
    const disk = await statfs(stage);
    if (header.payloadBytes > disk.bavail * disk.bsize) throw Error('恢复空间或配额不足');
    const extracted = join(stage, 'snapshot');
    await mkdir(extracted, { mode: 0o700 });
    await extractArchive(archive, extracted, { maxBytes: header.payloadBytes, maxEntries: 500000 });
    const meta = JSON.parse(await readFile(join(extracted, 'platform-backup.json'), 'utf8'));
    if (meta.version !== 1 || typeof meta.bound !== 'boolean') throw Error('备份元数据不正确');
    if (meta.bound && !knowledgeRoot)
      throw Error('此备份包含知识库，必须指定新的空目录 --knowledge-root');
    for (const path of [
      dataRoot,
      pluginRoot,
      secretRoot,
      ...(knowledgeRoot ? [knowledgeRoot] : []),
    ])
      await emptyTarget(path);
    receiptFile = join(dirname(profileFile), 'restore-' + randomUUID() + '.json');
    await writeFile(
      receiptFile,
      JSON.stringify(
        { phase: 'copying', source, dataRoot, pluginRoot, secretRoot, knowledgeRoot, profileFile },
        null,
        2,
      ) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    const root = knowledgeRoot || join(stage, 'rootless');
    const secret = await readFile(join(extracted, 'secrets/auth.key'), 'utf8');
    await restore(extracted, { ...meta.portable, dataRoot, knowledgeRoot: root, secret });
    await copyIfPresent(join(extracted, 'plugin-packages'), pluginRoot);
    for (const entry of await readdir(join(extracted, 'secrets')))
      await cp(join(extracted, 'secrets', entry), join(secretRoot, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    const db = openDatabase(dataRoot);
    try {
      if (!meta.bound)
        db.transaction(() => {
          db.prepare('DELETE FROM platform_settings').run();
          db.prepare("DELETE FROM index_meta WHERE key='root_identity'").run();
        }).immediate();
    } finally {
      db.close();
    }
    const profile = {
      ...meta.portable,
      origin: options.origin || meta.portable.origin,
      dataRoot,
      pluginRoot,
      secretFile: join(secretRoot, 'auth.key'),
      serviceManaged: false,
    };
    await writeFile(profileFile, JSON.stringify(profile, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(
      receiptFile,
      JSON.stringify(
        {
          phase: 'complete',
          profileFile,
          dataRoot,
          knowledgeRoot,
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    return {
      profileFile,
      dataRoot,
      ...(knowledgeRoot ? { knowledgeRoot } : {}),
      pluginsDisabled: true,
      sessionsRevoked: true,
      sharesRevoked: true,
      searchNeedsPreparation: true,
      restoreReceipt: receiptFile,
    };
  } catch (error) {
    if (receiptFile) {
      await writeFile(
        receiptFile,
        JSON.stringify(
          {
            phase: 'incomplete',
            source,
            dataRoot,
            pluginRoot,
            secretRoot,
            knowledgeRoot,
            profileFile,
          },
          null,
          2,
        ) + '\n',
        { mode: 0o600 },
      ).catch(() => {});
      throw Error(
        '恢复尚未完成，目标中的资料已保留；请核对 ' + receiptFile + ' 后选择新的空目录重试。',
      );
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
