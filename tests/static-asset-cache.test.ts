import { beforeAll, afterAll, it, expect } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createFixture } from './support/fixture.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

async function staticFixture() {
  const web = await mkdtemp(join(tmpdir(), 'dooknow-cache-web-'));
  await mkdir(join(web, 'assets'));
  await writeFile(join(web, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/assets/style-EfGh4567.css"></head><body><script type="module" src="/assets/app.js"></script></body></html>');
  await writeFile(join(web, 'assets/style-EfGh4567.css'), 'body { color: rgb(10, 20, 30) }');
  await writeFile(join(web, 'assets/chunk-AbCd0123.js'), 'export const value = "first release";');
  await writeFile(join(web, 'assets/app.js'), 'import { value } from "/assets/chunk-AbCd0123.js"; document.body.textContent = value;');
  await writeFile(join(web, 'assets/plugin-runtime.js'), 'export const runtime = 1;');
  await writeFile(join(web, 'assets/readme-AbCd0123.txt'), 'not a generated script');
  const f = await createFixture({ staticRoot: web });
  const requests: { path: string; status: number }[] = [];
  f.app.addHook('onResponse', async (request, reply) => { requests.push({ path: request.url, status: reply.statusCode }); });
  return { ...f, web, requests, async dispose() { await f.close(); await rm(web, { recursive: true, force: true }); } };
}

it('reuses fingerprinted assets on reload while a changed entry loads the next release', async () => {
  const f = await staticFixture();
  const context = await browser.newContext();
  try {
    await f.app.listen({ port: 0, host: '127.0.0.1' });
    const page = await context.newPage(), origin = 'http://127.0.0.1:' + (f.app.server.address() as AddressInfo).port;
    await page.goto(origin); await expect.poll(() => page.locator('body').innerText()).toBe('first release'); await page.waitForLoadState('networkidle');
    f.requests.length = 0;
    await page.reload(); await expect.poll(() => page.locator('body').innerText()).toBe('first release'); await page.waitForLoadState('networkidle');
    expect(f.requests.filter(r => r.path === '/assets/chunk-AbCd0123.js')).toEqual([]);
    expect(f.requests.filter(r => r.path === '/assets/style-EfGh4567.css')).toEqual([]);
    expect(f.requests.filter(r => r.path === '/assets/app.js')).toHaveLength(1);
    await writeFile(join(f.web, 'assets/chunk-QrSt9876.js'), 'export const value = "second release loaded";');
    await writeFile(join(f.web, 'assets/app.js'), 'import { value } from "/assets/chunk-QrSt9876.js"; document.body.textContent = value; // upgraded');
    f.requests.length = 0;
    await page.reload(); await expect.poll(() => page.locator('body').innerText()).toBe('second release loaded');
    expect(f.requests.filter(r => r.path === '/assets/chunk-QrSt9876.js')).toHaveLength(1);
  } finally { await context.close(); await f.dispose(); }
});

it('teaches an existing cache the new policy through conditional responses', async () => {
  const f = await staticFixture(), context = await browser.newContext();
  let legacy = true;
  f.app.addHook('onSend', async (request, reply) => {
    if (legacy && ['/assets/chunk-AbCd0123.js', '/assets/style-EfGh4567.css'].includes(request.url)) reply.header('cache-control', 'public, max-age=0');
  });
  try {
    await f.app.listen({ port: 0, host: '127.0.0.1' });
    const page = await context.newPage(), origin = 'http://127.0.0.1:' + (f.app.server.address() as AddressInfo).port;
    await page.goto(origin); await expect.poll(() => page.locator('body').innerText()).toBe('first release'); await page.waitForLoadState('networkidle');
    legacy = false; f.requests.length = 0;
    await page.reload(); await expect.poll(() => page.locator('body').innerText()).toBe('first release'); await page.waitForLoadState('networkidle');
    expect(f.requests.filter(r => r.path === '/assets/chunk-AbCd0123.js')).toEqual([{ path: '/assets/chunk-AbCd0123.js', status: 304 }]);
    f.requests.length = 0;
    await page.reload(); await expect.poll(() => page.locator('body').innerText()).toBe('first release'); await page.waitForLoadState('networkidle');
    expect(f.requests.filter(r => r.path === '/assets/chunk-AbCd0123.js')).toEqual([]);
    expect(f.requests.filter(r => r.path === '/assets/style-EfGh4567.css')).toEqual([]);
    expect(f.requests.filter(r => r.path === '/assets/app.js')).toHaveLength(1);
  } finally { await context.close(); await f.dispose(); }
});

it('keeps entries, unversioned files, missing assets and private API responses revalidatable', async () => {
  const f = await staticFixture();
  try {
    for (const [url, status] of [['/', 200], ['/assets/app.js', 200], ['/assets/plugin-runtime.js', 200], ['/assets/readme-AbCd0123.txt', 200], ['/assets/missing-YzAb4567.js', 404], ['/api/notes', 401]] as const) {
      const response = await f.app.inject({ url });
      expect(response.statusCode).toBe(status);
      expect(response.headers['cache-control'] || '').not.toMatch(/immutable|(?:s-)?max-age=[1-9]/);
    }
  } finally { await f.dispose(); }
});


it('does not cache a late file-open error after a fingerprinted asset is repaired', async () => {
  const f = await staticFixture(), file = join(f.web, 'assets/chunk-AbCd0123.js');
  try {
    await chmod(file, 0);
    const failed = await f.app.inject({ url: '/assets/chunk-AbCd0123.js' });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers['cache-control']).toBe('no-store');
    expect(Object.keys(failed.json())).toEqual(['error']);
    expect(failed.body).not.toContain('FST_ERR');
    expect(failed.body).not.toContain(f.web);
    expect(Number(failed.headers['content-length'])).toBe(failed.rawPayload.length);
    await chmod(file, 0o600);
    const repaired = await f.app.inject({ url: '/assets/chunk-AbCd0123.js' });
    expect(repaired.statusCode).toBe(200);
    expect(repaired.body).toBe('export const value = "first release";');
  } finally { await chmod(file, 0o600); await f.dispose(); }
});
