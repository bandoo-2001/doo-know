import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { openDatabase } from '../packages/core/db.js';
import { gitCredentials } from '../apps/server/git/credentials.js';
let root: string,
  db: ReturnType<typeof openDatabase>,
  credentials: ReturnType<typeof gitCredentials>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-credentials-'));
  db = openDatabase(root);
  credentials = gitCredentials(
    {
      dataRoot: root,
      origin: 'http://localhost',
      secret: 'fixture-secret-with-at-least-thirty-two-characters',
    },
    db,
  );
});
afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});
it('encrypts secrets and returns only summaries, bound to owner and host', () => {
  const saved = credentials.save('alice', {
    name: 'Github',
    host: 'github.com',
    kind: 'https',
    token: 'fixture-token-secret',
  });
  expect(JSON.stringify(saved)).not.toContain('fixture-token-secret');
  expect(credentials.list('alice')).toEqual([saved]);
  expect(credentials.list('bob')).toEqual([]);
  expect(credentials.get('alice', saved.id, 'github.com').token).toBe('fixture-token-secret');
  expect(() => credentials.get('bob', saved.id, 'github.com')).toThrow(
    'GIT_CREDENTIAL_UNAVAILABLE',
  );
  expect(() => credentials.get('alice', saved.id, 'gitee.com')).toThrow(
    'GIT_CREDENTIAL_UNAVAILABLE',
  );
  expect(JSON.stringify(db.prepare('SELECT * FROM git_credentials').all())).not.toContain(
    'fixture-token-secret',
  );
  db.prepare('UPDATE git_credentials SET owner_id=? WHERE id=?').run('bob', saved.id);
  expect(() => credentials.get('bob', saved.id, 'github.com')).toThrow(
    'GIT_CREDENTIAL_UNAVAILABLE',
  );
});
it('retains blank secrets only for same owner, host, and kind, and explicitly replaces/removes', () => {
  const original = {
    name: 'Github',
    host: 'github.com',
    kind: 'https',
    token: 'original-secret',
  } as const;
  const saved = credentials.save('alice', original);
  credentials.save('alice', { ...original, id: saved.id, token: '', name: 'renamed' });
  expect(credentials.get('alice', saved.id, 'github.com').token).toBe('original-secret');
  expect(() => credentials.save('bob', { ...original, id: saved.id })).toThrow(
    'GIT_CREDENTIAL_UNAVAILABLE',
  );
  expect(() =>
    credentials.save('alice', { ...original, id: saved.id, host: 'gitee.com', token: '' }),
  ).toThrow('GIT_INVALID_CREDENTIAL');
  credentials.save('alice', { ...original, id: saved.id, token: 'replacement-secret' });
  expect(credentials.get('alice', saved.id, 'github.com').token).toBe('replacement-secret');
  expect(() => credentials.remove('bob', saved.id)).toThrow('GIT_CREDENTIAL_UNAVAILABLE');
  credentials.remove('alice', saved.id);
  expect(credentials.list('alice')).toEqual([]);
});
it('requires an explicitly trusted host key and a supported private key for SSH', () => {
  const privateKey = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const blob = Buffer.concat([
    Buffer.from([0, 0, 0, 11]),
    Buffer.from('ssh-ed25519'),
    Buffer.from([0, 0, 0, 32]),
    Buffer.alloc(32, 1),
  ]).toString('base64');
  const input = {
    name: 'ssh',
    host: 'github.com',
    kind: 'ssh',
    privateKey,
    knownHosts: `github.com ssh-ed25519 ${blob}`,
    passphrase: 'secret-passphrase',
  } as const;
  expect(() => credentials.save('alice', input)).toThrow('GIT_SSH_TRUST_REQUIRED');
  expect(() =>
    credentials.save('alice', {
      ...input,
      trustHost: true,
      knownHosts: `gitee.com ssh-ed25519 ${blob}`,
    }),
  ).toThrow('GIT_INVALID_HOST_KEY');
  expect(() =>
    credentials.save('alice', { ...input, trustHost: true, privateKey: 'not-a-key' }),
  ).toThrow('GIT_INVALID_CREDENTIAL');
  const saved = credentials.save('alice', { ...input, trustHost: true });
  expect(credentials.get('alice', saved.id, 'github.com').privateKey).toBe(privateKey);
  const stored = JSON.stringify(db.prepare('SELECT * FROM git_credentials').all());
  expect(stored).not.toContain('PRIVATE KEY');
  expect(stored).not.toContain('secret-passphrase');
});
it('keeps optional temporary credentials only in this service instance and expires after thirty minutes', () => {
  const saved = credentials.save('alice', {
    name: 'once',
    host: 'github.com',
    kind: 'https',
    token: 'ephemeral-secret',
    remember: false,
  });
  expect(saved).toMatchObject({ temporary: true });
  expect(credentials.get('alice', saved.id, 'github.com').token).toBe('ephemeral-secret');
  expect(db.prepare('SELECT * FROM git_credentials').all()).toEqual([]);
  const restarted = gitCredentials(
    {
      dataRoot: root,
      origin: 'http://localhost',
      secret: 'fixture-secret-with-at-least-thirty-two-characters',
    },
    db,
  );
  expect(() => restarted.get('alice', saved.id, 'github.com')).toThrow(
    'GIT_CREDENTIAL_UNAVAILABLE',
  );
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
  try {
    expect(() => credentials.get('alice', saved.id, 'github.com')).toThrow(
      'GIT_CREDENTIAL_UNAVAILABLE',
    );
    expect(credentials.list('alice')).toEqual([]);
  } finally {
    now.mockRestore();
  }
});
