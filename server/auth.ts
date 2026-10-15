import { betterAuth } from 'better-auth';
import { username } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { hashPassword } from 'better-auth/crypto';
import { randomUUID } from 'node:crypto';
import type { HostConfig } from '../shared/platform-contracts.js';
import { openDatabase, type AppDatabase } from './db.js';
export async function createAuth(config: HostConfig, db: AppDatabase) {
  const auth = betterAuth({
    database: db,
    baseURL: config.origin,
    secret: config.secret,
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    session: { expiresIn: 86400, cookieCache: { enabled: false } },
    plugins: [username({ immutableUsername: true })],
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 20,
      customRules: { '/sign-in/username': { window: 60, max: 5 } },
    },
    logger: { disabled: true },
  });
  await (await getMigrations(auth.options)).runMigrations();
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS single_owner BEFORE INSERT ON user WHEN (SELECT COUNT(*) FROM user)>0 BEGIN SELECT RAISE(ABORT,'single owner'); END;`,
  );
  return auth;
}
export async function initializeOwner(config: HostConfig, name: string, password: string) {
  if (!/^[a-zA-Z0-9_.]{3,30}$/.test(name) || password.length < 12)
    throw new Error('用户名需 3–30 个字母、数字、点或下划线，密码至少 12 位');
  const db = openDatabase(config.dataRoot);
  try {
    await createAuth(config, db);
    if ((db.prepare('SELECT count(*) AS n FROM user').get() as { n: number }).n)
      throw new Error('账号已存在，请使用 reset');
    const id = randomUUID(),
      now = Date.now(),
      hashed = await hashPassword(password);
    db.transaction(() => {
      db.prepare(
        'INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt,username,displayUsername) VALUES(?,?,?,?,?,?,?,?)',
      ).run(id, name, `${name.toLowerCase()}@owner.invalid`, 1, now, now, name.toLowerCase(), name);
      db.prepare(
        'INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)',
      ).run(randomUUID(), id, 'credential', id, hashed, now, now);
    })();
  } finally {
    db.close();
  }
}
export async function resetOwnerPassword(config: HostConfig, password: string) {
  if (password.length < 12) throw new Error('密码至少 12 位');
  const db = openDatabase(config.dataRoot);
  try {
    await createAuth(config, db);
    const hash = await hashPassword(password);
    db.transaction(() => {
      const r = db
        .prepare("UPDATE account SET password=?,updatedAt=? WHERE providerId='credential'")
        .run(hash, Date.now());
      if (!r.changes) throw new Error('尚无账号');
      db.prepare('DELETE FROM session').run();
      db.prepare(
        "INSERT INTO index_meta VALUES('remote_auth_not_before',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      ).run(String(Math.floor(Date.now() / 1000)));
    })();
  } finally {
    db.close();
  }
}
