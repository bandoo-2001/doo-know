import { execFileSync } from 'node:child_process';
import type { AppDatabase } from '../../packages/core/db.js';
import { workspaceExec } from '../../packages/core/workspace/exec.js';
import type { GitExec } from '../../apps/server/git/transport.js';

/** Constructor-only test transport. No profile/environment can enable this mapping. */
export function localGitTransport(db: AppDatabase, repositories: Record<string, string>): GitExec {
  return async (cwd, args, options) => {
    const network = args.some((a) => ['clone', 'fetch', 'push', 'ls-remote'].includes(a));
    const url = network ? args.find((a) => Object.hasOwn(repositories, a)) : undefined;
    if (network && !url) throw Error('Unmapped test repository; external network forbidden');
    const mapped = args.map((a) =>
      a === 'protocol.file.allow=never'
        ? 'protocol.file.allow=always'
        : url && a === url
          ? repositories[url]
          : a,
    );
    const result = await workspaceExec(db, cwd, mapped, {
      ...options,
      env: { ...options?.env, GIT_ALLOW_PROTOCOL: 'file:https:ssh' },
    });
    if (url && args.includes('clone') && result.code === 0)
      execFileSync('git', ['-C', args.at(-1)!, 'config', 'remote.origin.url', url], {
        stdio: 'pipe',
      });
    return result;
  };
}
