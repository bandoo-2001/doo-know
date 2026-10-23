import { describe, expect, it } from 'vitest';
import { rewriteImportReferences } from '../apps/server/platform/transfer-import';
import { references } from '../packages/core/render';

const mapping = new Map([
  ['target.md', '00-Inbox/copy/target (2).md'],
  ['assets/a.png', '00-Inbox/copy/assets/a (2).png'],
]);
const rewrite = (source: string, paths = mapping) =>
  rewriteImportReferences(source, 'source.md', '00-Inbox/copy/source.md', paths);

describe('knowledge-aware import reference destinations', () => {
  it('rewrites wiki and standard links to the same collision-renamed note', () => {
    const source = '[[target|Go]]\n\n[standard](target.md)\n';
    const actual = rewrite(source);
    expect(actual).toBe('[[target (2).md|Go]]\n\n[standard](target%20(2).md)\n');
    expect(references(actual)).toEqual(['target%20(2).md', 'target%20(2).md']);
  });

  it('rewrites an image inside a referenced footnote definition', () => {
    const source = 'ref[^a]\n\n[^a]: ![image](assets/a.png)\n';
    expect(rewrite(source)).toBe('ref[^a]\n\n[^a]: ![image](assets/a%20(2).png)\n');
  });

  it('retains implicit wiki labels, Unicode fragments and CRLF after relocating the destination', () => {
    const source = '原文 [[资料/目标#章节 一]]\r\n\r\n尾段\r\n';
    const actual = rewrite(source, new Map([['资料/目标.md', '00-Inbox/copy/资料/目标 (2).md']]));
    expect(actual).toBe('原文 [[资料/目标 (2).md#章节 一|资料/目标#章节 一]]\r\n\r\n尾段\r\n');
    expect(references(actual)).toEqual(['%E8%B5%84%E6%96%99/%E7%9B%AE%E6%A0%87%20(2).md#%E7%AB%A0%E8%8A%82%20%E4%B8%80']);
  });

  it('uses an explicit Markdown link when a renamed filename cannot be represented by wiki delimiters', () => {
    const source = '[[target|Go *中文*]]\n';
    const actual = rewrite(source, new Map([['target.md', '00-Inbox/copy/target|v2#draft.md']]));
    expect(actual).toBe('[Go \\*中文\\*](<target%7Cv2%23draft.md>)\n');
    expect(references(actual)).toEqual(['target%7Cv2%23draft.md']);
  });

  it('retains escaped wiki separators inside table cells when rewriting their targets', () => {
    const source = '| Link | More |\r\n| --- | --- |\r\n| [[target\\|Go]] | [[target\\|Other\\|label]] |\r\n';
    const actual = rewrite(source);
    expect(actual).toBe('| Link | More |\r\n| --- | --- |\r\n| [[target (2).md\\|Go]] | [[target (2).md\\|Other\\|label]] |\r\n');
    expect(references(actual)).toEqual(['target%20(2).md', 'target%20(2).md']);
  });

  it('rewrites live destinations across a multi-paragraph footnote without changing its nested code', () => {
    const source = [
      'ref[^a]', '',
      '[^a]: first [[target|图稿]]', '',
      '    More ![image](assets/a.png)', '',
      '    ```md',
      '    [[target|literal]] ![image](assets/a.png)',
      '    ```', '',
    ].join('\r\n');
    const expected = source
      .replace('first [[target|图稿]]', 'first [[target (2).md|图稿]]')
      .replace('More ![image](assets/a.png)', 'More ![image](assets/a%20(2).png)');
    expect(rewrite(source)).toBe(expected);
  });

  it('maps links inside inline footnotes to their original source positions', () => {
    const source = 'Inline ^[See [[target|design]] and ![image](assets/a.png).]\r\n';
    expect(rewrite(source)).toBe('Inline ^[See [[target (2).md|design]] and ![image](assets/a%20(2).png).]\r\n');
  });

  it('leaves wiki and image-looking code, escaped syntax and math byte for byte intact', () => {
    const source = [
      '[[target|Live]]', '',
      '`[[target|Code]] ![image](assets/a.png)`', '',
      '\\[[target|Escaped]]', '',
      '```md', '[[target|Fence]]', '![image](assets/a.png)', '```', '',
      '$x + \\text{![image](assets/a.png)}$', '',
      '$$', '![image](assets/a.png)', '$$', '',
      'ref[^a]', '', '[^a]: ![live](assets/a.png)', '',
    ].join('\r\n');
    const expected = source
      .replace('[[target|Live]]', '[[target (2).md|Live]]')
      .replace('[^a]: ![live](assets/a.png)', '[^a]: ![live](assets/a%20(2).png)');
    expect(rewrite(source)).toBe(expected);
  });
});
