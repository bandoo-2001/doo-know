import { describe, expect, it } from 'vitest';
import { rewriteLibraryReferences } from '../packages/core/organization/references.js';

describe('lossless organization references', () => {
  it('rebases outgoing attachments and note links when a note moves', () => {
    const input =
      '# Keep  spaces\r\n\r\n![A](assets/a.png "title") and [B](../Other/b.md#part)\r\n';
    expect(rewriteLibraryReferences(input, 'Notes/a.md', 'New/Deep/a.md', []).content).toBe(
      '# Keep  spaces\r\n\r\n![A](../../Notes/assets/a.png "title") and [B](../../Other/b.md#part)\r\n',
    );
  });
  it('repairs incoming links using exact directory-prefix boundaries', () => {
    const input = '[one](Notes/a.md) [two](NotesElse/a.md)';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [
        { from: 'Notes', to: 'Archive/Notes' },
      ]).content,
    ).toBe('[one](Archive/Notes/a.md) [two](NotesElse/a.md)');
  });
  it('preserves encoded filenames, query and fragment', () => {
    expect(
      rewriteLibraryReferences('[a](<Notes/a%20b.md?view=1#hello>)', 'index.md', 'index.md', [
        { from: 'Notes', to: 'New Notes' },
      ]).content,
    ).toBe('[a](<New%20Notes/a%20b.md?view=1#hello>)');
  });
  it('updates a reference definition once while preserving labels and titles', () => {
    const input = '[A][ref]\n![B][ref]\n\n[ref]: Notes/a.md "Title"\n';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [
        { from: 'Notes/a.md', to: 'New/a.md' },
      ]).content,
    ).toBe('[A][ref]\n![B][ref]\n\n[ref]: New/a.md "Title"\n');
  });
  it('leaves code examples and inline code untouched', () => {
    const input = '```md\n[x](Notes/a.md)\n```\n`[x](Notes/a.md)`\n\n[x](Notes/a.md)\n';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [{ from: 'Notes', to: 'New' }])
        .content,
    ).toBe('```md\n[x](Notes/a.md)\n```\n`[x](Notes/a.md)`\n\n[x](New/a.md)\n');
  });
  it('preserves external, anchor and stable-ID links byte for byte', () => {
    const input = '[a](https://example.com/Notes/a.md) [b](#hello) [c](asset:abc) [d](note:xyz)';
    expect(rewriteLibraryReferences(input, 'Notes/a.md', 'New/a.md', []).content).toBe(input);
  });
  it('keeps label destinations and title examples out of rewriting', () => {
    const input = '[Notes/a.md](Notes/a.md "[x](Notes/a.md)")';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [{ from: 'Notes', to: 'New' }])
        .content,
    ).toBe('[Notes/a.md](New/a.md "[x](Notes/a.md)")');
  });
  it('uses the most specific mapping once without cascading', () => {
    const moves = [
      { from: 'Notes', to: 'New' },
      { from: 'Notes/Specific', to: 'Chosen' },
      { from: 'Chosen', to: 'Wrong' },
    ];
    expect(
      rewriteLibraryReferences('[x](Notes/Specific/a.md)', 'index.md', 'index.md', moves).content,
    ).toBe('[x](Chosen/a.md)');
  });
  it('rewrites wiki destinations without changing the visible label', () => {
    expect(
      rewriteLibraryReferences('[[Notes/a#part|My label]]', 'index.md', 'index.md', [
        { from: 'Notes/a.md', to: 'New/a.md' },
      ]).content,
    ).toBe('[[New/a#part|My label]]');
  });
  it('handles nested parentheses and escaped punctuation in link destinations', () => {
    expect(
      rewriteLibraryReferences('[x](Notes/a\\(b\\).md)', 'index.md', 'index.md', [
        { from: 'Notes', to: 'New' },
      ]).content,
    ).toBe('[x](New/a%28b%29.md)');
  });
  it('rewrites only whiteboard element link values and preserves JSON formatting', () => {
    const input =
      '{\n  "elements": [{"id":"a", "text":"Notes/a.md", "link":"Notes/a.md#part"}],\n  "files": {}\n}\n';
    expect(
      rewriteLibraryReferences(
        input,
        'board.excalidraw',
        'board.excalidraw',
        [{ from: 'Notes', to: 'New' }],
        true,
      ).content,
    ).toBe(
      '{\n  "elements": [{"id":"a", "text":"Notes/a.md", "link":"New/a.md#part"}],\n  "files": {}\n}\n',
    );
  });
  it('refuses unsafe path escapes when a moved note depends on them', () => {
    expect(() =>
      rewriteLibraryReferences('[x](../../outside.md)', 'Notes/a.md', 'New/a.md', []),
    ).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_REFERENCE' }));
  });
  it('ignores frontmatter, mathematical source and escaped examples', () => {
    const input =
      '---\nexample: "[x](Notes/a.md)"\n---\n\n$[x](Notes/a.md)$\n\\[x](Notes/a.md)\n\n[x](Notes/a.md)';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [{ from: 'Notes', to: 'New' }])
        .content,
    ).toBe(
      '---\nexample: "[x](Notes/a.md)"\n---\n\n$[x](Notes/a.md)$\n\\[x](Notes/a.md)\n\n[x](New/a.md)',
    );
  });
  it('repairs image and enclosing link destinations independently', () => {
    expect(
      rewriteLibraryReferences('[![A](Notes/a.png)](Notes/a.md)', 'index.md', 'index.md', [
        { from: 'Notes', to: 'New' },
      ]).content,
    ).toBe('[![A](New/a.png)](New/a.md)');
  });
  it('does not treat an invalid wiki destination as an effective reference', () => {
    const input = '[[Notes/a|label]] [[../wrong\\name]]';
    expect(
      rewriteLibraryReferences(input, 'index.md', 'index.md', [{ from: 'Notes', to: 'New' }])
        .content,
    ).toBe('[[New/a|label]] [[../wrong\\name]]');
  });
  it('resolves entity-escaped URL delimiters while preserving their source spelling', () => {
    expect(
      rewriteLibraryReferences(
        '[x](Notes/a.md&#35;part) [y](Notes/a.md?x=1&amp;y=2)',
        'index.md',
        'index.md',
        [{ from: 'Notes/a.md', to: 'New/a.md' }],
      ).content,
    ).toBe('[x](New/a.md&#35;part) [y](New/a.md?x=1&amp;y=2)');
  });
});
