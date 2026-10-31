import { expect, it } from 'vitest';
import { renderPrimaryPng } from '../apps/web/diagrams/primary-api';
it('rejects corrupt native whiteboard bytes before allocating a blank preview', async () => {
  await expect(
    renderPrimaryPng('whiteboard', { source: '{}', markdown: '', title: '图' }),
  ).rejects.toThrow('白板文件格式不正确');
});
