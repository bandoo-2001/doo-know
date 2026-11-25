import type { FastifyInstance, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { z } from 'zod';
import type { AppDatabase } from '../../../packages/core/db.js';
import { HttpError } from '../../../packages/core/errors.js';
import { assertRoot } from '../../../packages/core/indexing/reconcile.js';
import { readKnowledgeRootIdentity } from '../../../packages/core/indexing/root-identity.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import {
  maxOfficeFileBytes,
  officeFormats,
  validateOfficeFile,
  type OfficeFormat,
} from '../../../packages/core/onlyoffice/formats.js';
import {
  addOfficeDocument,
  listOfficeDocuments,
  officeDigest,
  officeSessionStore,
  readOfficeDocument,
} from '../../../packages/core/onlyoffice/documents.js';
import { officeSettings, type OfficeSettings } from '../../../packages/core/onlyoffice/settings.js';
import { workspaceWriteSync } from '../../../packages/core/workspace/gate.js';

const documentId = z.uuidv4();
const keyValue = z.string().max(128);
const claimsValue = z.object({ root: z.string(), id: documentId, key: keyValue });
const callbackValue = z.object({
  key: keyValue,
  status: z.int(),
  url: z.string().max(16384).optional(),
});
type Params = { id: string };
type CapabilityUse = 'onlyoffice-download' | 'onlyoffice-callback';

function officeDownload(
  file: ReturnType<typeof readOfficeDocument>,
  reply: import('fastify').FastifyReply,
  disposition: 'attachment' | 'inline' = 'attachment',
) {
  const { name, fileType } = file.metadata;
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase(),
  );
  return reply
    .type(officeFormats[fileType].mime)
    .header(
      'Content-Disposition',
      `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    )
    .header('X-Content-Type-Options', 'nosniff')
    .header(
      'Content-Security-Policy',
      disposition === 'inline'
        ? "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        : "default-src 'none'; sandbox",
    )
    .send(file.bytes);
}

function signer(payload: JWTPayload) {
  return new SignJWT(payload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuedAt();
}

async function verify(token: unknown, secret: Uint8Array, audience?: string) {
  if (typeof token !== 'string' || token.length > 24 * 1024)
    throw new HttpError(401, 'ONLYOFFICE 请求签名无效');
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'], audience });
    return payload;
  } catch {
    throw new HttpError(401, 'ONLYOFFICE 请求签名无效');
  }
}

function pathFrom(base: URL, candidate: URL) {
  if (candidate.origin !== base.origin || !candidate.pathname.startsWith(base.pathname)) return;
  return candidate.pathname.slice(base.pathname.length);
}

function trustedSaveUrl(settings: OfficeSettings, value: string, fileType: OfficeFormat) {
  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch {
    throw new HttpError(400, 'ONLYOFFICE 保存地址无效');
  }
  const relative = pathFrom(settings.internal, candidate) ?? pathFrom(settings.browser, candidate);
  if (
    candidate.username ||
    candidate.password ||
    candidate.hash ||
    !relative ||
    !relative.toLowerCase().endsWith(`.${fileType}`)
  )
    throw new HttpError(400, 'ONLYOFFICE 保存地址与配置不一致');
  // Assign the pathname as data so encoded or literal authority markers cannot change hosts.
  const target = new URL(settings.internal);
  target.pathname += relative;
  target.search = candidate.search;
  return target;
}

async function fetchSavedFile(settings: OfficeSettings, source: string, fileType: OfficeFormat) {
  const target = trustedSaveUrl(settings, source, fileType);
  try {
    const response = await fetch(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const size = response.headers.get('content-length');
    if (!response.ok || !response.body || (size && Number(size) > maxOfficeFileBytes)) {
      await response.body?.cancel();
      throw new Error('download unavailable');
    }
    let length = 0;
    const chunks: Buffer[] = [];
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxOfficeFileBytes) throw new Error('download too large');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const result = Buffer.concat(chunks, length);
    validateOfficeFile(result, fileType);
    return result;
  } catch {
    return fail(502, 'ONLYOFFICE_FILE_UNAVAILABLE', '未能读取 ONLYOFFICE 保存的文件', true);
  }
}

export function registerOnlyOfficeRoutes(
  app: FastifyInstance,
  options: {
    db: AppDatabase;
    origin: string;
    secret: string;
    getRoot: () => string;
    scheduleIndex: (documentId: string) => void;
  },
) {
  const { db } = options;
  const configured = officeSettings(options.origin);
  const capabilitySecret = Buffer.from(options.secret, 'utf8');
  const sessions = configured.settings && officeSessionStore(db);
  const callbacks = new Map<string, Promise<unknown>>();
  function indexDocument(id: string) {
    try {
      options.scheduleIndex(id);
    } catch {
      // The saved original stays authoritative. The index also reconciles originals on search.
    }
  }
  function root() {
    const path = options.getRoot();
    assertRoot({ knowledgeRoot: path }, db);
    return { path, identity: officeDigest(readKnowledgeRootIdentity(path)) };
  }
  function office() {
    if (!configured.settings || !sessions)
      throw new HttpError(404, configured.error ?? 'ONLYOFFICE 尚未配置');
    return { settings: configured.settings, sessions };
  }
  function checkMaintenance() {
    if (
      (db.prepare('SELECT active FROM maintenance WHERE id=1').get() as { active: number }).active
    )
      fail(503, 'SYNC_IN_PROGRESS', '维护中，请稍后重试', true);
  }
  async function capability(
    req: FastifyRequest<{ Params: Params; Querystring: { token?: string } }>,
    use: CapabilityUse,
  ) {
    const claims = claimsValue.safeParse(await verify(req.query.token, capabilitySecret, use));
    if (!claims.success || req.params.id !== claims.data.id)
      throw new HttpError(401, 'ONLYOFFICE 会话无效');
    return claims.data;
  }
  async function capabilityUrl(
    settings: OfficeSettings,
    use: CapabilityUse,
    scope: z.infer<typeof claimsValue>,
    expires: number,
  ) {
    const action = use === 'onlyoffice-download' ? 'download' : 'callback';
    const url = new URL(`integrations/onlyoffice/${scope.id}/${action}`, settings.app);
    url.searchParams.set(
      'token',
      await signer(scope).setAudience(use).setExpirationTime(expires).sign(capabilitySecret),
    );
    return url.href;
  }

  app.get('/api/office/status', async () => ({
    enabled: !!configured.settings,
    ...(configured.error ? { error: configured.error } : {}),
  }));
  app.get('/api/office/documents', async () => ({ documents: listOfficeDocuments(root().path) }));
  app.post(
    '/api/office/documents',
    { bodyLimit: maxOfficeFileBytes + 8192 },
    async (req, reply) => {
      office();
      const part = await req.file({
        limits: { files: 1, fields: 0, fileSize: maxOfficeFileBytes + 1 },
      });
      if (!part || part.fieldname !== 'file') throw new HttpError(400, '请选择一个 Office 文件');
      const bytes = await part.toBuffer();
      if (part.file.truncated || bytes.length > maxOfficeFileBytes)
        throw new HttpError(413, '文件不能超过 10 MiB');
      const document = workspaceWriteSync(db, { kind: 'onlyoffice.upload' }, () =>
        addOfficeDocument(root().path, part.filename, bytes),
      );
      indexDocument(document.id);
      return reply.code(201).send(document);
    },
  );
  app.get<{ Params: Params }>('/api/office/documents/:id/download', (req, reply) => {
    const file = readOfficeDocument(root().path, documentId.parse(req.params.id));
    return officeDownload(file, reply);
  });
  app.get<{ Params: Params }>('/api/office/documents/:id/view', (req, reply) => {
    const file = readOfficeDocument(root().path, documentId.parse(req.params.id));
    if (file.metadata.fileType !== 'pdf') throw new HttpError(404, 'PDF 文件不存在');
    validateOfficeFile(file.bytes, 'pdf');
    return officeDownload(file, reply, 'inline');
  });
  app.post<{ Params: Params }>('/api/office/documents/:id/session', async (req) => {
    const { settings, sessions } = office();
    const id = documentId.parse(req.params.id);
    const library = root();
    const file = readOfficeDocument(library.path, id);
    const { fileType } = file.metadata;
    validateOfficeFile(file.bytes, fileType);
    const row = sessions.begin(library.identity, id, file.digest);
    const scope = { root: library.identity, id, key: row.key };
    const [url, callbackUrl] = await Promise.all([
      capabilityUrl(settings, 'onlyoffice-download', scope, row.expires),
      capabilityUrl(settings, 'onlyoffice-callback', scope, row.expires),
    ]);
    const editorConfig = {
      type: 'desktop',
      width: '100%',
      height: '100%',
      documentType: officeFormats[fileType].documentType,
      document: {
        fileType,
        key: row.key,
        title: file.metadata.name,
        url,
        permissions: { edit: true },
      },
      editorConfig: {
        callbackUrl,
        lang: 'zh-CN',
        mode: 'edit',
        user: { id: (req as FastifyRequest & { ownerId: string }).ownerId, name: 'DooKnow' },
        customization: { forcesave: true },
      },
    };
    const token = await signer(editorConfig).setExpirationTime('15m').sign(settings.secret);
    return { editorUrl: settings.browser.href, config: { ...editorConfig, token } };
  });

  app.get<{ Params: Params; Querystring: { token?: string } }>(
    '/integrations/onlyoffice/:id/download',
    async (req, reply) => {
      const { sessions } = office();
      const claims = await capability(req, 'onlyoffice-download');
      checkMaintenance();
      const library = root();
      if (library.identity !== claims.root) throw new HttpError(401, 'ONLYOFFICE 会话无效');
      const file = readOfficeDocument(library.path, claims.id);
      const row = sessions.current(library.identity, claims.id, file.digest);
      if (row?.key !== claims.key || row.closed || row.digest !== file.digest)
        throw new HttpError(409, 'Office 文件版本已变化，请重新打开');
      return officeDownload(file, reply);
    },
  );
  app.post<{ Params: Params; Querystring: { token?: string } }>(
    '/integrations/onlyoffice/:id/callback',
    { bodyLimit: 256 * 1024 },
    async (req) => {
      const { settings, sessions } = office();
      const claims = await capability(req, 'onlyoffice-callback');
      const body = callbackValue.parse(req.body);
      const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
      const bodyToken = (req.body as { token?: unknown }).token;
      const decoded = await verify(bearer ?? bodyToken, settings.secret);
      const signed = callbackValue.safeParse(decoded.payload ?? decoded);
      if (
        !signed.success ||
        (decoded.operation && decoded.operation !== 'callback') ||
        body.key !== signed.data.key ||
        body.status !== signed.data.status ||
        body.url !== signed.data.url ||
        body.key !== claims.key
      )
        throw new HttpError(401, 'ONLYOFFICE 回调签名与内容不一致');

      const issuedAt = decoded.iat ?? 0;
      const { key, status, url } = signed.data;
      const receipt = officeDigest(JSON.stringify({ status, url }));
      const queueKey = `${claims.root}/${claims.id}`;
      function current() {
        checkMaintenance();
        const library = root();
        if (library.identity !== claims.root) throw new HttpError(401, 'ONLYOFFICE 会话无效');
        const file = readOfficeDocument(library.path, claims.id);
        const row = sessions.current(library.identity, claims.id, file.digest);
        if (sessions.alreadySaved(key, receipt)) return undefined;
        if (
          row?.key !== key ||
          row.closed ||
          row.digest !== file.digest ||
          (issuedAt !== 0 && issuedAt < row.last_issued_at)
        )
          throw new HttpError(409, 'Office 文件版本已变化，请重新打开');
        return { library, row, fileType: file.metadata.fileType };
      }
      const work = (callbacks.get(queueKey) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const active = current();
          if (!active) return { error: 0 };
          if (status === 4) sessions.close(key);
          if (status === 3 || status === 7) return { error: 1 };
          if (status !== 2 && status !== 6) return { error: 0 };
          if (!url) throw new HttpError(400, 'ONLYOFFICE 回调缺少保存地址');
          const bytes = await fetchSavedFile(settings, url, active.fileType);
          const committed = workspaceWriteSync(db, { kind: 'onlyoffice.save' }, () => {
            const latest = current();
            if (!latest) return false;
            if (latest.fileType !== active.fileType)
              throw new HttpError(409, 'Office 文件格式已变化，请重新打开');
            sessions.update(
              latest.library,
              claims.id,
              latest.fileType,
              latest.row,
              bytes,
              receipt,
              status,
              issuedAt,
            );
            return true;
          });
          if (committed) indexDocument(claims.id);
          return { error: 0 };
        });
      callbacks.set(queueKey, work);
      try {
        return await work;
      } finally {
        if (callbacks.get(queueKey) === work) callbacks.delete(queueKey);
      }
    },
  );
}
