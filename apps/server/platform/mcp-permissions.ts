import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { platformRuntime } from './runtime.js';
import type { PermissionPolicy, ResourceRef } from '../../../shared/permissions.js';
import {
  normalizePermissionPolicy,
  currentBlogInstanceId,
} from '../../../packages/core/auth/permissions.js';
import {
  directoryByPath,
  syncDirectoryCatalog,
} from '../../../packages/core/organization/catalog.js';
import { webPrincipal } from '../../../packages/core/knowledge/core.js';

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
    let policy: PermissionPolicy;
    if (config.permissionPolicy) policy = normalizePermissionPolicy(config.permissionPolicy);
    else {
      const resources: ResourceRef[] = [];
      for (const path of config.allowedPrefixes || webPrincipal.allowedPrefixes) {
        const dir = directoryByPath(db, path),
          note = notes.find((n) => n.path === path);
        if (dir) resources.push({ kind: 'directory', id: dir.id });
        else if (note) resources.push({ kind: 'note', id: note.id });
      }
      policy = {
        version: 2,
        domains: {
          knowledge: {
            enabled: true,
            ownerId,
            instanceId: identity.libraryId,
            actions: [
              'read',
              ...(config.readOnly === false ? ['write', 'archive'] : []),
              ...(config.allowIndex === true ? ['index'] : []),
            ],
            resources: { mode: 'selected', resources },
          },
          blog: {
            enabled: config.allowPublish === true && config.readOnly === false,
            ownerId,
            instanceId: blogInstance,
            actions:
              config.allowPublish === true && config.readOnly === false ? ['read', 'publish'] : [],
            resources: { mode: 'all' },
          },
        },
      };
    }
    const articles = db.prepare('SELECT id,slug FROM blog_posts ORDER BY slug').all() as {
      id: string;
      slug: string;
    }[];
    return {
      policy,
      resources: {
        knowledge: [
          ...directories.map((d) => ({ kind: 'directory', id: d.id, label: d.path })),
          ...notes.map((n) => ({ kind: 'note', id: n.id, label: n.path })),
        ],
        blog: [
          { kind: 'site', id: blogInstance, label: '整个博客' },
          ...articles.map((p) => ({ kind: 'post', id: p.id, label: p.slug })),
        ],
      },
    };
  });
}
