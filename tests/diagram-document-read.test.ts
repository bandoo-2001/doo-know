import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readCoherentDiagramDocument } from '../apps/web/diagrams/document-read';
const hash = async (text: string) => createHash('sha256').update(text).digest('hex');
const note = (content: string) => ({
  id: 'note',
  title: '图',
  relativePath: '00-Inbox/doc.md',
  content,
  modifiedAt: '1',
  updatedAt: 'now',
});
const resource = async (markdown: string, source = 'native') =>
  ({
    noteId: 'note',
    documentHash: await hash(markdown),
    source: { content: source, hash: await hash(source) },
  }) as any;
it('retries old Markdown paired with newer resource hashes instead of lending it fresh CAS baselines', async () => {
  let attempt = 0;
  const result = await readCoherentDiagramDocument(
    async () => note(++attempt === 1 ? 'old prose' : 'external prose'),
    async () => resource('external prose'),
    hash,
  );
  expect(result.document.content).toBe('external prose');
  expect(await hash(result.document.content)).toBe(result.resource.documentHash);
});
it('retries a native body that does not match the resource source hash', async () => {
  let attempt = 0;
  const result = await readCoherentDiagramDocument(
    async () => note('Markdown'),
    async () => {
      const proof = await resource('Markdown');
      if (++attempt === 1) proof.source.content = 'mixed native bytes';
      return proof;
    },
    hash,
  );
  expect(result.resource.source.content).toBe('native');
  expect(await hash(result.resource.source.content!)).toBe(result.resource.source.hash);
});
it('refuses a perpetually incoherent pair after a bounded read without returning an editing baseline', async () => {
  let reads = 0;
  await expect(
    readCoherentDiagramDocument(
      async () => {
        reads++;
        return note('old');
      },
      async () => resource('new'),
      hash,
    ),
  ).rejects.toThrow('未采用不一致');
  expect(reads).toBe(3);
});
it('permits a coherent read-only resource with absent native bytes for the existing PNG fallback', async () => {
  const proof = await resource('Markdown');
  delete proof.source.content;
  const result = await readCoherentDiagramDocument(
    async () => note('Markdown'),
    async () => proof,
    hash,
  );
  expect(result.document.content).toBe('Markdown');
  expect(result.resource.source.content).toBeUndefined();
});
