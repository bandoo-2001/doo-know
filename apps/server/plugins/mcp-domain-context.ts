import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../../../packages/core/db.js';
import type { Principal } from '../../../shared/knowledge-contracts.js';
import type { ServiceCallOptions } from '../../../packages/plugin-sdk/index.js';
import type { platformRuntime } from '../platform/runtime.js';
import type { McpTransferStore } from '../../../shared/mcp-domain-tools.js';

export type McpDomainContext = {
  config: AppConfig;
  db: AppDatabase;
  runtime: ReturnType<ReturnType<typeof platformRuntime>['get']>;
  authorize(scopes: readonly string[], options?: ServiceCallOptions): Principal;
  toDooAccess(options?: ServiceCallOptions): { listIds: string[]; domains: string[]; resourceListIds?: string[] };
  transfers: McpTransferStore;
};
