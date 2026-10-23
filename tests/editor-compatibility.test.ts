import { it, expect } from 'vitest';
import { evaluateDocumentEligibility } from '../apps/web/editor/compatibility';
it('文档准入保护大小、结构、服务端模式及开关，不放大现有限制', () => {
  const input = { editorMode: 'full', markdown: '# 小文档', units: 1, depth: 1, enabled: true };
  expect(evaluateDocumentEligibility(input).allowed).toBe(true);
  for (const delta of [
    { enabled: false },
    { editorMode: 'large' },
    { markdown: '中'.repeat(90000) },
    { units: 5001 },
    { depth: 33 },
  ])
    expect(evaluateDocumentEligibility({ ...input, ...delta }).allowed).toBe(false);
  expect(evaluateDocumentEligibility({ ...input, markdown: 'a'.repeat(262144) }).allowed).toBe(
    true,
  );
});
