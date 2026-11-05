import type { Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { bounded } from './lifecycle';

/** Read-only actual rendering state. Infinity is explicit rather than JSON null. */
export async function renderingState(page: Page) {
  return bounded('RENDERING_STATE_DIAGNOSTIC', page.evaluate(() => ({
    visibility: document.visibilityState, hasFocus: document.hasFocus(), fontsStatus: document.fonts.status,
    fontFaces: [...document.fonts].map(face => ({ family: face.family, status: face.status, display: face.display,
      style: face.style, weight: face.weight, stretch: face.stretch, unicodeRange: face.unicodeRange })),
    animations: document.getAnimations().map(animation => {
      const effect = animation.effect as KeyframeEffect | null, timing = effect?.getComputedTiming(), declared = effect?.getTiming();
      const target = effect?.target as Element | null;
      return { kind: animation.constructor.name, id: animation.id, playState: animation.playState, pending: animation.pending,
        currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : String(animation.currentTime),
        playbackRate: animation.playbackRate, startTime: animation.startTime,
        timing: timing ? { ...timing, endTime: Number.isFinite(timing.endTime) ? timing.endTime : String(timing.endTime),
          activeDuration: Number.isFinite(timing.activeDuration) ? timing.activeDuration : String(timing.activeDuration),
          iterations: Number.isFinite(timing.iterations) ? timing.iterations : String(timing.iterations) } : null,
        declaredTiming: declared ? { ...declared, iterations: Number.isFinite(declared.iterations) ? declared.iterations : String(declared.iterations) } : null,
        selectedForFiniteWait: animation.playState === 'running' && typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime),
        target: target ? { tag: target.tagName, className: String(target.className), role: target.getAttribute('role'),
          label: target.getAttribute('aria-label'), connected: target.isConnected,
          bounds: (() => { const r = target.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })() } : null };
    }),
  })), 2000);
}
export async function waitFontReadiness(page: Page, milliseconds = 10000) {
  return bounded('FONT_READINESS', (async () => {
    const before = await renderingState(page);
    // Retain the actual FontFaceSet.ready wait; do not replace it with status text.
    await page.evaluate(() => document.fonts.ready);
    return { before, after: await renderingState(page) };
  })(), milliseconds);
}
export async function waitAnimationSettle(page: Page, milliseconds = 10000) {
  return bounded('ANIMATION_SETTLE', (async () => {
    const before = await renderingState(page);
    // Some replaced Chromium CSS transitions report finished and leave the
    // live animation set while their original .finished promise stays pending.
    // Observe actual current visual work instead of retaining those old promises.
    // A newly mounted transition may start between the empty observation and
    // the second frame. Continue within the original deadline when that happens.
    let after;
    const deadline = Date.now() + milliseconds;
    do {
      await page.waitForFunction(() => !document.getAnimations().some(animation => {
        const timing = animation.effect?.getComputedTiming();
        return animation.playState === 'running' && typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime);
      }), undefined, { polling: 50, timeout: Math.max(1, deadline - Date.now()) });
      await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
      after = await renderingState(page);
      if (Date.now() >= deadline && after.animations.some(animation => animation.selectedForFiniteWait))
        throw Error('Finite visual animation did not settle before the original deadline');
    } while (after.animations.some(animation => animation.selectedForFiniteWait));
    return { mode: 'actual-live-finite-animation-set-empty-plus-two-frames', before, after };
  })(), milliseconds);
}

/** CDP capture bypasses Playwright font waits. Never count this as acceptance. */
export async function readinessDiagnostic(page: Page, directory: string, id: string, failedPhase: string) {
  const diagnostic: any = { kind: 'diagnostic-only-not-runtime-acceptance', failedPhase,
    at: new Date().toISOString(), runtimeEvidence: false };
  diagnostic.rendering = await renderingState(page).catch(error => ({ error: String(error) }));
  try {
    const privateFieldPresent = await bounded('DIAGNOSTIC_PRIVACY_CHECK', page.evaluate(() =>
      [...document.querySelectorAll('input[type="password"],textarea[aria-label="新 API Key"],input[aria-label="公开链接"],textarea[aria-label="SSH 私钥"],textarea[aria-label="恢复私钥"],textarea[autocomplete="new-password"],[data-testid="api-key-secret"]')]
        .some(element => 'value' in element ? String((element as HTMLInputElement).value).length > 0 : String(element.textContent ?? '').trim().length > 0)), 2000);
    if (privateFieldPresent) diagnostic.screenshotSkipped = 'Nonempty sensitive field; CDP cannot use normal screenshot masks.';
    else {
      const session = await bounded('CDP_DIAGNOSTIC_CONNECT', page.context().newCDPSession(page), 2000);
      try {
        const shot = await bounded('CDP_READINESS_DIAGNOSTIC', session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }), 5000);
        const bytes = Buffer.from(shot.data, 'base64'), file = id + '-readiness-diagnostic-only.png';
        await writeFile(resolve(directory, file), bytes);
        diagnostic.screenshot = { file, sha256: createHash('sha256').update(bytes).digest('hex'), kind: diagnostic.kind };
      } finally { await bounded('CDP_DIAGNOSTIC_DETACH', session.detach(), 2000).catch(error => { diagnostic.detachError = String(error); }); }
    }
  } catch (error) { diagnostic.screenshotError = String(error); }
  const metadata = id + '-readiness-diagnostic.json';
  await writeFile(resolve(directory, metadata), JSON.stringify(diagnostic, null, 2) + '\n');
  return { ...diagnostic, metadata };
}
