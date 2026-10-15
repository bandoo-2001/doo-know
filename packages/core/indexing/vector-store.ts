import { KnowledgeError, fail } from '../knowledge/errors.js';
export interface VectorAdapter {
  readonly name: string;
  search(vector: number[], allowed: string[], limit: number): Promise<any[]>;
}
export class VectorRuntimeClient {
  constructor(
    public url: string,
    public token: string,
    public spaceId: string,
  ) {
    if (!token) fail(503, 'VECTOR_NOT_CONFIGURED');
  }
  async call(path: string, body?: unknown): Promise<any> {
    try {
      const response = await fetch(new URL(path, this.url), {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.body) fail(503, 'VECTOR_UNAVAILABLE');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel();
            fail(413, 'VECTOR_RESPONSE_TOO_LARGE');
          }
          chunks.push(item.value);
        }
      } finally {
        reader.releaseLock();
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok)
        fail(
          response.status,
          value.error?.code || 'VECTOR_UNAVAILABLE',
          '本地向量服务未完成请求',
          true,
        );
      return value;
    } catch (e) {
      if (e instanceof KnowledgeError) throw e;
      return fail(503, 'VECTOR_UNAVAILABLE', '本地向量服务不可用', true);
    }
  }
  async query(query: string) {
    const data = await this.call('/embed/query', { query, spaceId: this.spaceId });
    if (data.spaceId !== this.spaceId) fail(409, 'EMBEDDING_SPACE_MISMATCH');
    return data.vector as number[];
  }
  async documents(texts: string[]) {
    const data = await this.call('/embed/documents', { texts, spaceId: this.spaceId });
    if (data.spaceId !== this.spaceId) fail(409, 'EMBEDDING_SPACE_MISMATCH');
    return data.vectors as number[][];
  }
}
