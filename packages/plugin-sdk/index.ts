import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Principal } from '../../shared/knowledge-contracts.js';
import type { PluginStorage } from '../plugin-contracts/index.js';
export type Disposer = () => void | Promise<void>;
export interface KnowledgePort {
  info(input: any): Promise<any>;
  list(input: any): Promise<any>;
  outline(input: any): Promise<any>;
  readPage(input: any): Promise<any>;
  create(input: any): Promise<any>;
  update(input: any): Promise<any>;
  patch(input: any): Promise<any>;
  archive(input: any): Promise<any>;
  search(input: any): Promise<any>;
  research(input: any): Promise<any>;
  refresh(input: any): Promise<any>;
  status(input: any): Promise<any>;
  operation(input: any): Promise<any>;
  cancel(input: any): Promise<any>;
}
export interface PluginServices {
  knowledge: KnowledgePort;
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
  registerCommand(id: string, handler: (call: PluginCall) => unknown | Promise<unknown>): Disposer;
  registerProvider(id: string, handler: (call: PluginCall) => unknown | Promise<unknown>): Disposer;
  registerProtocol(id: string, handler: (call: ProtocolCall) => Promise<void>): Disposer;
  onDispose(dispose: Disposer): void;
  onConfigure(validate: (config: Record<string, any>) => void | Promise<void>): void;
}
export interface PluginModule {
  activate(context: PluginContext): void | Disposer | Promise<void | Disposer>;
}
