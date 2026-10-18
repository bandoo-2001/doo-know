import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { openDatabase } from '../packages/core/db.js';
import { assertRoot } from '../packages/core/indexing/reconcile.js';
import { platformSettings } from '../apps/server/platform/settings.js';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
const exec = promisify(execFile);

it('persists public distribution without a token and explicitly replaces a stale private credential reference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-public-cli-'));
  try {
    const configDir = join(root, 'config'); await mkdir(configDir);
    const secret = 'test-fixture-secret-at-least-thirty-two-characters';
    const secretFile = join(configDir, 'auth.key'), profileFile = join(configDir, 'profile.json');
    await writeFile(secretFile, secret, {mode:0o600});
    const profile = {dataRoot:join(root,'data'),secretFile,origin:'http://127.0.0.1:15179',port:15179,
      distribution:{repository:'owner/public',tokenFile:join(root,'missing.token')}};
    await writeFile(profileFile,JSON.stringify(profile),{mode:0o600});
    await initializeOwner({...profile,secret},'owner',testPassword);
    await exec(process.execPath,['--import','tsx','scripts/manage.ts','install','--profile',profileFile,'--no-service','--github-repository','owner/public']);
    expect(JSON.parse(await readFile(profileFile,'utf8')).distribution).toEqual({repository:'owner/public'});
    expect(await readFile(secretFile,'utf8')).toBe(secret);
  } finally {await rm(root,{recursive:true,force:true});}
});

it('refuses binding a directory containing the configured download credential and refuses activating an old unsafe binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-credential-root-'));
  const knowledgeRoot = join(root, 'knowledge'), tokenFile = join(knowledgeRoot, 'github.md');
  await mkdir(knowledgeRoot); await writeFile(tokenFile, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
  const db = openDatabase(join(root, 'data'));
  try {
    const config = { dataRoot: join(root, 'data'), secret: 'test-fixture-secret-at-least-thirty-two-characters', origin: 'http://127.0.0.1:15177', allowedKnowledgeBases: [root], distribution: { repository: 'owner/private', tokenFile } };
    await initializeOwner(config, 'owner', testPassword);
    const settings = platformSettings(config, db);
    expect(() => settings.validate('owner', knowledgeRoot)).toThrow();
    const legacy = platformSettings({ ...config, knowledgeRoot }, db);
    expect(() => legacy.configured()).toThrow();
    expect(legacy.status(false, false).phase).toBe('configuration_error');
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

it('rejects an installer credential inside the database-bound root before changing an existing profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-credential-cli-'));
  try {
    const knowledgeRoot = join(root, 'knowledge'), configDir = join(root, 'config');
    await mkdir(knowledgeRoot); await mkdir(configDir);
    const tokenFile = join(knowledgeRoot, 'github.md'), secretFile = join(configDir, 'auth.key'), profileFile = join(configDir, 'profile.json');
    await writeFile(tokenFile, 'fixture_github_012345678901234567890123456789', { mode: 0o600 });
    await writeFile(secretFile, 'test-fixture-secret-at-least-thirty-two-characters', { mode: 0o600 });
    const profile = { dataRoot: join(root, 'data'), secretFile, origin: 'http://127.0.0.1:15177', port: 15177 };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    const db = openDatabase(profile.dataRoot); assertRoot({ ...profile, knowledgeRoot } as any, db); db.close();
    await expect(exec(process.execPath, ['--import', 'tsx', 'scripts/manage.ts', 'install', '--profile', profileFile, '--no-service', '--github-repository', 'owner/private', '--github-token-file', tokenFile])).rejects.toMatchObject({ stderr: expect.stringContaining('GITHUB_CREDENTIAL_INSIDE_KNOWLEDGE_ROOT') });
    expect(JSON.parse(await readFile(profileFile, 'utf8'))).toEqual(profile);
  } finally { await rm(root, { recursive: true, force: true }); }
});
