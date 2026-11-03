import { assertRoot } from '../packages/core/indexing/reconcile.js';
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { openDatabase } from '../packages/core/db.js';
import {
  planStorageDirectoryMigration,
  applyStorageDirectoryMigration,
  type StorageDirectoryMigrationPlan,
} from '../packages/core/storage-directory-migration.js';
import { createPlatformBackup } from '../apps/server/platform/backups.js';
import { loadHostConfig } from '../apps/server/platform/config.js';
import { activeDatabaseProcesses, readInstance } from '../apps/server/platform/instance.js';

const { values } = parseArgs({
  options: {
    'knowledge-root': { type: 'string' },
    'data-root': { type: 'string' },
    plan: { type: 'string' },
    apply: { type: 'string' },
    backup: { type: 'string' },
    profile: { type: 'string' },
  },
});
if (
  !values['knowledge-root'] ||
  !values['data-root'] ||
  (!values.plan && !values.apply) ||
  (values.plan && values.apply)
)
  throw Error(
    '用法：--knowledge-root <知识库> --data-root <运行数据> --plan <计划文件>，或 --apply <计划文件> --backup <独立备份目录>；应用前必须停止服务',
  );
const config = {
  knowledgeRoot: resolve(values['knowledge-root']),
  dataRoot: resolve(values['data-root']),
  origin: 'http://localhost',
  secret: 'offline-storage-migration',
};
if (values.plan) {
  const db = new Database(join(config.dataRoot, 'app.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const plan = planStorageDirectoryMigration(config, db);
    const path = resolve(values.plan);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      JSON.stringify({
        plan: path,
        assets: plan.assets.length,
        documents: plan.edits.length,
        preserved: plan.preserved.length,
        legacyData: plan.dataDirectory === '_data',
      }),
    );
  } finally {
    db.close();
  }
} else {
  if (!values.backup || !values.profile)
    throw Error('应用迁移必须提供 --profile 配置文件及 --backup 加密备份文件');
  if (
    readInstance(config.dataRoot) ||
    activeDatabaseProcesses(config.dataRoot).some(
      (process) => process.pid !== globalThis.process.pid,
    )
  )
    throw Error('应用迁移前必须停止所有服务和数据进程');
  const plan = JSON.parse(
    await readFile(resolve(values.apply!), 'utf8'),
  ) as StorageDirectoryMigrationPlan;
  if (plan.knowledgeRoot !== config.knowledgeRoot) throw Error('计划不属于当前知识库');
  const destination = resolve(values.backup);
  const host = loadHostConfig({ profileFile: resolve(values.profile) });
  if (resolve(host.dataRoot) !== config.dataRoot) throw Error('配置文件与运行数据目录不一致');
  const inspection = new Database(join(config.dataRoot, 'app.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const bound = inspection
      .prepare('SELECT knowledge_root FROM platform_settings WHERE id=1')
      .get() as { knowledge_root: string } | undefined;
    if (!bound || resolve(bound.knowledge_root) !== config.knowledgeRoot)
      throw Error('备份绑定的知识库与迁移目录不一致');
    assertRoot(config, inspection);
  } finally {
    inspection.close();
  }
  const saved = await createPlatformBackup(host, { destination });
  console.log(JSON.stringify({ backup: saved.file, keyFile: saved.keyFile }));
  const db = openDatabase(config.dataRoot, 'utility');
  try {
    console.log(JSON.stringify(await applyStorageDirectoryMigration(config, db, plan)));
  } finally {
    db.close();
  }
}
