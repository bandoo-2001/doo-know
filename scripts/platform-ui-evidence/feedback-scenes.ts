import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import type { Scene, SceneEnv } from './model';

const blogPath = '/?view=apps&app=blog&appSection=design';
const studio = (id: string, state: string, open: Scene['open']): Scene => ({
  id, sourceIds: ['PB-041'], title: state, state, role: 'owner', path: blogPath, target: '.blog-studio', open,
  representative: true, tests: ['tests/e2e/blog-studio.spec.ts', 'tests/e2e/blog-admin-visual.spec.ts'],
});
async function dirty(env: SceneEnv) {
  await env.page.getByLabel('姓名', { exact: true }).fill('仅存在于隔离草稿中的作者 ' + randomUUID().slice(0, 6));
  await expect(env.page.locator('.blog-studio-heading .blog-badge, .blog-studio > .blog-section-title .blog-badge').first()).toContainText('未保存');
}

export const feedbackScenes: Scene[] = [
  { ...studio('blog-feedback-dirty', 'Actual unsaved studio warning badge', dirty),
    importantStates: { 'PB-041': ['saved draft/unpublished/online-matched badges'] } },
  { ...studio('blog-feedback-save-success', 'Actual successful design save notice', async env => {
    await dirty(env); await env.page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(env.page.locator('.blog-studio .blog-alert.success')).toBeVisible();
  }), importantStates: { 'PB-041': ['saved draft/unpublished/online-matched badges'] } },
  { ...studio('blog-feedback-publish-success', 'Actual successful design publication', async env => {
    await dirty(env); await env.page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(env.page.getByRole('button', { name: '发布主页', exact: true })).toBeEnabled();
    await env.page.getByRole('button', { name: '发布主页', exact: true }).click();
    await expect(env.page.locator('.blog-studio .blog-alert.success')).toBeVisible();
  }), sourceIds: ['PB-041', 'PB-048'], importantStates: { 'PB-041': ['saved draft/unpublished/online-matched badges'], 'PB-048': ['version+time rows'] } },
  { ...studio('blog-feedback-version-conflict', 'Actual competing design version keeps local draft', async env => {
    await dirty(env);
    const current = await env.fixture.api('/api/blog/design');
    await env.fixture.api('/api/blog/design', 'PATCH', { expectedVersion: current.version, requestId: randomUUID(),
      design: { ...current.draft, profile: { ...current.draft.profile, name: '另一隔离会话已保存' } } });
    await env.page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(env.page.locator('.blog-studio .blog-alert.error')).toBeVisible();
    await expect(env.page.getByLabel('姓名', { exact: true })).toHaveValue(/仅存在于隔离草稿/);
  }), sourceIds: ['PB-049'], importantStates: { 'PB-049': ['design save/publish/restore error retains draft and version-review entry'] } },
  { ...studio('blog-feedback-save-network-error', 'Actual save transport rejection retains local design', async env => {
    await dirty(env); await env.page.route('**/api/blog/design', async route => {
      if (route.request().method() === 'PATCH') await route.abort('failed'); else await route.continue();
    });
    await env.page.getByRole('button', { name: '保存装修草稿', exact: true }).click();
    await expect(env.page.locator('.blog-studio .blog-alert.error')).toBeVisible();
  }), sourceIds: ['PB-049'], fault: 'Only PATCH /api/blog/design transport aborted; real draft/error renderer.',
    importantStates: { 'PB-049': ['design save/publish/restore error retains draft and version-review entry'] } },
  { id: 'blog-feedback-article-dirty', sourceIds: ['PB-032'], title: '文章信息未保存', state: 'Actual article metadata dirty warning and published badge', role: 'owner', path: '/?view=apps&app=blog&appSection=articles', target: '.blog-workspace', representative: true,
    open: async ({ page }) => { await page.locator('.blog-post-option').filter({ hasText: '让知识保持可用' }).first().click(); await page.getByLabel('文章标题', { exact: true }).fill('尚未保存的隔离标题'); await expect(page.locator('.blog-save-state.blog-unsaved')).toBeVisible(); },
    importantStates: { 'PB-032': ['dirty save-required status; busy guard', 'draft/published/withdrawn/unpublished changes badges', 'once published slug is read-only'] }, tests: ['tests/e2e/blog-admin-content.spec.ts'] },
  { id: 'blog-feedback-article-danger', sourceIds: ['PB-032'], title: '已发布文章操作', state: 'Actual published article danger controls', role: 'owner', path: '/?view=apps&app=blog&appSection=articles', target: '.blog-workspace', representative: true,
    open: async ({ page }) => { await page.locator('.blog-post-option').filter({ hasText: '让知识保持可用' }).first().click(); await expect(page.getByRole('button', { name: '下架文章', exact: true })).toBeVisible(); }, tests: ['tests/e2e/blog-admin-content.spec.ts'] },
  { id: 'git-long-credential', sourceIds: ['ST-075', 'ST-076'], title: '合法120字凭据名称', state: 'Actual saved 120-character HTTPS credential action wrapping', role: 'owner', path: '/?view=settings&section=library', target: page => page.getByRole('dialog', { name: '管理云端同步', exact: true }), window: true, representative: true,
    before: async ({ fixture }) => { await fixture.api('/api/platform/git/credentials', 'POST', {
      name: ('runtime-' + randomUUID() + '-').padEnd(120, '凭'), host: 'github.com', kind: 'https', username: 'runtime-fixture', token: 'disposable-fixture-token-never-use', remember: false,
    }); },
    open: async ({ page }) => { await page.getByRole('region', { name: '云端同步面板', exact: true }).getByRole('button', { name: /^(管理同步|关联云端仓库)$/ }).click(); await expect(page.locator('.credential-list li').last()).toBeVisible(); },
    verify: async ({ page }) => {
      const row = page.locator('.credential-list li').last(); const buttons = row.getByRole('button');
      const evidence = [];
      for (const control of await buttons.all()) {
        await control.scrollIntoViewIfNeeded();
        evidence.push(await control.evaluate(element => { const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2); const style = getComputedStyle(element); return {
          nameLength: (element.textContent ?? '').trim().length, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          centerHit: hit === element || !!hit && element.contains(hit), whiteSpace: style.whiteSpace, overflowWrap: style.overflowWrap,
          scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        }; }));
      }
      await buttons.first().click(); await expect(page.getByRole('dialog', { name: '更换凭据', exact: true })).toBeVisible();
      return { action: 'click actual long-label change-credential button', controls: evidence, openedChildDialog: true };
    }, importantStates: { 'ST-075': ['已有/无凭据'], 'ST-076': ['新增/更换标题与token占位不同'] }, tests: ['tests/e2e/settings-overlays.spec.ts'] },
];
