import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const filename = 'dooknow-0.0.1-linux-x64.tar.gz';
const checksum = '1'.repeat(64);

it('identifies environment, manifest, download and checksum failures before publishing a launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installer-diagnostics-'));
  let manifest = '';
  let manifestStatus = 404;
  let archiveStatus = 404;
  const server = createServer((req, res) => {
    if (req.url === '/release.txt') return res.writeHead(manifestStatus).end(manifest);
    if (req.url === '/' + filename)
      return res.writeHead(archiveStatus).end('wrong package contents');
    res.writeHead(404).end();
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const installRoot = join(root, 'install');
    const script = join(root, 'install.sh');
    const { renderInstaller } = await import(
      new URL('../scripts/install-template.mjs', import.meta.url).href
    );
    await writeFile(
      script,
      renderInstaller(
        await readFile('deploy/install.sh', 'utf8'),
        await readFile('deploy/github-fetch.sh', 'utf8'),
        { source, version: '0.0.1', nodeSha256: checksum },
      ),
    );
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      DOOKNOW_INSTALL_ROOT: installRoot,
      DOOKNOW_NO_SERVICE: '1',
    };
    async function failsWith(stage: string, hint: string, overrides = {}) {
      const error = await exec('bash', [script], { env: { ...env, ...overrides } }).catch(
        (failure: { stderr: string; code: number }) => failure,
      );
      expect(error).toMatchObject({ code: 1 });
      expect(error.stderr).toContain(stage);
      expect(error.stderr).toContain(hint);
      expect(error.stderr).not.toContain('fixture-private');
    }

    await failsWith('[1/6] 检查安装环境失败', '请检查 DOOKNOW_SOURCE', {
      DOOKNOW_SOURCE: 'https://user:fixture-private@example.com',
    });
    await failsWith('[2/6] 下载发行清单失败', '发行清单下载失败（HTTP 404）');
    manifestStatus = 200;
    manifest = `0.0.1 ${filename} fixture-private\n`;
    await failsWith('[2/6] 下载发行清单失败', 'SHA-256 校验字段无效');
    manifest = `0.0.1 ${filename} ${checksum}\n`;
    await failsWith('[3/6] 下载应用安装包失败', '应用安装包下载失败（HTTP 404）');
    archiveStatus = 200;
    await failsWith('[4/6] 校验应用安装包失败', '与发行清单的 SHA-256 不匹配');

    expect((await readdir(installRoot)).filter((name) => name.startsWith('.install.'))).toEqual([]);
    await expect(readFile(join(root, '.local/bin/dooknow'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it('stops before download when the host, paths or installation locks are unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installer-preflight-'));
  const script = new URL('../deploy/install.sh', import.meta.url).pathname;
  const tools = join(root, 'tools');
  const install = join(root, 'install');
  const bin = join(root, 'bin');
  const env = {
    PATH: tools + ':' + process.env.PATH,
    HOME: root,
    DOOKNOW_SOURCE: 'http://127.0.0.1:1',
    DOOKNOW_INSTALL_ROOT: install,
    DOOKNOW_BIN_DIR: bin,
    DOOKNOW_NO_SERVICE: '1',
  };
  async function expectPreflightFailure(
    command: string,
    args: string[],
    hint: string,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    const result = await exec(command, args, { env: { ...env, ...overrides }, timeout: 5000 }).then(
      () => ({ code: 0, stderr: '' }),
      (error) => error,
    );
    expect(result).toMatchObject({ code: 1 });
    expect(result.stderr).toContain('[1/6] 检查安装环境失败');
    expect(result.stderr).toContain(hint);
    expect(result.stderr).not.toContain('[2/6]');
  }

  try {
    await mkdir(tools);
    await mkdir(install);
    await mkdir(bin);
    const shims = [
      { name: 'getconf', output: 'printf "glibc 2.33\\n"', hint: '发行包要求 glibc ≥ 2.34' },
      {
        name: 'df',
        output: 'printf "header\\ndrive 20 10 10 50%% /\\n"',
        hint: '至少需要 768 MiB',
      },
      { name: 'systemctl', output: 'exit 1', hint: '无法连接当前用户的 systemd' },
    ];
    for (const { name, output, hint } of shims) {
      const path = join(tools, name);
      await writeFile(path, '#!/bin/sh\n' + output + '\n', { mode: 0o700 });
      await expectPreflightFailure('bash', [script], hint, {
        DOOKNOW_NO_SERVICE: name === 'systemctl' ? '0' : '1',
      });
      await rm(path);
    }
    const minimalPath = join(root, 'minimal-tools');
    await mkdir(minimalPath);
    for (const name of ['uname', 'tar']) {
      const { stdout } = await exec('bash', ['-c', 'command -v "$1"', 'fixture', name]);
      await symlink(stdout.trim(), join(minimalPath, name));
    }
    await expectPreflightFailure('/bin/bash', [script], '缺少必要命令 gzip', {
      PATH: minimalPath,
    });

    for (const lock of [join(install, 'install.lock'), join(bin, '.dooknow-install.lock')]) {
      await expectPreflightFailure('flock', [lock, 'bash', script], '另一个安装正在进行');
      await rm(lock);
    }
    const unrelated = join(root, 'keep-me');
    await writeFile(unrelated, 'unrelated file\n');
    await rm(join(install, 'install.lock'), { force: true });
    await symlink(unrelated, join(install, 'install.lock'));
    await expectPreflightFailure('bash', [script], '无法安全打开安装锁');
    await rm(join(install, 'install.lock'));
    await symlink(unrelated, join(bin, 'dooknow'));
    await expectPreflightFailure('bash', [script], '管理命令路径已被其他安装或文件占用');
    expect(await readlink(join(bin, 'dooknow'))).toBe(unrelated);
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated file\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
