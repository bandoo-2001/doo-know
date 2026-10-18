import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);

it('binds launchers to their installed profiles across fresh terminals and independent installations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-profile-'));
  const stage = join(root, 'stage');
  const home = join(root, 'home');
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await mkdir(home, { recursive: true });
    await mkdir(join(stage, 'runtime/node/bin'), { recursive: true });
    await mkdir(join(stage, 'deploy'), { recursive: true });
    await mkdir(join(stage, 'dist/server/scripts'), { recursive: true });
    const node = `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`;
    await writeFile(join(stage, 'runtime/node/bin/node'), node, { mode: 0o700 });
    await writeFile(
      join(stage, 'deploy/check-archive.mjs'),
      '// Controlled installer fixture, archive validation has separate tests.\n',
    );
    await writeFile(
      join(stage, 'dist/server/scripts/manage.js'),
      `
      const fs = require('node:fs'), path = require('node:path');
      const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
      const profileFile = args.includes('--profile') ? value('--profile') :
        process.env.DOOKNOW_PROFILE || path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config'), 'doo-know/profile.json');
      if (args[0] === 'install') {
        fs.mkdirSync(path.dirname(profileFile), { recursive: true });
        fs.writeFileSync(profileFile, JSON.stringify({ installRoot: value('--install-root'), port: value('--port') }));
      }
      console.log(JSON.stringify({ profileFile, configRoot: process.env.XDG_CONFIG_HOME,
        binDir: process.env.DOOKNOW_BIN_DIR, ...JSON.parse(fs.readFileSync(profileFile, 'utf8')) }));
    `,
    );
    const archive = join(root, 'dooknow-0.0.1-linux-x64.tar.gz');
    await exec('tar', ['-czf', archive, '-C', stage, '.']);
    const sha = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    const manifest = `0.0.1 dooknow-0.0.1-linux-x64.tar.gz ${sha}\n`;
    server = createServer(async (req, res) => {
      if (req.url === '/release.txt') return res.end(manifest);
      if (req.url === '/dooknow-0.0.1-linux-x64.tar.gz') return res.end(await readFile(archive));
      res.writeHead(404).end();
    });
    await new Promise<void>((yes) => server!.listen(0, '127.0.0.1', yes));
    const source = `http://127.0.0.1:${(server.address() as any).port}`;
    const { renderInstaller } = await import(
      pathToFileURL(resolve('scripts/install-template.mjs')).href
    );
    const script = join(root, 'install.sh');
    await writeFile(
      script,
      renderInstaller(await readFile('deploy/install.sh', 'utf8'), '', {
        source,
        version: '0.0.1',
        nodeSha256: createHash('sha256').update(node).digest('hex'),
      }),
    );
    const installations = [
      { name: 'first', configRoot: join(root, 'custom config'), profile: undefined },
      {
        name: 'second',
        configRoot: join(root, 'other config'),
        profile: join('profiles', 'second profile.json'),
      },
    ];
    for (const [i, installation] of installations.entries()) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: installation.configRoot,
        XDG_CACHE_HOME: join(root, 'cache'),
        DOOKNOW_INSTALL_ROOT: join(root, installation.name),
        DOOKNOW_BIN_DIR: join(root, installation.name, 'bin'),
        DOOKNOW_NO_SERVICE: '1',
        DOOKNOW_PORT: String(15270 + i),
      };
      delete env.DOOKNOW_PROFILE;
      if (installation.profile) env.DOOKNOW_PROFILE = installation.profile;
      await exec('bash', [script], { env, cwd: root });
    }
    const cleanEnv = {
      HOME: home,
      PATH: process.env.PATH!,
      XDG_CONFIG_HOME: join(root, 'unrelated config'),
      DOOKNOW_PROFILE: join(root, 'unrelated.json'),
      DOOKNOW_BIN_DIR: join(root, 'unrelated bin'),
    };
    for (const [i, installation] of installations.entries()) {
      const launcher = join(root, installation.name, 'bin/dooknow');
      const result = JSON.parse(
        (await exec(launcher, ['status'], { env: cleanEnv, cwd: home })).stdout,
      );
      expect(result).toMatchObject({
        profileFile: installation.profile
          ? resolve(root, installation.profile)
          : join(installation.configRoot, 'doo-know/profile.json'),
        configRoot: installation.configRoot,
        binDir: join(root, installation.name, 'bin'),
        installRoot: join(root, installation.name),
        port: String(15270 + i),
      });
    }
    await expect(
      exec('bash', [script], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(root, 'cache'),
          DOOKNOW_NO_SERVICE: '1',
          DOOKNOW_INSTALL_ROOT: join(root, 'first'),
          DOOKNOW_BIN_DIR: join(root, 'third/bin'),
          DOOKNOW_PROFILE: join(root, 'third/profile.json'),
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('此安装目录已绑定另一配置') });
    await expect(readFile(join(root, 'third/profile.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const originalProfile = join(installations[0].configRoot, 'doo-know/profile.json');
    await rm(originalProfile);
    await expect(
      exec('bash', [script], {
        cwd: root,
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: join(root, 'cache'),
          DOOKNOW_NO_SERVICE: '1',
          DOOKNOW_INSTALL_ROOT: join(root, 'first'),
          DOOKNOW_BIN_DIR: join(root, 'first/bin'),
          DOOKNOW_PROFILE: originalProfile,
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('配置文件不存在') });
    await expect(readFile(originalProfile)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((yes) => server!.close(() => yes()));
    }
    await rm(root, { recursive: true, force: true });
  }
});
