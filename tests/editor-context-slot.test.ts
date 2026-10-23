import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { contextAt } from '../apps/web/editor/context-slot';
import { createRichProjection, richExtensions } from '../apps/web/editor/rich-adapter';

const schema = getSchema(richExtensions());

describe('文档就近操作定位', () => {
  const table = schema.nodeFromJSON(
    createRichProjection(
      '| 链接 | 图片 |\n| --- | --- |\n| [资源](https://example.invalid/docs) | ![图示](assets/example.png) |',
    ).json,
  );
  it('表格内选择图片时使用图片控件，而非表格控件', () => {
    let position = -1;
    table.descendants((node, at) => {
      if (node.type.name === 'image') position = at;
    });
    const state = EditorState.create({
      doc: table,
      selection: NodeSelection.create(table, position),
    });
    expect(contextAt(state)).toMatchObject({ kind: 'image', position });
  });
  it('表格内选择链接时使用链接控件，而非表格控件', () => {
    let position = -1;
    table.descendants((node, at) => {
      if (node.isText && node.text === '资源') position = at;
    });
    const state = EditorState.create({
      doc: table,
      selection: TextSelection.create(table, position + 1),
    });
    expect(contextAt(state)).toMatchObject({ kind: 'link', position });
  });
  it('长段末尾的图片控件定位在图片处', () => {
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text('x'.repeat(2000)),
      schema.nodes.image.create({ src: 'assets/x.png', alt: 'x' }),
    ]);
    const doc = schema.nodes.doc.create(null, paragraph);
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, 2001) });
    expect(contextAt(state)).toEqual({ kind: 'image', position: 2001 });
  });
  it('长段末尾的链接控件定位在完整链接的起点', () => {
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text('x'.repeat(2000)),
      schema.text('目标链接', [schema.marks.link.create({ href: 'https://example.invalid' })]),
    ]);
    const doc = schema.nodes.doc.create(null, paragraph);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2003) });
    expect(contextAt(state)).toEqual({ kind: 'link', position: 2001 });
  });
});
