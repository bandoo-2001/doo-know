import { expect, it } from 'vitest';
import { collectionText } from '../packages/core/collections/source.js';

it('uses a leading H1 as the card title and summarizes body text and later headings', () => {
  expect(
    collectionText(
      '---\nprivate: metadata\n---\n# Card title\n\n**Body** [text](https://example.com)\n\n## Details\nMore',
    ),
  ).toEqual({
    title: 'Card title',
    summary: 'Body text Details More',
  });
});

it('caps parsing of supplied content and never searches the unseen tail for a title', () => {
  expect(collectionText('x'.repeat(9000) + '\n# Tail title')).toEqual({
    title: '',
    summary: 'x'.repeat(240),
  });
});
