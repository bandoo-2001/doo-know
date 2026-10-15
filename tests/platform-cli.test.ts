import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initializeOwner } from '../apps/server/auth.js';
import { testPassword } from './support/credentials.js';
const exec = promisify(execFile);
it('reinstall with an existing owner needs no TTY and preserves the secret and profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-'));
  try {
    const secretFile = join(root, 'auth.key'), profileFile = join(root, 'profile.json');
    const secret = 'cli-fixture-secret-at-least-thirty-two-characters';
    await writeFile(secretFile, secret, { mode: 0o600 });
    const profile = { dataRoot: join(root, 'data'), secretFile, origin: 'http://127.0.0.1:15177', port: 15177 };
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });
    await initializeOwner({ ...profile, secret }, 'owner', testPassword);
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/manage.ts', 'install', '--profile', profileFile, '--no-service']);
    expect(result.stdout).toContain('账号已存在');
    expect(await readFile(secretFile, 'utf8')).toBe(secret);
    expect(JSON.parse(await readFile(profileFile, 'utf8'))).toEqual(profile);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('fresh noninteractive installation never creates an empty-password owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dooknow-cli-'));
  try {
    await expect(exec(process.execPath, ['--import', 'tsx', 'scripts/manage.ts', 'install', '--profile', join(root, 'profile.json'), '--data-root', join(root, 'data'), '--no-service'])).rejects.toMatchObject({ code: 1 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('completes provider initialization before closing an offline self-check database',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dooknow-selfcheck-'));try{
  const secretFile=join(root,'auth.key'),profileFile=join(root,'profile.json'),secret='selfcheck-fixture-secret-at-least-thirty-two-characters';await writeFile(secretFile,secret,{mode:0o600});
  const profile={dataRoot:join(root,'data'),secretFile,origin:'http://127.0.0.1:15177',port:15177};await writeFile(profileFile,JSON.stringify(profile),{mode:0o600});await initializeOwner({...profile,secret},'owner',testPassword);
  const result=await exec(process.execPath,['--import','tsx','scripts/manage.ts','self-check','--profile',profileFile,'--data-root',join(root,'independent-check')]);
  expect(JSON.parse(result.stdout)).toMatchObject({check:'ok'});
 }finally{await rm(root,{recursive:true,force:true});}
});
