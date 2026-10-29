import { expect, it } from 'vitest';
import { toDooCaptureFromNote } from '../apps/web/to-doo-capture';

it('captures selected Markdown as an editable task while preserving source identity and draft status', () => {
  const markdown = '# Plan\n\n- [ ] Draw the architecture\n';
  const start = markdown.indexOf('- [ ]');
  const input = {
    noteId: 'note-1',
    title: 'Architecture plan',
    markdown,
    savedMarkdown: '# Old plan',
    selection: { anchor: start, head: markdown.length },
    contentHash: 'a'.repeat(64),
  };
  expect(toDooCaptureFromNote(input)).toMatchObject({
    title: 'Draw the architecture',
    description: '- [ ] Draw the architecture',
    source: { noteId: 'note-1', draft: true, contentHash: null, startLineHint: 3 },
    noteRefs: [{ noteId: 'note-1', role: 'source' }],
  });
  expect(input.savedMarkdown).toBe('# Old plan');
});

it('captures a whole-note follow-up without copying or modifying the entire note body', () => {
  const result = toDooCaptureFromNote({
    noteId: 'note-2',
    title: 'Meeting notes',
    markdown: '# Meeting\nConfidential long body',
    savedMarkdown: '# Meeting\nConfidential long body',
    contentHash: 'b'.repeat(64),
  });
  expect(result.title).toBe('跟进：Meeting notes');
  expect(result.description).toBe('');
  expect(result.source).toMatchObject({ draft: false, quote: '', contentHash: 'b'.repeat(64) });
});

it('retains the unsaved source snapshot when capturing a whole-note follow-up', () => {
  const result = toDooCaptureFromNote({ noteId:'draft-note',title:'Draft source',markdown:'# Draft\nA new unsaved idea',savedMarkdown:'# Saved' });
  expect(result.title).toBe('跟进：Draft source');
  expect(result.description).toBe('');
  expect(result.source).toMatchObject({draft:true,quote:'# Draft\nA new unsaved idea',contentHash:null,startLineHint:1});
});
