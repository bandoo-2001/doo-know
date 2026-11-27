import type { GitRemoteHost } from './git-contracts.js';

export type GitRemote = {
  url: string;
  host: GitRemoteHost;
  protocol: 'https' | 'ssh';
  repository: string;
};
/** Parse the original string, before URL parsers can silently remove dot segments or default ports. */
export function parseGitRemote(value: string): GitRemote | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%?#\x00-\x1f\x7f]/.test(value))
    return undefined;
  const match = value.match(
    /^(https:\/\/|ssh:\/\/git@|git@)(github\.com|gitee\.com)(\/|:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (!match || (match[1] === 'git@' ? match[3] !== ':' : match[3] !== '/')) return undefined;
  const owner = match[4],
    name = match[5].replace(/\.git$/, '');
  if (
    !owner ||
    !name ||
    [owner, name].some(
      (part) => part === '.' || part === '..' || part.startsWith('-') || part.endsWith('.'),
    )
  )
    return undefined;
  const host = match[2] as GitRemoteHost,
    protocol = match[1] === 'https://' ? 'https' : 'ssh';
  const repository = `${owner}/${name}`;
  return {
    url: `${protocol === 'https' ? 'https://' : 'ssh://git@'}${host}/${repository}.git`,
    host,
    protocol,
    repository,
  };
}
