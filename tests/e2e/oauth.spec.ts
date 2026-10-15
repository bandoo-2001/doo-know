import { test, expect } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { testPassword } from '../support/credentials.js';
test('OAuth login preserves signed authorization through owner consent and PKCE exchange', async ({ page, request }) => {
  const registered = await page.request.post('/api/auth/oauth2/register', { data: {
    client_name: '浏览器连接验收', redirect_uris: ['https://client.example/callback'],
    token_endpoint_auth_method: 'none', scope: 'knowledge:read offline_access' } });
  expect(registered.status()).toBe(201);
  const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: 'https://client.example/callback', response_type: 'code',
    scope: 'knowledge:read offline_access', resource: 'http://127.0.0.1:4179/mcp', state: 'browser-state',
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
  await page.route('https://client.example/callback**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>授权完成</h1>' }));
  await page.goto('/api/auth/oauth2/authorize?' + query);
  await page.getByLabel('用户名', { exact: true }).fill('owner');
  await page.getByLabel('密码', { exact: true }).fill(testPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('浏览器连接验收', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '允许访问', exact: true }).click();
  await expect(page.getByRole('heading', { name: '授权完成', exact: true })).toBeVisible();
  const callback = new URL(page.url()); expect(callback.searchParams.get('state')).toBe('browser-state');
  const exchanged = await request.post('http://127.0.0.1:4179/api/auth/oauth2/token', { form: {
    grant_type: 'authorization_code', client_id: clientId, code: callback.searchParams.get('code')!, code_verifier: verifier,
    redirect_uri: 'https://client.example/callback', resource: 'http://127.0.0.1:4179/mcp' } });
  expect(exchanged.status()).toBe(200);
  const tokens = await exchanged.json(); expect(typeof tokens.access_token).toBe('string'); expect(typeof tokens.refresh_token).toBe('string');
});
