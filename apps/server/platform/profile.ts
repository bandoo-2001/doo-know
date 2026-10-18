import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  linkSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export function boundProfile(installRoot: string) {
  const file = join(resolve(installRoot), 'profile.path');
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384)
    throw Error('安装目录的配置归属记录不可安全读取');
  const profile = readFileSync(file, 'utf8').replace(/\n$/, '');
  if (!isAbsolute(profile)) throw Error('安装目录的配置归属记录无效');
  return profile;
}

export function resolveProfileFile(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { installRoot?: string; allowCreate?: boolean } = {},
) {
  const installRoot = options.installRoot || env.DOOKNOW_INSTALL_ROOT;
  const bound = installRoot ? boundProfile(installRoot) : undefined;
  function required(path: string, allowCreate = false) {
    const selected = resolve(path);
    if (!existsSync(selected) && !allowCreate)
      throw Error('配置文件不存在，请恢复原配置；已停止操作，不会使用其他实例的数据或密钥');
    return selected;
  }
  if (explicit || env.DOOKNOW_PROFILE) {
    const selected = resolve(explicit || env.DOOKNOW_PROFILE!);
    return required(selected, !!options.allowCreate && selected !== bound);
  }
  if (bound) return required(bound);
  const fallback = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'doo-know/profile.json');
  if (!installRoot || options.allowCreate) return resolve(fallback);
  if (existsSync(fallback)) {
    const profile = JSON.parse(readFileSync(fallback, 'utf8'));
    if (profile.installRoot && resolve(profile.installRoot) === resolve(installRoot))
      return resolve(fallback);
  }
  throw Error('安装目录尚未绑定配置，请显式指定 --profile <原配置文件>；不会自动选择其他实例');
}

/** The legacy updater already passes its loaded profile to the new candidate's migrate command. */
export function bindInstallationProfile(installRoot: string, profileFile: string) {
  const existing = boundProfile(installRoot),
    profile = resolve(profileFile);
  if (existing && existing !== profile) throw Error('此安装目录已绑定另一配置');
  if (existing) return;
  mkdirSync(installRoot, { recursive: true, mode: 0o700 });
  const file = join(installRoot, 'profile.path'),
    temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, profile + '\n', { mode: 0o600, flag: 'wx' });
  try {
    try {
      linkSync(temporary, file);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        boundProfile(installRoot) !== profile
      )
        throw error;
    }
  } finally {
    unlinkSync(temporary);
  }
}
