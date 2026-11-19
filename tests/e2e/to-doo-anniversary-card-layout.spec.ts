import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import lunar from 'lunar-javascript';
import { test, expect } from '../support/browser-test';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { addDays, localDate } from '../../packages/core/to-doo/recurrence';

const pageURL = '/?view=apps&app=to-doo&appSection=anniversaries&appPage=all';
const photoHash = 'a'.repeat(64);
const longName = '把平凡日子里的每一次小小进步都认真收藏起来，写给未来自己的长名称纪念日';
const longDescription =
  '这是展开后的独立说明区域，图片应该保持保存时的取景，不应被拉高或重新裁切。'.repeat(12);
const styles = [
  'bloom',
  'postcard',
  'minimal',
  'photo',
  'pixel',
  'paper',
  'landscape',
  'orbit',
  'night',
] as const;
// The application declares only the Lunar methods it uses. This fixture also
// converts a Gregorian day back to lunar so both cards stay in the same group.
const fixtureCalendar = lunar as typeof lunar & {
  Solar: {
    fromYmd(
      year: number,
      month: number,
      day: number,
    ): {
      getLunar(): {
        getYear(): number;
        getMonth(): number;
        getDay(): number;
      };
    };
  };
};

async function theme(page: Page, value: 'light' | 'dark') {
  await page.evaluate(async (nextTheme) => {
    const path = '/preferences.ts';
    (await import(path)).setEditorPreferences({ theme: nextTheme });
    await document.fonts.ready;
  }, value);
  await expect(page.locator('html')).toHaveAttribute('data-theme', value);
}

// The existing browser fixture guarantees a temporary database. These cards and
// their image are response-only fixtures: no demo or user records are written.
async function mockCards(page: Page) {
  const response = await page.request.get('/api/to-doo/state?limit=200');
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const date = addDays(localDate(new Date(snapshot.now), snapshot.settings.timeZone), 3);
  const [year, month, day] = date.split('-').map(Number);
  const lunarDate = fixtureCalendar.Solar.fromYmd(year!, month!, day!).getLunar();
  const lunarOriginal = [lunarDate.getYear(), Math.abs(lunarDate.getMonth()), lunarDate.getDay()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('-');
  const imageBytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 800;
      const context = canvas.getContext('2d')!;
      for (const [index, color] of ['#e6c07c', '#6f9ca6', '#4c668e'].entries()) {
        context.fillStyle = color;
        context.fillRect(index * 400, 0, 400, 800);
      }
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  const cards = styles.map((style, index) =>
    toDooEntitySchemas.anniversary.parse({
      id: 'layout-anniversary-' + style,
      revision: 'layout-fixture-v1',
      createdAt: snapshot.now,
      updatedAt: snapshot.now,
      name: style === 'minimal' ? longName : '布局检查 · ' + style,
      category: style === 'minimal' ? '' : style === 'photo' ? '图片取景' : '值得记住',
      date: style === 'orbit' ? lunarOriginal : date,
      calendar: style === 'orbit' ? 'lunar' : 'gregorian',
      lunarLeapMonth: style === 'orbit' && lunarDate.getMonth() < 0,
      repeatYearly: false,
      description: style === 'photo' ? longDescription : '保留同一套卡片间距与内容顺序。',
      appearance: {
        style,
        palette: ['rose', 'sage', 'lavender', 'ocean', 'amber'][index % 5],
        ...(style === 'photo'
          ? {
              image: {
                hash: photoHash,
                name: 'layout-photo.png',
                mime: 'image/png',
                size: imageBytes.length,
                x: 19,
                y: 73,
                zoom: 1.6,
              },
            }
          : {}),
      },
    }),
  );
  await page.route('**/api/to-doo/state?**', async (route) => {
    const original = await route.fetch();
    const data = await original.json();
    await route.fulfill({ response: original, json: { ...data, anniversaries: cards } });
  });
  await page.route('**/api/to-doo/anniversary-images/' + photoHash, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: imageBytes,
    }),
  );
}

async function metrics(page: Page) {
  return page.locator('.todo-anniversaries > .todo-anniversary').evaluateAll((elements) =>
    elements.map((element) => {
      const article = element.getBoundingClientRect();
      const face = element.querySelector('.todo-anniversary-face')!.getBoundingClientRect();
      const slots = [
        '.todo-anniversary-heading',
        '.todo-anniversary-name',
        '.todo-anniversary-distance',
        '.todo-anniversary-dates',
        '.todo-anniversary-details > summary',
      ];
      return {
        style: element.getAttribute('data-card-style'),
        width: face.width,
        height: face.height,
        articleHeight: article.height,
        offsets: slots.map((selector) => {
          const box = element.querySelector(selector)!.getBoundingClientRect();
          return { x: box.left - article.left, y: box.top - article.top };
        }),
      };
    }),
  );
}

test('anniversary cards keep aligned slots and stable photo framing across widths and themes', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await mockCards(page);
  const widths = info.project.name === 'mobile' ? [390, 320] : [1920, 1280];
  await page.goto(pageURL);
  const cards = page.locator('.todo-anniversaries > .todo-anniversary');
  await expect(cards).toHaveCount(9);
  const photo = page.locator('.todo-anniversary[data-card-style="photo"]');
  const image = photo.locator('.todo-anniversary-photo');
  await photo.scrollIntoViewIfNeeded();
  await expect(photo.locator('.todo-anniversary-art')).toHaveAttribute('data-image-ready', 'true');
  await expect(image).toHaveCSS('object-position', '19% 73%');
  await expect(image).toHaveCSS('transform', 'matrix(1.6, 0, 0, 1.6, 0, 0)');

  for (const width of widths) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 1080 });
    for (const nextTheme of ['light', 'dark'] as const) {
      await theme(page, nextTheme);
      const measurements = await metrics(page);
      const reference = measurements[0]!;
      for (const card of measurements) {
        expect(Math.abs(card.width - reference.width), card.style || '').toBeLessThanOrEqual(1);
        expect(Math.abs(card.height - reference.height), card.style || '').toBeLessThanOrEqual(1);
        expect(Math.abs(card.height - card.width * 1.25), card.style || '').toBeLessThanOrEqual(2);
        for (let slot = 0; slot < reference.offsets.length; slot++) {
          expect(
            Math.abs(card.offsets[slot]!.x - reference.offsets[slot]!.x),
            `${card.style} slot ${slot} x`,
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs(card.offsets[slot]!.y - reference.offsets[slot]!.y),
            `${card.style} slot ${slot} y`,
          ).toBeLessThanOrEqual(1);
        }
      }
      await expect(page.locator('.todo-anniversaries').first()).toHaveCSS('column-gap', '16px');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      ).toBeLessThanOrEqual(1);
      await photo.scrollIntoViewIfNeeded();
      const originalFace = await photo.locator('.todo-anniversary-face').boundingBox();
      const originalArt = await photo.locator('.todo-anniversary-art').boundingBox();
      const neighbor = page.locator('.todo-anniversary[data-card-style="bloom"]');
      const originalNeighbor = await neighbor.boundingBox();
      const originalPhoto = await photo.boundingBox();
      await photo.locator('summary').click();
      await expect(photo.locator('.todo-anniversary-details-content')).toBeVisible();
      await expect(photo.locator('.todo-anniversary-details-content')).toContainText(
        longDescription,
      );
      const expandedFace = await photo.locator('.todo-anniversary-face').boundingBox();
      const expandedArt = await photo.locator('.todo-anniversary-art').boundingBox();
      expect(expandedFace!.width).toBeCloseTo(originalFace!.width, 1);
      expect(expandedFace!.height).toBeCloseTo(originalFace!.height, 1);
      expect(expandedArt!.width).toBeCloseTo(originalArt!.width, 1);
      expect(expandedArt!.height).toBeCloseTo(originalArt!.height, 1);
      expect((await neighbor.boundingBox())!.height).toBeCloseTo(originalNeighbor!.height, 1);
      expect((await photo.boundingBox())!.height).toBeGreaterThan(originalPhoto!.height + 30);
      await expect(image).toHaveCSS('object-position', '19% 73%');
      await expect(image).toHaveCSS('transform', 'matrix(1.6, 0, 0, 1.6, 0, 0)');
      await photo.locator('summary').click();
      await page.screenshot({
        path: info.outputPath(`anniversary-cards-${width}-${nextTheme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  const longCard = page.locator('.todo-anniversary[data-card-style="minimal"]');
  const title = longCard.getByRole('button', { name: '编辑 ' + longName, exact: true });
  await expect(longCard.locator('.todo-anniversary-name-text')).toHaveCSS(
    '-webkit-line-clamp',
    '2',
  );
  await title.click();
  const editor = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await expect(editor.getByLabel('名称', { exact: true })).toHaveValue(longName);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  await expect(editor).toBeHidden();
});
