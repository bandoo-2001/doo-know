import { expect, it } from 'vitest';
import { extractNoteLinks, resolveNoteLink } from '../shared/note-links';

it('resolves Unicode, parent directories, fragments and Wiki display aliases as ordinary relative note paths', () => {
  const source = '30-Knowledge/资料/source.md';
  expect(extractNoteLinks('[[../我的笔记#说明|显示别名]]\n\n[normal](../%E6%88%91%E7%9A%84%E7%AC%94%E8%AE%B0.md?view=1#section)', source))
    .toEqual(['30-Knowledge/我的笔记.md']);
  expect(resolveNoteLink('00-Inbox/source.md', '../README.md')).toBe('README.md');
  expect(resolveNoteLink('00-Inbox/source.md', './UPPER.MD#part')).toBe('00-Inbox/UPPER.MD');
});

it('uses parsed links rather than code, display math, properties, images or unused footnotes', () => {
  const content = '---\nrelated: "[[property]]"\n---\n\n`[[inline]]`\n\n```md\n[[fence]]\n```\n\n$$\nx\n\n[[math]]\n\n$$\n\n![image](image.md)\n\n[^unused]: [[unused]]\n\nread[^used]\n\n[^used]: [[visible]]\n';
  expect(extractNoteLinks(content, '00-Inbox/source.md')).toEqual(['00-Inbox/visible.md']);
});

it('does not count Wiki or ordinary link-looking text inside image captions as navigable note links', () => {
  expect(extractNoteLinks('![caption [[target]] and [label](ordinary.md)](photo.png)', '00-Inbox/source.md')).toEqual([]);
});

it('excludes selflinks and declines schemes, absolute paths, malformed encodings and directory targets', () => {
  expect(extractNoteLinks('[[source]] [self](source.md#part) [[target]] [duplicate](target.md)', '00-Inbox/source.md'))
    .toEqual(['00-Inbox/target.md']);
  for (const url of ['#part', '/api/notes/x', 'https://example.test/a.md', '//host/a.md', '%2Froot.md', 'javascript%3Ax.md', '%ZZ.md', '../../outside.md', 'a.md/', '.hidden/a.md', 'a\\b.md', 'image.png'])
    expect(resolveNoteLink('00-Inbox/source.md', url), url).toBeUndefined();
});
