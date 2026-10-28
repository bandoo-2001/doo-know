import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { test, expect } from '../support/browser-test';
import { expandFolderPath } from '../support/notebook-tree';
import { closeSidebar, showSidebar } from '../support/settings-navigation';

test.use({ sourceEditorPreference: true });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type FixtureNote = { id: string; relativePath: string; content: string };

async function createNote(page: Page, name: string): Promise<FixtureNote> {
  const csrf = await (await page.request.get('/api/security/csrf')).json();
  const response = await page.request.post('/api/notes', {
    headers: { origin: 'http://127.0.0.1:4179', 'x-csrf-token': csrf.token },
    data: {
      folderPath: '00-Inbox',
      fileName: `${name}-${crypto.randomUUID()}.md`,
      content: `# ${name}\n\n读取期间保留这段正文。\n`,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

async function selectNote(page: Page, note: FixtureNote) {
  await showSidebar(page);
  await expandFolderPath(page, '00-Inbox');
  await page
    .locator('.tree-scroll')
    .getByRole('button', {
      name: note.relativePath.split('/').at(-1),
      exact: true,
    })
    .click();
}

test.beforeEach(async ({ context }) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
});

test('session bootstrap shows a loading state until the signed-in workspace is available', async ({
  page,
}) => {
  const pending = gate(),
    requested = gate();
  await page.route('**/api/auth/get-session', async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await page.goto('/');
    await requested.promise;
    await expect(
      page.getByRole('status', { name: '正在打开知识空间…', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('用户名', { exact: true })).toHaveCount(0);
    await expect(page.locator('.workspace')).toHaveCount(0);
    pending.release();
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.loading-state-page')).toHaveCount(0);
  } finally {
    pending.release();
  }
});

test('an editor chunk loading state preserves the requested source line until the editor mounts', async ({
  page,
}) => {
  const note = await createNote(page, '延迟编辑器');
  const pending = gate(),
    requested = gate();
  await page.route(
    (url) =>
      url.pathname.endsWith('/components/MarkdownEditor.vue') ||
      /\/assets\/MarkdownEditor-[^/]+\.js$/.test(url.pathname),
    async (route) => {
      requested.release();
      await pending.promise;
      await route.continue();
    },
  );
  try {
    await page.goto('/?note=' + note.id + '#L3', { waitUntil: 'domcontentloaded' });
    await requested.promise;
    await expect(page.getByRole('status', { name: '正在准备编辑器…', exact: true })).toBeVisible();
    await expect(page.locator('.cm-content')).toHaveCount(0);
    pending.release();
    await expect(page.locator('.cm-content')).toBeVisible();
    await expect(page.locator('.cm-activeLine')).toHaveText('读取期间保留这段正文。');
    await expect(page.getByRole('status', { name: '正在准备编辑器…', exact: true })).toHaveCount(0);
  } finally {
    pending.release();
  }
});

test('an initial directory failure ends the skeleton and offers a working retry', async ({
  page,
}) => {
  const pending = gate(),
    requested = gate();
  let first = true;
  await page.route('**/api/tree', async (route) => {
    if (!first) return route.continue();
    first = false;
    requested.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: '目录暂时无法读取' } });
  });
  try {
    await page.goto('/');
    await requested.promise;
    await showSidebar(page);
    const tree = page.locator('.tree-scroll');
    await expect(tree).toHaveAttribute('aria-busy', 'true');
    await expect(tree.getByRole('status', { name: '正在读取目录…', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toHaveCount(0);
    pending.release();
    await expect(page.getByRole('button', { name: '重新加载目录', exact: true })).toBeVisible();
    await expect(tree).toHaveAttribute('aria-busy', 'false');
    await expect(tree.locator('.loading-state-list')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '重新加载目录', exact: true }).click();
    await expect(tree.getByRole('button', { name: '展开 00-Inbox', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重新加载目录', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible();
  } finally {
    pending.release();
  }
});

test('a pending note open retains the current editor and restores editing after failure', async ({
  page,
}) => {
  const current = await createNote(page, '当前正文'),
    destination = await createNote(page, '稍后打开');
  await page.goto('/?note=' + current.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('当前正文');
  await expect(editor).toBeEditable();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText('导航前撤销历史');
  await expect(editor).toContainText('导航前撤销历史');
  await editor.press('ControlOrMeta+z');
  await expect(editor).not.toContainText('导航前撤销历史');
  await expect(page.locator('.save-state')).toContainText('已保存');
  const originalEditor = await editor.elementHandle();
  const pending = gate(),
    requested = gate();
  await page.route(`**/api/notes/${destination.id}/meta`, async (route) => {
    requested.release();
    await pending.promise;
    await route.fulfill({ status: 503, json: { error: '目标笔记暂时无法读取' } });
  });
  try {
    await selectNote(page, destination);
    await requested.promise;
    await closeSidebar(page);
    await expect(page.locator('.workspace-load-progress')).toContainText('正在打开笔记…');
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'true');
    await expect(editor).toContainText('当前正文');
    await expect(editor).not.toBeEditable();
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true);
    await expect(page).toHaveURL(new RegExp('note=' + current.id));
    pending.release();
    await expect(page.getByText('目标笔记暂时无法读取', { exact: true })).toBeVisible();
    await expect(page.locator('.workspace-load-progress')).toHaveCount(0);
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'false');
    await expect(editor).toBeEditable();
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true);
    await editor.press('ControlOrMeta+Shift+z');
    await expect(editor).toContainText('导航前撤销历史');
    await editor.fill('# 失败后继续编辑\n');
    await expect(editor).toContainText('失败后继续编辑');
    await expect(page).toHaveURL(new RegExp('note=' + current.id));
  } finally {
    pending.release();
    await originalEditor?.dispose();
  }
});

test('opening a folder cancels a pending note and a late response cannot restore the busy state', async ({
  page,
}) => {
  const current = await createNote(page, '取消前正文'),
    destination = await createNote(page, '取消目标');
  await page.goto('/?note=' + current.id);
  await expect(page.locator('.cm-content')).toContainText('取消前正文');
  const pending = gate(),
    requested = gate();
  await page.route(`**/api/notes/${destination.id}/meta`, async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await selectNote(page, destination);
    await requested.promise;
    await showSidebar(page);
    await page
      .locator('.tree-scroll')
      .getByRole('button', { name: '00-Inbox', exact: true })
      .click();
    await expect(page.locator('.folder-view')).toBeVisible();
    await expect(page.locator('.workspace-load-progress')).toHaveCount(0);
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'false');
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/notes/${destination.id}/meta`),
    );
    pending.release();
    await (await lateResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page.locator('.folder-view')).toBeVisible();
    await expect(page).toHaveURL(/folder=00-Inbox/);
    await expect(page.locator('.workspace-load-progress')).toHaveCount(0);
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'false');
  } finally {
    pending.release();
  }
});

test('returning to the retained note from a collection cancels a pending destination', async ({
  page,
}) => {
  const current = await createNote(page, '集合保留正文'),
    destination = await createNote(page, '集合取消目标');
  await page.goto('/?note=' + current.id);
  const editor = page.locator('.cm-content');
  await expect(editor).toContainText('集合保留正文');
  const originalEditor = await editor.elementHandle();
  await showSidebar(page);
  await page.locator('.sidebar-footer').getByRole('button', { name: '最近', exact: true }).click();
  await expect(page.locator('.collection-workspace')).toBeVisible();
  await showSidebar(page);
  const sidebarNotes = page.locator('.tree-scroll');
  const pending = gate(),
    requested = gate();
  await page.route(`**/api/notes/${destination.id}/meta`, async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await sidebarNotes
      .getByRole('button', {
        name: destination.relativePath.split('/').at(-1),
        exact: true,
      })
      .click();
    await requested.promise;
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'true');
    await sidebarNotes
      .getByRole('button', {
        name: current.relativePath.split('/').at(-1),
        exact: true,
      })
      .click();
    await expect(editor).toBeVisible();
    await expect(editor).toBeEditable();
    await expect(editor).toContainText('集合保留正文');
    await expect(page.locator('.main-content')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('.workspace-load-progress')).toHaveCount(0);
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true);
    const lateResponse = page.waitForResponse((response) =>
      response.url().endsWith(`/api/notes/${destination.id}/meta`),
    );
    pending.release();
    await (await lateResponse).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(page).toHaveURL(new RegExp('note=' + current.id));
    await expect(editor).toContainText('集合保留正文');
    await expect(editor).toBeEditable();
    await expect(page.locator('.workspace-load-progress')).toHaveCount(0);
    expect(await originalEditor!.evaluate((node) => node.isConnected)).toBe(true);
  } finally {
    pending.release();
    await originalEditor?.dispose();
  }
});

test('reduced motion keeps loading feedback visible without repeating animations', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const pending = gate(),
    requested = gate();
  await page.route('**/api/auth/get-session', async (route) => {
    requested.release();
    await pending.promise;
    await route.continue();
  });
  try {
    await page.goto('/');
    await requested.promise;
    const loading = page.getByRole('status', { name: '正在打开知识空间…', exact: true });
    await expect(loading).toBeVisible();
    const animated = await loading.evaluate((root) => {
      return [root, ...root.querySelectorAll('*')].flatMap((element) => {
        return [null, '::before', '::after']
          .map((pseudo) => {
            const css = getComputedStyle(element, pseudo);
            return {
              name: css.animationName,
              duration: css.animationDuration,
              iterations: css.animationIterationCount,
            };
          })
          .filter((value) => value.name !== 'none');
      });
    });
    for (const animation of animated) {
      for (const duration of animation.duration.split(',')) {
        const value = parseFloat(duration);
        const milliseconds = duration.trim().endsWith('ms') ? value : value * 1000;
        expect(milliseconds).toBeLessThanOrEqual(0.01);
      }
      for (const count of animation.iterations.split(',')) expect(Number(count)).toBe(1);
    }
    pending.release();
    await expect(page.locator('.workspace')).toBeVisible();
  } finally {
    pending.release();
  }
});
