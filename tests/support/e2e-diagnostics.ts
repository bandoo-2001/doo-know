import { appendFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { performance } from 'node:perf_hooks';

/** Opt-in fixture telemetry. Never records query strings, headers, cookies or bodies. */
export function browserFixtureDiagnostics(file: string | undefined) {
  if (!file) return { attach(_server: Server, _layer: string) {}, async close() {} };
  const target = file;
  let rows: string[] = [],
    serial = Promise.resolve(),
    sequence = 0;
  const pending = new Map<number, { layer: string; path: string; at: number }>();
  const record = (event: Record<string, unknown>) => {
    rows.push(
      JSON.stringify({
        elapsed: Math.round(performance.now()),
        wallTime: Math.round(performance.timeOrigin + performance.now()),
        ...event,
      }) + '\n',
    );
  };
  function flush() {
    if (!rows.length) return;
    const content = rows.join('');
    rows = [];
    serial = serial.then(() => appendFile(target, content, { mode: 0o600 }));
  }
  let last = performance.now(),
    heartbeat = 0;
  const timer = setInterval(() => {
    const now = performance.now(),
      lag = now - last - 500;
    if (lag > 100) record({ kind: 'loop-lag', milliseconds: Math.round(lag) });
    last = now;
    if (++heartbeat % 10 === 0)
      record({ kind: 'heartbeat', pending: pending.size, memory: process.memoryUsage() });
    const slow = [...pending].filter(([, value]) => now - value.at > 1000);
    if (slow.length)
      record({
        kind: 'pending',
        requests: slow.map(([id, value]) => ({
          id,
          layer: value.layer,
          path: value.path,
          milliseconds: Math.round(now - value.at),
        })),
        memory: process.memoryUsage(),
      });
    flush();
  }, 500);
  timer.unref();
  return {
    attach(server: Server, layer: string) {
      server.prependListener('request', (request, response) => {
        const id = ++sequence,
          at = performance.now();
        const path = new URL(request.url || '/', 'http://fixture.invalid').pathname.replace(
          /\/[a-zA-Z0-9_-]{24,}(?=\/|$)/g,
          '/:id',
        );
        pending.set(id, { layer, path, at });
        record({ kind: 'start', id, layer, path, method: request.method });
        response.once('close', () => {
          pending.delete(id);
          record({
            kind: 'end',
            id,
            layer,
            path,
            milliseconds: Math.round(performance.now() - at),
            status: response.statusCode,
            completed: response.writableFinished,
          });
        });
      });
    },
    async close() {
      clearInterval(timer);
      record({ kind: 'closed', pending: pending.size });
      flush();
      await serial;
    },
  };
}
