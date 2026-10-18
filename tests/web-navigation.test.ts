import { beforeAll, afterAll, beforeEach, afterEach, expect, test } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import ts from 'typescript';

let browser: Browser, context: BrowserContext, page: Page, source: string;
beforeAll(async () => {
  source = ts.transpileModule(
    await readFile(new URL('../apps/web/navigation.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
    },
  ).outputText;
  const libs = resolve('.local/browser-deps/root/usr/lib/x86_64-linux-gnu'),
    env = { ...process.env };
  if (existsSync(libs))
    env.LD_LIBRARY_PATH = libs + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
  browser = await chromium.launch({ env });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  context = await browser.newContext();
  await context.route('http://dooknow-navigation.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Navigation test</title>',
    }),
  );
  page = await context.newPage();
  await page.goto('http://dooknow-navigation.test/?note=A');
  await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const { createWorkspaceNavigation } = await new Function('url', 'return import(url)')(url);
    URL.revokeObjectURL(url);
    const state = ((window as any).navigationState = {
      visible: 'A',
      dirty: false,
      rejectB: false,
      errors: 0,
      capabilities: { canBack: false, canForward: false },
      pending: undefined as (() => Promise<void>) | undefined,
      holdB: undefined as Promise<void> | undefined,
    });
    (window as any).navigation = createWorkspaceNavigation({
      dirty: () => state.dirty,
      onState: (value: { canBack: boolean; canForward: boolean }) => {
        state.capabilities = value;
      },
      guard: async (apply: () => Promise<void>) => {
        state.pending = apply;
      },
      apply: async (route: { note: string }) => {
        if (route.note === 'B' && state.holdB) await state.holdB;
        if (route.note === 'B' && state.rejectB)
          throw new Error('Controlled document read failure');
        state.visible = route.note;
      },
      error: () => {
        state.errors++;
        (state as any).onError?.();
      },
    });
    (window as any).navigation.commit({ note: 'B' });
    state.visible = 'B';
    (window as any).navigation.commit({ note: 'C' });
    state.visible = 'C';
  }, source);
});
afterEach(async () => {
  await context?.close();
});

async function expectRoute(note: string) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        note: new URL(location.href).searchParams.get('note'),
        visible: (window as any).navigationState.visible,
      })),
    )
    .toEqual({ note, visible: note });
}

test('a failed back navigation restores the real pointer before later push, cancel, discard and forward', async () => {
  await page.evaluate(() => {
    (window as any).navigationState.rejectB = true;
  });
  await page.goBack();
  await expect.poll(() => page.evaluate(() => (window as any).navigationState.errors)).toBe(1);
  await expectRoute('C');
  await page.evaluate(() => {
    (window as any).navigationState.rejectB = false;
    (window as any).navigation.commit({ note: 'D' });
    (window as any).navigationState.visible = 'D';
  });
  await page.goBack();
  await expectRoute('C');
  await page.evaluate(() => {
    (window as any).navigationState.dirty = true;
  });
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).navigationState.pending))
    .toBe(true);
  await expectRoute('C');
  await page.evaluate(() => {
    (window as any).navigationState.pending = undefined;
  });
  await expectRoute('C');
  await page.goBack();
  await expect
    .poll(() => page.evaluate(() => !!(window as any).navigationState.pending))
    .toBe(true);
  await expectRoute('C');
  await page.evaluate(async () => {
    const state = (window as any).navigationState;
    state.dirty = false;
    await state.pending();
  });
  await expectRoute('B');
  await page.goForward();
  await expectRoute('C');
});

test('an obsolete failed route cannot roll back a newer committed selection', async () => {
  await page.evaluate(() => {
    const state = (window as any).navigationState;
    state.holdB = new Promise<void>((resolve) => {
      state.releaseB = resolve;
    });
    state.rejectB = true;
  });
  await page.goBack();
  await page.evaluate(() => {
    (window as any).navigation.commit({ note: 'D' });
    (window as any).navigationState.visible = 'D';
    (window as any).navigationState.releaseB();
  });
  await expectRoute('D');
  await expect.poll(() => page.evaluate(() => (window as any).navigationState.errors)).toBe(0);
});

test('a selection committed while rollback is pending is pushed after the real pointer is restored', async () => {
  await page.evaluate(() => {
    const state = (window as any).navigationState;
    state.rejectB = true;
    state.onError = () => {
      (window as any).navigation.commit({ note: 'D' });
      state.visible = 'D';
    };
  });
  await page.goBack();
  await expectRoute('D');
  await page.evaluate(() => {
    (window as any).navigationState.rejectB = false;
  });
  await page.goBack();
  await expectRoute('C');
  await page.goBack();
  await expectRoute('B');
  await page.goForward();
  await expectRoute('C');
});

test('disposing a workspace prevents its outstanding failed navigation from changing the new route', async () => {
  await page.evaluate(() => {
    const state = (window as any).navigationState;
    state.holdB = new Promise<void>((resolve) => {
      state.releaseB = resolve;
    });
    state.rejectB = true;
  });
  await page.goBack();
  await page.evaluate(() => {
    const state = (window as any).navigationState;
    (window as any).navigation.dispose();
    history.pushState({ dooknowIndex: 2 }, '', '?note=NEW_WORKSPACE');
    state.visible = 'NEW_WORKSPACE';
    state.releaseB();
  });
  await expectRoute('NEW_WORKSPACE');
  await expect.poll(() => page.evaluate(() => (window as any).navigationState.errors)).toBe(0);
});

test('toolbar history buttons track available in-app navigation and truncate forward history after a new selection', async () => {
  const capabilities = () => page.evaluate(() => (window as any).navigationState.capabilities);
  expect(await capabilities()).toEqual({ canBack: true, canForward: false });
  await page.evaluate(() => (window as any).navigation.back());
  await expectRoute('B');
  expect(await capabilities()).toEqual({ canBack: true, canForward: true });
  await page.evaluate(() => (window as any).navigation.back());
  await expectRoute('A');
  expect(await capabilities()).toEqual({ canBack: false, canForward: true });
  await page.evaluate(() => (window as any).navigation.forward());
  await expectRoute('B');
  await page.evaluate(() => {
    (window as any).navigation.commit({ note: 'D' });
    (window as any).navigationState.visible = 'D';
  });
  expect(await capabilities()).toEqual({ canBack: true, canForward: false });
});
