export type GitRemoteHost = 'github.com' | 'gitee.com';
export interface GitCredentialInput {
  id?: string;
  name: string;
  host: GitRemoteHost;
  kind: 'https' | 'ssh';
  username?: string;
  token?: string;
  privateKey?: string;
  passphrase?: string;
  knownHosts?: string;
  trustHost?: boolean;
  remember?: boolean;
}
export interface GitCredentialSummary {
  id: string;
  name: string;
  host: GitRemoteHost;
  kind: 'https' | 'ssh';
  username?: string;
  updatedAt: number;
  temporary?: boolean;
}
/** Server-only result: never serialize this type into an API response. */
export interface GitCredentialSecret extends GitCredentialSummary {
  token?: string;
  privateKey?: string;
  passphrase?: string;
  knownHosts?: string;
}
