import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../support/browser-test';

const anniversaryPage = '/?view=apps&app=to-doo&appSection=anniversaries&appPage=all';
const imageEndpoint = '/api/to-doo/anniversary-images';
const themes = [
  ['花间', 'bloom'],
  ['远山', 'landscape'],
  ['星轨', 'orbit'],
  ['留白', 'minimal'],
  ['像素', 'pixel'],
  ['明信片', 'postcard'],
  ['手帐', 'paper'],
  ['夜空', 'night'],
  ['照片', 'photo'],
] as const;

test.beforeEach(async ({ context, page }, info) => {
  await context.addCookies(JSON.parse(await readFile('.local/e2e-cookies.json', 'utf8')));
  await page.setViewportSize(
    info.project.name === 'mobile' ? { width: 320, height: 568 } : { width: 1920, height: 1080 },
  );
});

async function createEditor(page: Page, name: string) {
  await page.goto(anniversaryPage);
  await page
    .getByRole('button', { name: /新建纪念日/ })
    .first()
    .click();
  const editor = page.getByRole('dialog', { name: '新建纪念日', exact: true });
  await editor.getByLabel('名称', { exact: true }).fill(name);
  return editor;
}

async function savedAnniversary(page: Page, name: string) {
  const response = await page.request.get('/api/to-doo/state?kind=anniversary&limit=200');
  expect(response.ok()).toBe(true);
  const snapshot = await response.json();
  const anniversary = snapshot.anniversaries.find((entry: any) => entry.name === name);
  expect(anniversary).toBeTruthy();
  return anniversary;
}

async function setSlider(editor: Locator, name: string, value: number) {
  const slider = editor.getByRole('slider', { name, exact: true });
  await slider.evaluate((element: HTMLInputElement, nextValue) => {
    element.value = String(nextValue);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await expect(slider).toHaveValue(String(value));
}

async function expectNoHorizontalOverflow(page: Page, editor?: Locator) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  if (!editor) return;
  const metrics = await editor.locator('.ant-modal-content').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const body = element.querySelector<HTMLElement>('.ant-modal-body')!;
    return {
      left: bounds.left,
      right: bounds.right,
      width: innerWidth,
      overflow: body.scrollWidth - body.clientWidth,
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.right).toBeLessThanOrEqual(metrics.width);
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  await expect(editor.locator('button[type="submit"]')).toBeInViewport();
}

async function setDarkTheme(page: Page) {
  await page.evaluate(async () => {
    const modulePath = '/preferences.ts';
    (await import(modulePath)).setEditorPreferences({ theme: 'dark' });
    await document.fonts.ready;
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
}

// A deterministic raster fixture, generated without an external asset or a business-data upload.
async function testPhoto(page: Page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 600;
    const context = canvas.getContext('2d')!;
    for (const [index, color] of ['#b53e54', '#3c658b', '#d3a34e'].entries()) {
      context.fillStyle = color;
      context.fillRect(index * 400, 0, 400, 600);
    }
    context.fillStyle = '#fff8e5';
    context.beginPath();
    context.arc(220, 190, 110, 0, Math.PI * 2);
    context.fill();
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return {
    name: 'anniversary-landscape.png',
    mimeType: 'image/png',
    buffer: Buffer.from(base64, 'base64'),
  };
}

test('all anniversary themes preview and persist with reachable actions at desktop and 320px widths', async ({
  page,
}, info) => {
  const name = `主题回归 ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`;
  const editor = await createEditor(page, name);
  const preview = editor.getByRole('article', { name: '卡片预览', exact: true });
  const choices = editor.getByRole('group', { name: '卡片样式', exact: true });
  for (const [label, value] of themes) {
    await choices.getByRole('button', { name: label, exact: true }).click();
    await expect(preview).toHaveAttribute('data-card-style', value);
    await expect(choices.getByRole('button', { name: label, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await choices.getByRole('button', { name: '像素', exact: true }).click();
  await editor.getByRole('button', { name: '雾蓝', exact: true }).click();
  await expect(preview).toHaveAttribute('data-card-palette', 'ocean');
  await setDarkTheme(page);
  await expectNoHorizontalOverflow(page, editor);
  await page.screenshot({
    path: info.outputPath('anniversary-pixel-editor-dark.png'),
    animations: 'disabled',
  });
  await editor.locator('button[type="submit"]').click();
  await expect(editor).toBeHidden();
  await page.reload();
  const card = page.getByRole('article', { name: '纪念日 ' + name, exact: true });
  await expect(card).toHaveAttribute('data-card-style', 'pixel');
  await expect(card).toHaveAttribute('data-card-palette', 'ocean');
  expect((await savedAnniversary(page, name)).appearance).toMatchObject({
    style: 'pixel',
    palette: 'ocean',
  });
  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await expect(edit.getByRole('button', { name: '像素', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await edit.getByRole('button', { name: '明信片', exact: true }).click();
  await expectNoHorizontalOverflow(page, edit);
  await edit.locator('button[type="submit"]').click();
  await expect(edit).toBeHidden();
  await page.reload();
  await expect(card).toHaveAttribute('data-card-style', 'postcard');
  await expectNoHorizontalOverflow(page);
  expect((await savedAnniversary(page, name)).appearance).toMatchObject({
    style: 'postcard',
    palette: 'ocean',
  });
  await page.screenshot({
    path: info.outputPath('anniversary-postcard-dark.png'),
    animations: 'disabled',
  });
});

test('photo framing survives reload while cancellation and invalid files preserve the saved image', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const name = `照片回归 ${info.project.name} ${crypto.randomUUID().slice(0, 6)}`;
  const editor = await createEditor(page, name);
  await editor.getByRole('button', { name: '照片', exact: true }).click();
  await editor.getByLabel('选择纪念日图片', { exact: true }).setInputFiles(await testPhoto(page));
  const framing = editor.getByRole('region', { name: '图片取景', exact: true });
  await expect(framing).toBeVisible();
  await expect(editor.getByLabel('选择纪念日图片', { exact: true })).toBeHidden();
  await expect(framing.locator('.todo-photo-slider-field').first()).toHaveCSS('display', 'grid');
  await setSlider(editor, '缩放', 1.8);
  const cropFrame = framing.locator('.todo-photo-crop-frame');
  await expect(cropFrame.locator('.todo-anniversary-art')).toHaveAttribute(
    'data-image-ready',
    'true',
  );
  await cropFrame.scrollIntoViewIfNeeded();
  const bounds = (await cropFrame.boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  if (info.project.name === 'mobile') {
    // Native touch input exercises pointer capture as well as the shared drag handlers.
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + 24, y: start.y + 24 }],
      });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 24, start.y + 24, { steps: 4 });
    await page.mouse.up();
  }
  await expect
    .poll(async () =>
      Number(await editor.getByRole('slider', { name: '水平取景', exact: true }).inputValue()),
    )
    .toBeLessThan(50);
  await expect
    .poll(async () =>
      Number(await editor.getByRole('slider', { name: '垂直取景', exact: true }).inputValue()),
    )
    .toBeLessThan(50);
  await setSlider(editor, '水平取景', 15);
  await setSlider(editor, '垂直取景', 80);
  await expect(editor.locator('button[type="submit"]')).toBeDisabled();
  await expect(editor.getByRole('button', { name: '像素', exact: true })).toBeDisabled();
  await setDarkTheme(page);
  await expectNoHorizontalOverflow(page, editor);
  await page.screenshot({
    path: info.outputPath('anniversary-photo-framing-dark.png'),
    animations: 'disabled',
  });

  let uploads = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === imageEndpoint) uploads++;
  });
  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => {
    releaseUpload = resolve;
  });
  let uploadAttempts = 0;
  await page.route(
    (url) => url.pathname === imageEndpoint,
    async (route) => {
      if (++uploadAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: '图片上传暂时失败，请重试。' } });
        return;
      }
      await uploadGate;
      await route.continue();
    },
  );
  const failedUpload = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === imageEndpoint,
  );
  await editor.getByRole('button', { name: '确认取景', exact: true }).click();
  expect((await failedUpload).status()).toBe(503);
  await expect(editor.getByRole('alert')).toContainText('图片上传暂时失败，请重试。');
  await expect(framing).toBeVisible();
  await expect(editor.getByRole('slider', { name: '水平取景', exact: true })).toHaveValue('15');
  await expect(editor.getByRole('slider', { name: '垂直取景', exact: true })).toHaveValue('80');
  await expect(editor.getByRole('slider', { name: '缩放', exact: true })).toHaveValue('1.8');
  await expect(
    editor.getByRole('article', { name: '卡片预览', exact: true }).locator('.todo-anniversary-art'),
  ).toHaveAttribute('data-image-ready', 'true');
  await expect(editor.locator('button[type="submit"]')).toBeDisabled();
  await expect(editor.getByRole('button', { name: '像素', exact: true })).toBeDisabled();
  const afterFailure = await (
    await page.request.get('/api/to-doo/state?kind=anniversary&limit=200')
  ).json();
  expect(afterFailure.anniversaries.some((entry: any) => entry.name === name)).toBe(false);
  expect(uploads).toBe(1);
  const uploadRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === imageEndpoint,
  );
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === imageEndpoint,
  );
  try {
    await editor.getByRole('button', { name: '确认取景', exact: true }).click();
    await uploadRequest;
    await expect(editor.locator('button[type="submit"]')).toBeDisabled();
    await expect(editor.getByRole('button', { name: '关闭编辑', exact: true })).toBeDisabled();
    await expect(editor.getByRole('button', { name: '取消', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(editor).toBeVisible();
  } finally {
    releaseUpload();
  }
  const response = await uploadResponse;
  expect(response.ok()).toBe(true);
  const uploaded = await response.json();
  expect(uploaded.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(uploaded.mime).toBe('image/webp');
  await expect(framing).toBeHidden();
  await expect(editor.locator('button[type="submit"]')).toBeEnabled();
  await editor.locator('button[type="submit"]').click();
  await expect(editor).toBeHidden();
  const savedImage = (await savedAnniversary(page, name)).appearance.image;
  expect(savedImage).toMatchObject({
    hash: uploaded.hash,
    mime: 'image/webp',
    x: 15,
    y: 80,
    zoom: 1.8,
  });
  const privateImage = await page.request.get(imageEndpoint + '/' + savedImage.hash);
  expect(privateImage.ok()).toBe(true);
  expect(privateImage.headers()['content-type']).toContain('image/webp');

  await page.reload();
  const card = page.getByRole('article', { name: '纪念日 ' + name, exact: true });
  await expect(card).toHaveAttribute('data-card-style', 'photo');
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.todo-anniversary-art')).toHaveAttribute('data-image-ready', 'true');
  const image = card.locator('.todo-anniversary-photo');
  await expect(image).toHaveCSS('object-position', '15% 80%');
  await expect(image).toHaveCSS('transform', 'matrix(1.8, 0, 0, 1.8, 0, 0)');
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: info.outputPath('anniversary-photo-card-dark.png'),
    animations: 'disabled',
  });
  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await edit.getByRole('button', { name: '重新取景', exact: true }).click();
  await expect(edit.getByRole('slider', { name: '水平取景', exact: true })).toHaveValue('15');
  await expect(edit.getByRole('slider', { name: '垂直取景', exact: true })).toHaveValue('80');
  await expect(edit.getByRole('slider', { name: '缩放', exact: true })).toHaveValue('1.8');
  await setSlider(edit, '水平取景', 85);
  await setSlider(edit, '缩放', 2.4);
  await edit.getByRole('button', { name: '取消取景', exact: true }).click();
  await expect(edit.getByRole('region', { name: '图片取景', exact: true })).toBeHidden();
  await expect(edit.getByRole('button', { name: '像素', exact: true })).toBeEnabled();
  await expect(edit.locator('button[type="submit"]')).toBeEnabled();
  await expect(
    edit.getByRole('article', { name: '卡片预览', exact: true }).locator('.todo-anniversary-photo'),
  ).toHaveCSS('object-position', '15% 80%');
  expect(uploads).toBe(2);

  // A missing blob may arrive later through sync; never confirm an empty framing panel.
  await page.route(imageEndpoint + '/' + savedImage.hash, (route) =>
    route.fulfill({ status: 404 }),
  );
  await edit.getByRole('button', { name: '重新取景', exact: true }).click();
  const unavailableFraming = edit.getByRole('region', { name: '图片取景', exact: true });
  await expect(unavailableFraming.getByRole('alert')).toContainText('图片暂未加载');
  await expect(edit.getByRole('button', { name: '确认取景', exact: true })).toBeDisabled();
  await edit.getByRole('button', { name: '取消取景', exact: true }).click();
  await page.unroute(imageEndpoint + '/' + savedImage.hash);

  for (const invalid of [
    { name: 'not-a-photo.txt', mimeType: 'text/plain', buffer: Buffer.from('plain text') },
    { name: 'broken-photo.png', mimeType: 'image/png', buffer: Buffer.from('invalid png data') },
  ]) {
    await edit.getByLabel('选择纪念日图片', { exact: true }).setInputFiles(invalid);
    await expect(edit.getByRole('alert')).toContainText(/图片|PNG|JPEG|WebP/);
    await expect(
      edit
        .getByRole('article', { name: '卡片预览', exact: true })
        .locator('.todo-anniversary-photo'),
    ).toHaveCSS('object-position', '15% 80%');
  }
  expect(uploads).toBe(2);
  await expectNoHorizontalOverflow(page, edit);
  await edit.locator('button[type="submit"]').click();
  await expect(edit).toBeHidden();
  expect((await savedAnniversary(page, name)).appearance.image).toEqual(savedImage);

  await card.getByRole('button', { name: '编辑 ' + name, exact: true }).click();
  const remove = page.getByRole('dialog', { name: '编辑纪念日', exact: true });
  await remove.getByRole('button', { name: '移除图片', exact: true }).click();
  await expect(
    remove.getByRole('article', { name: '卡片预览', exact: true }).locator('.todo-anniversary-art'),
  ).toHaveCount(0);
  await remove.getByRole('button', { name: '像素', exact: true }).click();
  await remove.locator('button[type="submit"]').click();
  await expect(remove).toBeHidden();
  expect((await savedAnniversary(page, name)).appearance.image).toBeUndefined();
  expect(uploads).toBe(2);
});
