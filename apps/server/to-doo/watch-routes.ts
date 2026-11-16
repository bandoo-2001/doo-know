import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { remoteAuthGeneration } from '../../../packages/core/auth/remote-auth.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import { HttpError } from '../../../packages/core/errors.js';
import type { ToDooService } from '../../../shared/to-doo-contracts.js';
import { readWatchState, runWatchCommand } from '../../../packages/core/to-doo/watch.js';

const deviceApi = '/api/to-doo/watch/v1';
const ownerApi = '/api/to-doo/watch/devices';
export const watchDeviceRoutes = new Set(
  ['/pair/start', '/pair/claim', '/state', '/command'].map((suffix) => deviceApi + suffix),
);
const pairLifetime = 300;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const limited = (max: number) => ({
  bodyLimit: 8192,
  config: { rateLimit: { max, timeWindow: '1 minute' } },
});

export function registerWatchRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  runtime: () => { toDoo: ToDooService },
) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS to_doo_watch_devices (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      expires_at INTEGER,
      user_code TEXT UNIQUE,
      claim_hash TEXT UNIQUE,
      owner_id TEXT REFERENCES user(id) ON DELETE CASCADE,
      auth_generation INTEGER,
      root_identity TEXT,
      token_hash TEXT UNIQUE
    )
  `);
  const cleanup = () =>
    db.prepare('DELETE FROM to_doo_watch_devices WHERE expires_at <= ?').run(Date.now());
  function authorize(header: string | undefined) {
    const token = /^Bearer (dkw_[A-Za-z0-9_-]{43})$/i.exec(header ?? '')?.[1];
    const bound =
      token &&
      db
        .prepare(
          `SELECT 1 FROM to_doo_watch_devices
        WHERE token_hash=? AND auth_generation=?
        AND root_identity=(SELECT value FROM index_meta WHERE key='root_identity')`,
        )
        .get(hash(token), remoteAuthGeneration(db));
    if (!bound) throw new HttpError(401, '手表未配对或授权已失效');
    return runtime().toDoo;
  }

  app.post(deviceApi + '/pair/start', limited(8), async (req) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    cleanup();
    const pending = db
      .prepare('SELECT COUNT(*) AS count FROM to_doo_watch_devices WHERE expires_at IS NOT NULL')
      .get() as { count: number };
    if (pending.count >= 256) throw new HttpError(429, '配对请求过多，请稍后再试');
    const userCode = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join('');
    const deviceCode = randomBytes(32).toString('base64url');
    db.prepare(
      `INSERT INTO to_doo_watch_devices (id, created_at, expires_at, user_code, claim_hash)
      VALUES (?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      new Date().toISOString(),
      Date.now() + pairLifetime * 1000,
      userCode,
      hash(deviceCode),
    );
    return { userCode, deviceCode, expiresIn: pairLifetime };
  });
  app.post(deviceApi + '/pair/claim', limited(40), async (req) => {
    const { deviceCode } = z
      .object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
      .strict()
      .parse(req.body);
    return db
      .transaction(() => {
        const request = db
          .prepare(
            `SELECT id, owner_id, auth_generation,
              root_identity=(SELECT value FROM index_meta WHERE key='root_identity') AS same_root
              FROM to_doo_watch_devices
        WHERE claim_hash=? AND expires_at>?`,
          )
          .get(hash(deviceCode), Date.now()) as
          | {
              id: string;
              owner_id: string | null;
              auth_generation: number | null;
              same_root: number | null;
            }
          | undefined;
        if (!request) throw new HttpError(410, '配对码已过期或已使用');
        if (!request.owner_id) return { status: 'pending' };
        if (!request.same_root || request.auth_generation !== remoteAuthGeneration(db))
          throw new HttpError(410, '授权已失效，请重新配对');
        runtime();
        const token = 'dkw_' + randomBytes(32).toString('base64url');
        db.prepare(
          `UPDATE to_doo_watch_devices SET token_hash=?, expires_at=NULL, claim_hash=NULL
        WHERE id=?`,
        ).run(hash(token), request.id);
        return { status: 'paired', token };
      })
      .immediate();
  });

  app.post(ownerApi + '/approve', limited(10), async (req) => {
    const { userCode } = z
      .object({
        userCode: z
          .string()
          .trim()
          .max(12)
          .transform((value) => value.toUpperCase().replace(/[ -]/g, ''))
          .pipe(z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/)),
      })
      .strict()
      .parse(req.body);
    const row = db
      .prepare(
        `UPDATE to_doo_watch_devices SET owner_id=?, auth_generation=?,
          root_identity=(SELECT value FROM index_meta WHERE key='root_identity'), user_code=NULL
      WHERE user_code=? AND expires_at>? AND owner_id IS NULL RETURNING id`,
      )
      .get((req as { ownerId?: string }).ownerId, remoteAuthGeneration(db), userCode, Date.now());
    if (!row) throw new HttpError(404, '配对码无效或已过期');
    return row;
  });
  app.get(ownerApi, async (req) => {
    cleanup();
    return {
      devices: db
        .prepare(
          `SELECT id, created_at AS createdAt FROM to_doo_watch_devices
      WHERE owner_id=? AND auth_generation=?
        AND root_identity=(SELECT value FROM index_meta WHERE key='root_identity') ORDER BY created_at DESC`,
        )
        .all((req as { ownerId?: string }).ownerId, remoteAuthGeneration(db)),
    };
  });
  app.delete<{ Params: { id: string } }>(ownerApi + '/:id', async (req) => {
    const { changes } = db
      .prepare('DELETE FROM to_doo_watch_devices WHERE id=? AND owner_id=?')
      .run(z.uuid().parse(req.params.id), (req as { ownerId?: string }).ownerId);
    if (!changes) throw new HttpError(404, '未找到这台手表');
    return { ok: true };
  });
  app.get(deviceApi + '/state', limited(90), async (req) =>
    readWatchState(authorize(req.headers.authorization), req.query),
  );
  app.post(deviceApi + '/command', limited(60), async (req) =>
    runWatchCommand(authorize(req.headers.authorization), req.body),
  );
}
