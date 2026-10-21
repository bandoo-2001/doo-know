import { beforeAll, afterAll, beforeEach, afterEach, it, expect } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type ServerResponse, type Server } from 'node:http';
import { build } from 'esbuild';

const original = '# 原文\r\n\r\n<!-- 完整保留 -->\r\n';
const pending = new Set<ServerResponse>();
let server: Server, browser: Browser, context: BrowserContext, page: Page, origin: string;
let mode: 'headers' | 'body' = 'headers',
  available = false,
  csrfRequests = 0,
  aborted = 0;
let writes: { token: string | undefined; body: unknown }[] = [];
beforeAll(async () => {
  const compiled = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
  import {api} from './apps/web/api.ts';
  const original=${JSON.stringify(original)};
  window.result={phase:'pending',original};
  window.expiryNotifications=0;
  window.addEventListener('dooknow-session-expired',()=>window.expiryNotifications++);
  window.checkSession=async(defer)=>{try{await api('/api/session-probe','GET',undefined,defer?{notifySessionExpired:false}:undefined);return {status:200};}catch(error){return {status:error.status};}};
  window.send=async()=>{window.result.phase='pending';try{await api('/api/protected','POST',{content:original});window.result.phase='complete';}catch{window.result.phase='failed';}};
  void window.send();
 `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
  });
  server = createServer((q, r) => {
    if (q.url === '/api/session-probe') {
      r.writeHead(401, { 'content-type': 'application/json' });
      r.end(JSON.stringify({ error: 'Session expired' }));
    } else if (q.url === '/api/security/csrf') {
      csrfRequests++;
      if (available) {
        r.writeHead(200, { 'content-type': 'application/json' });
        r.end(JSON.stringify({ token: 'recovered-token' }));
        return;
      }
      pending.add(r);
      r.once('close', () => {
        pending.delete(r);
        aborted++;
      });
      if (mode === 'body') {
        r.writeHead(200, { 'content-type': 'application/json', 'content-length': 1024 });
        r.write('{"token":');
      }
    } else if (q.url === '/api/protected') {
      const chunks: Buffer[] = [];
      q.on('data', (b) => chunks.push(b));
      q.on('end', () => {
        writes.push({
          token: q.headers['x-csrf-token'] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        r.writeHead(
          q.method === 'POST' && q.headers['x-csrf-token'] === 'recovered-token' ? 200 : 403,
          { 'content-type': 'application/json' },
        );
        r.end('{}');
      });
    } else if (q.url === '/app.js') {
      r.writeHead(200, { 'content-type': 'text/javascript' });
      r.end(compiled.outputFiles[0].text);
    } else r.end('<!doctype html><html><body><script src="/app.js"></script></body></html>');
  });
  await new Promise<void>((yes) => server.listen(0, '127.0.0.1', yes));
  origin = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  browser = await chromium.launch();
});

it.each([false, true])('retains a 401 rejection with session notification deferred=%s', async (defer) => {
  available = true;
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as any).result.phase)).toBe('complete');
  expect(await page.evaluate((defer) => (window as any).checkSession(defer), defer)).toEqual({ status: 401 });
  expect(await page.evaluate(() => (window as any).expiryNotifications)).toBe(defer ? 0 : 1);
  expect(await page.evaluate(() => (window as any).result.original)).toBe(original);
  expect(csrfRequests).toBe(1);
  expect(writes).toEqual([{ token: 'recovered-token', body: { content: original } }]);
});
afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((yes) => server.close(() => yes()));
});
beforeEach(async () => {
  available = false;
  csrfRequests = aborted = 0;
  writes = [];
  context = await browser.newContext();
  page = await context.newPage();
});
afterEach(async () => {
  await context?.close();
  await expect.poll(() => pending.size).toBe(0);
});

it.each(['headers', 'body'] as const)(
  'aborts a CSRF preflight with stalled %s and lets the unchanged content be explicitly retried',
  async (kind) => {
    mode = kind;
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => pending.size).toBe(1);
    // The existing API policy is 15 seconds. The CSRF preflight must also settle,
    // including a response whose headers arrived but whose JSON body never ends.
    await expect
      .poll(() => page.evaluate(() => (window as any).result.phase), { timeout: 17500 })
      .toBe('failed');
    await expect.poll(() => pending.size).toBe(0);
    expect(aborted).toBe(1);
    expect(csrfRequests).toBe(1);
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => (window as any).result.original)).toBe(original);
    available = true;
    await page.evaluate(() => (window as any).send());
    expect(await page.evaluate(() => (window as any).result.phase)).toBe('complete');
    expect(csrfRequests).toBe(2);
    expect(writes).toEqual([{ token: 'recovered-token', body: { content: original } }]);
  },
);

it('submits the exact content once after a complete CSRF response', async () => {
  available = true;
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => (window as any).result.phase)).toBe('complete');
  expect(csrfRequests).toBe(1);
  expect(writes).toEqual([{ token: 'recovered-token', body: { content: original } }]);
});
