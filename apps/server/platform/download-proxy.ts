import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const maxBytes = 16384;
const keys = ['HTTP_PROXY', 'HTTPS_PROXY'] as const;
const readFailure =
  '保存的下载代理设置无法安全读取；请显式设置 HTTP_PROXY / HTTPS_PROXY，或设置 DOOKNOW_NO_SAVED_PROXY=1 后重试。';
type ProxyEnvironment = Partial<Record<'HTTP_PROXY' | 'HTTPS_PROXY' | 'NO_PROXY', string>>;

function explicitProxy(env: NodeJS.ProcessEnv) {
  return keys.some((key) => env[key]?.trim() || env[key.toLowerCase()]?.trim());
}

function proxyURL(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n]/.test(value))
    throw Error();
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.hash ||
    url.search ||
    url.pathname !== '/'
  )
    throw Error();
  return url;
}

function assertPrivateFile(fd: number) {
  const info = fstatSync(fd);
  if (
    !info.isFile() ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > maxBytes
  )
    throw Error();
}

function openPrivate(file: string) {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    assertPrivateFile(fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Only update may use these values as a fallback; explicit process settings win. */
export function loadDownloadProxy(
  profileFile: string,
  env: NodeJS.ProcessEnv = process.env,
): ProxyEnvironment | undefined {
  if (env.DOOKNOW_NO_SAVED_PROXY === '1' || explicitProxy(env)) return;
  let fd: number | undefined;
  try {
    fd = openPrivate(resolve(profileFile) + '.download-proxy.json');
    if (fd === undefined) return;
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0,
      count: number;
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)))
      size += count;
    if (size > maxBytes) throw Error();
    assertPrivateFile(fd);
    const saved = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (
      !saved ||
      saved.version !== 1 ||
      saved.profileFile !== resolve(profileFile) ||
      Object.keys(saved).some((key) => !['version', 'profileFile', 'proxy'].includes(key)) ||
      !saved.proxy ||
      typeof saved.proxy !== 'object' ||
      Array.isArray(saved.proxy) ||
      Object.keys(saved.proxy).some((key) => ![...keys, 'NO_PROXY'].includes(key as any))
    )
      throw Error();
    const result: ProxyEnvironment = {};
    for (const key of keys) {
      if (saved.proxy[key] === undefined) continue;
      const url = proxyURL(saved.proxy[key]);
      if (url.username || url.password) throw Error();
      result[key] = saved.proxy[key];
    }
    if (!result.HTTP_PROXY && !result.HTTPS_PROXY) throw Error();
    if (saved.proxy.NO_PROXY !== undefined) {
      if (
        typeof saved.proxy.NO_PROXY !== 'string' ||
        saved.proxy.NO_PROXY.length > 8192 ||
        /[\r\n]/.test(saved.proxy.NO_PROXY)
      )
        throw Error();
      if (env.NO_PROXY === undefined && env.no_proxy === undefined)
        result.NO_PROXY = saved.proxy.NO_PROXY;
    }
    return result;
  } catch {
    throw Error(readFailure);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Remember only non-authenticated HTTP(S) proxies beside this instance's profile. */
export function rememberDownloadProxy(profileFile: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.DOOKNOW_NO_SAVED_PROXY === '1') return false;
  const proxy: ProxyEnvironment = {};
  try {
    for (const key of keys) {
      const value = env[key.toLowerCase()]?.trim() || env[key]?.trim();
      if (!value) continue;
      const url = proxyURL(value);
      if (url.username || url.password) return false;
      proxy[key] = value;
    }
    if (!proxy.HTTP_PROXY && !proxy.HTTPS_PROXY) return false;
    const noProxy = (env.no_proxy?.trim() || env.NO_PROXY?.trim()) ?? env.no_proxy?.trim();
    if (noProxy !== undefined) {
      if (noProxy.length > 8192 || /[\r\n]/.test(noProxy)) throw Error();
      proxy.NO_PROXY = noProxy;
    }
    const file = resolve(profileFile) + '.download-proxy.json';
    const data = JSON.stringify({ version: 1, profileFile: resolve(profileFile), proxy }) + '\n';
    if (Buffer.byteLength(data) > maxBytes) throw Error();
    const existing = openPrivate(file);
    if (existing !== undefined) closeSync(existing);
    const temporary = file + '.' + randomUUID() + '.tmp';
    let fd: number | undefined;
    try {
      fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, data);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, file);
      const directory = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try {
        unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return true;
  } catch {
    throw Error('无法保存下载代理设置。');
  }
}
