import { accessSync, constants, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
export function setupDirectoryPolicy(config: HostConfig) {
  const strictChild = (path: string, parent: string) => path.startsWith(parent + sep);
  const overlap = (a: string, b: string) => a === b || strictChild(a, b) || strictChild(b, a);
  return function checkRoot(input: unknown, options: { browse?: boolean; missing?: boolean } = {}) {
    if (typeof input !== 'string' || !input || input.includes('\0') || !input.startsWith('/'))
      fail(400, 'INVALID_KNOWLEDGE_ROOT');
    const path = resolve(input);
    const allowed = (config.allowedKnowledgeBases || [homedir()]).map((p) => resolve(p));
    const parent = allowed.find((p) => strictChild(path, p) || (options.browse && path === p));
    if (!parent) fail(403, 'FORBIDDEN_KNOWLEDGE_ROOT');
    try {
      if (realpathSync(parent) !== parent) fail(400, 'INVALID_KNOWLEDGE_ROOT');
      let current = parent;
      for (const component of relative(parent, path).split(sep).filter(Boolean)) {
        if (component.startsWith('.')) fail(400, 'INVALID_KNOWLEDGE_ROOT');
        current = resolve(current, component);
        let s;
        try {
          s = lstatSync(current);
        } catch (e) {
          if (options.missing && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
        if (!s.isDirectory() || s.isSymbolicLink()) fail(400, 'INVALID_KNOWLEDGE_ROOT');
      }
      for (const forbidden of [
        config.dataRoot,
        config.applicationRoot,
        config.installRoot,
        config.searchRuntimeRoot,
        config.searchModelsRoot,
        config.profileFile && resolve(config.profileFile, '..'),
        config.pluginRoot || resolve(config.dataRoot, '../plugins'),
        config.secretFile && resolve(config.secretFile, '..'),
        config.distribution?.tokenFile,
      ].filter(Boolean) as string[]) {
        let canonical = resolve(forbidden);
        try {
          canonical = realpathSync(canonical);
        } catch {}
        if (
          options.browse
            ? path === canonical || strictChild(path, canonical)
            : overlap(path, canonical)
        )
          fail(403, 'FORBIDDEN_KNOWLEDGE_ROOT');
      }
      if (options.missing) return { path, dev: '', ino: '' };
      accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
      const s = lstatSync(path, { bigint: true });
      return { path: realpathSync(path), dev: String(s.dev), ino: String(s.ino) };
    } catch (e) {
      if (e instanceof Error && 'statusCode' in e) throw e;
      fail(400, 'INVALID_KNOWLEDGE_ROOT');
    }
  };
}
