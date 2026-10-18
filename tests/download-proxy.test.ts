import { afterEach, expect, it, vi } from 'vitest';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadDownloadProxy,
  rememberDownloadProxy,
} from '../apps/server/platform/download-proxy.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-download-proxy-'));
  roots.push(root);
  return { root, profile: join(root, 'profile.json') };
}

it('remembers an instance proxy privately and restores it in a clean terminal', async () => {
  const { profile } = await fixture();
  expect(
    rememberDownloadProxy(profile, {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'localhost,127.0.0.1',
    }),
  ).toBe(true);
  const file = profile + '.download-proxy.json',
    info = lstatSync(file);
  expect(info.mode & 0o777).toBe(0o600);
  expect(info.uid).toBe(process.getuid?.());
  expect(info.nlink).toBe(1);
  expect(loadDownloadProxy(profile, {})).toEqual({
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: 'localhost,127.0.0.1',
  });
  expect(loadDownloadProxy(profile + '.other', {})).toBeUndefined();
});

it('does not replace explicit proxies or NO_PROXY and honors the opt-out', async () => {
  const { profile } = await fixture();
  rememberDownloadProxy(profile, { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' });
  expect(loadDownloadProxy(profile, { HTTPS_PROXY: 'http://other.invalid:7891' })).toBeUndefined();
  expect(loadDownloadProxy(profile, { https_proxy: 'http://other.invalid:7891' })).toBeUndefined();
  expect(loadDownloadProxy(profile, { NO_PROXY: '*' })).toEqual({
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  });
  expect(loadDownloadProxy(profile, { no_proxy: '' })).toEqual({
    HTTPS_PROXY: 'http://127.0.0.1:7890',
  });
  expect(loadDownloadProxy(profile, { DOOKNOW_NO_SAVED_PROXY: '1' })).toBeUndefined();
  expect(
    rememberDownloadProxy(profile, {
      HTTPS_PROXY: 'http://other.invalid:7891',
      DOOKNOW_NO_SAVED_PROXY: '1',
    }),
  ).toBe(false);
  expect(loadDownloadProxy(profile, {})).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7890' });
});

it('uses effective lowercase values, ignores empty shadows, and never persists authentication', async () => {
  const { profile } = await fixture();
  rememberDownloadProxy(profile, {
    HTTPS_PROXY: 'http://upper.invalid:7890',
    https_proxy: 'http://lower.invalid:7891',
    no_proxy: '',
    NO_PROXY: 'localhost',
  });
  expect(loadDownloadProxy(profile, {})).toEqual({
    HTTPS_PROXY: 'http://lower.invalid:7891',
    NO_PROXY: 'localhost',
  });
  const before = readFileSync(profile + '.download-proxy.json');
  expect(
    rememberDownloadProxy(profile, {
      HTTPS_PROXY: 'http://fixture-user:fixture-secret@auth.invalid:7890',
      HTTP_PROXY: 'http://plain.invalid:7890',
    }),
  ).toBe(false);
  expect(readFileSync(profile + '.download-proxy.json')).toEqual(before);
  expect(rememberDownloadProxy(profile, {})).toBe(false);
  expect(rememberDownloadProxy(profile, { ALL_PROXY: 'socks5://127.0.0.1:7890' })).toBe(false);
});

it.each([
  'symlink',
  'dangling-symlink',
  'hardlink',
  'public',
  'directory',
  'oversized',
  'corrupt',
  'foreign-profile',
  'userinfo',
  'unsupported-protocol',
  'unknown-key',
  'control-character',
])('rejects unsafe or damaged saved settings: %s', async (kind) => {
  const { root, profile } = await fixture();
  rememberDownloadProxy(profile, { HTTPS_PROXY: 'http://127.0.0.1:7890' });
  const file = profile + '.download-proxy.json';
  if (kind === 'symlink') {
    await rm(file);
    writeFileSync(join(root, 'outside'), '{}', { mode: 0o600 });
    symlinkSync(join(root, 'outside'), file);
  }
  if (kind === 'dangling-symlink') {
    await rm(file);
    symlinkSync(join(root, 'missing'), file);
  }
  if (kind === 'hardlink') linkSync(file, join(root, 'alias'));
  if (kind === 'public') chmodSync(file, 0o644);
  if (kind === 'directory') {
    await rm(file);
    mkdirSync(file);
  }
  if (kind === 'oversized') writeFileSync(file, ' '.repeat(16385));
  if (kind === 'corrupt') writeFileSync(file, '{fixture-secret');
  if (kind === 'foreign-profile') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.profileFile = profile + '.other';
    writeFileSync(file, JSON.stringify(data));
  }
  if (kind === 'userinfo') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.proxy.HTTPS_PROXY = 'http://fixture-user:fixture-secret@auth.invalid:7890';
    writeFileSync(file, JSON.stringify(data));
  }
  if (kind === 'unsupported-protocol') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.proxy.HTTPS_PROXY = 'socks5://127.0.0.1:7890';
    writeFileSync(file, JSON.stringify(data));
  }
  if (kind === 'unknown-key') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.proxy.NODE_OPTIONS = '--inspect';
    writeFileSync(file, JSON.stringify(data));
  }
  if (kind === 'control-character') {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.proxy.NO_PROXY = 'localhost\nfixture-secret';
    writeFileSync(file, JSON.stringify(data));
  }
  expect(() => loadDownloadProxy(profile, {})).toThrow(/保存.*代理|代理.*设置/);
  try {
    loadDownloadProxy(profile, {});
  } catch (error) {
    expect(String(error)).not.toMatch(/fixture-secret|auth\.invalid|outside/);
  }
  expect(
    loadDownloadProxy(profile, { HTTPS_PROXY: 'http://override.invalid:7891' }),
  ).toBeUndefined();
  expect(loadDownloadProxy(profile, { DOOKNOW_NO_SAVED_PROXY: '1' })).toBeUndefined();
});

it('does not follow or modify unsafe destination files while remembering a proxy', async () => {
  const { root, profile } = await fixture(),
    outside = join(root, 'outside');
  writeFileSync(outside, 'keep me', { mode: 0o600 });
  symlinkSync(outside, profile + '.download-proxy.json');
  expect(() => rememberDownloadProxy(profile, { HTTPS_PROXY: 'http://127.0.0.1:7890' })).toThrow(
    /保存.*代理|代理.*设置/,
  );
  expect(readFileSync(outside, 'utf8')).toBe('keep me');
});

it('replaces prior settings atomically with the new effective environment', async () => {
  const { profile } = await fixture();
  rememberDownloadProxy(profile, {
    HTTP_PROXY: 'http://old.invalid:7890',
    NO_PROXY: 'old.invalid',
  });
  rememberDownloadProxy(profile, { HTTPS_PROXY: 'https://new.invalid:7891' });
  expect(loadDownloadProxy(profile, {})).toEqual({ HTTPS_PROXY: 'https://new.invalid:7891' });
  expect(lstatSync(profile + '.download-proxy.json').mode & 0o777).toBe(0o600);
});

it('remembers an explicitly empty lowercase NO_PROXY instead of adding a default next time', async () => {
  const { profile } = await fixture();
  rememberDownloadProxy(profile, { HTTPS_PROXY: 'http://127.0.0.1:7890', no_proxy: '' });
  expect(loadDownloadProxy(profile, {})).toEqual({
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    NO_PROXY: '',
  });
});
