import type { z } from 'zod';
import type { PluginServices, KnowledgePort } from '../../../packages/plugin-sdk/index.js';
import type { Principal } from './contracts.js';
import * as c from './contracts.js';
import { BridgeError } from './errors.js';
export type CallOptions = { deadline?: number; signal?: AbortSignal };
export type KnowledgeClient = {
  [K in keyof KnowledgePort]: (p: Principal, input: any, options?: CallOptions) => Promise<any>
} & { externalWebOriginConfigured(): boolean };
const schemas: Record<keyof KnowledgePort, z.ZodType> = {
  info: c.noteInfo, list: c.listOutput, outline: c.outlineReply, readPage: c.readReply,
  create: c.writeSummary, update: c.writeSummary, patch: c.fileReply(c.patchResult), archive: c.archiveSummary,
  search: c.searchOutput, research: c.researchObject, refresh: c.refreshOutput,
  status: c.indexStatusOutput, operation: c.fileOperation, cancel: c.fileOperation,
};
const writes = new Set<keyof KnowledgePort>(['create','update','patch','archive','refresh']);
export function hostClient(services: () => PluginServices, configuration: () => { externalWebOrigin?: string }): KnowledgeClient {
  function origin() {
    const value = configuration().externalWebOrigin || '';
    if (!value) return '';
    try { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw Error(); return value; }
    catch { throw new BridgeError('INVALID_CONFIGURATION', 503); }
  }
  function links(value: any, base: string): any {
    if (Array.isArray(value)) return value.map(item => links(item, base));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'url' && typeof item === 'string') {
        if (base) { const old = new URL(item); result[key] = base + old.pathname + old.search + old.hash; }
      } else result[key] = links(item, base);
    }
    return result;
  }
  const client = { externalWebOriginConfigured: () => !!origin() } as KnowledgeClient;
  for (const name of Object.keys(schemas) as (keyof KnowledgePort)[]) client[name] = async (_p, input, options = {}) => {
    if (options.signal?.aborted || (options.deadline != null && Date.now() > options.deadline)) throw new BridgeError('CALL_CANCELLED', 499);
    let value: unknown;
    try { value = await services().knowledge[name](input); }
    catch (e) {
      if (e instanceof BridgeError) throw e;
      const error = e as any;
      if (typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code))
        throw new BridgeError(error.code, error.statusCode || 500, !!error.retryable, input?.requestId);
      throw new BridgeError(writes.has(name) ? 'OPERATION_OUTCOME_UNKNOWN' : 'INTERNAL_ERROR', 502, writes.has(name), input?.requestId);
    }
    const checked = schemas[name].safeParse(links(value, origin()));
    if (!checked.success) throw new BridgeError(writes.has(name) ? 'OPERATION_OUTCOME_UNKNOWN' : 'INVALID_BACKEND_RESPONSE', 502, writes.has(name), input?.requestId);
    return checked.data;
  };
  return client;
}
