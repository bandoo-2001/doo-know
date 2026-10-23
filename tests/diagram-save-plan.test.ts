import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  collectDiagramSaveNeeds,
  hashDiagramCode,
  normalizeDiagramCode,
  parseDiagramBinding,
  serializeDiagramBinding,
  stripDiagramPreviews,
} from '../shared/diagram-portability';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><path d="M0 0H40V20Z"/></svg>';
const png = 'assets/diagram-' + 'a'.repeat(64) + '.png';
const source = 'assets/diagram-' + 'b'.repeat(64) + '.svg';
const sourceHash = 'c'.repeat(64);
const fence = (code = svg, kind = 'svg', newline = '\n') => ['```' + kind, code, '```', ''].join(newline);
async function bound(code = svg, boundCode = code, newline = '\n') {
  const marker = serializeDiagramBinding({ kind: 'svg', codeHash: await hashDiagramCode(boundCode), sourceHash });
  return `![SVG 预览](${png})${newline}${newline}[图形源文件](${source})${newline}${newline}${marker}${newline}${newline}${fence(code, 'svg', newline)}`;
}

describe('explicit diagram save planning', () => {
  it('does not require conversion of unchanged legacy fences, including moved source ranges', async () => {
    const baseline = fence() + '\n' + fence('graph TD\nA-->B', 'mermaid');
    expect(await collectDiagramSaveNeeds('# changed prose\n\n' + baseline, baseline)).toEqual([]);
  });

  it('finds newly inserted supported fences and records their exact source range', async () => {
    const current = '# start\r\n\r\n' + fence(svg, 'svg', '\r\n') + '\r\nend';
    const needs = await collectDiagramSaveNeeds(current, '# start\r\n');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: 'svg', reason: 'new', line: 3, from: 11 });
    expect(current.slice(needs[0].from, needs[0].to)).toBe(fence(svg, 'svg', '\r\n'));
    expect(needs[0].codeHash).toBe(createHash('sha256').update(svg).digest('hex'));
  });

  it('requires a choice after changing an unconverted existing fence', async () => {
    const changed = svg.replace('40V20', '20V20');
    const needs = await collectDiagramSaveNeeds(fence(changed), fence());
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: 'svg', reason: 'changed' });
  });

  it('accepts a freshly bound immutable preview without pretending its source hash equals normalized fence code', async () => {
    const current = await bound();
    expect(sourceHash).not.toBe(await hashDiagramCode(svg));
    expect(await collectDiagramSaveNeeds(current, '')).toEqual([]);
  });

  it('reports an S1 preview adjacent to edited S2 source as stale and retains the old binding for display', async () => {
    const changed = svg.replace('40V20', '20V20');
    const current = await bound(changed, svg);
    const needs = await collectDiagramSaveNeeds(current, await bound());
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ kind: 'svg', reason: 'stale', prefixFrom: 0,
      previewPath: png, sourcePath: source, binding: { sourceHash, codeHash: await hashDiagramCode(svg) } });
    expect(current.slice(needs[0].from, needs[0].to)).toBe(fence(changed));
  });

  it('does not reuse a nearby user image or a binding separated by prose as proof of a current preview', async () => {
    const marker = serializeDiagramBinding({ kind: 'svg', codeHash: await hashDiagramCode(svg), sourceHash });
    const current = `![user image](${png})\n\n[图形源文件](${source})\n\n${marker}\n\n` + fence();
    const needs = await collectDiagramSaveNeeds(current, '');
    expect(needs).toHaveLength(1);
    expect(needs[0].prefixFrom).toBeUndefined();
    expect(stripDiagramPreviews(current, needs)).toBe(current);
    const separated = (await bound()).replace('```svg', 'user explanation\n\n```svg');
    expect(await collectDiagramSaveNeeds(separated, '')).toHaveLength(1);
  });

  it('does not require legacy groups without a binding to migrate, or delete them on source-only save', async () => {
    const current = `![SVG 预览](${png})\n\n[图形源文件](${source})\n\n` + fence();
    expect(await collectDiagramSaveNeeds(current, current)).toEqual([]);
    const needs = await collectDiagramSaveNeeds(current, '');
    expect(needs).toHaveLength(1);
    expect(stripDiagramPreviews(current, needs)).toBe(current);
  });

  it('keeps duplicate diagram occurrences separate and matches unchanged baseline copies before edited ones', async () => {
    const changed = svg.replace('40V20', '20V20');
    const current = fence(changed) + '\n' + fence();
    const needs = await collectDiagramSaveNeeds(current, fence());
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ from: 0, reason: 'new' });
    const both = await collectDiagramSaveNeeds(fence() + '\n' + fence(), '');
    expect(both).toHaveLength(2);
    expect(both[0].to).toBeLessThan(both[1].from);
  });

  it('counts all supported kinds without reading diagram-looking text in code, HTML comments or math', async () => {
    const current = [
      '````text', '```svg', svg, '```', '````', '',
      '<!--', '```mermaid', 'graph TD', '```', '-->', '',
      '$$', '```svg', svg, '```', '$$', '',
      fence('graph TD\nA-->B', 'mermaid'),
      fence('board.excalidraw', 'excalidraw'),
    ].join('\n');
    expect((await collectDiagramSaveNeeds(current, '')).map(need => need.kind)).toEqual(['mermaid', 'excalidraw']);
  });

  it('strips only an explicitly selected recognized bound group, preserving CRLF, the exact fence and user neighbors', async () => {
    const changed = svg.replace('40V20', '20V20');
    const prefix = '# Keep\r\n\r\n![my figure](assets/user.png)\r\n\r\n';
    const current = prefix + await bound(changed, svg, '\r\n') + '\r\nTail\r\n';
    const needs = await collectDiagramSaveNeeds(current, await bound());
    expect(stripDiagramPreviews(current, needs)).toBe(prefix + fence(changed, 'svg', '\r\n') + '\r\nTail\r\n');
    expect(current).toContain('dooknow:diagram-preview');
  });

  it('rejects stale source ranges instead of stripping unrelated neighbors after another edit', async () => {
    const changed = svg.replace('40V20', '20V20');
    const current = await bound(changed, svg);
    const needs = await collectDiagramSaveNeeds(current, await bound());
    expect(() => stripDiagramPreviews('new prose\n' + current, needs)).toThrow(/变化|重新/);
  });

  it('leaves a second generated group alone when only the first stale group is selected', async () => {
    const changed = svg.replace('40V20', '20V20');
    const first = await bound(changed, svg), second = await bound();
    const current = first + '\n---\n\n' + second;
    const needs = await collectDiagramSaveNeeds(current, await bound());
    expect(needs).toHaveLength(1);
    expect(stripDiagramPreviews(current, needs)).toBe(fence(changed) + '\n---\n\n' + second);
  });
});

describe('portable diagram binding comments', () => {
  it('hashes normalized fence code without altering meaningful whitespace', async () => {
    expect(normalizeDiagramCode('hello\r\n\r\n')).toBe('hello');
    expect(await hashDiagramCode('hello\r\n')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(await hashDiagramCode(' hello\n')).not.toBe(await hashDiagramCode('hello\n'));
  });

  it('serializes a strict standard HTML comment and rejects malformed or executable lookalikes', async () => {
    const binding = { kind: 'svg' as const, codeHash: await hashDiagramCode(svg), sourceHash };
    const comment = serializeDiagramBinding(binding);
    expect(comment).toBe(`<!-- dooknow:diagram-preview v1 kind=svg code=${binding.codeHash} source=${sourceHash} -->`);
    expect(parseDiagramBinding(comment)).toEqual(binding);
    for (const invalid of [comment + '<img src=x>', comment.replace('source=' + sourceHash, 'source=bad'),
      comment.replace('v1', 'v2'), comment.replace('kind=svg', 'kind=html'), '<!-- unrelated -->'])
      expect(parseDiagramBinding(invalid)).toBeUndefined();
  });
});
