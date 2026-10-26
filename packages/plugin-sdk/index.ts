import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../../shared/knowledge-contracts.js';
import type { PluginStorage } from '../plugin-contracts/index.js';
import type { BlogNoteStatus, BlogPost, BlogPublishInput, BlogUnpublishInput } from '../../shared/blog-contracts.js';
export type Disposer = () => void | Promise<void>;
export type ServiceCallOptions = { deadline?: number; signal?: AbortSignal };
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
export interface PluginServices {
  knowledge: KnowledgePort;
  blog?: BlogPort;
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
  dataRoot: string;
  storage: PluginStorage;
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
