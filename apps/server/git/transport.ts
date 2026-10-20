import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, lstat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import type { AppDatabase } from '../../../packages/core/db.js';
import { fail } from '../../../packages/core/knowledge/errors.js';
import { workspaceExec, type ExecOptions } from '../../../packages/core/workspace/exec.js';
import { workspacePermit } from '../../../packages/core/workspace/gate.js';
import { guardedProcess } from '../../../packages/core/processes/guarded.js';
import type { HostConfig } from '../../../shared/platform-contracts.js';
import type { GitCredentialSecret, GitRemoteHost } from '../../../shared/git-contracts.js';
import { validGitHost, validateKnownHosts } from './credentials.js';

export type GitResult = { stdout: Buffer; stderr: Buffer; code: number };
export type GitExec = (cwd: string, args: string[], options?: ExecOptions) => Promise<GitResult>;
export type GitRunOptions = {
  url?: string;
  credential?: GitCredentialSecret;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};
export type GitRemote = {
  url: string;
  host: GitRemoteHost;
  protocol: 'https' | 'ssh';
  repository: string;
};
/** Parse the original string, before URL parsers can silently remove dot segments or default ports. */
export function normalizeRemote(value: string): GitRemote {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\%?#\x00-\x1f\x7f]/.test(value))
    fail(400, 'GIT_INVALID_REMOTE');
  const match = value.match(
    /^(https:\/\/|ssh:\/\/git@|git@)(github\.com|gitee\.com)(\/|:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/,
  );
  if (!match || (match[1] === 'git@' ? match[3] !== ':' : match[3] !== '/'))
    fail(400, 'GIT_INVALID_REMOTE');
  const owner = match[4],
    name = match[5].replace(/\.git$/, '');
  if (
    !owner ||
    !name ||
    [owner, name].some(
      (part) => part === '.' || part === '..' || part.startsWith('-') || part.endsWith('.'),
    )
  )
    fail(400, 'GIT_INVALID_REMOTE');
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
const fixedConfig = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.alternateRefsCommand=/bin/false',
  'core.attributesFile=/dev/null',
  'credential.helper=',
  'credential.interactive=false',
  'http.extraHeader=',
  'http.followRedirects=false',
  'http.sslVerify=true',
  'http.cookieFile=',
  'http.saveCookies=false',
  'protocol.allow=never',
  'protocol.https.allow=always',
  'protocol.ssh.allow=always',
  'protocol.file.allow=never',
  'protocol.ext.allow=never',
  'submodule.recurse=false',
  'fetch.recurseSubmodules=false',
  'push.recurseSubmodules=no',
  'fetch.fsckObjects=true',
  'transfer.fsckObjects=true',
  'gc.auto=0',
  'maintenance.auto=false',
  'core.askPass=',
];
const hardening = fixedConfig.flatMap((value) => ['-c', value]);
const fixedEnv = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_ALLOW_PROTOCOL: 'https:ssh',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_PAGER: 'cat',
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
  SSH_AUTH_SOCK: '',
  LC_ALL: 'C.UTF-8',
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) fail(409, 'GIT_COMMAND_CANCELLED');
}
function classified(error: string): string {
  // Remote URLs and porcelain ref columns are identifiers, not failure reasons.
  const diagnostic = error
    .replace(/\b(?:https?|ssh):\/\/[^\s"'<>]+|\bgit@[a-z0-9.-]+:[^\s"'<>]+/gi, '[remote]')
    .replace(/^[ *+=!\-]\t[^\t\r\n]*\t/gm, '[push] ');
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed|offending .* key/i.test(
      diagnostic,
    )
  )
    return 'GIT_HOST_KEY_CHANGED';
  if (
    /authentication failed|could not read username|terminal prompts disabled|permission denied \(publickey|invalid username or (?:password|token)|could not read password|unable to get password from user/i.test(
      diagnostic,
    )
  )
    return 'GIT_AUTH_FAILED';
  if (
    /returned error:\s*403\b|\bHTTP(?:\/\d+(?:\.\d+)?)?\s+403\b|permission .*denied|access denied|write access .*not granted|key [^\r\n]*marked as read[ -]only|repository not found|does not appear to be a git repository/i.test(
      diagnostic,
    )
  )
    return 'GIT_PERMISSION_DENIED';
  if (
    /\((?:non-fast-forward|fetch first)\)|\[rejected\]|\[remote rejected\]|pre-receive hook declined|protected branch/i.test(
      diagnostic,
    )
  )
    return 'GIT_REMOTE_REJECTED';
  if (/timed out|\b(?:SSL\s+)?(?:connection|operation|request|socket|connect|handshake)\s+timeout\b|\btimeout\s+(?:expired|reached)\b/i.test(diagnostic))
    return 'GIT_COMMAND_TIMEOUT';
  return 'GIT_NETWORK_FAILED';
}
function cleanError(error: unknown, signal?: AbortSignal): never {
  cancelled(signal);
  const code = (error as { code?: string })?.code;
  if (code === 'PROCESS_CONTAINMENT_UNAVAILABLE')
    fail(503, code, '后台任务暂时无法启动，请联系部署者检查安装和系统支持。');
  if (
    code &&
    [
      'GIT_UNSAFE_CONFIG',
      'GIT_INVALID_REMOTE',
      'GIT_CREDENTIAL_UNAVAILABLE',
      'GIT_AUTH_FAILED',
      'GIT_PERMISSION_DENIED',
      'GIT_NETWORK_FAILED',
      'GIT_COMMAND_TIMEOUT',
      'GIT_REMOTE_REJECTED',
      'GIT_HOST_KEY_CHANGED',
      'GIT_COMMAND_CANCELLED',
      'GIT_INVALID_HOST_KEY',
      'GIT_OUTPUT_TOO_LARGE',
      'WORKSPACE_BUSY',
      'WORKSPACE_PERMIT_REQUIRED',
    ].includes(code)
  )
    fail(code === 'GIT_COMMAND_TIMEOUT' ? 504 : 400, code);
  if (code === 'PROCESS_TIMEOUT') fail(504, 'GIT_COMMAND_TIMEOUT');
  if (code === 'PROCESS_OUTPUT_TOO_LARGE') fail(413, 'GIT_OUTPUT_TOO_LARGE');
  fail(502, 'GIT_NETWORK_FAILED');
}
export function gitTransport(
  config: HostConfig,
  db: AppDatabase,
  options: { exec?: GitExec } = {},
) {
  const exec: GitExec = options.exec || ((cwd, args, opts) => workspaceExec(db, cwd, args, opts));
  async function checkConfig(cwd: string, opts: ExecOptions) {
    const result = await exec(
      cwd,
      [...hardening, 'config', '--local', '--null', '--list', '--no-includes'],
      opts,
    );
    if (result.code !== 0) {
      // A clone's parent may not be a repository. Malformed or unreadable existing config is unsafe.
      if (
        result.code === 128 &&
        /--local can only be used inside a git repository|not in a git directory/.test(
          result.stderr.toString(),
        )
      )
        return;
      fail(400, 'GIT_UNSAFE_CONFIG');
    }
    for (const entry of result.stdout.toString().split('\0').filter(Boolean)) {
      const at = entry.indexOf('\n'),
        key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase(),
        value = at < 0 ? '' : entry.slice(at + 1);
      if (
        /^(url\.|http\.|https\.|credential\.|filter\.|include\.|includeif\.|protocol\.|alias\.|submodule\.)/.test(
          key,
        ) ||
        /^core\.(sshcommand|gitproxy|fsmonitor|hookspath|alternaterefscommand)$/.test(key) ||
        key === 'extensions.worktreeconfig' ||
        /^remote\..*\.(pushurl|uploadpack|receivepack|proxy|proxyauthmethod|vcs|foreignvcs|serveroption)$/.test(
          key,
        )
      )
        fail(400, 'GIT_UNSAFE_CONFIG');
      // Git resolves remote names before URLs, including a name equal to the URL itself.
      const remoteName = key.match(/^remote\.(.*)\.[^.]+$/)?.[1];
      if (remoteName && /[:@]/.test(remoteName)) fail(400, 'GIT_UNSAFE_CONFIG');
      if (/^remote\..*\.url$/.test(key)) {
        try {
          normalizeRemote(value);
        } catch {
          fail(400, 'GIT_UNSAFE_CONFIG');
        }
      }
    }
    // Resolve through Git so this also covers bare repositories and linked worktrees.
    // rev-parse does not enumerate alternate refs and receives no credential environment.
    const objectPaths = await exec(
      cwd,
      [
        ...hardening,
        'rev-parse',
        '--path-format=absolute',
        '--git-path',
        'objects/info/alternates',
        '--git-path',
        'objects/info/http-alternates',
        '--git-path',
        'info/grafts',
      ],
      opts,
    );
    const paths = objectPaths.stdout.toString().trimEnd().split('\n');
    if (objectPaths.code !== 0 || paths.length !== 3 || paths.some((path) => !isAbsolute(path)))
      fail(400, 'GIT_UNSAFE_CONFIG');
    for (const path of paths) {
      try {
        // Any existing file, directory or dangling symlink is unsafe; do not read its contents.
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        fail(400, 'GIT_UNSAFE_CONFIG');
      }
      fail(400, 'GIT_UNSAFE_CONFIG');
    }
  }
  return {
    async run(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
      cancelled(opts.signal);
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
        fail(400, 'INVALID_GIT_ARGUMENT');
      const remote = opts.url === undefined ? undefined : normalizeRemote(opts.url);
      if (remote) {
        if (!args.some((arg) => arg === opts.url || arg === remote.url))
          fail(400, 'GIT_INVALID_REMOTE');
        for (const arg of args) {
          if (
            /^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(arg) &&
            normalizeRemote(arg).url !== remote.url
          )
            fail(400, 'GIT_INVALID_REMOTE');
        }
      }
      if (!remote && ['clone', 'fetch', 'push', 'pull', 'ls-remote'].includes(args[0]))
        fail(400, 'GIT_INVALID_REMOTE');
      const credential = opts.credential;
      if (
        credential &&
        (!remote || credential.host !== remote.host || credential.kind !== remote.protocol)
      )
        fail(404, 'GIT_CREDENTIAL_UNAVAILABLE');
      const env: Record<string, string> = { ...fixedEnv };
      const execution: ExecOptions = {
        env,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? 120000,
        maxBytes: opts.maxBytes ?? 8 * 1024 * 1024,
      };
      let temporary: string | undefined;
      try {
        await checkConfig(cwd, execution);
        cancelled(opts.signal);
        const extra: string[] = [];
        if (remote) {
          const parent = join(config.dataRoot, 'git-auth');
          await mkdir(parent, { recursive: true, mode: 0o700 });
          temporary = await mkdtemp(join(parent, 'operation-'));
          // A child-only home prevents libcurl from picking up the account's .netrc.
          // The host process environment and user's actual home are never changed.
          env.HOME = temporary;
          env.XDG_CONFIG_HOME = temporary;
        }
        if (remote?.protocol === 'https' && credential) {
          if (
            !credential.token ||
            /[\r\n\0]/.test(credential.token) ||
            /[\r\n\0:]/.test(credential.username || '')
          )
            fail(400, 'GIT_AUTH_FAILED');
          env.DOOKNOW_GIT_AUTH_HEADER = `Authorization: Basic ${Buffer.from(`${credential.username || 'oauth2'}:${credential.token}`).toString('base64')}`;
          extra.push(
            `--config-env=http.https://${remote.host}/.extraHeader=DOOKNOW_GIT_AUTH_HEADER`,
          );
        }
        if (remote?.protocol === 'ssh') {
          if (!credential?.privateKey || !credential.knownHosts) fail(401, 'GIT_AUTH_FAILED');
          const key = join(temporary!, 'identity'),
            hosts = join(temporary!, 'known_hosts'),
            askpass = join(temporary!, 'askpass');
          await writeFile(key, credential.privateKey, { mode: 0o600, flag: 'wx' });
          await writeFile(hosts, credential.knownHosts, { mode: 0o600, flag: 'wx' });
          env.DOOKNOW_GIT_KEY_FILE = key;
          env.DOOKNOW_GIT_HOSTS_FILE = hosts;
          env.GIT_SSH_COMMAND = `/usr/bin/ssh -F /dev/null -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o IdentityAgent=none -o GlobalKnownHostsFile=/dev/null -o UserKnownHostsFile=${quote(hosts)} -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PreferredAuthentications=publickey -o AddKeysToAgent=no -o ForwardAgent=no -o PermitLocalCommand=no -o UpdateHostKeys=no -o VerifyHostKeyDNS=no -o ConnectTimeout=20 -i ${quote(key)}`;
          env.GIT_SSH_VARIANT = 'ssh';
          if (credential.passphrase) {
            await writeFile(
              askpass,
              '#!/bin/sh\nprintf \'%s\\n\' "$DOOKNOW_GIT_KEY_PASSPHRASE"\n',
              { mode: 0o700, flag: 'wx' },
            );
            env.SSH_ASKPASS = askpass;
            env.SSH_ASKPASS_REQUIRE = 'force';
            env.DISPLAY = ':0';
            env.DOOKNOW_GIT_KEY_PASSPHRASE = credential.passphrase;
          } else env.GIT_SSH_COMMAND += ' -o BatchMode=yes';
        }
        cancelled(opts.signal);
        const result = await exec(
          cwd,
          [
            ...hardening,
            ...extra,
            ...args.map((arg) => (remote && arg === opts.url ? remote.url : arg)),
          ],
          execution,
        );
        cancelled(opts.signal);
        if (remote && result.code !== 0)
          fail(502, classified(Buffer.concat([result.stderr, result.stdout]).toString()));
        // Successful network stderr may contain remote-controlled text. It is never needed by callers.
        return remote ? { ...result, stderr: Buffer.alloc(0) } : result;
      } catch (error) {
        if (remote) cleanError(error, opts.signal);
        throw error;
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
        delete env.DOOKNOW_GIT_AUTH_HEADER;
        delete env.DOOKNOW_GIT_KEY_PASSPHRASE;
      }
    },
    async scanHost(
      host: string,
      signal?: AbortSignal,
    ): Promise<{ host: string; knownHosts: string; fingerprints: string[] }> {
      if (!validGitHost(host)) fail(400, 'GIT_INVALID_REMOTE');
      cancelled(signal);
      const token = workspacePermit(db, false);
      try {
        const result = await guardedProcess(
          db,
          { kind: 'workspace', token },
          '/usr/bin/ssh-keyscan',
          ['-T', '10', '-t', 'ed25519,ecdsa,rsa', host],
          config.dataRoot,
          {
            signal,
            timeoutMs: 15000,
            maxBytes: 65536,
            env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' },
          },
        ).wait;
        cancelled(signal);
        if (result.code !== 0) fail(502, 'GIT_NETWORK_FAILED');
        const knownHosts = validateKnownHosts(result.stdout.toString(), host);
        const fingerprints = knownHosts
          .trim()
          .split('\n')
          .map((line) => {
            const [, kind, key] = line.split(/\s+/);
            return `${kind} SHA256:${createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')}`;
          });
        return { host, knownHosts, fingerprints };
      } catch (error) {
        return cleanError(error, signal);
      }
    },
  };
}
