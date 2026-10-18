import { test, expect } from '../support/browser-test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

test('citation opens its line and a large share renders only saved local attachments', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const name = `引用与附件-${info.project.name}.md`;
  await mkdir(join(config.knowledgeRoot, '00-Inbox/assets'), { recursive: true });
  const image = `citation-${info.project.name}.png`;
  await writeFile(
    join(config.knowledgeRoot, '00-Inbox/assets', image),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7i8AAAAASUVORK5CYII=',
      'base64',
    ),
  );
  await writeFile(
    join(config.knowledgeRoot, '00-Inbox', name),
    `# 分享附件\n\n![本地图片](assets/${image})\n\n` + '正文一行\n\n'.repeat(180000),
  );
  await page.goto('/');
  const notes = await (await page.request.get('/api/notes')).json();
  const note = notes.find((n: any) => n.relativePath === `00-Inbox/${name}`);
  await page.goto(`/?note=${encodeURIComponent(note.id)}#L100`);
  await expect(page.locator('.large-workspace p').filter({ hasText: /第 \d+/ })).toContainText(
    '第 100–',
  );
  const csrf = await page.request.get('/api/security/csrf');
  const share = await (
    await page.request.post(`/api/notes/${note.id}/share`, {
      data: {},
      headers: { 'x-csrf-token': (await csrf.json()).token, origin: 'http://127.0.0.1:4179' },
    })
  ).json();
  expect(share.token).toBeTruthy();
  const guest = await context.browser()!.newContext();
  try {
    const view = await guest.newPage();
    await view.goto(`http://127.0.0.1:4179/s/${share.token}`);
    const imageEl = view.getByAltText('本地图片');
    await expect(imageEl).toBeVisible();
    await expect.poll(() => imageEl.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
    await expect(view.locator('.reader-title')).toHaveText('分享附件');
    await page.request.delete(`/api/notes/${note.id}/share`, {
      headers: { 'x-csrf-token': (await csrf.json()).token, origin: 'http://127.0.0.1:4179' },
    });
    await view.reload();
    await expect(view.getByRole('heading', { name: '分享不存在或已取消' })).toBeVisible();
  } finally {
    await guest.close();
  }
});
