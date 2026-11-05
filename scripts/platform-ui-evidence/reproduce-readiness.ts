/** One isolated plugin-conflict readiness investigation; does not start a server. */
import { chromium, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isolatedConfig, authBudget } from './fixture';
import { settingsScenes } from './settings-scenes';
import { startSceneLifecycle, releaseScene, boundAPIRequests, bounded } from './lifecycle';
import type { Fixture } from './model';
import { waitFontReadiness, waitAnimationSettle } from './readiness';

const output = resolve(process.argv[2] || '.local/readiness-reproduction');
const freshMcp = process.argv.includes('--fresh-mcp');
const liveWait = process.argv.includes('--current-animation-wait');
await mkdir(output, { recursive: true });
const config = await isolatedConfig('.local/e2e-config.json');
if (config.origin !== 'http://127.0.0.1:4479') throw Error('This investigation is restricted to the root-owned4479 fixture');
authBudget(config);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: config.origin, viewport: { width: 1440, height: 1000 }, colorScheme: 'light' });
boundAPIRequests(context.request, 15000);
await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
const session = await (await context.request.get('/api/auth/get-session')).json();
const csrf = await (await context.request.get('/api/security/csrf')).json();
const page = await context.newPage(); page.setDefaultTimeout(8000); startSceneLifecycle(page);
await context.addInitScript(id => localStorage.setItem('dooknow.preferences.v1:' + encodeURIComponent(id), JSON.stringify({ editorKind: 'source', mode: 'edit', theme: 'light' })), session.user.id);
const records: any[] = [], pageErrors: string[] = [];
page.on('pageerror', error => pageErrors.push(error.message));
const started = Date.now();
async function snapshot(phase: string, extra: Record<string, unknown> = {}) {
  const state = await page.evaluate(() => ({
    documentVisibility: document.visibilityState, fontsStatus: document.fonts.status,
    waitTracker: (window as any).__platformUIReadinessWait ? {
      phase: (window as any).__platformUIReadinessWait.phase,
      entries: (window as any).__platformUIReadinessWait.entries.map((entry: any) => ({
        initial: entry.initial, promiseState: entry.promiseState, events: entry.events,
        current: { playState: entry.animation.playState, pending: entry.animation.pending,
          currentTime: entry.animation.currentTime, playbackRate: entry.animation.playbackRate,
          connected: entry.animation.effect?.target?.isConnected, inCurrentAnimations: document.getAnimations().includes(entry.animation),
          timing: entry.animation.effect?.getComputedTiming(), sameFinishedPromise: entry.animation.finished === entry.originalFinished },
      })),
    } : null,
    faces: [...document.fonts].map(face => ({ family: face.family, style: face.style, weight: face.weight,
      stretch: face.stretch, status: face.status, display: face.display, unicodeRange: face.unicodeRange })),
    animations: document.getAnimations().map(animation => {
      const effect = animation.effect as KeyframeEffect | null;
      const target = effect?.target as Element | null;
      return { kind: animation.constructor.name, id: animation.id, playState: animation.playState,
        pending: animation.pending, currentTime: animation.currentTime, playbackRate: animation.playbackRate,
        startTime: animation.startTime, timing: effect?.getComputedTiming(), declaredTiming: effect?.getTiming(),
        target: target ? { tag: target.tagName, className: String(target.className), role: target.getAttribute('role'),
          label: target.getAttribute('aria-label'), bounds: (() => { const r = target.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() } : null };
    }),
    fontResources: performance.getEntriesByType('resource').filter(entry => /\.(?:woff2?|ttf|otf)(?:[?#]|$)/.test(entry.name)).map(entry => ({
      name: new URL(entry.name).pathname, duration: entry.duration, startTime: entry.startTime })),
    conflictVisible: [...document.querySelectorAll('.plugin-settings')].some(element => (element.textContent ?? '').includes('已保存配置在其他位置发生变化')),
    secretFieldLengths: [...document.querySelectorAll('input[type="password"],textarea[aria-label="新 API Key"]')].map(element => (element as HTMLInputElement).value.length),
  }));
  const entry = { phase, elapsedMs: Date.now() - started, ...extra, state };
  records.push(entry);
  await writeFile(resolve(output, 'diagnostics.json'), JSON.stringify({ kind: 'diagnostic-not-acceptance',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pageErrors, records }, null, 2) + '\n');
  console.log(JSON.stringify({ phase, elapsedMs: entry.elapsedMs, fonts: state.fontsStatus, faceCount: state.faces.length,
    animationCount: state.animations.length, finiteAnimations: state.animations.filter(animation => typeof animation.timing?.endTime === 'number' && Number.isFinite(animation.timing.endTime)).length,
    ...Object.fromEntries(Object.entries(extra).filter(([key]) => !['fonts', 'animations'].includes(key))) }));
  return state;
}
const fixture: Fixture = { ...config, userId: session.user.id, noteId: '', secondNoteId: '', noteContent: '', privateNoteId: '', revokedNoteId: '', expiredNoteId: '', publicSlug: '', collectionSlug: '', shares: [],
  api: async (path, method = 'GET', data) => {
    const response = await context.request.fetch(path, { method, headers: { origin: config.origin, 'x-csrf-token': csrf.token }, data });
    if (!response.ok()) throw Error(`Readiness fixture API ${method} failed ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  }, setTemplate: async () => { throw Error('Not part of minimal readiness reproduction'); } };
const scene = settingsScenes.find(scene => scene.id === 'settings-extra-plugin-config-conflict')!;
const env = { page, context, fixture, variant: { id: '1440-light', width: 1440, height: 1000, theme: 'light' as const } };
try {
  if (freshMcp) {
    const registry = await fixture.api('/api/platform/plugins');
    if (registry.installed.some((plugin: any) => plugin.id === 'mcp')) await fixture.api('/api/platform/plugins/mcp/uninstall', 'POST', {});
    console.log(JSON.stringify({ phase: 'fresh-mcp-precondition', actualUninstall: true, scope: 'guarded-synthetic-fixture-only-data-retained' }));
  }
  await bounded('MINIMAL_SCENE_BEFORE_OPEN', (async () => {
    await scene.before?.(env); await page.goto(typeof scene.path === 'string' ? scene.path : scene.path(fixture), { waitUntil: 'domcontentloaded', timeout: 15000 });
    await expect(page.locator('.settings-workspace h1').first()).toBeVisible();
    await snapshot('before-open'); await scene.open?.(env);
    await (typeof scene.target === 'string' ? page.locator(scene.target) : scene.target(page)).last().waitFor({ state: 'visible', timeout: 8000 });
  })(), 45000);
  if (freshMcp) {
    if (liveWait) {
      const fonts = await waitFontReadiness(page, 10000);
      const animations = await waitAnimationSettle(page, 10000);
      await expect(page.getByText('已保存配置在其他位置发生变化', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '保存插件配置', exact: true })).toBeDisabled();
      await snapshot('fresh-current-live-animation-wait-resolved', { fonts, animations });
    } else {
    await bounded('FRESH_ORIGINAL_FONTS_RETURN', page.evaluate(() => document.fonts.ready), 10000);
    await snapshot('fresh-original-fonts-return-resolved');
    await bounded('FRESH_ORIGINAL_ANIMATION_AND_RAF', page.evaluate(async () => {
      const animations = document.getAnimations().filter(animation => { const timing = animation.effect?.getComputedTiming(); return animation.playState === 'running' && typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime); });
      const tracker = { phase: 'original-finished-promises', entries: animations.map(animation => ({ animation, originalFinished: animation.finished,
        promiseState: 'pending', events: [] as string[], initial: { kind: animation.constructor.name, playState: animation.playState,
          currentTime: animation.currentTime, timing: animation.effect?.getComputedTiming(),
          targetClass: String((animation.effect as KeyframeEffect | null)?.target?.className) } })) };
      (window as any).__platformUIReadinessWait = tracker;
      await Promise.all(tracker.entries.map(entry => {
        entry.animation.addEventListener('finish', () => entry.events.push('finish'));
        entry.animation.addEventListener('cancel', () => entry.events.push('cancel'));
        return entry.originalFinished.then(() => { entry.promiseState = 'resolved'; }, () => { entry.promiseState = 'rejected'; });
      }));
      tracker.phase = 'raf-1';
      await new Promise<void>(done => requestAnimationFrame(() => { tracker.phase = 'raf-2'; requestAnimationFrame(() => { tracker.phase = 'settled'; done(); }); }));
    }), 10000);
    await snapshot('fresh-original-full-settle-resolved');
    }
  }
  const state = await snapshot('after-real-conflict-open-and-target');
  await bounded('ORIGINAL_DOCUMENT_FONTS_RETURN', page.evaluate(() => document.fonts.ready), 10000)
    .then(() => snapshot('original-fonts-return-resolved'), error => snapshot('original-fonts-return-timeout', { error: String(error) }));
  const cdp = await context.newCDPSession(page);
  if (!state.secretFieldLengths.some(length => length > 0)) {
    const shot = await bounded('CDP_DIAGNOSTIC_SCREENSHOT', cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), 5000);
    const bytes = Buffer.from(shot.data, 'base64'); await writeFile(resolve(output, 'diagnostic-only.png'), bytes);
    await snapshot('diagnostic-cdp-screenshot', { kind: 'diagnostic-only-not-runtime-acceptance', sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await cdp.detach();
  await bounded('DOCUMENT_FONTS_READY', page.evaluate(() => document.fonts.ready.then(() => true)), 10000)
    .then(() => snapshot('fonts-ready-resolved'), error => snapshot('fonts-ready-timeout', { error: String(error) }));
  await bounded('FINITE_ANIMATIONS_FINISHED', page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => { const timing = animation.effect?.getComputedTiming(); return animation.playState === 'running' && typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime); });
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined))); return true;
  }), 10000).then(() => snapshot('finite-animations-resolved'), error => snapshot('finite-animations-timeout', { error: String(error) }));
} catch (error) { await snapshot('reproduction-failed', { error: String(error).split('\n').slice(0, 3).join(' ') }); process.exitCode = 1;
} finally {
  await releaseScene(page, 'minimal-reproduction-finished');
  await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close(); await browser.close();
}
