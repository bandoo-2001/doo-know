import { expect, it } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  mkdtemp,
  mkdir,
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
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const version = '0.0.2';
const oldVersion = '0.0.1';
const manager = `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), option = key => args[args.indexOf(key) + 1];
const base = option('--install-root'), profile = option('--profile');
if (args[0] === 'update') {
  if (!fs.existsSync(process.env.FIXTURE_RESTORED)) {
    console.error('升级自检无法访问原知识库目录');
    process.exit(Number(process.env.FIXTURE_UPDATE_EXIT || 42));
  }
  fs.unlinkSync(path.join(base, 'current'));
  fs.symlinkSync('releases/' + option('--version'), path.join(base, 'current'));
} else if (args[0] === 'install') {
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, JSON.stringify({
    host: option('--host'), port: Number(option('--port')), serviceName: option('--service-name'),
    dataRoot: path.join(process.env.XDG_DATA_HOME, 'doo-know/data'),
  }));
}
`;

async function terminal(
  env: NodeJS.ProcessEnv,
  replies: { after: string; input: string; prepare?: () => void }[],
) {
  const child = spawn('script', ['-qefc', 'bash "$FIXTURE_INSTALLER"', '/dev/null'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    index = 0,
    offset = 0;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    const next = replies[index];
    if (!next) return;
    const found = output.indexOf(next.after, offset);
    if (found === -1) return;
    offset = found + next.after.length;
    index++;
    next.prepare?.();
    child.stdin.write(next.input + '\n');
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  child.stdin.on('error', () => {});
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(index, output).toBe(replies.length);
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}

it('retries or starts an independent instance only after an explicit terminal choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-install-wizard-'));
  const nodeShim = `#!/bin/sh\nexec '${process.execPath}' "$@"\n`;
  async function writeRelease(directory: string) {
    await mkdir(join(directory, 'runtime/node/bin'), { recursive: true });
    await mkdir(join(directory, 'deploy'), { recursive: true });
    await mkdir(join(directory, 'dist/server/scripts'), { recursive: true });
    await writeFile(join(directory, 'runtime/node/bin/node'), nodeShim, { mode: 0o700 });
    await writeFile(join(directory, 'deploy/check-archive.mjs'), '// Disposable test archive.');
    await writeFile(join(directory, 'dist/server/scripts/manage.js'), manager);
  }
  const server = createServer();
  try {
    const stage = join(root, 'stage');
    await writeRelease(stage);
    const archive = `dooknow-${version}-linux-x64.tar.gz`;
    await exec('tar', ['-czf', join(root, archive), '-C', stage, '.']);
    const bytes = await readFile(join(root, archive));
    server.on('request', (req, res) => {
      if (req.url === '/release.txt') return res.end(`${version} ${archive} ${hash(bytes)}\n`);
      if (req.url === '/' + archive) return res.end(bytes);
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const source = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const script = join(root, 'install.sh');
    const { renderInstaller } = await import(
      new URL('../scripts/install-template.mjs', import.meta.url).href
    );
    await writeFile(
      script,
      renderInstaller(await readFile('deploy/install.sh', 'utf8'), '', {
        source,
        version,
        nodeSha256: hash(nodeShim),
      }),
    );

    async function oldInstallation(name: string) {
      const home = join(root, name);
      const base = join(home, 'program');
      const profile = join(home, 'profile.json');
      const bin = join(home, 'bin');
      await writeRelease(join(base, 'releases', oldVersion));
      await writeFile(profile, '{}');
      await writeFile(join(base, 'profile.path'), profile + '\n');
      await symlink(`releases/${oldVersion}`, join(base, 'current'));
      const env = {
        HOME: home,
        PATH: process.env.PATH,
        TERM: 'xterm',
        DOOKNOW_SOURCE: source,
        DOOKNOW_NO_SERVICE: '1',
        DOOKNOW_PROFILE: profile,
        DOOKNOW_INSTALL_ROOT: base,
        DOOKNOW_BIN_DIR: bin,
        XDG_CACHE_HOME: join(root, 'cache'),
        FIXTURE_INSTALLER: script,
        FIXTURE_RESTORED: join(home, 'restored'),
      };
      return { home, base, profile, bin, env };
    }
    const noninteractive = await oldInstallation('headless');
    await expect(exec('bash', [script], { env: noninteractive.env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('在交互终端重跑安装向导'),
    });
    expect(await readlink(join(noninteractive.base, 'current'))).toBe(`releases/${oldVersion}`);
    expect(await readFile(join(noninteractive.bin, 'dooknow'), 'utf8')).toContain(
      noninteractive.profile,
    );

    const retry = await oldInstallation('retry');
    const retryResult = await terminal(retry.env, [
      { after: '创建独立的新实例？', input: 'N' },
      {
        after: '恢复原目录或挂载后按回车重试',
        input: '',
        prepare: () => writeFileSync(retry.env.FIXTURE_RESTORED, ''),
      },
    ]);
    expect(retryResult.code, retryResult.output).toBe(0);
    expect(retryResult.output).toContain('\x1b[1;33m');
    expect(await readlink(join(retry.base, 'current'))).toBe(`releases/${version}`);

    const fresh = await oldInstallation('fresh');
    const installed = await terminal({ ...fresh.env, NO_COLOR: '1' }, [
      { after: '创建独立的新实例？', input: 'Y' },
    ]);
    expect(installed.code, installed.output).toBe(0);
    expect(installed.output).not.toContain('\x1b[');
    expect(await readlink(join(fresh.base, 'current'))).toBe(`releases/${oldVersion}`);
    expect(await readFile(fresh.profile, 'utf8')).toBe('{}');
    const instances = join(fresh.home, '.local/share/doo-know-instances');
    const [name] = await readdir(instances);
    const instance = join(instances, name);
    const created = JSON.parse(await readFile(join(instance, 'config/profile.json'), 'utf8'));
    expect(created).toMatchObject({
      host: '127.0.0.1',
      dataRoot: join(instance, 'share/doo-know/data'),
      serviceName: `doo-know-${name}.service`,
    });
    expect(created.port).toBeGreaterThan(0);
    expect(await readFile(join(instance, 'bin/dooknow'), 'utf8')).toContain(instance);

    const quit = await oldInstallation('quit');
    const cancelled = await terminal(quit.env, [{ after: '创建独立的新实例？', input: 'Q' }]);
    expect(cancelled.code, cancelled.output).toBe(1);
    expect(cancelled.output).toContain('已退出安装向导');
    expect(await readlink(join(quit.base, 'current'))).toBe(`releases/${oldVersion}`);

    await expect(
      exec('bash', [script], { env: { ...quit.env, FIXTURE_UPDATE_EXIT: '1' } }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('发现已有实例，升级未完成'),
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
