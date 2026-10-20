export type GitJobKind =
  | 'test'
  | 'clone'
  | 'connect'
  | 'check'
  | 'push'
  | 'pull'
  | 'disconnect'
  | 'ssh-host';
export type GitJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_reconciliation';
export interface GitJobInput {
  kind: GitJobKind;
  requestId: string;
  url?: string;
  branch?: string;
  credentialId?: string;
  name?: string;
  parentPath?: string;
  timeZone?: string;
  expectedHead?: string;
  host?: string;
  confirm?: boolean;
}
export interface GitJob {
  id: string;
  requestId: string;
  kind: GitJobKind;
  status: GitJobStatus;
  phase: string;
  error?: string;
  result?: any;
  createdAt: number;
  updatedAt: number;
}
export interface GitRemoteStatus {
  pluginInstalled: boolean;
  pluginEnabled: boolean;
  repository: 'unbound' | 'missing' | 'ready' | 'unavailable';
  branch: string | null;
  head: string | null;
  changes: number;
  connection: null | {
    url: string;
    host: string;
    branch: string;
    remoteName: string;
    credentialId: string | null;
    credentialAvailable: boolean;
    lastCheckedAt: number | null;
    remoteHead: string | null;
    remoteExists: boolean;
    ahead: number | null;
    behind: number | null;
    writeVerified: boolean;
  };
  discoveredRemotes: { name: string; url: string }[];
  jobs: GitJob[];
  code?: string;
}
