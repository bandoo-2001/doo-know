import type { PermissionPolicy } from './permissions.js';

export interface McpApiClientView {
  clientId: string;
  name: string;
  status: 'active' | 'requires_reauthorization' | 'revoked';
  version: number;
  grantVersion: number;
  permissionPolicy: PermissionPolicy;
  effectivePolicy?: PermissionPolicy;
  key: {
    id: string;
    suffix: string;
    version: number;
    createdAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
  } | null;
}
