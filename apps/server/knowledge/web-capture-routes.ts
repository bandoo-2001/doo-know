import { lstatSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../../packages/core/errors.js';
import { isMissingSource, safePath, validName } from '../../../packages/core/files.js';
import { fail, KnowledgeError } from '../../../packages/core/knowledge/errors.js';
import { boundedText } from '../../../packages/core/knowledge/limits.js';
import type { NoteService } from '../../../packages/core/notes.js';
import {
  normalizeWebCaptureUrl,
  previewWebPage,
} from '../../../packages/core/web-capture/index.js';

const inbox = '00-Inbox';
const urlInput = z.string().trim().min(1).max(4096);
const maxMarkdownBytes = 256 * 1024;
const previewInput = z.object({ url: urlInput }).strict();
const saveInput = z
  .object({
    title: z.string().trim().min(1).max(240),
    sourceUrl: urlInput,
    markdown: z.string(),
    requestId: z.uuid(),
  })
  .strict();

function fileStem(title: string) {
  const normalized = title
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.md$/i, '')
    .replace(/^[. ]+|[. ]+$/g, '');
  const stem = boundedText(normalized, 150).trimEnd();
  if (!stem || !validName(stem + '.md')) return '网页摘录';
  return stem;
}

function ensureInbox(root: string, notes: NoteService) {
  function check() {
    if (!lstatSync(safePath(root, inbox, 'folder')).isDirectory())
      fail(409, 'WEB_CAPTURE_INBOX_UNAVAILABLE', '收集箱路径已被文件占用');
  }
  try {
    check();
  } catch (error) {
    if (!isMissingSource(error)) throw error;
    try {
      notes.createFolder('', inbox);
    } catch (creationError) {
      if (!(creationError instanceof HttpError && creationError.statusCode === 409))
        throw creationError;
      check();
    }
  }
}

export function registerWebCaptureRoutes(
  app: FastifyInstance,
  knowledgeRoot: () => string,
  notes: NoteService,
) {
  app.post(
    '/api/web-capture/preview',
    { bodyLimit: 32 * 1024, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (req) => previewWebPage(previewInput.parse(req.body).url),
  );
  app.post('/api/web-capture/save', async (req, reply) => {
    const input = saveInput.parse(req.body);
    const title = input.title.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
    const markdown = input.markdown.trimEnd();
    const source = normalizeWebCaptureUrl(input.sourceUrl);
    if (!title || !markdown.trim() || markdown.includes('\0'))
      fail(400, 'WEB_CAPTURE_INVALID_NOTE', '请填写有效的笔记标题和正文');
    if (Buffer.byteLength(markdown, 'utf8') > maxMarkdownBytes)
      fail(413, 'WEB_CAPTURE_TOO_LARGE', '正文超过 256 KiB，请缩短后保存');

    const heading = title.replace(/[\\`*_~\[\]<>#!&$]/g, '\\$&');
    const content = `# ${heading}\n\n原网页：<${source}>\n\n${markdown}\n`;
    const stem = fileStem(title);
    ensureInbox(knowledgeRoot(), notes);
    try {
      return reply
        .code(201)
        .send(notes.createNote(inbox, stem + '.md', content, `web-${input.requestId}`));
    } catch (error) {
      if (!(error instanceof KnowledgeError && error.code === 'NAME_CONFLICT')) throw error;
      // Each name has a stable operation ID, including the retry after a name collision.
      const name = `${stem} (${input.requestId.slice(0, 8)}).md`;
      return reply
        .code(201)
        .send(notes.createNote(inbox, name, content, `web-${input.requestId}-alternate`));
    }
  });
}
