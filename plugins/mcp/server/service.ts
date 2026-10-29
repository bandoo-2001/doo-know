import type { z } from 'zod';
import type { PluginServices, KnowledgePort } from '../../../packages/plugin-sdk/index.js';
import type { Principal } from './contracts.js';
import * as c from './contracts.js';
import { BridgeError, annotateError } from './errors.js';
import { toDooMcpQueryResult, toDooMcpContextResult, toDooMcpReceipt } from '../../../shared/to-doo-mcp-contracts.js';
export type CallOptions = { deadline?: number; signal?: AbortSignal };
export type KnowledgeClient = {
  [K in keyof KnowledgePort]: (p: Principal, input: any, options?: CallOptions) => Promise<any>
} & {
  blogStatus(p: Principal, input: any, options?: CallOptions): Promise<any>;
  blogPublish(p: Principal, input: any, options?: CallOptions): Promise<any>;
  blogUnpublish(p: Principal, input: any, options?: CallOptions): Promise<any>;
  toDooQuery(p: Principal, input: any, options?: CallOptions): Promise<any>;
  toDooContext(p: Principal, input: any, options?: CallOptions): Promise<any>;
  toDooCommand(p: Principal, input: any, options?: CallOptions): Promise<any>;
  externalWebOriginConfigured(): boolean;
};
const schemas: Record<keyof KnowledgePort, z.ZodType> = {
  info: c.noteInfo, list: c.listOutput, outline: c.outlineReply, readPage: c.readReply,
  create: c.writeSummary, update: c.writeSummary, patch: c.fileReply(c.patchResult), archive: c.archiveSummary,
  search: c.searchOutput, research: c.researchObject, refresh: c.refreshOutput,
  status: c.indexStatusOutput, operation: c.fileOperation, cancel: c.fileOperation,
};
const writes = new Set<keyof KnowledgePort>(['create','update','patch','archive','refresh','cancel']);
const toolNames: Record<keyof KnowledgePort, string> = {
  info: 'get_note_info', list: 'list_notes', outline: 'get_note_outline', readPage: 'read_note',
  create: 'create_note', update: 'update_note', patch: 'patch_note', archive: 'archive_note',
  search: 'search_notes', research: 'fetch', refresh: 'refresh_index', status: 'index_status',
  operation: 'operation_status', cancel: 'cancel_operation',
};
export function hostClient(services: () => PluginServices, configuration: () => { externalWebOrigin?: string }, track?: <T>(task: Promise<T>) => Promise<T>): KnowledgeClient {
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
  async function invoke(tool: string, input: any, options: CallOptions, schema: z.ZodType, work: () => Promise<unknown>, write: boolean, rewriteLinks: boolean) {
    if (options.signal?.aborted || (options.deadline != null && Date.now() > options.deadline)) throw new BridgeError('CALL_CANCELLED', 499);
    let value: unknown;
    try {
      const task = work();
      track?.(task);
      value = await new Promise((resolve, reject) => {
        // A disconnected writer may already have committed. Await its receipt
        // within the deadline; a deadline without a receipt means unknown outcome.
        const cancelled = () => { clean(); reject(new BridgeError(write ? 'OPERATION_OUTCOME_UNKNOWN' : 'CALL_CANCELLED', write ? 504 : 499, write, input?.requestId)); };
        const timer = options.deadline == null ? undefined : setTimeout(cancelled, Math.max(0, options.deadline - Date.now()));
        if (!write) options.signal?.addEventListener('abort', cancelled, { once: true });
        const clean = () => { clearTimeout(timer); if (!write) options.signal?.removeEventListener('abort', cancelled); };
        void task.then((result) => { clean(); resolve(result); }, (error) => { clean(); reject(error); });
        if (!write && options.signal?.aborted) { clean(); cancelled(); }
      });
    }
    catch (e) {
      if (e instanceof BridgeError) throw annotateError(e, tool, input);
      const error = e as any;
      const code = error?.code || error?.details?.code;
      if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
        const translated = new BridgeError(code, error.statusCode || 500, !!error.retryable, input?.requestId);
        translated.requiredScope = error.requiredScope;
        translated.currentModifiedAt = [error.currentModifiedAt, error.details?.currentModifiedAt].find(value => typeof value === 'string' && /^\d{1,30}$/.test(value));
        throw annotateError(translated, tool, input);
      }
      throw annotateError(new BridgeError(write ? 'OPERATION_OUTCOME_UNKNOWN' : 'INTERNAL_ERROR', 502, write, input?.requestId), tool, input);
    }
    const blogOperation = typeof value === 'object' && value !== null && ['blog.publish', 'blog.unpublish'].includes((value as any).kind);
    const checked = schema.safeParse(rewriteLinks && !blogOperation ? links(value, origin()) : value);
    if (!checked.success) throw annotateError(new BridgeError(write ? 'OPERATION_OUTCOME_UNKNOWN' : 'INVALID_BACKEND_RESPONSE', 502, write, input?.requestId), tool, input);
    return checked.data;
  }
  const client = { externalWebOriginConfigured: () => !!origin() } as KnowledgeClient;
  for (const name of Object.keys(schemas) as (keyof KnowledgePort)[]) client[name] = (_p, input, options = {}) =>
    invoke(toolNames[name], input, options, schemas[name], () => services().knowledge[name](input, options), writes.has(name), true);
  const blogSchemas = { status: c.blogNoteStatus, publish: c.blogPost, unpublish: c.blogPost };
  for (const name of Object.keys(blogSchemas) as (keyof typeof blogSchemas)[]) {
    const key = ({ status: 'blogStatus', publish: 'blogPublish', unpublish: 'blogUnpublish' } as const)[name];
    const tool = ({ status: 'get_blog_status', publish: 'publish_blog_post', unpublish: 'unpublish_blog_post' } as const)[name];
    client[key] = (_p, input, options = {}) => invoke(tool, input, options, blogSchemas[name], () => {
      const blog = services().blog;
      if (!blog) throw new BridgeError('BLOG_UNAVAILABLE', 503);
      return blog[name](input, options);
    }, name !== 'status', false);
  }
  client.toDooQuery = (_p, input, options = {}) => invoke('query_to_doos', input, options, toDooMcpQueryResult, async () => {
    const port = services().toDoo;
    if (!port) throw new BridgeError('TO_DOO_UNAVAILABLE', 503);
    return port.query(input, options);
  }, false, false);
  client.toDooContext = (_p, input, options = {}) => invoke('get_to_doo_context', input, options, toDooMcpContextResult, async () => {
    const port = services().toDoo;
    if (!port) throw new BridgeError('TO_DOO_UNAVAILABLE', 503);
    return port.context(input, options);
  }, false, false);
  client.toDooCommand = (_p, input, options = {}) => invoke('manage_to_doo', input, options, toDooMcpReceipt, async () => {
    const port = services().toDoo;
    if (!port) throw new BridgeError('TO_DOO_UNAVAILABLE', 503);
    return port.command(input, options);
  }, input.action !== 'preview_plan', false);
  return client;
}
