import { it, expect } from 'vitest';
import { createRichProjection, safeEditorUrl } from '../apps/web/editor/rich-adapter';
it('原始 HTML、脚本和伪装标签保持原文而不进入活动 HTML', () => {
  for (const source of [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://example.invalid"></iframe>',
    'before </span> after',
    '<span style="color:red">outside allowlist</span>',
  ]) {
    const p = createRichProjection(source);
    expect(
      p.json.content!.some((n) => n.type === 'opaqueSource'),
      source,
    ).toBe(true);
    expect(p.serialize(p.json)).toMatchObject({ ok: true, markdown: source });
  }
});
it('编辑器地址拒绝危险协议、控制符和协议相对地址', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:image/svg+xml,test',
    'vbscript:x',
    '//external.invalid',
    'java\nscript:x',
    'file:///private',
    'http:\\external.invalid',
  ])
    expect(safeEditorUrl(url), url).toBe(false);
  for (const url of [
    'assets/photo.png',
    '../notes/read.md',
    'https://example.invalid',
    'mailto:user@example.invalid',
    '#heading',
  ])
    expect(safeEditorUrl(url), url).toBe(true);
});
