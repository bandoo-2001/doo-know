import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';
import { toDooEntitySchemas } from '../../shared/to-doo-contracts';
import { localDate } from '../../packages/core/to-doo/recurrence';

const pageURL = '/?view=apps&app=to-doo&appSection=anniversaries&appPage=all';
const photoHash = 'e'.repeat(64);
const name = '收藏山海与日常里那些值得记住的小小瞬间 · 编辑布局示例';

async function mockAnniversary(page: Page) {
  const response = await page.request.get('/api/to-doo/state?limit=200');
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const imageBytes = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 800;
      const context = canvas.getContext('2d')!;
      const sky = context.createLinearGradient(0, 0, 0, 800);
      sky.addColorStop(0, '#91c7db');
      sky.addColorStop(1, '#e8c796');
      context.fillStyle = sky;
      context.fillRect(0, 0, 1200, 800);
      context.fillStyle = '#3c6580';
      context.beginPath();
      context.moveTo(0, 800);
      context.lineTo(480, 280);
      context.lineTo(1200, 800);
      context.fill();
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  const anniversary = toDooEntitySchemas.anniversary.parse({
    id: 'anniversary-editor-layout-fixture',
    revision: 'anniversary-editor-layout-v1',
    createdAt: snapshot.now,
    updatedAt: snapshot.now,
    name,
    date: localDate(new Date(snapshot.now), snapshot.settings.timeZone),
    repeatYearly: false,
    category: '山海与生活',
    description: '这是响应中合成的编辑示例，不会写入真实记录。',
    appearance: {
      style: 'photo',
      palette: 'ocean',
      image: {
        hash: photoHash,
        name: 'editor-layout.png',
        mime: 'image/png',
        size: imageBytes.length,
        x: 19,
        y: 73,
        zoom: 1.6,
      },
    },
  });
  await page.route('**/api/to-doo/state?**', async (route) => {
    const original = await route.fetch();
    const data = await original.json();
    await route.fulfill({ response: original, json: { ...data, anniversaries: [anniversary] } });
  });
  await page.route('**/api/to-doo/anniversary-images/' + photoHash, (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: imageBytes }),
  );
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate(async (value) => {
    const path = '/preferences.ts';
    (await import(path)).setEditorPreferences({ theme: value });
    await document.fonts.ready;
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function slider(editor: Locator, label: string, value: number) {
  const input = editor.getByRole('slider', { name: label, exact: true });
  await input.evaluate((element: HTMLInputElement, next) => {
    element.value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  await expect(input).toHaveValue(String(value));
}

async function todayStyle(element: Locator) {
  return element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      size: style.fontSize,
      weight: style.fontWeight,
      lineHeight: style.lineHeight,
      top: style.paddingTop,
      bottom: style.paddingBottom,
    };
  });
}

async function finishModalMotion(editor: Locator) {
  await editor.evaluate(async (dialog) => {
    const wrap = dialog.closest('.ant-modal-wrap') || dialog;
    // Let Ant install the enter animation, then wait for the actual animation
    // completion rather than comparing geometry at different zoom fractions.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.all(
      wrap
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function expectViewportSafe(page: Page, editor: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  const dimensions = await editor.locator('.ant-modal-content').evaluate((content) => {
    const box = content.getBoundingClientRect();
    const body = content.querySelector<HTMLElement>('.ant-modal-body')!;
    return {
      left: box.left,
      right: box.right,
      viewport: innerWidth,
      overflow: body.scrollWidth - body.clientWidth,
    };
  });
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.overflow).toBeLessThanOrEqual(1);
  await expect(editor.locator('button[type="submit"]')).toBeInViewport();
}

test('anniversary editor keeps theme choices, framing and live preview usable across screen sizes', async ({
  page,
  context,
}, info) => {
  test.setTimeout(120_000);
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await mockAnniversary(page);
  await page.goto(pageURL);
  const card = page.getByRole('article', { name: '纪念日 ' + name, exact: true });
  await expect(card).toBeVisible();
  const widths = info.project.name === 'mobile' ? [390, 320] : [1920, 1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 1080 });
    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      const listToday = await todayStyle(card.locator('.todo-anniversary-today'));
      await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
      const editor = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
      const options = editor.locator('.todo-card-customizer-options');
      const previewPane = editor.locator('.todo-card-preview-pane');
      const preview = editor.getByRole('article', { name: '卡片预览', exact: true });
      await expect(editor.getByLabel('名称', { exact: true })).toHaveValue(name);
      await finishModalMotion(editor);
      await expect(
        editor.getByRole('group', { name: '卡片样式', exact: true }).getByRole('button'),
      ).toHaveCount(9);
      await expect(editor.locator('.todo-card-style-description')).toContainText(/照片|上传/);
      const thumbnail = editor
        .getByRole('button', { name: '照片', exact: true })
        .locator('.todo-card-style-sample');
      await expect(thumbnail.locator('.todo-anniversary-art')).toHaveAttribute(
        'data-image-ready',
        'true',
      );
      const thumbnailWidths = await thumbnail.evaluate((element) => ({
        sample: element.getBoundingClientRect().width,
        image: element.querySelector('.todo-anniversary-art')!.getBoundingClientRect().width,
      }));
      expect(Math.abs(thumbnailWidths.sample - thumbnailWidths.image)).toBeLessThanOrEqual(1);
      expect(await todayStyle(preview.locator('.todo-anniversary-today'))).toEqual(listToday);
      await expectViewportSafe(page, editor);
      const layout = await editor
        .locator('.todo-card-customizer-workspace')
        .evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);
      expect(layout).toBe(width < 400 ? 1 : 2);
      if (width > 400) {
        const left = (await options.boundingBox())!,
          right = (await previewPane.boundingBox())!;
        expect(right.x).toBeGreaterThanOrEqual(left.x + left.width + 12);
        await expect(previewPane).toHaveCSS('position', 'sticky');
      }

      await editor.getByRole('button', { name: '重新取景', exact: true }).click();
      const framing = editor.getByRole('region', { name: '图片取景', exact: true });
      await expect(framing.locator('.todo-anniversary-art')).toHaveAttribute(
        'data-image-ready',
        'true',
      );
      await expect(editor.locator('button[type="submit"]')).toBeDisabled();
      await slider(editor, '水平取景', 85);
      await slider(editor, '垂直取景', 20);
      await slider(editor, '缩放', 2);
      await editor.getByRole('button', { name: '居中重置', exact: true }).click();
      await expect(editor.getByRole('slider', { name: '水平取景', exact: true })).toHaveValue('50');
      await expect(editor.getByRole('slider', { name: '垂直取景', exact: true })).toHaveValue('50');
      await expect(editor.getByRole('slider', { name: '缩放', exact: true })).toHaveValue('1');
      await expect(preview.locator('.todo-anniversary-photo')).toHaveCSS(
        'object-position',
        '50% 50%',
      );
      if (width < 400) {
        await editor.getByRole('button', { name: '查看预览', exact: true }).click();
        await expect(previewPane).toBeInViewport();
        await expectViewportSafe(page, editor);
        await editor.getByRole('button', { name: '继续调整', exact: true }).click();
        await expect(framing.locator('.todo-photo-crop-frame')).toBeInViewport();
      } else {
        await framing.locator('.todo-photo-crop-frame').scrollIntoViewIfNeeded();
        await expect(framing.locator('.todo-photo-crop-frame')).toBeInViewport();
        await expect(preview).toBeInViewport();
      }
      await expectViewportSafe(page, editor);
      await page.screenshot({
        path: info.outputPath(`anniversary-editor-${width}-${theme}.png`),
        animations: 'disabled',
      });
      // Escape must cancel the local framing draft before closing the outer editor.
      await previewPane.focus();
      await page.keyboard.press('Escape');
      await expect(framing).toBeHidden();
      await expect(editor).toBeVisible();
      await expect(preview.locator('.todo-anniversary-photo')).toHaveCSS(
        'object-position',
        '19% 73%',
      );
      await expect(preview.locator('.todo-anniversary-photo')).toHaveCSS(
        'transform',
        'matrix(1.6, 0, 0, 1.6, 0, 0)',
      );
      await expect(editor.locator('button[type="submit"]')).toBeEnabled();
      await editor.getByRole('button', { name: '取消', exact: true }).click();
      await expect(editor).toBeHidden();
    }
  }
});
