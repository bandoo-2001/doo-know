import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, realpath, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { applicationRoot } from './config.js';
import { boundProfile } from './profile.js';
import { releaseInfo } from './release.js';

const exec = promisify(execFile);
const legacyTail = 'release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"\nexec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"\n';
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function recoveryTail(root: string, managerVersion: string) {
  // Keep the value-taking options aligned with scripts/manage.ts. Parse only to
  // choose the executable; the manager still receives and validates every argument.
  return `# DooKnow recovery manager: ${managerVersion}
release_root="$(readlink -f "$DOOKNOW_INSTALL_ROOT/current")"
dooknow_command=''
dooknow_skip=0
for dooknow_arg in "$@"; do
  if [ "$dooknow_skip" = 1 ]; then dooknow_skip=0; continue; fi
  if [ "$dooknow_skip" = 2 ]; then dooknow_command="$dooknow_arg"; break; fi
  case "$dooknow_arg" in
    --profile|--data-root|--origin|--port|--host|--allow-root|--destination|--source|--version|--knowledge-root|--key-file|--plugin-root|--service-name|--install-root|--auth-secret-file|--github-repository|--github-token-file) dooknow_skip=1 ;;
    --*=*|--help|--no-service) ;;
    --) dooknow_skip=2 ;;
    *) dooknow_command="$dooknow_arg"; break ;;
  esac
done
case "$dooknow_command" in
  update|rollback)
    if "$release_root/runtime/node/bin/node" -e 'const fs=require("node:fs");let pending=true;try{const state=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));pending=!state||!["complete","recovered"].includes(state.phase)}catch(error){pending=error.code!=="ENOENT"}process.exit(pending?0:1)' "$DOOKNOW_INSTALL_ROOT/update-transaction.json"; then
      release_root=${shellQuote(join(root, 'releases', managerVersion))}
    fi ;;
esac
exec "$release_root/runtime/node/bin/node" "$release_root/dist/server/scripts/manage.js" "$@"
`;
}

/** Upgrade only an installer-owned native entrypoint, before any service disruption. */
export async function prepareRecoveryLauncher(config: HostConfig) {
  const root = resolve(config.installRoot!), owner = boundProfile(root), manager = resolve(applicationRoot());
  if (!owner) {
    // Source/API fixtures have no installed entrypoint. An actual native CLI is
    // identifiable from its installer environment and must never silently bypass this check.
    if (process.env.DOOKNOW_BIN_DIR || process.env.DOOKNOW_INSTALL_ROOT === root ||
        dirname(manager) === join(root, 'releases'))
      throw Error('管理命令入口缺少安装归属记录；已保留当前服务，请核对安装');
    return;
  }
  const refuse = () => Error('管理命令入口无法安全更新；已保留当前服务，请核对安装归属和完整性');
  if (!config.profileFile || owner !== resolve(config.profileFile)) throw refuse();
  const bin = resolve(process.env.DOOKNOW_BIN_DIR || join(homedir(), '.local/bin')),
    launcher = join(bin, 'dooknow'),
    configHome = resolve(process.env.XDG_CONFIG_HOME || join(homedir(), '.config')),
    version = basename(manager),
    uid = process.getuid?.();
  if ([root, owner, bin, configHome].some(value => /[\x00-\x1f]/.test(value))) throw refuse();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,79}$/.test(version) ||
      manager !== join(root, 'releases', version) || await realpath(manager) !== manager ||
      releaseInfo(manager).version !== version) throw refuse();
  for (const directory of [root, bin, manager]) {
    const info = await lstat(directory);
    // Existing installers support the user's primary-group writable bin (775).
    // Keep release storage stricter; never accept a world-writable command directory.
    const unsafeWrite = directory === bin
      ? (info.mode & 0o002) || ((info.mode & 0o020) && info.gid !== process.getgid?.())
      : info.mode & 0o022;
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || unsafeWrite ||
        await realpath(directory) !== directory) throw refuse();
  }
  for (const file of ['package.sha256', 'runtime/node/bin/node', 'dist/server/scripts/manage.js']) {
    const info = await lstat(join(manager, file));
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022)) throw refuse();
  }
  if (!/^[a-f0-9]{64}\n?$/.test(await readFile(join(manager, 'package.sha256'), 'utf8'))) throw refuse();
  const before = await lstat(launcher);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid ||
      (before.mode & 0o022) || before.size > 16384) throw refuse();
  const original = await readFile(launcher, 'utf8'),
    id = createHash('sha256').update(root).digest('hex');
  // Bash's own %q reproduces the existing installer's bytes even for spaces and
  // quotes. No launcher content is evaluated, sourced or used as a command.
  const { stdout: header } = await exec('/bin/bash', ['-c',
    `printf '#!/usr/bin/env bash\\n# DooKnow install: %s\\nset -euo pipefail\\nexport DOOKNOW_INSTALL_ROOT=%q\\n' "$1" "$2"; printf 'export DOOKNOW_PROFILE=%q\\nexport XDG_CONFIG_HOME=%q\\nexport DOOKNOW_BIN_DIR=%q\\n' "$3" "$4" "$5"`,
    'dooknow', id, root, owner, configHome, bin]);
  const previousVersion = original.match(/^# DooKnow recovery manager: ([0-9A-Za-z][0-9A-Za-z.+-]{0,79})$/m)?.[1];
  if (original !== header + legacyTail &&
      (!previousVersion || original !== header + recoveryTail(root, previousVersion))) throw refuse();
  const next = header + recoveryTail(root, version);
  if (original === next) return;
  const temporary = launcher + '.' + randomUUID() + '.tmp';
  try {
    const file = await open(temporary, 'wx', 0o700);
    try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
    const current = await lstat(launcher);
    if (current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 ||
        await readFile(launcher, 'utf8') !== original) throw refuse();
    await rename(temporary, launcher);
    const directory = await open(dirname(launcher), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
