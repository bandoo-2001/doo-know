import { expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import {
  collectDiagramSaveNeeds,
  hashDiagramCode,
  serializeDiagramBinding,
  stripDiagramPreviews,
} from '../shared/diagram-portability';

it.each(['- ', '1. ', '> - '])(
  'preserves the container when removing an expired generated preview: %s',
  async (container) => {
    const marker = serializeDiagramBinding({
      kind: 'mermaid',
      codeHash: await hashDiagramCode('graph LR\nA-->B'),
      sourceHash: 'c'.repeat(64),
    });
    const old = `![MERMAID 预览](assets/diagram-${'a'.repeat(64)}.png)\n\n[图形源文件](assets/diagram-${'b'.repeat(64)}.mmd)\n\n${marker}\n\n\`\`\`mermaid\ngraph LR\nA-->B\n\`\`\`\n`;
    const indentation = container.startsWith('>') ? '>   ' : ' '.repeat(container.length);
    const nested = old
      .split('\n')
      .map((line, index) => (index ? indentation + line : container + line))
      .join('\n');
    const current = nested.replace('A-->B', 'A-->C');
    const needs = await collectDiagramSaveNeeds(current, nested);
    expect(needs).toHaveLength(1);
    const result = stripDiagramPreviews(current, needs);
    const before = new MarkdownIt().parse(current, {}),
      after = new MarkdownIt().parse(result, {});
    expect(
      after.filter((token) => token.type.endsWith('list_open')).map((token) => token.type),
    ).toEqual(
      before.filter((token) => token.type.endsWith('list_open')).map((token) => token.type),
    );
    expect(result.slice(result.indexOf(indentation + '```mermaid'))).toBe(
      current.slice(current.indexOf(indentation + '```mermaid')),
    );
    expect(result).not.toContain('![MERMAID');
    expect(after.find((token) => token.type === 'fence')?.content).toContain('A-->C');
  },
);
