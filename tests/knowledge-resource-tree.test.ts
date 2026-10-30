import { describe, expect, it } from 'vitest';
import {
  buildKnowledgeResourceTree,
  knowledgeResourceSelection,
} from '../apps/web/knowledge-resource-tree';

const resources = [
  { kind: 'directory', id: 'knowledge', label: '30-Knowledge', path: '30-Knowledge' },
  { kind: 'directory', id: 'topic', label: '30-Knowledge/主题', path: '30-Knowledge/主题' },
  { kind: 'note', id: 'one', label: '30-Knowledge/主题/一.md', path: '30-Knowledge/主题/一.md' },
  { kind: 'note', id: 'two', label: '30-Knowledge/主题/二.md', path: '30-Knowledge/主题/二.md' },
  { kind: 'directory', id: 'similar', label: '30-Knowledge-copy', path: '30-Knowledge-copy' },
];

describe('knowledge resource selection', () => {
  it('builds a directory/note hierarchy using stable identities instead of paths', () => {
    const tree = buildKnowledgeResourceTree(resources, []);
    expect(tree[0]).toMatchObject({ value: '["directory","knowledge"]', title: '30-Knowledge' });
    expect(tree[0].children[0]).toMatchObject({ value: '["directory","topic"]', title: '主题' });
    expect(tree[0].children[0].children.map((node) => node.value).sort()).toEqual([
      '["note","one"]',
      '["note","two"]',
    ]);
    const renamed = buildKnowledgeResourceTree(
      resources.map((ref) => ({
        ...ref,
        path: ref.path.replace(/^30-Knowledge(?=\/|$)/, '改名'),
        label: ref.label.replace(/^30-Knowledge(?=\/|$)/, '改名'),
      })),
      [],
    );
    expect(
      renamed
        .find((node) => node.id === 'knowledge')
        ?.children[0].children.find((node) => node.id === 'one')?.value,
    ).toBe('["note","one"]');
  });

  it('shows descendants as included without adding them to explicit selected resources', () => {
    const selected = [{ kind: 'directory', id: 'knowledge' }];
    const tree = buildKnowledgeResourceTree(resources, selected);
    expect(tree[0].children[0]).toMatchObject({
      included: true,
      checkable: false,
      selectable: false,
    });
    expect(tree[0].children[0].children[0]).toMatchObject({ included: true });
    expect(tree[1]).toMatchObject({ included: false });
    expect(
      knowledgeResourceSelection([{ value: '["directory","knowledge"]' }], resources, selected),
    ).toEqual(selected);
  });

  it('allows narrowing a parent ceiling to descendants while excluding similarly named siblings', () => {
    const ceiling = { mode: 'selected' as const, resources: [{ kind: 'directory', id: 'topic' }] };
    const tree = buildKnowledgeResourceTree(resources, [], ceiling);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ path: '30-Knowledge', selectable: false, checkable: false });
    expect(tree[0].children[0].children.map((node) => node.id).sort()).toEqual(['one', 'two']);
    expect(
      knowledgeResourceSelection(
        [{ value: '["note","one"]' }, { value: '["directory","similar"]' }],
        resources,
        [],
        ceiling,
      ),
    ).toEqual([{ kind: 'note', id: 'one' }]);
  });

  it('keeps complete leaf selections explicit instead of promoting their parent or whole-library mode', () => {
    expect(
      knowledgeResourceSelection(
        [{ value: '["note","one"]' }, { value: '["note","two"]' }],
        resources,
        [],
      ),
    ).toEqual([
      { kind: 'note', id: 'one' },
      { kind: 'note', id: 'two' },
    ]);
    expect(
      knowledgeResourceSelection(
        [{ value: '["directory","topic"]', halfChecked: true }],
        resources,
        [],
      ),
    ).toEqual([]);
  });

  it('keeps missing selected identities visible and removable without adopting an old-path replacement', () => {
    const selected = [{ kind: 'directory', id: 'missing' }];
    const tree = buildKnowledgeResourceTree(resources, selected);
    expect(tree.at(-1)).toMatchObject({ value: '["directory","missing"]', unavailable: true });
    expect(
      knowledgeResourceSelection(
        [{ value: '["directory","missing"]' }, { value: '["note","one"]' }],
        resources,
        selected,
      ),
    ).toEqual([
      { kind: 'directory', id: 'missing' },
      { kind: 'note', id: 'one' },
    ]);
    expect(knowledgeResourceSelection([], resources, selected)).toEqual([]);
    expect(
      knowledgeResourceSelection([{ value: '["directory","missing"]' }], resources, []),
    ).toEqual([]);
  });

  it('does not infer descendant access from a missing ceiling identity or a note ceiling', () => {
    const missing = {
      mode: 'selected' as const,
      resources: [{ kind: 'directory', id: 'missing' }],
    };
    expect(buildKnowledgeResourceTree(resources, [], missing)).toEqual([]);
    const note = { mode: 'selected' as const, resources: [{ kind: 'note', id: 'one' }] };
    const tree = buildKnowledgeResourceTree(resources, [], note);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual(['one']);
    expect(tree[0].children[0]).toMatchObject({ checkable: false, selectable: false });
  });
});
