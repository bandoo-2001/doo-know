/** Real runtime evidence. This script never starts or stops a server. */
import { chromium, expect, type Locator, type Page, type ElementHandle } from '@playwright/test';
import { mkdir, readFile, writeFile, readdir, copyFile, appendFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { closeSidebar } from './scenes';
import { allScenes as scenes } from './registry';
import { variants, type Scene, type Variant } from './model';
import { inputs, writeMatrix } from './coverage';
import { isolatedConfig, authBudget, prepareFixture } from './fixture';
import { prepareSetupFixture } from './setup-adapter';
import { startSceneLifecycle, releaseScene, assertSceneActive, boundAPIRequests, bounded, runSceneBudget } from './lifecycle';
import { waitFontReadiness, waitAnimationSettle, readinessDiagnostic } from './readiness';

const args = process.argv.slice(2);
function option(name: string, fallback = '') { const index = args.indexOf('--' + name); return index < 0 ? fallback : args[index + 1] ?? ''; }
const directory = resolve(option('output', '.local/platform-ui-evidence-plan'));
const suite = option('suite', 'main');
if (!['main', 'setup'].includes(suite)) throw Error('--suite must be main or setup');
const sceneBudgetMs = Number(option('scene-timeout-ms', '180000'));
const apiTimeoutMs = Number(option('api-timeout-ms', '30000'));
const cleanupTimeoutMs = Number(option('cleanup-timeout-ms', '12000'));
for (const value of [sceneBudgetMs, apiTimeoutMs, cleanupTimeoutMs]) if (!Number.isInteger(value) || value < 1000 || value > 900000) throw Error('Capture time budgets must be integer milliseconds from1000 through900000');
const selection = option('scenes').split(',').filter(Boolean);
// The modern permission model changes the isolated plugin's persisted ceiling.
const modernOnly = 'public-oauth-modern';
if (selection.includes(modernOnly) && selection.length !== 1)
  throw Error('Run public-oauth-modern alone on a disposable V2 browser fixture');
const selected = scenes.filter(scene => (scene.suite ?? 'main') === suite &&
  (selection.length ? selection.includes(scene.id) : scene.id !== modernOnly || args.includes('--plan')));
const chosenVariants = option('variants').split(',').filter(Boolean);
const runVariants = variants.filter(variant => !chosenVariants.length || chosenVariants.includes(variant.id));
if (selection.some(id => !scenes.some(scene => scene.id === id))) throw Error('Unknown --scenes id');
if (!selected.length) throw Error('No scenes selected in the requested suite');
if (chosenVariants.some(id => !variants.some(variant => variant.id === id))) throw Error('Unknown --variants id');

if (args.includes('--plan')) {
  const matrix = await writeMatrix(directory, scenes, []);
  await writeFile(resolve(directory, 'capture-plan.json'), JSON.stringify({
    scenes: selected.map(({ open, before, verify, afterCapture, path, target, ...scene }) => ({ ...scene,
      route: typeof path === 'string' ? path : '<isolated-fixture-route>', target: typeof target === 'string' ? target : '<role-selector>' })), variants: runVariants,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'plan-only-no-browser-started', scenes: selected.length, variants: runVariants.length, sourceSummary: matrix.summary }));
  process.exit(0);
}

const sourceCommit = option('source-commit');
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw Error('Supply exact --source-commit <40-character SHA> after application source is frozen.');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (head !== sourceCommit) throw Error('Current checkout HEAD differs from frozen --source-commit.');
const applicationPaths = ['apps', 'packages', 'plugins', 'shared', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json'];
const applicationFiles = execFileSync('git', ['ls-files', '-z', '--', ...applicationPaths]).toString().split('\0').filter(Boolean).sort();
const changedApplicationFiles = execFileSync('git', ['diff', '--name-only', sourceCommit, '--', ...applicationPaths]).toString().trim();
const untrackedApplicationFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...applicationPaths]).toString().trim();
if (changedApplicationFiles || untrackedApplicationFiles) throw Error('Application source differs from frozen commit; commit changes and recapture.');
async function fingerprint() {
  const files = [];
  for (const path of applicationFiles) files.push({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  return { algorithm: 'sha256-sorted-path-nul-content-hash', sha256: createHash('sha256').update(files.map(file => file.path + '\0' + file.sha256 + '\n').join('')).digest('hex'), files };
}
const applicationFingerprint = await fingerprint();
const harnessDirectory = resolve('scripts/platform-ui-evidence');
const harnessFiles = [];
for (const file of (await readdir(harnessDirectory)).filter(file => file.endsWith('.ts')).sort()) harnessFiles.push({ file,
  sha256: createHash('sha256').update(await readFile(resolve(harnessDirectory, file))).digest('hex') });
const harnessFingerprint = { algorithm: 'sha256-sorted-file-and-content-hash', files: harnessFiles,
  sha256: createHash('sha256').update(harnessFiles.map(file => file.file + '\0' + file.sha256 + '\n').join('')).digest('hex') };
const config = await isolatedConfig(option('config', '.local/e2e-config.json'));
config.captureApiTimeoutMs = apiTimeoutMs;
if (suite === 'setup' && config.setupFixture !== true) throw Error('Setup suite requires the dedicated setup factory config');
if (suite === 'main' && config.setupFixture === true) throw Error('Dedicated setup fixture cannot execute the main suite');
if (option('origin') && option('origin') !== config.origin) throw Error('--origin differs from guarded fixture origin.');
await mkdir(directory, { recursive: true });
if ((await readdir(directory)).some(file => file === 'capture-results.json')) throw Error('Output already contains a capture run. Use a new directory; preserve original failures.');
const frozenInputs = await inputs();
const designOutputs = new Map<string, any>(frozenInputs.catalog.outputs.map((output: any) => [output.id, output]));
const designCoverage = new Map<string, any>(frozenInputs.catalog.coverage.map((entry: any) => [entry.sourceId, entry]));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const startedAt = new Date().toISOString();
await writeFile(resolve(directory, 'run.json'), JSON.stringify({ schema: 1, runId, status: 'running', suite, startedAt, sourceCommit,
  limits: { sceneBudgetMs, apiTimeoutMs, cleanupTimeoutMs },
  applicationFingerprint, harnessFingerprint, inputFingerprints: frozenInputs.fingerprints,
  browser: 'Playwright Chromium; emulation only, no physical keyboard/OS-picker/print/external-delivery claim',
  fixture: { origin: config.origin, temporaryRootGuardPassed: true, realLocalAPIs: true },
  buildFlags: { VITE_DOCUMENT_EDITOR_ENABLED: process.env.VITE_DOCUMENT_EDITOR_ENABLED ?? 'unknown-server-build-flag' },
  requestedScenes: selected.map(scene => scene.id), variants: runVariants,
  command: process.argv.map(value => value.includes('cookie') ? '<cookie-file-option-or-path>' : value),
}, null, 2) + '\n');

function shortError(error: unknown) {
  return String(error).split('\n').slice(0, 3).join(' ').replace(/\/s\/[^\s?'"]+/g, '/s/<isolated-capability>')
    .replace(/oauth_query=[^\s&'"]+/g, 'oauth_query=<isolated-request>');
}
function safeRoute(url: string) {
  const parsed = new URL(url);
  if (parsed.pathname.startsWith('/s/')) return '/s/<isolated-capability>';
  if (/oauth|authorize/.test(parsed.pathname)) return parsed.pathname + '?<isolated-request>';
  return parsed.pathname + parsed.search.replace(/([?&]note=)[^&]+/g, '$1<fixture-note>');
}
const sensitiveSelectors = ['input[type="password"]', 'textarea[aria-label="新 API Key"]', 'input[aria-label="公开链接"]',
  'textarea[aria-label="SSH 私钥"]', 'textarea[aria-label="恢复私钥"]', 'textarea[autocomplete="new-password"]',
  '[data-testid="api-key-secret"]', '.share-link input'];
async function screenshot(page: Page, filename: string) {
  const bytes = await page.screenshot({ path: resolve(directory, filename), animations: 'disabled', fullPage: false,
    mask: sensitiveSelectors.map(selector => page.locator(selector)), maskColor: '#cbd5e1', timeout: 10000 });
  return { file: filename, sha256: createHash('sha256').update(bytes).digest('hex'), redactionSelectors: sensitiveSelectors };
}
async function businessReady(page: Page, route: string, scene: Scene) {
  const asserted: string[] = [];
  if (scene.readiness === 'target') return ['explicit transitional/fault scene: actual scene target and open assertions govern readiness'];
  if (scene.role === 'owner' && !/oauth|\/api\/blog/.test(route)) {
    await expect(page.locator('.workspace')).toBeVisible({ timeout: 20000 });
    if (route === '/') { await expect(page.getByRole('heading', { name: '选择一篇笔记', exact: true })).toBeVisible({ timeout: 20000 }); asserted.push('real ready heading 选择一篇笔记'); }
    if (/[?&]note=/.test(route)) { await expect(page.locator('.note-header h1')).toBeVisible({ timeout: 20000 }); asserted.push('actual note title mounted'); }
    if (route.includes('view=settings')) {
      await expect(page.locator('.settings-workspace h1').first()).toBeVisible({ timeout: 20000 });
      await expect(page.getByText('正在读取知识库信息…', { exact: true })).toBeHidden();
      await expect(page.getByText('正在读取备份记录…', { exact: true })).toBeHidden();
      asserted.push('settings heading; initial library/backup loading hidden');
    }
    if (route.includes('app=graph')) { await expect(page.locator('.graph-workspace')).toBeVisible({ timeout: 20000 }); await expect(page.locator('.workspace-main-menu[data-menu-id="graph"]')).toHaveCount(1, { timeout: 20000 }); asserted.push('real graph workspace and registered hosted menu'); }
    if (route.includes('app=blog')) {
      const section = new URL(route, config.origin).searchParams.get('appSection') || 'overview';
      await expect(page.locator('.blog-workspace #blog-title')).toBeVisible({ timeout: 30000 });
      await expect(page.locator('.blog-admin-site-state')).toBeVisible({ timeout: 30000 });
      const content = { overview: '.blog-overview', articles: '.blog-articles', taxonomy: '.blog-taxonomy',
        settings: '.blog-settings', design: '.blog-studio-editor' }[section];
      if (!content) throw Error('Unknown blog section readiness contract: ' + section);
      await expect(page.locator(content)).toBeVisible({ timeout: 30000 });
      if (section === 'design') await expect(page.getByLabel('姓名', { exact: true })).toBeVisible();
      await expect(page.locator('.main-content .loading-state:visible')).toHaveCount(0, { timeout: 30000 });
      await expect(page.locator('.blog-empty').filter({ hasText: '正在加载博客' })).toBeHidden({ timeout: 30000 });
      asserted.push('actual blog dashboard/site-state and ' + section + ' content; actual LoadingState absent');
    }
    if (route.includes('view=recent') || route.includes('view=favorites')) { await expect(page.locator('.collection-workspace')).toHaveAttribute('aria-busy', 'false', { timeout: 20000 }); asserted.push('collection aria-busy=false'); }
    await closeSidebar(page);
  }
  if (scene.id === 'public-reader') { await expect(page.getByRole('heading', { name: '让知识保持可用', exact: true }).first()).toBeVisible(); asserted.push('real published article heading'); }
  if (scene.id === 'share-reader') { await expect(page.locator('.share-page .markdown')).toContainText('仅用于最终界面取证'); asserted.push('real saved public body'); }
  return asserted;
}
async function probe(target: Locator, page: Page, scene: Scene) {
  await expect(target).toBeVisible();
  // Sampling actual geometry waits for moving drawers without replacing app CSS.
  let previous = ''; for (let attempt = 0; attempt < 12; attempt++) {
    const box = await target.boundingBox(), current = JSON.stringify(box);
    if (current === previous) break; previous = current;
    await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  }
  const targetBounds = await target.boundingBox(), viewport = page.viewportSize()!;
  const targetWithinViewport = !!targetBounds && targetBounds.x >= -1 && targetBounds.y >= -1 &&
    targetBounds.x + targetBounds.width <= viewport.width + 1 && targetBounds.y + targetBounds.height <= viewport.height + 1;
  // Keep actual node identities while asynchronous lists settle. A removed node
  // is a recorded probe limitation, never a new nth node silently substituted.
  const controls = await target.locator('button, input:not([type="hidden"]), textarea, select, [role="button"], [role="combobox"], [tabindex="0"], a[href], summary').elementHandles() as ElementHandle<Element>[];
  const count = controls.length, controlResults = [];
  for (let index = 0; index < Math.min(count, 160); index++) {
    const control = controls[index];
    try {
    if (!await control.isVisible()) continue;
    const identity = await control.evaluate(element => ({ tag: element.tagName, role: element.getAttribute('role'),
      label: (element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent || '').trim().slice(0, 160),
      disabled: element.matches(':disabled,[aria-disabled="true"]'), tabindex: element.getAttribute('tabindex'),
      pointerEvents: getComputedStyle(element).pointerEvents, editingContent: !!element.closest('[contenteditable="true"]') }));
    const initialBounds = await control.boundingBox();
    let scrollError: string | null = null;
    try { await control.scrollIntoViewIfNeeded({ timeout: 1500 }); } catch (error) { scrollError = shortError(error); }
    const metrics = await control.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        withinViewport: rect.x >= -1 && rect.y >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
        centerHit: hit === element || !!hit && element.contains(hit),
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        wrap: getComputedStyle(element).overflowWrap, whiteSpace: getComputedStyle(element).whiteSpace };
    });
    let focused: boolean | null = null;
    if (!identity.disabled && identity.tag !== 'SUMMARY') {
      try { await control.focus(); await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => done()))); focused = await control.evaluate(element => element === document.activeElement || element.contains(document.activeElement)); }
      catch { focused = false; }
    }
    const activeElement = await page.evaluate(() => ({ tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role'), ariaLabel: document.activeElement?.getAttribute('aria-label'), ariaHidden: document.activeElement?.getAttribute('aria-hidden') }));
    const afterFocus = await control.evaluate(element => { const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); return {
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      withinViewport: rect.x >= -1 && rect.y >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1,
      centerHit: hit === element || !!hit && element.contains(hit),
    }; });
    controlResults.push({ index, ...identity, initialBounds, beforeFocus: metrics, ...metrics, ...afterFocus, focused, activeElement, scrollError });
    } catch (error) { controlResults.push({ index, status: 'node-removed-or-probe-failed', error: shortError(error) }); }
  }
  const scrollOwners = await target.evaluate(root => [root, ...root.querySelectorAll('*')].filter(element => {
    const style = getComputedStyle(element); return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  }).map(element => ({ tag: element.tagName, className: String(element.className).slice(0, 120), clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, scrollTop: element.scrollTop })));
  const contrast = await target.evaluate(root => {
    // Object methods serialize without tsx/esbuild's module-scoped __name helper.
    const tools = {
      rgb(value: string) { const match = value.match(/[\d.]+/g); return match ? match.slice(0, 3).map(Number) : [0, 0, 0]; },
      luminance(color: number[]) { return color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0); },
    };
    return [...root.querySelectorAll('.blog-alert, .blog-unsaved, .blog-changes-hint, .blog-badge, .ant-alert, .ant-form-item-explain-error, .ant-btn-dangerous, .blog-danger, .blog-button.danger, [role="alert"], .settings-error, .plugin-feedback')].filter(element => element.getBoundingClientRect().width > 0).map(element => {
      const style = getComputedStyle(element); let ancestor: Element | null = element;
      // Composite the actual browser-parsed CSS colors (including color-mix and alpha).
      const backgrounds: string[] = [];
      while (ancestor) { backgrounds.push(getComputedStyle(ancestor).backgroundColor); ancestor = ancestor.parentElement; }
      const context = new OffscreenCanvas(1, 1).getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, 1, 1);
      for (const value of [...backgrounds].reverse()) { context.fillStyle = value; context.fillRect(0, 0, 1, 1); }
      const backgroundRGB = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      context.fillStyle = style.color; context.fillRect(0, 0, 1, 1);
      const foregroundRGB = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      const a = tools.luminance(foregroundRGB), b = tools.luminance(backgroundRGB); const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      return { selector: element.tagName + '.' + String(element.className).trim().replace(/\s+/g, '.'), text: (element.textContent ?? '').trim().slice(0, 160),
        foreground: style.color, background: backgrounds[0], backgrounds, foregroundRGB, backgroundRGB,
        contrastRatio: Number(ratio.toFixed(3)), meets45: ratio >= 4.5,
        backgroundImageRequiresReview: getComputedStyle(element).backgroundImage !== 'none' };
    });
  });
  const failures = controlResults.filter(control => {
    if (!('disabled' in control)) return true;
    return !control.disabled && control.pointerEvents !== 'none' && (!control.withinViewport || !control.centerHit || control.focused === false && !control.editingContent);
  });
  return { targetBounds, targetWithinViewport, windowBoundsRequired: !!scene.window,
    controls: controlResults, controlsFound: count, controlProbeTruncated: count > 160, scrollOwners, contrast,
    probeStatus: failures.length || scene.window && !targetWithinViewport ? 'review-failures' : 'measured-no-failure',
    failureControlIndices: failures.map(control => control.index),
    outerOverflow: await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) };
}

const browser = await chromium.launch();
const records: any[] = [];
let owner: Awaited<ReturnType<typeof prepareFixture>>['owner'] | undefined;
let fatalError: string | null = null;
try {
  const sharedPrepared = suite === 'main' ? await prepareFixture(browser, config, option('cookies', '.local/e2e-cookies.json')) : null;
  owner = sharedPrepared?.owner;
  for (const variant of runVariants) for (const scene of selected) {
    if (variant.representative && !scene.representative) continue;
    if (scene.widths && !scene.widths.includes(variant.width)) continue;
    if (suite === 'main') authBudget(config);
    const id = variant.id + '-' + scene.id;
    const sceneStarted = Date.now(); let currentPhase = 'fixture-prepare', lastWorkPhase = 'fixture-prepare', sequence = 0;
    async function phase(name: string, details: Record<string, unknown> = {}) {
      currentPhase = name;
      if (!['cleanup-start', 'cleanup-finished', 'scene-failed', 'persisted'].includes(name)) lastWorkPhase = name;
      const receipt = { runId, id, sceneId: scene.id, sourceIds: scene.sourceIds, suite, sourceCommit, sequence: ++sequence,
        phase: name, elapsedMs: Date.now() - sceneStarted, at: new Date().toISOString(), ...details };
      await appendFile(resolve(directory, 'progress.jsonl'), JSON.stringify(receipt) + '\n');
      await writeFile(resolve(directory, id + '-progress.json'), JSON.stringify(receipt, null, 2) + '\n');
    }
    await phase('fixture-prepare');
    const prepared: Awaited<ReturnType<typeof prepareFixture>> & { extraHTTPHeaders?: Record<string, string>; dispose?: () => Promise<void> } =
      sharedPrepared ?? await prepareSetupFixture(browser, config, scene.setupMode);
    const context = await browser.newContext({ baseURL: config.origin, viewport: { width: variant.width, height: variant.height },
      colorScheme: variant.theme, locale: 'zh-CN', timezoneId: 'UTC', hasTouch: variant.hasTouch, isMobile: variant.isMobile,
      extraHTTPHeaders: prepared.extraHTTPHeaders,
      permissions: ['clipboard-read', 'clipboard-write'] });
    boundAPIRequests(context.request, apiTimeoutMs);
    if (scene.role === 'owner') await context.addCookies(prepared.cookies);
    await context.addInitScript(({ id, theme }) => localStorage.setItem('dooknow.preferences.v1:' + encodeURIComponent(id),
      JSON.stringify({ editorKind: 'source', mode: 'edit', theme })), { id: prepared.fixture.userId, theme: variant.theme });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    let renderingPage = page;
    startSceneLifecycle(page);
    const pageErrors: string[] = [], requestFailures: any[] = [];
    page.on('pageerror', error => pageErrors.push(shortError(error)));
    page.on('requestfailed', request => requestFailures.push({ method: request.method(), route: safeRoute(request.url()), failure: request.failure()?.errorText }));
    const baseRecord: any = { schema: 1, id, runId, sceneId: scene.id, sourceIds: scene.sourceIds, title: scene.title, state: scene.state,
      role: scene.role, viewport: { width: variant.width, height: variant.height }, theme: variant.theme,
      sourceCommit, applicationFingerprint: applicationFingerprint.sha256, kind: 'actual-after-ui-unification', suite, isolatedFixture: true,
      harnessFingerprint: harnessFingerprint.sha256,
      faultInjection: scene.fault ?? null, testsReused: scene.tests, pageErrors, requestFailures,
      designAssets: scene.sourceIds.flatMap(sourceId => (designCoverage.get(sourceId)?.assetIds ?? []).map((assetId: string) => ({ sourceId, assetId, current: designOutputs.get(assetId)?.current ?? null }))),
      visualComparison: 'pending', hardwareVerification: 'not-verified' };
    let cleanupPromise: Promise<unknown> | undefined;
    function cleanup(reason: string) {
      if (!cleanupPromise) cleanupPromise = (async () => {
        const cleanupErrors: string[] = [];
        await phase('cleanup-start', { reason });
        const gates = await bounded('RELEASE_SCENE_GATES', releaseScene(page, reason), cleanupTimeoutMs).catch(error => {
          cleanupErrors.push(shortError(error)); return { releasedGates: 0, errors: [shortError(error)] };
        });
        cleanupErrors.push(...gates.errors.map(shortError));
        // Gates resolve before routing is removed; all known holds are cooperative.
        // ignoreErrors prevents cancelled routed requests from blocking context close.
        for (const [label, work] of [
          ['PAGE_UNROUTE', () => page.unrouteAll({ behavior: 'ignoreErrors' })],
          ['CONTEXT_UNROUTE', () => context.unrouteAll({ behavior: 'ignoreErrors' })],
          ['CONTEXT_CLOSE', () => context.close()],
          ...(prepared.dispose ? [['SETUP_DISPOSE', () => prepared.dispose!()]] as const : []),
        ] as const) {
          await bounded(label, work(), cleanupTimeoutMs).catch(error => { cleanupErrors.push(shortError(error)); });
        }
        const result = { reason, releasedGates: gates.releasedGates, errors: cleanupErrors,
          cancelledRequestCount: requestFailures.filter(request => /abort|cancel|closed/i.test(request.failure ?? '')).length };
        baseRecord.cleanup = result;
        const record = records.find(record => record.id === id);
        if (record) { record.cleanup = result; if (cleanupErrors.length) record.probeStatus = 'review-failures'; }
        await phase('cleanup-finished', { cleanup: result });
        return result;
      })();
      return cleanupPromise;
    }
    try {
      await runSceneBudget(async () => {
      if (scene.requires === 'graph-model' && !config.graphModelURL) throw Error('UNAVAILABLE: graph model fixture disabled');
      const fixture = { ...prepared.fixture,
        api: async (path: string, method = 'GET', data?: unknown) => {
          assertSceneActive(page); await phase(currentPhase, { event: 'fixture-api-request', method, route: safeRoute(new URL(path, config.origin).href) });
          const result = await prepared.fixture.api(path, method, data); assertSceneActive(page); return result;
        },
        setTemplate: async (template: string) => { assertSceneActive(page); const result = await prepared.fixture.setTemplate(template); assertSceneActive(page); return result; },
      };
      const env = { page, context, fixture, variant };
      await phase('before');
      if (scene.before) await scene.before(env);
      const route = typeof scene.path === 'string' ? scene.path : scene.path(fixture);
      await phase('navigation');
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await phase('business-readiness');
      const readinessAssertions = await businessReady(page, route, scene);
      await phase('open-and-state-assertions');
      if (scene.open) await scene.open(env);
      await phase('target-readiness');
      const target = (typeof scene.target === 'string' ? page.locator(scene.target) : scene.target(page)).last();
      await target.waitFor({ state: 'visible', timeout: 15000 });
      await phase('font-readiness');
      const fonts = await waitFontReadiness(page, 10000);
      await phase('font-readiness', { completed: true, fonts });
      await phase('animation-settle');
      const animations = await waitAnimationSettle(page, 10000);
      await phase('animation-settle', { completed: true, animations });
      assertSceneActive(page); await phase('screenshot');
      const renderedTheme = await target.evaluate(element => ({
        documentTheme: document.documentElement.dataset.theme ?? null,
        rootColorScheme: getComputedStyle(document.documentElement).colorScheme,
        browserPrefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        targetBackground: getComputedStyle(element).backgroundColor,
      }));
      const before = await screenshot(page, id + '.png');
      await phase('target-controls-probe');
      const metrics = await probe(target, page, scene);
      const after = await screenshot(page, id + '-controls.png');
      await phase('interaction-verification');
      const interactionResult = scene.verify ? await scene.verify(env) : { openingFlow: 'actual-route-and-ui-actions-completed', primaryAction: 'untested' };
      await phase('after-capture');
      const dismissal: any = scene.afterCapture ? await scene.afterCapture(env) : { escapeCloseFocusReturn: 'untested' };
      let artifactEvidence: any = null;
      if (dismissal?.needsArtifactCapture && dismissal.temporaryDownloadPath) {
        await phase('standalone-artifact');
        const artifactName = id + '-download.html'; await copyFile(dismissal.temporaryDownloadPath, resolve(directory, artifactName));
        const artifactPage = await context.newPage(); await artifactPage.goto(pathToFileURL(resolve(directory, artifactName)).href);
        renderingPage = artifactPage;
        await expect(artifactPage.locator('main')).toBeVisible();
        await expect(artifactPage.locator('.workspace')).toHaveCount(0);
        await expect(artifactPage.locator('main')).toContainText('仅用于最终界面取证');
        await phase('artifact-font-readiness'); await waitFontReadiness(artifactPage, 10000);
        await phase('artifact-animation-settle'); await waitAnimationSettle(artifactPage, 10000);
        const exportPNG = await screenshot(artifactPage, id + '-export.png');
        const exportMetrics = await probe(artifactPage.locator('main'), artifactPage, { ...scene, window: false });
        const exportControls = await screenshot(artifactPage, id + '-export-controls.png');
        artifactEvidence = { ...exportPNG, ...exportMetrics, controlsScreenshot: exportControls,
          route: '<actual-downloaded-standalone-html>', artifactFile: artifactName,
          runtimeSurface: 'actual-downloaded-standalone-html',
          readinessAssertions: ['real browser download completed', 'downloaded file opened independently', 'standalone main content matches fixture source', 'owner workspace absent'] };
        await artifactPage.close();
        renderingPage = page;
        dismissal.exportArtifact = { file: artifactName, sha256: createHash('sha256').update(await readFile(resolve(directory, artifactName))).digest('hex'), screenshot: exportPNG };
        delete dismissal.temporaryDownloadPath;
      }
      if (scene.evidenceKind === 'downloaded-html' && !artifactEvidence) throw Error('Standalone HTML evidence requires an actual downloaded artifact, not the owner shell');
      assertSceneActive(page); await phase('record-capture');
      records.push({ ...baseRecord, status: 'captured', readinessAssertions, renderedTheme, route: safeRoute(page.url()), ...before, controlsScreenshot: after,
        ...metrics, interactionResult, dismissal,
        ...(scene.evidenceKind === 'downloaded-html' ? { triggerScreenshot: before, triggerControlsScreenshot: after,
          triggerMetrics: metrics, ...artifactEvidence } : {}) });
      }, sceneBudgetMs, () => cleanup('scene-budget-exceeded'), apiTimeoutMs + cleanupTimeoutMs);
    } catch (error) {
      const message = shortError(error);
      const failedPhase = lastWorkPhase;
      await phase('scene-failed', { failedPhase, error: message });
      const diagnostic = /font-readiness|animation-settle/.test(failedPhase) ? await readinessDiagnostic(renderingPage, directory, id, failedPhase) : null;
      const failureImage = diagnostic ? diagnostic.screenshot ?? null : await screenshot(page, id + '-failure.png').catch(() => null);
      records.push({ ...baseRecord, status: message.includes('UNAVAILABLE:') ? 'unavailable' : 'selector-or-flow-failure',
        failedPhase, error: message, renderingDiagnostic: diagnostic, diagnosticScreenshot: failureImage, runtimeEvidence: false });
    } finally { await cleanup('scene-finally'); }
    await writeFile(resolve(directory, id + '.json'), JSON.stringify(records.at(-1), null, 2) + '\n');
    await writeFile(resolve(directory, 'capture-results.json'), JSON.stringify(records, null, 2) + '\n');
    await phase('persisted', { status: records.at(-1).status });
    console.log(JSON.stringify({ id, status: records.at(-1).status, probeStatus: records.at(-1).probeStatus, error: records.at(-1).error }));
    if (records.at(-1).error?.includes('SCENE_CALLBACK_DRAIN')) throw Error('Noncooperative recipe quarantined; stopped after bounded cleanup rather than continue with a live callback');
  }
} catch (error) { fatalError = shortError(error); throw error;
} finally {
  if (owner) await owner.close(); await browser.close();
  const finalFingerprint = await fingerprint();
  const matrix = await writeMatrix(directory, scenes, records);
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ runId, sourceCommit,
    runStatus: fatalError ? 'aborted-with-fatal-error' : records.some(record => record.status !== 'captured' || record.probeStatus === 'review-failures') ? 'finished-with-failures-or-review-items' : 'finished-capture-review-pending',
    fatalError,
    applicationFingerprint: applicationFingerprint.sha256, finalFingerprint: finalFingerprint.sha256,
    sourceStableDuringRun: applicationFingerprint.sha256 === finalFingerprint.sha256,
    finishedAt: new Date().toISOString(), requested: records.length, captured: records.filter(record => record.status === 'captured').length,
    failures: records.filter(record => record.status !== 'captured').map(record => ({ id: record.id, status: record.status, error: record.error })),
    probeReviews: records.filter(record => record.probeStatus === 'review-failures').map(record => record.id),
    sourceSummary: matrix.summary, visualReview: 'pending-no-automatic-design-comparison-pass' }, null, 2) + '\n');
}
if (records.some(record => record.status !== 'captured' || record.probeStatus === 'review-failures')) process.exitCode = 1;
