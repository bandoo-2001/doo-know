/** Read-only product investigation against the already-running isolated fixture. */
import { chromium, expect, type Page } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isolatedConfig, authBudget } from './fixture';

const config = await isolatedConfig('.local/e2e-config.json');
const output = resolve(process.argv[2] || '.local/password-focus-reproduction');
await mkdir(output, { recursive: true });
authBudget(config);
const browser = await chromium.launch();
const context = await browser.newContext({ baseURL: config.origin, viewport: { width: 1440, height: 1000 } });
await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
const page = await context.newPage();
const records: any[] = [];
async function snapshot(step: string, page: Page) {
  const record = await page.evaluate(() => {
    const view = {
      describe(element: Element) {
        const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { tag: element.tagName, className: String(element.className).slice(0, 180), role: element.getAttribute('role'),
          ariaLabel: element.getAttribute('aria-label'), ariaHidden: element.getAttribute('aria-hidden'), ariaModal: element.getAttribute('aria-modal'),
          tabIndex: element.getAttribute('tabindex'), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display, visibility: style.visibility, pointerEvents: style.pointerEvents,
          inert: !!element.closest('[inert]'), focusableDescendants: element.querySelectorAll('button,input,textarea,select,[tabindex]').length };
      },
    };
    const activeAncestors = []; let element = document.activeElement;
    while (element) { activeAncestors.push(view.describe(element)); element = element.parentElement; }
    return { documentHasFocus: document.hasFocus(), activeAncestors,
      surfaces: [...document.querySelectorAll('[aria-modal], .n-modal, .n-drawer, .settings-overlay')].map(element => view.describe(element)),
      guards: [...document.querySelectorAll('[aria-hidden="true"][tabindex]')].map(element => ({ ...view.describe(element),
        parent: element.parentElement ? view.describe(element.parentElement) : null })),
      passwords: [...document.querySelectorAll('input[type="password"]')].map(element => ({ ...view.describe(element), valueLength: (element as HTMLInputElement).value.length })),
    };
  });
  records.push({ step, ...record });
  await writeFile(resolve(output, 'dom-focus-sequence.json'), JSON.stringify(records, null, 2) + '\n');
}
try {
  await page.goto('/?view=settings&section=account');
  await expect(page.getByRole('heading', { name: '当前账户', exact: true })).toBeVisible();
  await snapshot('account-ready-before-any-modal', page);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => {
    const end = animation.effect?.getComputedTiming().endTime;
    return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
  }).map(animation => animation.finished.catch(() => undefined))); });
  await snapshot('after-open-and-finite-transitions-no-screenshots', page);
  const input = dialog.getByLabel('当前密码', { exact: true });
  await input.focus(); await snapshot('current-password-programmatic-focus', page);
  await page.keyboard.press('Tab'); await snapshot('keyboard-tab-after-focus', page);
  await input.click(); await snapshot('current-password-real-pointer-click', page);
  await page.keyboard.type('fixture-only'); await snapshot('real-keyboard-text-input-length-only', page);
  await input.fill('');
  await page.keyboard.press('Escape'); await snapshot('escape-dismiss-or-dirty-confirmation', page);
  console.log(JSON.stringify({ status: 'reproduced-and-recorded-no-product-write', records: records.length, output }));
} finally { await context.close(); await browser.close(); }
