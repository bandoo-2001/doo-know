import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, test } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import ts from 'typescript';

// Exercise the browser's real transactions without starting an application server.
let browser: Browser, context: BrowserContext, page: Page, moduleSource: string;
beforeAll(async () => {
  moduleSource = ts.transpileModule(
    await readFile(new URL('../apps/web/drafts.ts', import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } },
  ).outputText;
  const libs = resolve('.local/browser-deps/root/usr/lib/x86_64-linux-gnu');
  const env = { ...process.env };
  if (existsSync(libs))
    env.LD_LIBRARY_PATH = libs + (env.LD_LIBRARY_PATH ? delimiter + env.LD_LIBRARY_PATH : '');
  browser = await chromium.launch({ env });
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  context = await browser.newContext();
  await context.route('http://dooknow-drafts.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Draft storage test</title>',
    }),
  );
  page = await context.newPage();
  await page.goto('http://dooknow-drafts.test/');
  await page.evaluate(async (source) => {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    (window as any).draftModule = await new Function('url', 'return import(url)')(url);
    URL.revokeObjectURL(url);
  }, moduleSource);
});
afterEach(async () => {
  await context?.close();
});

describe('browser local draft recovery', () => {
  test('upgrades an existing version-one database without losing recoverable draft text', async () => {
    const result = await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('dooknow-local-drafts', 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('drafts', {
            keyPath: ['scope.ownerId', 'scope.knowledgeId', 'noteId'],
          });
          store.createIndex('owner', 'scope.ownerId');
          store.createIndex('scope', ['scope.ownerId', 'scope.knowledgeId']);
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({
            noteId: 'existing',
            kind: 'note',
            content: 'recover this existing draft',
            baseRevision: 'v1',
            version: 'existing-version',
            updatedAt: 1,
            scope: { ownerId: 'owner', knowledgeId: 'knowledge' },
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      });
      const store = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'owner', knowledgeId: 'knowledge' },
      });
      return await store.load('existing');
    });
    expect(result.content).toBe('recover this existing draft');
    expect(result.version).toBe('existing-version');
  });

  test('a write queued in another page behind logout cannot recreate a cleared draft', async () => {
    const otherPage = await context.newPage();
    await otherPage.goto('http://dooknow-drafts.test/');
    await otherPage.evaluate(async (source) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      (window as any).draftModule = await new Function('url', 'return import(url)')(url);
      URL.revokeObjectURL(url);
      (window as any).oldStore = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'shared-owner', knowledgeId: 'binding' },
      });
      await (window as any).oldStore.put({
        noteId: 'n',
        kind: 'note',
        content: 'before logout',
        baseRevision: 'v1',
      });
      // Keep a real transaction alive, so logout and the late write are both
      // queued before either can commit. No application server or timers.
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('dooknow-local-drafts');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('drafts', 'readwrite');
          const spin = () => {
            const read = tx.objectStore('drafts').get(['shared-owner', 'binding', 'n']);
            read.onsuccess = () => {
              if (!(window as any).releaseDraftLock) spin();
            };
          };
          spin();
          tx.oncomplete = () => db.close();
          resolve();
        };
      });
    }, moduleSource);
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') (window as any).logoutQueued = true;
        return tx;
      };
      (window as any).logoutResult = (window as any).draftModule.clearOwnerDrafts('shared-owner');
    });
    await expect.poll(() => page.evaluate(() => !!(window as any).logoutQueued)).toBe(true);
    await otherPage.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const tx = original.apply(this, args);
        if (args[1] === 'readwrite') (window as any).lateWriteQueued = true;
        return tx;
      };
      (window as any).lateWriteResult = (window as any).oldStore
        .put({ noteId: 'n', kind: 'note', content: 'must stay cleared', baseRevision: 'v1' })
        .then(
          () => 'succeeded',
          (error: any) => error.code,
        );
    });
    await expect.poll(() => otherPage.evaluate(() => !!(window as any).lateWriteQueued)).toBe(true);
    await otherPage.evaluate(() => {
      (window as any).releaseDraftLock = true;
    });
    await page.evaluate(() => (window as any).logoutResult);
    expect(await otherPage.evaluate(() => (window as any).lateWriteResult)).toBe('scope-cleared');
    const restored = await otherPage.evaluate(async () => {
      const freshStore = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'shared-owner', knowledgeId: 'binding' },
      });
      return await freshStore.load('n');
    });
    expect(restored).toBeUndefined();
  });

  test('logout in one page invalidates an existing store in another JavaScript realm', async () => {
    const otherPage = await context.newPage();
    await otherPage.goto('http://dooknow-drafts.test/');
    await otherPage.evaluate(async (source) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      (window as any).draftModule = await new Function('url', 'return import(url)')(url);
      URL.revokeObjectURL(url);
      (window as any).oldStore = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'shared-owner', knowledgeId: 'binding' },
      });
      await (window as any).oldStore.put({
        noteId: 'n',
        kind: 'note',
        content: 'before logout',
        baseRevision: 'v1',
      });
    }, moduleSource);
    await page.evaluate(async () => {
      await (window as any).draftModule.clearOwnerDrafts('shared-owner');
    });
    const result = await otherPage.evaluate(async () => {
      let staleWriteCode = '';
      try {
        await (window as any).oldStore.put({
          noteId: 'n',
          kind: 'note',
          content: 'must not reappear',
          baseRevision: 'v1',
        });
      } catch (error) {
        staleWriteCode = (error as any).code;
      }
      const freshStore = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'shared-owner', knowledgeId: 'binding' },
      });
      const afterLogout = await freshStore.load('n');
      await freshStore.put({
        noteId: 'new-session',
        kind: 'note',
        content: 'new login work',
        baseRevision: 'v2',
      });
      return { staleWriteCode, afterLogout, newSession: await freshStore.load('new-session') };
    });
    expect(result.staleWriteCode).toBe('scope-cleared');
    expect(result.afterLogout).toBeUndefined();
    expect(result.newSession.content).toBe('new login work');
  });

  test('retains unsaved text after a reload, isolated by owner, knowledge binding and note', async () => {
    await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const store = createDraftStore({ scope: { ownerId: 'owner-a', knowledgeId: 'knowledge-a' } });
      await store.put({
        noteId: 'note-a',
        kind: 'note',
        content: 'private unsaved text',
        baseRevision: 'v1',
      });
    });
    await page.reload();
    await page.evaluate(async (source) => {
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      (window as any).draftModule = await new Function('url', 'return import(url)')(url);
      URL.revokeObjectURL(url);
    }, moduleSource);
    const result = await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const store = (ownerId: string, knowledgeId: string) =>
        createDraftStore({ scope: { ownerId, knowledgeId } });
      const draft = await store('owner-a', 'knowledge-a').load('note-a');
      return {
        draft,
        otherOwner: await store('owner-b', 'knowledge-a').load('note-a'),
        otherKnowledge: await store('owner-a', 'knowledge-b').load('note-a'),
        otherNote: await store('owner-a', 'knowledge-a').load('note-b'),
        localStorageLength: localStorage.length,
      };
    });
    expect(result.draft.content).toBe('private unsaved text');
    expect(result.draft.version).toEqual(expect.any(String));
    expect(result.draft.updatedAt).toBeGreaterThan(0);
    expect(result.otherOwner).toBeUndefined();
    expect(result.otherKnowledge).toBeUndefined();
    expect(result.otherNote).toBeUndefined();
    expect(result.localStorageLength).toBe(0);
  });

  test.each([
    { name: 'an unknown version', loadFirst: false, base: 'v1', kind: 'note', winner: 'note' },
    {
      name: 'a shared original revision',
      loadFirst: true,
      base: 'v1',
      kind: 'note',
      winner: 'note',
    },
    {
      name: 'a different original revision',
      loadFirst: true,
      base: 'v2',
      kind: 'note',
      winner: 'note',
    },
    { name: 'a competing fragment', loadFirst: true, base: 'v2', kind: 'fragment', winner: 'note' },
    { name: 'an existing fragment', loadFirst: true, base: 'v1', kind: 'note', winner: 'fragment' },
  ])('preserves a foreign durable draft against $name', async (input) => {
    const result = await page.evaluate(async (input) => {
      const { createDraftStore } = (window as any).draftModule;
      const scope = { ownerId: 'shared-owner', knowledgeId: 'knowledge' };
      const writer = createDraftStore({ scope }),
        contender = createDraftStore({ scope });
      if (input.loadFirst) await contender.load('n');
      const range = {
        startLine: 1,
        endLine: 1,
        lineByteOffset: 0,
        startByte: 0,
        endByte: 10,
        rangeHash: 'range',
      };
      const first = await writer.put({
        noteId: 'n',
        kind: input.winner,
        content: 'B durable text',
        baseRevision: 'v1',
        ...(input.winner === 'fragment' ? { range } : {}),
      });
      let error: any;
      try {
        await contender.put({
          noteId: 'n',
          kind: input.kind,
          content: 'A competing text',
          baseRevision: input.base,
          ...(input.kind === 'fragment' ? { range } : {}),
        });
      } catch (cause) {
        error = { code: (cause as any).code, message: (cause as any).message };
      }
      const after = await createDraftStore({ scope }).load('n');
      return {
        error,
        content: after?.content,
        kind: after?.kind,
        sameVersion: after?.version === first.version,
      };
    }, input);
    expect(result.error?.code).toBe('conflict');
    expect(result.error?.message).toContain('其他页面');
    expect(result.error?.message).not.toContain('B durable text');
    expect(result.content).toBe('B durable text');
    expect(result.kind).toBe(input.winner);
    expect(result.sameVersion).toBe(true);
  });

  test.each([undefined, null, '', 0])(
    'preserves a present record with unusable version %s',
    async (invalidVersion) => {
      const result = await page.evaluate(async (invalidVersion) => {
        const { createDraftStore } = (window as any).draftModule;
        const scope = { ownerId: 'owner', knowledgeId: 'knowledge' };
        const contender = createDraftStore({ scope });
        await contender.load('n');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const opening = indexedDB.open('dooknow-local-drafts');
          opening.onsuccess = () => resolve(opening.result);
          opening.onerror = () => reject(opening.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('drafts', 'readwrite');
          tx.objectStore('drafts').put({
            scope,
            noteId: 'n',
            kind: 'note',
            content: 'existing recovery text',
            baseRevision: 'v1',
            updatedAt: 1,
            ...(invalidVersion === undefined ? {} : { version: invalidVersion }),
          });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
        await contender.load('n');
        const code = await contender
          .put({
            noteId: 'n',
            kind: 'note',
            content: 'must not replace malformed record',
            baseRevision: 'v1',
          })
          .then(
            () => 'written',
            (error: any) => error.code,
          );
        return { code, after: (await contender.load('n'))?.content };
      }, invalidVersion);
      expect(result.code).toBe('conflict');
      expect(result.after).toBe('existing recovery text');
    },
  );

  test('a pending load cannot authorize a write that was already called without its version', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const scope = { ownerId: 'owner', knowledgeId: 'knowledge' };
      const writer = createDraftStore({ scope });
      const first = await writer.put({
        noteId: 'n',
        kind: 'note',
        content: 'already durable B',
        baseRevision: 'v1',
      });
      const contender = createDraftStore({ scope });
      const loading = contender.load('n');
      const writing = contender
        .put({
          noteId: 'n',
          kind: 'note',
          content: 'queued before observing B',
          baseRevision: 'v1',
        })
        .then(
          () => 'written',
          (error: any) => error.code,
        );
      const observed = await loading;
      return {
        observedFirst: observed?.version === first.version,
        write: await writing,
        after: (await writer.load('n'))?.content,
      };
    });
    expect(result.observedFirst).toBe(true);
    expect(result.write).toBe('conflict');
    expect(result.after).toBe('already durable B');
  });

  test('a failed stale removal does not adopt another writer version for a later write', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const scope = { ownerId: 'owner', knowledgeId: 'knowledge' };
      const writer = createDraftStore({ scope }),
        contender = createDraftStore({ scope });
      const first = await writer.put({
        noteId: 'n',
        kind: 'note',
        content: 'B first',
        baseRevision: 'v1',
      });
      await contender.load('n');
      const newer = await writer.put({
        noteId: 'n',
        kind: 'note',
        content: 'B newer durable',
        baseRevision: 'v1',
      });
      const removed = await contender.remove('n', first.version);
      const code = await contender
        .put({ noteId: 'n', kind: 'note', content: 'A stale update', baseRevision: 'v1' })
        .then(
          () => 'written',
          (error: any) => error.code,
        );
      const after = await writer.load('n');
      return {
        removed,
        code,
        content: after?.content,
        sameVersion: after?.version === newer.version,
      };
    });
    expect(result.removed).toBe(false);
    expect(result.code).toBe('conflict');
    expect(result.content).toBe('B newer durable');
    expect(result.sameVersion).toBe(true);
  });

  test('a stale writer cannot resurrect a removed draft until it explicitly observes the absence', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const scope = { ownerId: 'owner', knowledgeId: 'knowledge' };
      const writer = createDraftStore({ scope }),
        contender = createDraftStore({ scope });
      const first = await writer.put({
        noteId: 'n',
        kind: 'note',
        content: 'old draft',
        baseRevision: 'v1',
      });
      await contender.load('n');
      await writer.remove('n', first.version);
      const code = await contender
        .put({ noteId: 'n', kind: 'note', content: 'stale resurrected text', baseRevision: 'v1' })
        .then(
          () => 'written',
          (error: any) => error.code,
        );
      const afterRejected = await writer.load('n');
      await contender.load('n');
      await contender.put({
        noteId: 'n',
        kind: 'note',
        content: 'new explicitly observed work',
        baseRevision: 'v2',
      });
      return { code, afterRejected, afterExplicitLoad: (await contender.load('n'))?.content };
    });
    expect(result.code).toBe('conflict');
    expect(result.afterRejected).toBeUndefined();
    expect(result.afterExplicitLoad).toBe('new explicitly observed work');
  });

  test.each(['one store', 'separate stores'])(
    'only one racing unobserved write can commit through %s',
    async (kind) => {
      const result = await page.evaluate(async (kind) => {
        const { createDraftStore } = (window as any).draftModule;
        const scope = { ownerId: 'owner', knowledgeId: 'knowledge' };
        const first = createDraftStore({ scope }),
          second = kind === 'one store' ? first : createDraftStore({ scope });
        await Promise.all([first.load('n'), second.load('n')]);
        const settled = await Promise.allSettled([
          first.put({
            noteId: 'n',
            kind: 'note',
            content: 'first competing text',
            baseRevision: 'v1',
          }),
          second.put({
            noteId: 'n',
            kind: 'note',
            content: 'second competing text',
            baseRevision: 'v1',
          }),
        ]);
        return {
          successful: settled.filter((item) => item.status === 'fulfilled').length,
          errors: settled
            .filter((item): item is PromiseRejectedResult => item.status === 'rejected')
            .map((item) => item.reason.code),
          content: (await createDraftStore({ scope }).load('n'))?.content,
        };
      }, kind);
      expect(result.successful).toBe(1);
      expect(result.errors).toEqual(['conflict']);
      expect(['first competing text', 'second competing text']).toContain(result.content);
    },
  );

  test('serialized own writes remain writable after successful removal and scope clearing', async () => {
    const result = await page.evaluate(async () => {
      const store = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'owner', knowledgeId: 'knowledge' },
      });
      const first = await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'first',
        baseRevision: 'v1',
      });
      const second = await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'second',
        baseRevision: 'v1',
      });
      const removed = await store.remove('n', second.version);
      await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'after own removal',
        baseRevision: 'v2',
      });
      await store.clearScope();
      await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'after own scope clear',
        baseRevision: 'v3',
      });
      return {
        differentVersion: first.version !== second.version,
        removed,
        content: (await store.load('n'))?.content,
      };
    });
    expect(result.differentVersion).toBe(true);
    expect(result.removed).toBe(true);
    expect(result.content).toBe('after own scope clear');
  });

  test('clears only the submitted version and keeps edits made while a save is running', async () => {
    const result = await page.evaluate(async () => {
      const store = (window as any).draftModule.createDraftStore({
        scope: { ownerId: 'o', knowledgeId: 'k' },
      });
      const submitted = await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'submitted',
        baseRevision: 'v1',
      });
      const next = await store.put({
        noteId: 'n',
        kind: 'note',
        content: 'typed during save',
        baseRevision: 'v1',
      });
      const staleRemoval = await store.remove('n', submitted.version);
      const afterSave = await store.load('n');
      const currentRemoval = await store.remove('n', next.version);
      return { staleRemoval, afterSave, currentRemoval, afterRemoval: await store.load('n') };
    });
    expect(result.staleRemoval).toBe(false);
    expect(result.afterSave.content).toBe('typed during save');
    expect(result.currentRemoval).toBe(true);
    expect(result.afterRemoval).toBeUndefined();
  });

  test('explicit logout clears every binding of its owner and invalidates pending stores', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore, clearOwnerDrafts } = (window as any).draftModule;
      const a = createDraftStore({ scope: { ownerId: 'a', knowledgeId: 'k' } });
      const b = createDraftStore({ scope: { ownerId: 'a', knowledgeId: 'other-k' } });
      const other = createDraftStore({ scope: { ownerId: 'b', knowledgeId: 'k' } });
      const input = { noteId: 'n', kind: 'note', content: 'unsaved', baseRevision: 'v1' };
      await Promise.all([a.put(input), b.put(input), other.put(input)]);
      await clearOwnerDrafts('a');
      let lateWriteCode = '';
      try {
        await a.put({ ...input, content: 'late timer' });
      } catch (error) {
        lateWriteCode = (error as any).code;
      }
      return {
        own: await createDraftStore({ scope: { ownerId: 'a', knowledgeId: 'k' } }).load('n'),
        ownOtherBinding: await createDraftStore({
          scope: { ownerId: 'a', knowledgeId: 'other-k' },
        }).load('n'),
        other: await other.load('n'),
        lateWriteCode,
      };
    });
    expect(result.own).toBeUndefined();
    expect(result.ownOtherBinding).toBeUndefined();
    expect(result.other.content).toBe('unsaved');
    expect(result.lateWriteCode).toBe('scope-cleared');
  });

  test('reports unavailable and quota failures without exposing private content', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore } = (window as any).draftModule;
      const store = createDraftStore({ scope: { ownerId: 'o', knowledgeId: 'k' } });
      await store.load('n');
      const originalPut = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () {
        throw new DOMException('private text must not leak', 'QuotaExceededError');
      };
      let quota: any;
      try {
        await store.put({
          noteId: 'n',
          kind: 'note',
          content: 'private text must not leak',
          baseRevision: 'v1',
        });
      } catch (error) {
        quota = { code: (error as any).code, message: (error as any).message };
      }
      IDBObjectStore.prototype.put = originalPut;
      Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      let unavailable: any;
      try {
        await createDraftStore({ scope: { ownerId: 'x', knowledgeId: 'y' } }).load('n');
      } catch (error) {
        unavailable = { code: (error as any).code, message: (error as any).message };
      }
      return { quota, unavailable };
    });
    expect(result.quota.code).toBe('quota');
    expect(result.quota.message).not.toContain('private text');
    expect(result.unavailable.code).toBe('unavailable');
  });

  test('stores only a bounded large-file fragment with its exact source and line range', async () => {
    const result = await page.evaluate(async () => {
      const { createDraftStore, noteDraftBase } = (window as any).draftModule;
      const store = createDraftStore({ scope: { ownerId: 'o', knowledgeId: 'k' } });
      const base = noteDraftBase({ modifiedAt: '2026-10-18T10:00:00Z', contentHash: 'hash-a' });
      const range = {
        startLine: 70,
        endLine: 75,
        lineByteOffset: 0,
        startByte: 700,
        endByte: 750,
        rangeHash: 'range-a',
      };
      await store.put({
        noteId: 'large',
        kind: 'fragment',
        content: 'only this fragment',
        baseRevision: base,
        range,
      });
      let oversizedRejected = false;
      try {
        await store.put({
          noteId: 'large',
          kind: 'fragment',
          content: '字'.repeat(50000),
          baseRevision: base,
          range,
        });
      } catch {
        oversizedRejected = true;
      }
      return {
        draft: await store.load('large'),
        oversizedRejected,
        changed:
          base !== noteDraftBase({ modifiedAt: '2026-10-18T10:00:01Z', contentHash: 'hash-b' }),
      };
    });
    expect(result.draft.content).toBe('only this fragment');
    expect(result.draft.range).toEqual({
      startLine: 70,
      endLine: 75,
      lineByteOffset: 0,
      startByte: 700,
      endByte: 750,
      rangeHash: 'range-a',
    });
    expect(result.oversizedRejected).toBe(true);
    expect(result.changed).toBe(true);
  });
});
