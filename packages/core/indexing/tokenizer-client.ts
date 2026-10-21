import { type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, KnowledgeError } from '../knowledge/errors.js';
import { interactiveProcess } from '../processes/interactive.js';
export class TokenizerClient {
  private child?: ChildProcessWithoutNullStreams;
  private owned?: ReturnType<typeof interactiveProcess>;
  private buffer = Buffer.alloc(0);
  private pending = new Map<
    string,
    {
      resolve: (data: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private options: { runtimeRoot?: string; modelDir?: string; python?: string } = {}) {}
  private start() {
    if (this.child) return this.child;
    const root = resolve(this.options.runtimeRoot || 'runtime/vector-service'),
      owned = interactiveProcess(
        this.options.python || join(root, '.venv/bin/python'),
        [join(root, 'tokenizer_cli.py')],
        {
          ...process.env,
          DOOKNOW_MODEL_DIR: resolve(this.options.modelDir || '.local/models/bge-small-zh-v1.5'),
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
          PYTHONUNBUFFERED: '1',
        },
      ),
      child = owned.child;
    this.child = child;
    this.owned = owned;
    const rejectAll = (release: boolean) => {
      if (this.owned !== owned) return;
      for (const item of this.pending.values()) {
        clearTimeout(item.timer);
        item.reject(new KnowledgeError(503, 'TOKENIZER_UNAVAILABLE', '本地分词进程不可用', true));
      }
      this.pending.clear();
      if (release) {
        this.child = undefined;
        this.owned = undefined;
      }
      this.buffer = Buffer.alloc(0);
    };
    void owned.wait.then(
      () => rejectAll(true),
      () => rejectAll(!owned.alive()),
    );
    child.stderr.resume();
    child.stdout.on('data', (bytes: Buffer) => {
      if (this.owned !== owned) return;
      this.buffer = Buffer.concat([this.buffer, bytes]);
      if (this.buffer.length > 1024 * 1024) {
        owned.terminate();
        return;
      }
      let end: number;
      while ((end = this.buffer.indexOf(10)) !== -1) {
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 1);
        try {
          const reply = JSON.parse(line.toString('utf8')),
            item = this.pending.get(reply.id);
          if (!item) continue;
          clearTimeout(item.timer);
          this.pending.delete(reply.id);
          if (reply.error)
            item.reject(new KnowledgeError(503, String(reply.error), '分词未完成', true));
          else item.resolve(reply.data);
        } catch {
          owned.terminate();
        }
      }
    });
    return child;
  }
  private call(method: string, fields: Record<string, unknown>): Promise<any> {
    if (this.pending.size >= 32) fail(429, 'TOKENIZER_BUSY');
    const id = randomUUID(),
      body = JSON.stringify({ id, method, ...fields }) + '\n';
    if (Buffer.byteLength(body) > 1024 * 1024) fail(413, 'TOKENIZER_REQUEST_TOO_LARGE');
    const child = this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new KnowledgeError(504, 'TOKENIZER_TIMEOUT', '分词超时', true));
      }, 10000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(body, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new KnowledgeError(503, 'TOKENIZER_UNAVAILABLE', '分词未完成', true));
        }
      });
    });
  }
  async count(texts: string[]): Promise<number[]> {
    return this.call('count', { texts });
  }
  async split(
    text: string,
    header = '',
  ): Promise<{
    slices: { content: string; startByte: number; endByte: number; tokenCount: number }[];
    header: string;
    carryStartByte: number;
  }> {
    return this.call('split', { text, header });
  }
  async tokenize(texts: string[]): Promise<string[][]> {
    return this.call('tokenize', { texts });
  }
  async close() {
    await this.owned?.close();
  }
}
