import type { PermissionPolicy } from './permissions.js';
export interface MCPConnectionAttempt {
  at: string;
  mode: 'oauth' | 'tunnel';
  outcome: 'authenticated' | 'rejected';
  code: string;
}

export interface MCPConnectionState {
  origin: string;
  plugin: { installed: boolean; enabled: boolean; state: string; configVersion: number | null };
  connection: {
    oauth: { ready: boolean; address: string; reason?: string };
    tunnel: { ready: boolean; address?: string; reason?: string };
  };
  externalVerification: 'unknown';
  latestConnectionAttempt: MCPConnectionAttempt | null;
  latestSuccessfulCall: { at: string; tool: string; client: string } | null;
  clients: {
    clientId: string;
    permissionPolicy?: PermissionPolicy;
    effectivePolicy?: PermissionPolicy;
    policyVersion?: 1 | 2;
    grantVersion?: number;
    active: boolean;
    scopes: string[];
    allowedPrefixes: string[];
    effectiveScopes: string[];
    effectivePrefixes: string[];
  }[];
}
