import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDatabase } from '../../../packages/core/db.js';
import { HttpError } from '../../../packages/core/errors.js';
import { assertRoot } from '../../../packages/core/indexing/reconcile.js';
import { readKnowledgeRootIdentity } from '../../../packages/core/indexing/root-identity.js';
import { workspaceWriteSync } from '../../../packages/core/workspace/gate.js';
import { notebookFolderIdentity } from '../../../packages/core/office/notebook-files.js';
import {
  addOfficeDocument,
  listOfficeDocuments,
  officeDigest,
  officeIdPattern,
  readOfficeDocument,
  saveOfficeDocument,
} from '../../../packages/core/office/documents.js';
import {
  maxOfficeFileBytes,
  officeFormats,
  validateOfficeFile,
} from '../../../packages/core/office/formats.js';

const documentId = z.string().regex(officeIdPattern);
const uploadLimit = { bodyLimit: maxOfficeFileBytes + 8192 };
type Params = { id: string };

async function receiveFile(req: FastifyRequest) {
  const part = await req.file({
    limits: { files: 1, fields: 0, fileSize: maxOfficeFileBytes + 1 },
  });
  if (!part || part.fieldname !== 'file') throw new HttpError(400, '请选择一个办公文件');
  const bytes = await part.toBuffer();
  if (part.file.truncated || bytes.length > maxOfficeFileBytes)
    throw new HttpError(413, '文件不能超过 10 MiB');
  return { name: part.filename, bytes };
}

function version(root: string, digest: string) {
  return '"' + officeDigest(readKnowledgeRootIdentity(root)) + '.' + digest + '"';
}

function sendOriginal(
  file: ReturnType<typeof readOfficeDocument>,
  reply: FastifyReply,
  disposition: 'attachment' | 'inline',
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

export function registerOfficeRoutes(
  app: FastifyInstance,
  options: {
    db: AppDatabase;
    getRoot: () => string;
    scheduleIndex: (id: string) => void;
  },
) {
  function root() {
    const path = options.getRoot();
    assertRoot({ knowledgeRoot: path }, options.db);
    return path;
  }
  function index(id: string) {
    try {
      options.scheduleIndex(id);
    } catch {
      // A later search reconciles the index from the saved originals.
    }
  }

  app.get('/api/office/documents', async () => ({ documents: listOfficeDocuments(root()) }));
  app.post<{ Querystring: { folder?: string } }>(
    '/api/office/documents',
    uploadLimit,
    async (req, reply) => {
      const path = root();
      const identity = readKnowledgeRootIdentity(path);
      const folder = z
        .string()
        .max(4096)
        .parse(req.query.folder ?? '');
      const destination = notebookFolderIdentity(path, folder);
      const file = await receiveFile(req);
      const doc = workspaceWriteSync(options.db, { kind: 'office.upload' }, () => {
        if (path !== root() || identity !== readKnowledgeRootIdentity(path))
          throw new HttpError(409, '知识库已切换，请重新上传');
        if (destination !== notebookFolderIdentity(path, folder))
          throw new HttpError(409, '目标目录已变化，请重新选择');
        return addOfficeDocument(path, folder, file.name, file.bytes);
      });
      index(doc.id);
      return reply.code(201).send(doc);
    },
  );
  app.get<{ Params: Params }>('/api/office/documents/:id/download', async (req, reply) => {
    const path = root();
    const file = readOfficeDocument(path, documentId.parse(req.params.id));
    reply.header('ETag', version(path, file.digest));
    return sendOriginal(file, reply, 'attachment');
  });
  app.get<{ Params: Params }>('/api/office/documents/:id/view', async (req, reply) => {
    const file = readOfficeDocument(root(), documentId.parse(req.params.id));
    if (file.metadata.fileType !== 'pdf') throw new HttpError(404, 'PDF 文件不存在');
    validateOfficeFile(file.bytes, 'pdf');
    return sendOriginal(file, reply, 'inline');
  });
  app.put<{ Params: Params }>('/api/office/documents/:id', uploadLimit, async (req, reply) => {
    const id = documentId.parse(req.params.id);
    const expected = req.headers['if-match'];
    const match =
      typeof expected === 'string' && /^"([0-9a-f]{64})\.([0-9a-f]{64})"$/.exec(expected);
    if (!match) throw new HttpError(428, '缺少文件版本，请重新打开');
    const { bytes } = await receiveFile(req);
    const result = workspaceWriteSync(options.db, { kind: 'office.save' }, () => {
      const path = root();
      const file = readOfficeDocument(path, id);
      const type = file.metadata.fileType;
      if (type !== 'docx' && type !== 'xlsx') throw new HttpError(405, '此格式仅支持预览');
      const digest = officeDigest(bytes);
      const [, openedLibrary, openedDigest] = match;
      // A retry can find its previous write, but only in the library originally opened.
      if (
        openedLibrary !== officeDigest(readKnowledgeRootIdentity(path)) ||
        (openedDigest !== file.digest && digest !== file.digest)
      )
        throw new HttpError(409, '原件已更新，请先下载修改副本，再重新打开');
      const document =
        digest === file.digest
          ? file.metadata
          : saveOfficeDocument(path, id, type, bytes, file.digest);
      return { document, version: version(path, digest) };
    });
    index(id);
    return reply.header('ETag', result.version).send(result);
  });
}
