import { parseArgs } from 'node:util';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import { renameRootInPlace, rootBusinessDigest } from '../apps/server/platform/root-migration.js';
import type { AppDatabase } from '../packages/core/db.js';
const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    'env-file': { type: 'string' },
    journal: { type: 'string' },
    'verify-module': { type: 'string' },
    'require-stopped': { type: 'string', multiple: true },
  },
});
function writePrivate(file: string, data: string | Buffer) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
  const directory = openSync(dirname(file), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
async function main() {
  if (
    !values.from ||
    !values.to ||
    !values['env-file'] ||
    !values.journal ||
    !values['require-stopped']?.length
  )
    throw Error(
      '需要 --from、--to、--env-file、--journal 与每个 --require-stopped 用户服务；先完成停写一致性加密备份',
    );
  const envFile = resolve(values['env-file']),
    journal = resolve(values.journal),
    oldRoot = resolve(values.from),
    newRoot = resolve(values.to);
  if (existsSync(journal)) throw Error('迁移日志已存在，请先核对上次结果');
  const info = lstatSync(envFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.mode & 0o077)
    throw Error('配置须为权限600的独立普通文件');
  const original = readFileSync(envFile),
    env = parse(original);
  if (env.KNOWLEDGE_ROOT !== oldRoot || !env.DATA_ROOT?.startsWith('/'))
    throw Error('配置中的原路径或数据目录与迁移不一致');
  const lines = original.toString('utf8').split('\n'),
    matches = lines.filter((line) => /^KNOWLEDGE_ROOT=/.test(line));
  if (matches.length !== 1) throw Error('原文路径必须恰好配置一次');
  const updated = Buffer.from(
    lines
      .map((line) =>
        /^KNOWLEDGE_ROOT=/.test(line) ? 'KNOWLEDGE_ROOT=' + JSON.stringify(newRoot) : line,
      )
      .join('\n'),
  );
  for (const unit of values['require-stopped']) {
    if (!/^[A-Za-z0-9_.@-]+\.service$/.test(unit)) throw Error('服务名称不正确');
    const state = execFileSync(
      'systemctl',
      ['--user', 'show', unit, '--property=ActiveState', '--value'],
      { encoding: 'utf8' },
    ).trim();
    if (!['inactive', 'failed'].includes(state)) throw Error('迁移前必须停止服务：' + unit);
  }
  const db = new Database(join(env.DATA_ROOT, 'app.sqlite'), {
    fileMustExist: true,
  }) as AppDatabase;
  const previous = (
    db.prepare("SELECT value FROM index_meta WHERE key='root_identity'").get() as any
  )?.value;
  const record = {
    version: 1,
    phase: 'prepared',
    oldRoot,
    newRoot,
    dataRoot: env.DATA_ROOT,
    envFile,
    previousIdentity: previous,
    units: values['require-stopped'],
    businessDigest: rootBusinessDigest(db),
  };
  try {
    writePrivate(journal, JSON.stringify(record, null, 2) + '\n');
    const verify = values['verify-module']
      ? (await import(pathToFileURL(resolve(values['verify-module'])).href)).assertRoot
      : undefined;
    if (values['verify-module'] && typeof verify !== 'function')
      throw Error('固定发布校验模块未提供 assertRoot');
    const result = renameRootInPlace(db, {
      oldRoot,
      newRoot,
      expectedIdentity: previous,
      configuration: {
        apply() {
          if (!readFileSync(envFile).equals(original)) throw Error('配置已被外部修改');
          writePrivate(envFile, updated);
        },
        rollback() {
          const current = readFileSync(envFile);
          if (current.equals(original)) return;
          if (!current.equals(updated)) throw Error('配置出现未知变化，请核对迁移日志');
          writePrivate(envFile, original);
        },
      },
      ...(verify
        ? {
            verify: (root: string, connection: AppDatabase) =>
              verify({ knowledgeRoot: root, dataRoot: env.DATA_ROOT }, connection),
          }
        : {}),
    });
    writePrivate(
      journal,
      JSON.stringify(
        { ...record, phase: 'complete', result, completedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    writePrivate(
      journal,
      JSON.stringify(
        { ...record, phase: 'needs_verification', checkedAt: new Date().toISOString() },
        null,
        2,
      ) + '\n',
    );
    throw error;
  } finally {
    db.close();
  }
}
main().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
