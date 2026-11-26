import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '../support/browser-test';
import { setFeatureSwitch } from '../support/settings-navigation';

test('loads a synchronized Git author while keeping Git disabled', async ({ page, context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const { knowledgeRoot } = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  await page.goto('/?view=settings&section=library');
  await setFeatureSwitch(page, 'Git 版本管理', false);
  const directory = join(knowledgeRoot, '_doo-data/plugins/git');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'state.json'), JSON.stringify({
    format: 1, revision: crypto.randomUUID(),
    data: {
      schemaVersion: 1,
      plugin: { id: 'git', version: '1.1.4', apiVersion: '^1.0.0' },
      config: { authorName: 'Repository author', authorEmail: 'author@example.invalid' },
      userData: {},
    },
  }));
  await page.reload();
  await expect(page.getByLabel('提交作者', { exact: true })).toHaveValue('Repository author');
  await expect(page.getByRole('switch', { name: '启用 Git 版本管理', exact: true })).not.toBeChecked();
});
