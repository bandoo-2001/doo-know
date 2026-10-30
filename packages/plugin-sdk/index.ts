import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../../shared/knowledge-contracts.js';
import type { PluginStorage } from '../plugin-contracts/index.js';
import type { BlogNoteStatus, BlogPost, BlogPublishInput, BlogUnpublishInput } from '../../shared/blog-contracts.js';
import type { ToDooCommand } from '../../shared/to-doo-contracts.js';
import type { ToDooMcpQuery, ToDooMcpQueryResult, ToDooMcpContext, ToDooMcpContextResult, ToDooMcpReceipt } from '../../shared/to-doo-mcp-contracts.js';
export type Disposer = () => void | Promise<void>;
export type ServiceCallOptions = { deadline?: number; signal?: AbortSignal };
export interface ToDooPort {
  query(input: ToDooMcpQuery, options?: ServiceCallOptions): Promise<ToDooMcpQueryResult>;
  context(input: ToDooMcpContext, options?: ServiceCallOptions): Promise<ToDooMcpContextResult>;
  command(input: ToDooCommand, options?: ServiceCallOptions): Promise<ToDooMcpReceipt>;
}
export interface BlogPort {
  status(input: { noteId: string }, options?: ServiceCallOptions): Promise<BlogNoteStatus>;
  publish(input: BlogPublishInput, options?: ServiceCallOptions): Promise<BlogPost>;
  unpublish(input: BlogUnpublishInput, options?: ServiceCallOptions): Promise<BlogPost>;
}
export interface KnowledgePort {
  info(input: any, options?: ServiceCallOptions): Promise<any>;
  list(input: any, options?: ServiceCallOptions): Promise<any>;
  outline(input: any, options?: ServiceCallOptions): Promise<any>;
  readPage(input: any, options?: ServiceCallOptions): Promise<any>;
  create(input: any, options?: ServiceCallOptions): Promise<any>;
  update(input: any, options?: ServiceCallOptions): Promise<any>;
  patch(input: any, options?: ServiceCallOptions): Promise<any>;
  archive(input: any, options?: ServiceCallOptions): Promise<any>;
  search(input: any, options?: ServiceCallOptions): Promise<any>;
  research(input: any, options?: ServiceCallOptions): Promise<any>;
  refresh(input: any, options?: ServiceCallOptions): Promise<any>;
  status(input: any, options?: ServiceCallOptions): Promise<any>;
  operation(input: any, options?: ServiceCallOptions): Promise<any>;
  cancel(input: any, options?: ServiceCallOptions): Promise<any>;
}
export interface McpPermissionContext {
  policy: import('../../shared/permissions.js').PermissionPolicy;
  organization?: import('../../shared/organization-contracts.js').OrganizationContext;
}
export interface KnowledgeOrganizationPort {
  context(options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').OrganizationContext>;
  list(input: import('../../shared/organization-contracts.js').DirectoryListInput, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').DirectoryPage>;
  submit(input: import('../../shared/organization-contracts.js').OrganizeInput, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').OrganizationReply>;
  history(input: import('../../shared/organization-contracts.js').HistoryInput, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').HistoryPage>;
  undo(input: import('../../shared/organization-contracts.js').UndoOrganizationInput, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').OrganizationReply>;
  operation(input: {operationId?: string; requestId?: string}, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').OrganizationOperation>;
  cancel(input: {operationId: string}, options?: ServiceCallOptions): Promise<import('../../shared/organization-contracts.js').OrganizationOperation>;
}
export interface PluginServices {
  knowledgeTools?: import('../../shared/mcp-domain-tools.js').McpDomainToolPort;
  blogTools?: import('../../shared/mcp-domain-tools.js').McpDomainToolPort;
  toDooTools?: import('../../shared/mcp-domain-tools.js').McpDomainToolPort;
  transfers?: import('../../shared/mcp-domain-tools.js').McpDomainToolPort;
  permissions?: { context(options?: ServiceCallOptions): Promise<McpPermissionContext> };
  knowledgeOrganization?: KnowledgeOrganizationPort;
  knowledge: KnowledgePort;
  blog?: BlogPort;
  toDoo?: ToDooPort;
  authorization?: {
    list(): Promise<any[]>;
    revoke(clientId: string): Promise<{ revoked: boolean; cleanupPending: boolean }>;
    connection(): Promise<Record<string, any>>;
  };
  workspace?: {
    root: string;
    bindingVersion: number;
    read<T>(work: () => Promise<T>): Promise<T>;
    exec(
      args: string[],
      options?: {
        env?: Record<string, string>;
        input?: string | Buffer;
        maxBytes?: number;
        timeoutMs?: number;
      },
    ): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;
    exclusive<T>(work: () => Promise<T>): Promise<T>;
  };
  operations: {
    begin(kind: string, requestId: string, params: unknown): { fresh: boolean; operation: any };
    committing(id: string): void;
    finish(id: string, result: unknown): void;
    fail(id: string, code: string): void;
    pending(): {
      operationId: string;
      requestId: string;
      details: any;
      status: string;
      result: any;
    }[];
    stage(id: string, details: unknown): void;
    intent<T = any>(id: string): T | undefined;
    find(key: { id?: string; requestId?: string }): any;
  };
}
export interface HostCallContext {
  ownerId: string;
  requestId?: string;
  principal?: Principal;
  channel?: 'web' | 'mcp';
}
export interface PluginCall extends HostCallContext {
  input: any;
  services: PluginServices;
}
export interface ProtocolCall {
  request: IncomingMessage;
  response: ServerResponse;
  body: unknown;
  call: PluginCall;
}
export interface PluginContext {
  id: string;
  /** Machine-local files, including temporary indexes and other runtime state. */
  dataRoot: string;
  /** Machine-local state. Existing keys are deliberately not exported. */
  storage: PluginStorage;
  /** Durable user data that travels with the knowledge library; never store credentials here. */
  userData: PluginStorage;
  secrets: { getOrCreate(name: string): string };
  config(): Record<string, any>;
  /** Keep unfinished service calls owned by the plugin after its HTTP wait ends. */
  track?<T>(task: Promise<T>): Promise<T>;
  registerCommand(id: string, handler: (call: PluginCall) => unknown | Promise<unknown>): Disposer;
  registerProvider(id: string, handler: (call: PluginCall) => unknown | Promise<unknown>): Disposer;
  registerProtocol(id: string, handler: (call: ProtocolCall) => Promise<void>): Disposer;
  onDispose(dispose: Disposer): void;
  onConfigure(validate: (config: Record<string, any>) => void | Promise<void>): void;
}
export interface PluginModule {
  activate(context: PluginContext): void | Disposer | Promise<void | Disposer>;
}
