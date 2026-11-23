import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
