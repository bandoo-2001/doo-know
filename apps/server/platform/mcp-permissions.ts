import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { platformRuntime } from './runtime.js';
import type { PermissionPolicy } from '../../../shared/permissions.js';
import {
  currentBlogInstanceId,
  currentToDooInstanceId,
} from '../../../packages/core/auth/permissions.js';
import {
  syncDirectoryCatalog,
} from '../../../packages/core/organization/catalog.js';
import { mcpPermissionCeiling } from '../../../packages/core/auth/grants.js';

/** Owner inventory, separate from MCP caller discovery and its resource filters. */
export function registerMcpPermissionRoutes(
  app: FastifyInstance,
  db: AppDatabase,
  platform: ReturnType<typeof platformRuntime>,
) {
  app.get('/api/platform/mcp/permissions', async (request) => {
    const ownerId = (request as any).ownerId as string;
    const runtime = platform.get();
    const identity = syncDirectoryCatalog(runtime.config, db);
    runtime.notes.scan();
    const directories = db
      .prepare('SELECT id,path FROM organization_directories WHERE active=1 ORDER BY path')
      .all() as { id: string; path: string }[];
    const notes = db.prepare('SELECT id,path FROM notes WHERE active=1 ORDER BY path').all() as {
      id: string;
      path: string;
    }[];
    const row = db
      .prepare("SELECT config_json FROM platform_plugins WHERE id='mcp' AND installed=1")
      .get() as { config_json: string } | undefined;
    const config = row ? JSON.parse(row.config_json) : {};
    const blogInstance = currentBlogInstanceId(db);
    // Unavailable optional task data must not prevent editing the other domain settings.
    let taskLists: { id: string; name: string; deletedAt?: string | null }[] = [];
    try {
      taskLists = runtime.toDoo.snapshot({ kind: 'list', limit: 1000 }).lists;
    } catch {}
    const taskInstance = currentToDooInstanceId(db);
    const policy: PermissionPolicy = mcpPermissionCeiling(db, ownerId, config);
    policy.domains['to-doo'] ??= {
      enabled: false,
      ownerId,
      instanceId: taskInstance,
      actions: [],
      resources: { mode: 'all' },
    };
    const articles = db.prepare('SELECT id,slug FROM blog_posts ORDER BY slug').all() as {
      id: string;
      slug: string;
    }[];
    return {
      policy,
      bindings: {
        knowledge: { ownerId, instanceId: identity.libraryId },
        blog: { ownerId, instanceId: blogInstance },
        'to-doo': { ownerId, instanceId: taskInstance },
      },
      resources: {
        knowledge: [
          ...directories.map((d) => ({ kind: 'directory', id: d.id, label: d.path, path: d.path })),
          ...notes.map((n) => ({ kind: 'note', id: n.id, label: n.path, path: n.path })),
        ],
        'to-doo': [
          { kind: 'list', id: 'inbox', label: '收集箱' },
          ...taskLists
            .filter((list) => !list.deletedAt)
            .map((list) => ({ kind: 'list', id: list.id, label: list.name })),
        ],
        blog: [
          { kind: 'site', id: blogInstance, label: '整个博客' },
          ...articles.map((p) => ({ kind: 'post', id: p.id, label: p.slug })),
        ],
      },
    };
  });
}
