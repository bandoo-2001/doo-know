import { z } from 'zod';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import {
  createKnowledgeDataDomain,
  readKnowledgeDataFile,
  writeKnowledgeDataFile,
} from '../knowledge-data.js';
import { blogDesignSchema, assertStudioImage } from './studio.js';
import { blogHash } from './resources.js';
import { BlogError } from './errors.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z
  .string()
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)));
const mediaDescriptor = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 ** 2),
  })
  .strict();
const portableState = z
  .object({
    version: z.literal(1),
    state: z
      .object({
        version: revision.refine((v) => v > 0),
        draft: blogDesignSchema,
        published: blogDesignSchema,
        publishedRevision: revision,
        publishedAt: timestamp.nullable(),
      })
      .strict(),
    history: z
      .array(
        z
          .object({
            revision: revision.refine((v) => v > 0),
            design: blogDesignSchema,
            publishedAt: timestamp,
          })
          .strict(),
      )
      .max(10),
    media: z.array(mediaDescriptor).max(100000),
  })
  .strict();
type PortableState = z.infer<typeof portableState>;
const domains = new WeakMap<
  AppDatabase,
  ReturnType<typeof createKnowledgeDataDomain<PortableState>>
>();
const mediaPath = (hash: string) => 'apps/blog/design-media/' + hash;
function invalid(message = '博客装修便携数据无效，已保留原有记录'): never {
  throw new BlogError(409, message, { code: 'KNOWLEDGE_DATA_INVALID' });
}
/** A separate domain keeps the legacy publication snapshot readable by old clients. */
export function portableBlogStudio(
  config: Pick<AppConfig, 'knowledgeRoot' | 'origin'>,
  db: AppDatabase,
) {
  const previous = domains.get(db);
  if (previous) {
    if (previous.root !== config.knowledgeRoot) invalid('博客装修资料目录已变化，请重新打开知识库');
    return previous;
  }
  function readMedia(descriptor: PortableState['media'][number]) {
    const bytes = readKnowledgeDataFile(config.knowledgeRoot, mediaPath(descriptor.hash));
    if (!bytes || bytes.length !== descriptor.size || blogHash(bytes) !== descriptor.hash)
      invalid('博客装修图片缺失或校验失败，已保留原有记录');
    try {
      assertStudioImage(bytes, descriptor.mime);
    } catch {
      invalid('博客装修图片类型校验失败');
    }
    return bytes;
  }
  function validate(input: unknown): PortableState {
    const parsed = portableState.safeParse(input);
    if (!parsed.success) invalid();
    const value = parsed.data;
    const hashes = new Map(value.media.map((m) => [m.hash, m]));
    if (hashes.size !== value.media.length) invalid();
    const history = new Map(value.history.map((h) => [h.revision, h]));
    if (
      history.size !== value.history.length ||
      value.history.some((h) => h.revision > value.state.publishedRevision)
    )
      invalid();
    const current = history.get(value.state.publishedRevision);
    if (
      value.state.publishedRevision > 0 &&
      (!current ||
        current.publishedAt !== value.state.publishedAt ||
        JSON.stringify(current.design) !== JSON.stringify(value.state.published))
    )
      invalid();
    if (!value.state.publishedRevision && value.state.publishedAt !== null) invalid();
    for (const design of [
      value.state.draft,
      value.state.published,
      ...value.history.map((h) => h.design),
    ]) {
      const images = [...new Set([design.profile.avatar, design.profile.cover].filter(Boolean))];
      let size = 0;
      for (const url of images) {
        const descriptor = hashes.get(url.slice('/blog/media/'.length));
        if (!descriptor) invalid('博客装修引用的图片缺失');
        size += descriptor.size;
      }
      if (size > 20 * 1024 ** 2) invalid('博客装修引用的图片总量超限');
    }
    for (const descriptor of value.media) readMedia(descriptor);
    return value;
  }
  const domain = createKnowledgeDataDomain(config, db, 'apps/blog/design.json', {
    tables: ['blog_design_state', 'blog_design_history', 'blog_design_media'],
    read: (): PortableState => {
      const row = db.prepare('SELECT * FROM blog_design_state WHERE id=1').get() as {
        version: number;
        draft_json: string;
        published_json: string;
        published_revision: number;
        published_at: string | null;
      };
      const history = (
        db.prepare('SELECT * FROM blog_design_history ORDER BY revision DESC').all() as {
          revision: number;
          design_json: string;
          published_at: string;
        }[]
      ).map((h) => ({
        revision: h.revision,
        design: JSON.parse(h.design_json),
        publishedAt: h.published_at,
      }));
      const media = (
        db.prepare('SELECT * FROM blog_design_media ORDER BY hash').all() as {
          hash: string;
          mime: PortableState['media'][number]['mime'];
          bytes: Buffer;
        }[]
      ).map((m) => {
        if (blogHash(m.bytes) !== m.hash) invalid('博客装修本地图片校验失败');
        const previous = readKnowledgeDataFile(config.knowledgeRoot, mediaPath(m.hash));
        if (previous && !previous.equals(m.bytes)) invalid('博客装修图片发生冲突，已保留两侧资料');
        if (!previous) writeKnowledgeDataFile(config.knowledgeRoot, mediaPath(m.hash), m.bytes);
        return { hash: m.hash, mime: m.mime, size: m.bytes.length };
      });
      return {
        version: 1,
        state: {
          version: row.version,
          draft: JSON.parse(row.draft_json),
          published: JSON.parse(row.published_json),
          publishedRevision: row.published_revision,
          publishedAt: row.published_at,
        },
        history,
        media,
      };
    },
    validate,
    write: (value) => {
      const media = value.media.map((m) => ({ ...m, bytes: readMedia(m) }));
      const current = db
        .prepare(
          'SELECT version,draft_json,published_json,published_revision,published_at FROM blog_design_state WHERE id=1',
        )
        .get() as {
        version: number;
        draft_json: string;
        published_json: string;
        published_revision: number;
        published_at: string | null;
      };
      const changed =
        JSON.stringify(JSON.parse(current.draft_json)) !== JSON.stringify(value.state.draft) ||
        JSON.stringify(JSON.parse(current.published_json)) !==
          JSON.stringify(value.state.published) ||
        current.published_revision !== value.state.publishedRevision ||
        current.published_at !== value.state.publishedAt;
      // Device-local counters can coincide. An imported different design must
      // invalidate confirmations made before synchronization, even on rollback.
      const localVersion = Math.max(value.state.version, current.version + Number(changed));
      db.prepare('DELETE FROM blog_design_history').run();
      db.prepare('DELETE FROM blog_design_media').run();
      db.prepare(
        'UPDATE blog_design_state SET version=?,draft_json=?,published_json=?,published_revision=?,published_at=? WHERE id=1',
      ).run(
        localVersion,
        JSON.stringify(value.state.draft),
        JSON.stringify(value.state.published),
        value.state.publishedRevision,
        value.state.publishedAt,
      );
      for (const h of value.history)
        db.prepare(
          'INSERT INTO blog_design_history(revision,design_json,published_at) VALUES(?,?,?)',
        ).run(h.revision, JSON.stringify(h.design), h.publishedAt);
      for (const m of media)
        db.prepare('INSERT INTO blog_design_media(hash,mime,bytes) VALUES(?,?,?)').run(
          m.hash,
          m.mime,
          m.bytes,
        );
    },
  });
  domains.set(db, domain);
  return domain;
}
