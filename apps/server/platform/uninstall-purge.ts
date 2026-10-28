import {
  constants,
  lstatSync,
  realpathSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  fstatSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, parse, sep } from 'node:path';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { HostConfig } from '../../../shared/platform-contracts.js';

const within = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
function info(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
// Resolve existing ancestors too, so absent children cannot conceal a linked parent.
function physical(path: string): string {
  const absolute = resolve(path);
  if (info(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(physical(parent), parse(absolute).base);
}
function unlinked(path: string) {
  for (let current = path; ; current = dirname(current)) {
    if (info(current)?.isSymbolicLink()) throw Error('清理目录或其父目录是符号链接，已停止卸载');
    if (dirname(current) === current) break;
  }
}
function checkBackups(path: string) {
  for (const name of readdirSync(path)) {
    const file = join(path, name),
      stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue; // Never follow venv links or external data links.
    if (name.toLowerCase() === 'backups' || /\.(dooknow(?:-backup)?|bak|backup)$/i.test(name))
      throw Error('清理目录包含备份，请先将备份移到保留目录后重试');
    if (stat.isDirectory()) checkBackups(file);
    else if (stat.isFile()) {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!fstatSync(fd).isFile()) throw Error('清理目录中的文件发生变化，已停止卸载');
        const header = Buffer.alloc(64);
        const bytes = readSync(fd, header, 0, header.length, 0);
        if (bytes >= 10 && header.subarray(0, 10).toString() === 'DOOKNOWBK1')
          throw Error('清理目录包含加密备份，请先将备份移到保留目录后重试');
        if (
          /^-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(header.subarray(0, bytes).toString())
        )
          throw Error('清理目录包含私钥，请先将私钥移到保留目录后重试');
      } finally {
        closeSync(fd);
      }
    } else throw Error('清理目录包含特殊文件，已停止卸载');
  }
}
function knowledgeRoots(config: HostConfig) {
  const roots = config.knowledgeRoot ? [resolve(config.knowledgeRoot)] : [];
  const file = join(config.dataRoot, 'app.sqlite');
  if (info(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_settings'")
          .get()
      ) {
        const row = db.prepare('SELECT knowledge_root FROM platform_settings WHERE id=1').get() as
          | { knowledge_root: string }
          | undefined;
        if (row?.knowledge_root) roots.push(resolve(row.knowledge_root));
      }
    } finally {
      db.close();
    }
  }
  return roots;
}
function plan(config: HostConfig, env: NodeJS.ProcessEnv) {
  const targets = [
    ...new Set(
      [
        config.pluginRoot || join(config.dataRoot, '..', 'plugins'),
        config.searchRuntimeRoot || join(config.dataRoot, '..', 'runtimes'),
        config.searchModelsRoot || join(config.dataRoot, '..', 'models'),
        config.searchCacheRoot ||
          join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'doo-know/search'),
        join(config.dataRoot, 'indexes'),
      ].map((path) => resolve(path)),
    ),
  ];
  const trees = [
    ...knowledgeRoots(config),
    config.profileFile && join(dirname(config.profileFile), 'secrets'),
    join(config.dataRoot, 'backups'),
    config.installRoot && join(config.installRoot, 'backups'),
    config.modelDir,
    config.tokenizerPython,
  ].filter(Boolean) as string[];
  const anchors = [
    config.dataRoot,
    join(config.dataRoot, 'app.sqlite'),
    join(config.dataRoot, 'app.sqlite-wal'),
    join(config.dataRoot, 'app.sqlite-shm'),
    config.installRoot,
    homedir(),
    process.cwd(),
    config.profileFile,
    config.secretFile,
    config.distribution?.tokenFile,
    config.vectorServiceTokenFile,
    env.XDG_CACHE_HOME || join(homedir(), '.cache'),
    env.XDG_DATA_HOME || join(homedir(), '.local/share'),
    env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  ].filter(Boolean) as string[];
  const protectedPaths = (values: string[]) => values.flatMap((p) => [resolve(p), physical(p)]);
  const protectedTrees = protectedPaths(trees),
    protectedAnchors = protectedPaths(anchors);
  const check = (path: string, program = false) => {
    unlinked(path);
    if (
      path === parse(path).root ||
      /^\/(?:bin|sbin|usr(?:\/local)?|var(?:\/(?:lib|cache|tmp))?|tmp|etc|opt|home|root|srv(?:\/(?:data|stacks|backups|secrets))?|mnt|media|run|proc|sys|dev)$/.test(
        path,
      ) ||
      protectedTrees.some((p) => within(p, path) || within(path, p)) ||
      protectedAnchors.some((p) => within(p, path)) ||
      (!program &&
        config.applicationRoot &&
        (within(path, physical(config.applicationRoot)) ||
          within(physical(config.applicationRoot), path)))
    )
      throw Error('清理目录与原文、备份、配置或受保护目录重叠，已停止卸载');
    const stat = info(path);
    if (!stat) return;
    if (!stat.isDirectory() || stat.uid !== process.getuid?.())
      throw Error('清理目标不是当前用户的独立目录，已停止卸载');
    checkBackups(path);
    return { path, device: stat.dev, inode: stat.ino };
  };
  const roots = targets.map((path) => check(path)).filter((value) => value !== undefined);
  // Ordinary uninstall removes releases too; protect originals/backups there as well.
  const program = config.installRoot
    ? check(resolve(config.installRoot, 'releases'), true)
    : undefined;
  return { roots, program };
}

/** Preflight before stopping the service; revalidate all targets before any removal. */
export function prepareUninstallPurge(config: HostConfig, env: NodeJS.ProcessEnv = process.env) {
  const before = plan(config, env);
  return () => {
    const after = plan(config, env);
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw Error('清理目录身份发生变化，已停止卸载');
    // Remove nested targets first; shared/identical configured roots are deduplicated.
    for (const root of after.roots.sort((a, b) => b.path.length - a.path.length)) {
      unlinked(root.path);
      const stat = info(root.path);
      if (!stat || stat.dev !== root.device || stat.ino !== root.inode)
        throw Error('清理目录身份发生变化，已停止卸载');
      rmSync(root.path, { recursive: true });
    }
  };
}
