import { test, expect } from '../support/browser-test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { showSidebar } from '../support/settings-navigation';

async function openFixtureNote(page: import('@playwright/test').Page, fileName: string) {
  await page.goto('/');
  await expect(page.locator('.workspace')).toBeVisible();
  await showSidebar(page);
  await page.getByRole('button', { name: '00-Inbox', exact: true }).first().click();
  const metadata = page.waitForResponse((response) =>
    /\/api\/notes\/[^/]+\/meta$/.test(response.url()),
  );
  await page.locator('.folder-view').getByRole('button', { name: fileName, exact: true }).click();
  const noteId = (await (await metadata).json()).id as string;
  // A direct URL keeps the selected note stable across reloads.
  await page.goto('/?note=' + encodeURIComponent(noteId));
  return noteId;
}

async function waitForLocalDraft(
  page: import('@playwright/test').Page,
  noteId: string,
  content: string,
) {
  await expect
    .poll(async () =>
      page.evaluate(
        async ({ noteId, content }) => {
          if (!(await indexedDB.databases()).some((db) => db.name === 'dooknow-local-drafts'))
            return false;
          return new Promise<boolean>((resolve, reject) => {
            const request = indexedDB.open('dooknow-local-drafts');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const read = db.transaction('drafts').objectStore('drafts').getAll();
              read.onsuccess = () => {
                db.close();
                resolve(
                  read.result.some((draft) => draft.noteId === noteId && draft.content === content),
                );
              };
              read.onerror = () => {
                db.close();
                reject(read.error);
              };
            };
          });
        },
        { noteId, content },
      ),
    )
    .toBe(true);
}

test('reload offers an unsaved note draft and manual recovery never writes the source', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `本地恢复-${info.project.name}.md`;
  const path = join(config.knowledgeRoot, '00-Inbox', fileName);
  const original = '# Source\nSaved source stays intact.\n';
  const content = '# Unsaved\nRecovered only into this browser editor.\n';
  await writeFile(path, original);
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.cm-content')).toContainText('Saved source stays intact.');
  await page.locator('.cm-content').fill(content);
  await waitForLocalDraft(page, noteId, content);
  expect(await readFile(path, 'utf8')).toBe(original);
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Saved source stays intact.');
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText(
    'Recovered only into this browser editor.',
  );
  expect(await readFile(path, 'utf8')).toBe(original);
});

test('a changed large-file base offers copy recovery and refuses to apply an old fragment', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `片段恢复-${info.project.name}.md`;
  const path = join(config.knowledgeRoot, '00-Inbox', fileName);
  const original =
    '# Large source\n' + 'unchanged line\n'.repeat(160000) + 'UNLOADED_RECOVERY_TAIL';
  const content = '# Local fragment\nUnsaved fragment text.\n';
  await writeFile(path, original);
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.large-workspace .cm-content')).toContainText('Large source');
  await page.locator('.large-workspace .cm-content').fill(content);
  await waitForLocalDraft(page, noteId, content);
  await writeFile(path, '# Newer source\n' + original);
  await page.reload();
  await expect(page.locator('.draft-recovery')).toContainText('原文基准已变化');
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '复制恢复文本', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '本地草稿恢复文本', exact: true })).toHaveValue(
    content,
  );
  await expect(page.locator('.large-workspace .cm-content')).toContainText('Newer source');
  expect((await readFile(path, 'utf8')).endsWith('UNLOADED_RECOVERY_TAIL')).toBe(true);
  expect(await readFile(path, 'utf8')).not.toContain('Unsaved fragment text.');
});

test('a large-file draft returns to its recorded second-page range before explicit recovery', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `片段范围-${info.project.name}.md`;
  const path = join(config.knowledgeRoot, '00-Inbox', fileName);
  const original = '# Large range\n' + 'range line\n'.repeat(210000) + 'RANGE_TAIL';
  const content = '# Second range draft\nRecovered at the recorded range.\n';
  await writeFile(path, original);
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.large-workspace .cm-content')).toContainText('Large range');
  await page.getByRole('button', { name: '下一片段', exact: true }).click();
  await expect(page.locator('.large-range')).not.toContainText('第 1–');
  const rangeBefore = await page.locator('.large-range').innerText();
  expect(rangeBefore).not.toContain('第 1–');
  await page.locator('.large-workspace .cm-content').fill(content);
  await waitForLocalDraft(page, noteId, content);
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeEnabled();
  await expect(page.locator('.large-range')).toContainText(rangeBefore.split(' · ')[0]);
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.locator('.large-workspace .cm-content')).toContainText(
    'Recovered at the recorded range.',
  );
  expect(await readFile(path, 'utf8')).toBe(original);
  await page.getByRole('button', { name: '保存片段', exact: true }).click();
  await expect(page.getByText('片段已保存', { exact: true })).toBeVisible();
  const saved = await readFile(path, 'utf8');
  expect(saved).toContain('Recovered at the recorded range.');
  expect(saved.endsWith('RANGE_TAIL')).toBe(true);
  await page.reload();
  await expect(page.locator('.large-workspace .cm-content')).toBeVisible();
  await expect(page.locator('.draft-recovery')).toHaveCount(0);
});

test('a newer note source stays visible until an older local draft is explicitly recovered', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `草稿基准-${info.project.name}.md`,
    path = join(config.knowledgeRoot, '00-Inbox', fileName);
  await writeFile(path, '# Earlier source\n');
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.cm-content')).toContainText('Earlier source');
  const content = '# Older local work\n';
  await page.locator('.cm-content').fill(content);
  await waitForLocalDraft(page, noteId, content);
  const newer = '# Newer externally saved source\n';
  await writeFile(path, newer);
  await page.reload();
  await expect(page.locator('.draft-recovery')).toContainText('原文基准已变化');
  await expect(page.locator('.cm-content')).toContainText('Newer externally saved source');
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Older local work');
  expect(await readFile(path, 'utf8')).toBe(newer);
});

test('saving one version keeps later typing recoverable after the save response arrives', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `草稿保存竞态-${info.project.name}.md`,
    path = join(config.knowledgeRoot, '00-Inbox', fileName);
  await writeFile(path, '# Original source\n');
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.cm-content')).toContainText('Original source');
  const submitted = '# Submitted text\n',
    subsequent = '# Typed while saving\n';
  await page.locator('.cm-content').fill(submitted);
  let release!: () => void, received!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  await page.route(`**/api/notes/${noteId}`, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    received();
    await responseGate;
    await route.fulfill({ response });
  });
  await page.keyboard.press('ControlOrMeta+s');
  await requestReceived;
  await page.locator('.cm-content').fill(subsequent);
  await waitForLocalDraft(page, noteId, subsequent);
  release();
  await expect(page.getByText('笔记已保存', { exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Typed while saving');
  expect(await readFile(path, 'utf8')).toBe(submitted);
  await page.reload();
  await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeVisible();
  await expect(page.locator('.cm-content')).toContainText('Submitted text');
  await page.getByRole('button', { name: '恢复本地草稿', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Typed while saving');
  expect(await readFile(path, 'utf8')).toBe(submitted);
});

test('explicitly discarding a recovered note draft removes it without changing the source', async ({
  page,
  context,
}, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
  const fileName = `丢弃本地草稿-${info.project.name}.md`,
    path = join(config.knowledgeRoot, '00-Inbox', fileName);
  const original = '# Source retained after discard\n',
    content = '# Discard this local text\n';
  await writeFile(path, original);
  const noteId = await openFixtureNote(page, fileName);
  await expect(page.locator('.cm-content')).toContainText('Source retained after discard');
  await page.locator('.cm-content').fill(content);
  await waitForLocalDraft(page, noteId, content);
  await page.reload();
  await page.getByRole('button', { name: '丢弃本地草稿', exact: true }).click();
  await expect(page.locator('.draft-recovery')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('Source retained after discard');
  await page.reload();
  await expect(page.locator('.cm-content')).toContainText('Source retained after discard');
  await expect(page.locator('.draft-recovery')).toHaveCount(0);
  expect(await readFile(path, 'utf8')).toBe(original);
});

for (const previousMode of ['full', 'large'] as const) {
  test(`a draft from ${previousMode} mode stays copyable after the source switches editor mode`, async ({
    page,
    context,
  }, info) => {
    await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
    const config = JSON.parse(await readFile('.local/e2e-config.json', 'utf8'));
    const fileName = `模式变化-${previousMode}-${info.project.name}.md`,
      path = join(config.knowledgeRoot, '00-Inbox', fileName);
    const small = '# Small complete source\n',
      large = '# Large changed source\n' + 'mode range line\n'.repeat(150000);
    const original = previousMode === 'full' ? small : large;
    const replacement = previousMode === 'full' ? large : small;
    await writeFile(path, original);
    const noteId = await openFixtureNote(page, fileName);
    await expect(page.locator('.cm-content')).toContainText(
      previousMode === 'full' ? 'Small complete source' : 'Large changed source',
    );
    const content = '# Recover this earlier mode text\n';
    await page.locator('.cm-content').fill(content);
    await waitForLocalDraft(page, noteId, content);
    await writeFile(path, replacement);
    await page.reload();
    await expect(page.locator('.draft-recovery')).toContainText('原文基准已变化');
    await expect(page.getByRole('button', { name: '恢复本地草稿', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '复制恢复文本', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '本地草稿恢复文本', exact: true })).toHaveValue(
      content,
    );
    await expect(page.locator('.cm-content')).toContainText(
      previousMode === 'full' ? 'Large changed source' : 'Small complete source',
    );
    expect(await readFile(path, 'utf8')).toBe(replacement);
  });
}
