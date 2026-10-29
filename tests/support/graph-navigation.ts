import { expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

export const graphArtifactRoot =
  process.env.DOOKNOW_E2E_GRAPH_ARTIFACTS || '.local/semantic-graph-artifacts';
export async function captureGraph(page: Page, project: string, name: string) {
  await mkdir(graphArtifactRoot, { recursive: true });
  await page.screenshot({
    path: `${graphArtifactRoot}/${project}-${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
}

export async function chooseGraphMode(page: Page, label: '图谱类型' | '显示方式', choice: string) {
  const group = page.getByRole('group', { name: label, exact: true });
  await group.getByText(choice, { exact: true }).click();
  await expect(group.getByRole('radio', { name: choice, exact: true })).toBeChecked();
}

export async function chooseGraphOption(page: Page, label: string, choice: string) {
  const control = page.getByRole('combobox', { name: label, exact: true });
  await control.focus();
  await control.press('ArrowDown');
  const popup = page.locator('.ant-select-dropdown:visible').last();
  await popup.getByText(choice, { exact: true }).click();
}

export async function openGraphPanel(page: Page, label: '模型' | '视图' | '问答' | '审核') {
  if (label === '审核') {
    const direct = page.getByRole('button', { name: /^审核/ });
    if (await direct.isVisible()) {
      await direct.click();
      return;
    }
  }
  await page.getByRole('button', { name: '更多图谱操作', exact: true }).click();
  const title = { 模型: '模型设置', 视图: '视图与导出', 问答: '图谱问答', 审核: '关系审核' }[label];
  await page.getByRole('menuitem', { name: title, exact: true }).click();
}
