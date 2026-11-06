import { readFileSync } from 'node:fs';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { expect, test } from 'vitest';

test('compiled task theme overrides stay inside the task page in both themes', () => {
  const filename = new URL('../apps/web/components/ToDooWorkspace.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const selectors: string[] = [];
  for (const style of descriptor.styles) {
    const compiled = compileStyle({
      source: style.content,
      filename: filename.pathname,
      id: 'data-v-task-scope',
      scoped: style.scoped,
    });
    expect(compiled.errors).toEqual([]);
    compiled.rawResult!.root.walkRules((rule) => {
      rule.walkDecls(/^--todo-(accent|tint)$/, () => {
        selectors.push(rule.selector);
      });
    });
  }
  expect(selectors.length).toBeGreaterThan(0);
  for (const selector of selectors) expect(selector).toContain('.todo-task-page');
});
