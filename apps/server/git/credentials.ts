import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type {
  GitCredentialInput,
  GitCredentialSecret,
  GitCredentialSummary,
  GitRemoteHost,
} from '../../../shared/git-contracts.js';

type Row = {
  id: string;
  owner_id: string;
  name: string;
  host: GitRemoteHost;
  kind: 'https' | 'ssh';
  username: string | null;
  updated_at: number;
  sealed: string;
};
const unavailable = (): never => fail(404, 'GIT_CREDENTIAL_UNAVAILABLE');
export function validGitHost(host: unknown): host is GitRemoteHost {
  return host === 'github.com' || host === 'gitee.com';
}
function field(value: unknown, limit: number, required = false): value is string {
  return (
    typeof value === 'string' &&
    value.length <= limit &&
    (!required || value.trim().length > 0) &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
/** Only exact, unmarked keys for the selected host; no wildcards, aliases or hashed host lists. */
export function validateKnownHosts(value: unknown, host: GitRemoteHost): string {
  if (typeof value !== 'string' || value.length > 65536 || value.includes('\0'))
    fail(400, 'GIT_INVALID_HOST_KEY');
  const lines = value
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
  if (!lines.length || lines.length > 20) fail(400, 'GIT_INVALID_HOST_KEY');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (
      parts.length !== 3 ||
      parts[0] !== host ||
      !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[1]) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[2])
    )
      fail(400, 'GIT_INVALID_HOST_KEY');
    const raw = Buffer.from(parts[2], 'base64');
    if (
      raw.length < 32 ||
      raw.length > 16384 ||
      raw.readUInt32BE(0) !== parts[1].length ||
      raw.subarray(4, 4 + parts[1].length).toString() !== parts[1]
    )
      fail(400, 'GIT_INVALID_HOST_KEY');
  }
  return lines.map((line) => line.trim()).join('\n') + '\n';
}
function validatePrivateKey(value: unknown, passphrase?: string): string {
  if (
    typeof value !== 'string' ||
    value.length > 65536 ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail(400, 'GIT_INVALID_CREDENTIAL');
  const match = value
    .trim()
    .match(
      /^-----BEGIN ((?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY)-----\r?\n([A-Za-z0-9+/=\r\n]+)\r?\n-----END \1-----$/,
    );
  if (!match) fail(400, 'GIT_INVALID_CREDENTIAL');
  try {
    if (match[1] === 'OPENSSH PRIVATE KEY') {
      const binary = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
      if (binary.length < 64 || !binary.subarray(0, 15).equals(Buffer.from('openssh-key-v1\0')))
        throw Error();
    } else createPrivateKey({ key: value, format: 'pem', passphrase });
  } catch {
    fail(400, 'GIT_INVALID_CREDENTIAL');
  }
  return value;
}
export function gitCredentials(config: HostConfig, db: AppDatabase) {
  db.exec(`CREATE TABLE IF NOT EXISTS git_credentials(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,host TEXT NOT NULL,kind TEXT NOT NULL,username TEXT,updated_at INTEGER NOT NULL,sealed TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS git_credentials_owner ON git_credentials(owner_id);`);
  const key = Buffer.from(
    hkdfSync('sha256', config.secret, 'doo-know/git-credentials/v1', 'aes-256-gcm', 32),
  );
  const ephemeral = new Map<
    string,
    { owner: string; secret: GitCredentialSecret; expiresAt: number }
  >();
  const sweep = () => {
    for (const [id, entry] of ephemeral) if (entry.expiresAt <= Date.now()) ephemeral.delete(id);
  };
  const aad = (row: Omit<Row, 'sealed'>) =>
    Buffer.from(
      JSON.stringify([
        row.id,
        row.owner_id,
        row.name,
        row.host,
        row.kind,
        row.username,
        row.updated_at,
      ]),
    );
  const summary = (row: Row): GitCredentialSummary => ({
    id: row.id,
    name: row.name,
    host: row.host,
    kind: row.kind,
    ...(row.username ? { username: row.username } : {}),
    updatedAt: row.updated_at,
  });
  const summarizeSecret = (secret: GitCredentialSecret): GitCredentialSummary => ({
    id: secret.id,
    name: secret.name,
    host: secret.host,
    kind: secret.kind,
    ...(secret.username ? { username: secret.username } : {}),
    updatedAt: secret.updatedAt,
    ...(secret.temporary ? { temporary: true } : {}),
  });
  function get(owner: string, id: string, host: string): GitCredentialSecret {
    sweep();
    if (!field(owner, 256, true) || !field(id, 256, true) || !validGitHost(host)) unavailable();
    const memory = ephemeral.get(id);
    if (memory) {
      if (memory.owner !== owner || memory.secret.host !== host) unavailable();
      return { ...memory.secret };
    }
    const row = db
      .prepare('SELECT * FROM git_credentials WHERE id=? AND owner_id=? AND host=?')
      .get(id, owner, host) as Row | undefined;
    if (!row) return unavailable();
    try {
      const bytes = Buffer.from(row.sealed, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(aad(row));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const secrets = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
      );
      return { ...summary(row), ...secrets };
    } catch {
      return unavailable();
    }
  }
  return {
    list(owner: string): GitCredentialSummary[] {
      sweep();
      return [
        ...(
          db
            .prepare('SELECT * FROM git_credentials WHERE owner_id=? ORDER BY updated_at DESC,id')
            .all(owner) as Row[]
        ).map(summary),
        ...[...ephemeral.values()]
          .filter((entry) => entry.owner === owner)
          .map((entry) => summarizeSecret(entry.secret)),
      ];
    },
    get,
    save(owner: string, input: GitCredentialInput): GitCredentialSummary {
      if (
        !input ||
        !field(owner, 256, true) ||
        !field(input.name, 120, true) ||
        !validGitHost(input.host) ||
        !['https', 'ssh'].includes(input.kind) ||
        (input.username !== undefined &&
          (!field(input.username, 128) || input.username.includes(':'))) ||
        (input.remember !== undefined && typeof input.remember !== 'boolean')
      )
        fail(400, 'GIT_INVALID_CREDENTIAL');
      sweep();
      let existing: GitCredentialSecret | undefined;
      if (input.id) {
        const row = db
          .prepare('SELECT host FROM git_credentials WHERE id=? AND owner_id=?')
          .get(input.id, owner) as { host: string } | undefined;
        const memory = ephemeral.get(input.id);
        existing = get(owner, input.id, row?.host || memory?.secret.host || input.host);
      }
      const sameBinding = existing?.host === input.host && existing?.kind === input.kind;
      const secrets: Pick<
        GitCredentialSecret,
        'token' | 'privateKey' | 'passphrase' | 'knownHosts'
      > = {};
      if (input.kind === 'https') {
        secrets.token = input.token || (sameBinding ? existing?.token : undefined);
        if (!field(secrets.token, 16384, true)) fail(400, 'GIT_INVALID_CREDENTIAL');
      } else {
        const reuse = sameBinding && !input.privateKey;
        secrets.passphrase =
          input.passphrase === undefined && reuse ? existing?.passphrase : input.passphrase;
        if (secrets.passphrase !== undefined && !field(secrets.passphrase, 4096))
          fail(400, 'GIT_INVALID_CREDENTIAL');
        secrets.privateKey = validatePrivateKey(
          input.privateKey || (sameBinding ? existing?.privateKey : undefined),
          secrets.passphrase,
        );
        const knownHosts = input.knownHosts || (sameBinding ? existing?.knownHosts : undefined);
        if (!(sameBinding && knownHosts === existing?.knownHosts) && input.trustHost !== true)
          fail(400, 'GIT_SSH_TRUST_REQUIRED');
        secrets.knownHosts = validateKnownHosts(knownHosts, input.host);
      }
      const id = existing?.id || randomUUID(),
        updatedAt = Date.now();
      const row = {
        id,
        owner_id: owner,
        name: input.name.trim(),
        host: input.host,
        kind: input.kind,
        username: input.username || null,
        updated_at: updatedAt,
      };
      const result = summary({ ...row, sealed: '' });
      if (input.remember === false) {
        db.prepare('DELETE FROM git_credentials WHERE id=? AND owner_id=?').run(id, owner);
        result.temporary = true;
        ephemeral.set(id, {
          owner,
          secret: { ...result, ...secrets },
          expiresAt: Date.now() + 30 * 60 * 1000,
        });
      } else {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(row));
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(secrets)), cipher.final()]);
        const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
        db.prepare(
          'INSERT INTO git_credentials(id,owner_id,name,host,kind,username,updated_at,sealed) VALUES(@id,@owner_id,@name,@host,@kind,@username,@updated_at,@sealed) ON CONFLICT(id) DO UPDATE SET name=excluded.name,host=excluded.host,kind=excluded.kind,username=excluded.username,updated_at=excluded.updated_at,sealed=excluded.sealed',
        ).run({ ...row, sealed });
        ephemeral.delete(id);
      }
      return result;
    },
    remove(owner: string, id: string) {
      sweep();
      const memory = ephemeral.get(id);
      if (memory) {
        if (memory.owner !== owner) unavailable();
        ephemeral.delete(id);
        return;
      }
      if (
        !db.prepare('DELETE FROM git_credentials WHERE id=? AND owner_id=?').run(id, owner).changes
      )
        unavailable();
    },
  };
}
