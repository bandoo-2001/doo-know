/** Run against an isolated temporary database after building the web app. */
import { chromium, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createFixture, testPassword } from '../../tests/support/fixture';
import { createApp } from '../../apps/server/app';
import { initializeOwner } from '../../apps/server/auth';
const buildModule = '../build-plugins.mjs';
const { buildPlugins } = await import(buildModule);
import { closeSidebar } from '../../tests/support/settings-navigation';
const [oldRoot, target] = process.argv.slice(2);
if (!oldRoot || !target)
  throw Error(
    'Usage: tsx scripts/platform-ui-evidence/verify-plugin-upgrade.ts <rc61-artifact-directory> <fresh-evidence-directory>',
  );
const origin = 'http://127.0.0.1:4881',
  out = resolve(target);
await mkdir(out, { recursive: false });
// Pin the existing rc.61 artifacts to local bytes after validating their catalog checksums.
const oldCatalog = JSON.parse(await readFile(join(oldRoot, 'catalog.json'), 'utf8'));
for (const e of oldCatalog) {
  const file = join(oldRoot, basename(new URL(e.artifact.url).pathname));
  expect(
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  ).toBe(e.artifact.sha256);
  e.artifact.url = pathToFileURL(file).href;
}
const temp = await mkdtemp(join(tmpdir(), 'dooknow-version-check-'));
const newCatalog = await buildPlugins({
  output: temp,
  ids: ['mcp', 'git'],
  baseURL: pathToFileURL(temp + '/').href,
});
const fixture = await createFixture({
  origin,
  pluginCatalog: oldCatalog,
  staticRoot: resolve('dist/web'),
});
const browser = await chromium.launch();
let next: Awaited<ReturnType<typeof createApp>> | undefined;
try {
  await initializeOwner(fixture.config, 'owner', testPassword);
  await fixture.app.listen({ port: 4881, host: '127.0.0.1' });
  const ctx = await browser.newContext({
    baseURL: origin,
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
  });
  const signin = await ctx.request.post('/api/auth/sign-in/username', {
    headers: { origin },
    data: { username: 'owner', password: testPassword },
  });
  expect(signin.ok()).toBeTruthy();
  const { token } = await (await ctx.request.get('/api/security/csrf')).json();
  const headers = { origin, 'x-csrf-token': token };
  for (const e of oldCatalog) {
    expect(
      (
        await ctx.request.post('/api/platform/plugins/' + e.id + '/install', { headers, data: {} })
      ).ok(),
    ).toBeTruthy();
  }
  const old = await (await ctx.request.get('/api/platform/plugins')).json();
  const entry = old.installed.find((e: any) => e.id === 'git');
  expect(
    (
      await ctx.request.put('/api/platform/plugins/git/config', {
        headers,
        data: {
          configVersion: entry.configVersion,
          values: { authorName: 'Catalog preservation fixture' },
        },
      })
    ).ok(),
  ).toBeTruthy();
  await fixture.app.close();
  next = await createApp({ ...fixture.config, pluginCatalog: newCatalog });
  await next.listen({ port: 4881, host: '127.0.0.1' });
  const page = await ctx.newPage();
  await page.goto('/?view=settings&section=plugins');
  await closeSidebar(page);
  const check = async () => await (await ctx.request.get('/api/platform/plugins')).json();
  const before = await check();
  const versions = (list: { id: string; installedVersion: string }[]): Record<string, string> =>
    Object.fromEntries(list.map((e) => [e.id, e.installedVersion]));
  expect(versions(before.installed)).toMatchObject({ mcp: '2.0.0', git: '1.1.3' });
  const installedTab = page.getByRole('button', { name: /^已安装/ });
  if (await installedTab.isVisible()) await installedTab.click();
  const cards = page.locator('.plugin-card');
  const upgrades = cards.getByRole('button', { name: '升级', exact: true });
  await expect(upgrades).toHaveCount(2);
  for (const available of newCatalog) {
    const oldVersion = versions(before.installed)[available.id];
    const heading = cards.getByRole('heading', { name: new RegExp(available.title) });
    await expect(heading).toContainText('v' + oldVersion);
    await expect(heading).toContainText('可升级至 v' + available.version);
  }
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await closeSidebar(page);
    await upgrades.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(out, width + '-before.png'), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const e of newCatalog) {
    const card = cards.filter({
      has: page.getByRole('heading', { name: new RegExp('v' + e.version.replaceAll('.', '\\.')) }),
    });
    await card.getByRole('button', { name: '升级', exact: true }).click();
    await expect
      .poll(async () => versions((await check()).installed)[e.id], { timeout: 30000 })
      .toBe(e.version);
    const back = page.getByRole('button', { name: '返回插件列表', exact: true });
    await expect(back).toBeVisible();
    await back.click();
  }
  const after = await check();
  await expect(upgrades).toHaveCount(0);
  for (const available of newCatalog) {
    const heading = cards.getByRole('heading', { name: new RegExp(available.title) });
    await expect(heading).toContainText('v' + available.version);
    await expect(heading).not.toContainText('可升级至');
  }
  expect(after.installed.find((e: any) => e.id === 'git').config.authorName).toBe(
    'Catalog preservation fixture',
  );
  const files = ['1440-before.png', '390-before.png', '320-before.png'];
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await closeSidebar(page);
    await cards.first().getByRole('heading').scrollIntoViewIfNeeded();
    const file = width + '-after.png';
    await page.screenshot({ path: join(out, file), animations: 'disabled' });
    files.push(file);
  }
  const screenshots = [];
  for (const file of files)
    screenshots.push({
      file,
      sha256: createHash('sha256')
        .update(await readFile(join(out, file)))
        .digest('hex'),
    });
  const result = {
    fixture:
      'isolated browser, real rc61 packages, real API, same temporary DB across application restart',
    before: versions(before.installed),
    newCatalog: Object.fromEntries(
      newCatalog.map((e: { id: string; version: string }) => [e.id, e.version]),
    ),
    after: versions(after.installed),
    setupDidNotAutoUpgrade: true,
    manualUpgradeActions: 2,
    preservedExistingGitConfig: true,
    screenshots,
  };
  await writeFile(join(out, 'receipt.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await next?.close();
  await fixture.close();
  await rm(temp, { recursive: true, force: true });
}
