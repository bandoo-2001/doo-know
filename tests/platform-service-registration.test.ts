import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, access, stat } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HostConfig } from '../shared/platform-contracts';
import {
  writeService,
  assertServiceOwnership,
  serviceActive,
  unitName,
} from '../apps/server/platform/service';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(defaultDirectory = false) {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-systemd-registration-'));
  roots.push(root);
  const home = join(root, 'home'),
    configHome = defaultDirectory ? join(home, '.config') : join(root, 'isolated-config');
  const daemonDirectory = join(home, '.config/systemd/user');
  const unitDirectory = join(configHome, 'systemd/user');
  const config: HostConfig = {
    profileFile: join(configHome, 'profile.json'),
    installRoot: join(root, 'application'),
    dataRoot: join(root, 'data'),
    knowledgeRoot: join(root, 'knowledge'),
    secret: 'disposable-service-registration-fixture',
    origin: 'http://127.0.0.1:15177',
    serviceName: defaultDirectory ? undefined : 'dooknow-registration-fixture.service',
  };
  const file = join(unitDirectory, unitName(config));
  const stateFile = join(root, 'manager.json'),
    callsFile = join(root, 'calls.jsonl'),
    bin = join(root, 'bin');
  await mkdir(bin);
  await mkdir(unitDirectory, { recursive: true });
  await mkdir(daemonDirectory, { recursive: true });
  const initial = {
    fragment: null as string | null,
    active: false,
    mode: 'normal',
    shadow: null as string | null,
    race: null as string | null,
  };
  await writeFile(stateFile, JSON.stringify(initial));
  const fake =
    `#!${process.execPath}\n` +
    `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2); if (args.shift() !== '--user') process.exit(2);
const action = args[0], stateFile = ${JSON.stringify(stateFile)};
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + '\\n');
const commit = () => fs.writeFileSync(stateFile, JSON.stringify(state));
if (action === 'show') {
  if (args.includes('--property=MainPID')) { console.log('0'); process.exit(0); }
  if (state.mode === 'bad-metadata') { console.log('unexpected-output'); process.exit(0); }
  if (state.mode === 'duplicate-metadata') { console.log('LoadState=loaded'); console.log('LoadState=not-found'); console.log('FragmentPath='); process.exit(0); }
  if (state.mode === 'incomplete-metadata') { console.log('LoadState=not-found'); process.exit(4); }
  if (state.mode === 'bus-failure') { console.error('synthetic manager unavailable'); process.exit(1); }
  if (state.race) { fs.writeFileSync(${JSON.stringify(file)}, state.race); state.race = null; commit(); }
  console.log('LoadState=' + (state.mode === 'masked' ? 'masked' : state.fragment ? 'loaded' : 'not-found'));
  console.log('FragmentPath=' + (state.fragment || ''));
  process.exit(state.fragment ? 0 : 4);
}
if (action === 'is-active') { console.log(state.active ? 'active' : 'inactive'); process.exit(state.active ? 0 : 3); }
if (action === 'link') {
  const source = args[1]; if (!path.isAbsolute(source)) process.exit(2);
  if (state.mode === 'link-fails' || state.mode === 'natural-search-path') { console.error('synthetic link unavailable'); process.exit(1); }
  const link = path.join(${JSON.stringify(daemonDirectory)}, path.basename(source));
  if (fs.existsSync(link)) {
    if (fs.realpathSync(link) !== fs.realpathSync(source)) process.exit(1);
  } else if (link !== source) fs.symlinkSync(source, link);
  state.fragment = fs.realpathSync(source); commit(); process.exit(0);
}
if (action === 'daemon-reload') {
  const natural = path.join(${JSON.stringify(daemonDirectory)}, ${JSON.stringify(unitName(config))});
  if (state.shadow) state.fragment = state.shadow;
  else if (fs.existsSync(natural)) state.fragment = fs.realpathSync(natural);
  commit(); process.exit(0);
}
if (['enable','start','stop','restart'].includes(action)) process.exit(state.fragment ? 0 : 4);
process.exit(2);
`;
  await writeFile(join(bin, 'systemctl'), fake, { mode: 0o700 });
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', defaultDirectory ? '' : configHome);
  vi.stubEnv('PATH', bin + ':' + process.env.PATH);
  return {
    root,
    config,
    file,
    daemonDirectory,
    initial,
    state: (value: Partial<typeof initial>) =>
      writeFileSync(
        stateFile,
        JSON.stringify({ ...JSON.parse(readFileSync(stateFile, 'utf8')), ...value }),
      ),
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    marker: (profile = config.profileFile!) =>
      '# DooKnow profile: ' + profile + '\n[Service]\nExecStart=/bin/true\n',
  };
}

test('registers an external XDG unit with the manager before enable can use its name', async () => {
  const f = await fixture();
  const file = writeService(f.config, '/synthetic/release', '/synthetic/node');
  expect(file).toBe(f.file);
  const calls = f.calls();
  expect(calls).toContainEqual(['link', f.file]);
  expect(calls.findIndex((call) => call[0] === 'link')).toBeLessThan(
    calls.findIndex((call) => call[0] === 'daemon-reload'),
  );
  expect(assertServiceOwnership(f.config)).toBe(f.file);
  expect(await readFile(join(f.daemonDirectory, unitName(f.config)), 'utf8')).toContain(
    f.config.profileFile,
  );
  expect((await stat(f.file)).mode & 0o777).toBe(0o600);
});

test('default-directory installation and reinstallation are idempotent even when link is unnecessary', async () => {
  const f = await fixture(true);
  f.state({ mode: 'natural-search-path' });
  expect(writeService(f.config, '/synthetic/release-one', '/synthetic/node')).toBe(f.file);
  expect(writeService(f.config, '/synthetic/release-two', '/synthetic/node')).toBe(f.file);
  expect(assertServiceOwnership(f.config)).toBe(f.file);
  expect(await readFile(f.file, 'utf8')).toContain(
    '/synthetic/release-two/dist/server/scripts/manage.js',
  );
  expect(f.calls().some((call) => call.includes('--force'))).toBe(false);
});

test('control follows the real loaded fragment when CLI XDG differs from the manager', async () => {
  const f = await fixture();
  const actual = join(f.root, 'actual-owned.service');
  await writeFile(actual, f.marker());
  f.state({ fragment: actual, active: true });
  expect(assertServiceOwnership(f.config)).toBe(actual);
  expect(serviceActive(f.config)).toBe(true);
  expect(writeService(f.config, '/synthetic/updated', '/synthetic/node')).toBe(actual);
  expect(await readFile(actual, 'utf8')).toContain('/synthetic/updated');
  await expect(access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a self-marked CLI unit cannot hide a different profile loaded by the manager', async () => {
  const f = await fixture();
  await writeFile(f.file, f.marker());
  const actual = join(f.root, 'foreign.service'),
    foreign = f.marker(join(f.root, 'other-profile.json'));
  await writeFile(actual, foreign);
  f.state({ fragment: actual, active: true });
  expect(() => assertServiceOwnership(f.config)).toThrow('不属于此配置');
  expect(() => serviceActive(f.config)).toThrow('不属于此配置');
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow(
    '不属于此配置',
  );
  expect(await readFile(actual, 'utf8')).toBe(foreign);
  expect(await readFile(f.file, 'utf8')).toBe(f.marker());
  expect(
    f
      .calls()
      .some((call) => ['link', 'daemon-reload', 'start', 'stop', 'enable'].includes(call[0]!)),
  ).toBe(false);
});

test('another CLI-local unit cannot be unlinked by claiming an owned daemon unit', async () => {
  const f = await fixture();
  const foreign = f.marker(join(f.root, 'other-profile.json'));
  await writeFile(f.file, foreign);
  const actual = join(f.root, 'actual-owned.service');
  await writeFile(actual, f.marker());
  f.state({ fragment: actual, active: true });
  expect(() => assertServiceOwnership(f.config)).toThrow('不属于此配置');
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow(
    '已属于其他安装',
  );
  expect(await readFile(f.file, 'utf8')).toBe(foreign);
});

for (const mode of [
  'bad-metadata',
  'duplicate-metadata',
  'incomplete-metadata',
  'bus-failure',
  'masked',
]) {
  test('rejects ' + mode + ' metadata before writing or controlling a service', async () => {
    const f = await fixture();
    f.state({ mode, active: true });
    expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow(
      '无法核对',
    );
    expect(() => serviceActive(f.config)).toThrow('无法核对');
    await expect(access(f.file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      f
        .calls()
        .some((call) => ['link', 'daemon-reload', 'start', 'stop', 'enable'].includes(call[0]!)),
    ).toBe(false);
  });
}

test('a failed link cannot be mistaken for a successful external registration', async () => {
  const f = await fixture();
  f.state({ mode: 'link-fails' });
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow();
  expect(f.calls().some((call) => ['enable', 'start'].includes(call[0]!))).toBe(false);
});

test('checks the actual manager fragment again after reload rather than enabling a shadow unit', async () => {
  const f = await fixture();
  const shadow = join(f.root, 'shadow.service');
  await writeFile(shadow, f.marker(join(f.root, 'other-profile.json')));
  f.state({ shadow });
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow(
    '不属于此配置',
  );
  expect(f.calls().some((call) => ['enable', 'start'].includes(call[0]!))).toBe(false);
});

test('refuses a same-name file that appears after the initial ownership check', async () => {
  const f = await fixture();
  const foreign = f.marker(join(f.root, 'concurrent-profile.json'));
  f.state({ race: foreign });
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow(
    '不属于此配置',
  );
  expect(await readFile(f.file, 'utf8')).toBe(foreign);
  expect(f.calls().some((call) => ['link', 'daemon-reload'].includes(call[0]!))).toBe(false);
});

test('a dangling unit symlink never creates or overwrites its outside target', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside.service');
  await symlink(outside, f.file);
  expect(() => writeService(f.config, '/synthetic/release', '/synthetic/node')).toThrow();
  await expect(access(outside)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(f.calls()).toEqual([]);
});
