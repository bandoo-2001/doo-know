import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../packages/core/db';
import { noteService } from '../packages/core/notes';
import { createToDooService } from '../packages/core/to-doo/service';
import { createOutcomeNoteService } from '../apps/server/to-doo/outcome-note';

it('creates one evidence note, atomically completes its task, and replays after copying to a fresh database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-outcome-note-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-outcome-secret-thirty-two-characters',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    todo = createToDooService(config, db, notes);
  let second: ReturnType<typeof openDatabase> | undefined;
  try {
    const result = todo.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'Explain the design' },
    });
    const occurrence = todo.snapshot().occurrences.find((item) => item.taskId === result.ids[0])!;
    const input = {
      requestId: randomUUID(),
      occurrenceId: occurrence.id,
      expectedRevision: occurrence.revision,
      title: 'Design evidence',
      folderPath: '00-Inbox',
      content: '# Design evidence\n\nA real explanation.',
      verification: 'practice' as const,
      complete: true,
    };
    const workflow = createOutcomeNoteService(config, db, notes, todo);
    const first = workflow.create(input);
    expect(notes.getNote(first.noteId).content).toContain('A real explanation.');
    expect(todo.getEntity('occurrence', occurrence.id)).toMatchObject({ status: 'done' });
    expect(workflow.create(input).noteId).toBe(first.noteId);
    expect((db.prepare('SELECT COUNT(*) n FROM notes WHERE active=1').get() as any).n).toBe(1);
    const newConfig = {
      ...config,
      knowledgeRoot: join(root, 'second-knowledge'),
      dataRoot: join(root, 'second-data'),
    };
    await cp(config.knowledgeRoot, newConfig.knowledgeRoot, { recursive: true });
    second = openDatabase(newConfig.dataRoot);
    const newNotes = noteService(newConfig, second),
      newTodo = createToDooService(newConfig, second, newNotes);
    try {
      const replay = createOutcomeNoteService(newConfig, second, newNotes, newTodo).create(input);
      expect(replay.noteId).toBe(first.noteId);
      expect(newNotes.getNote(replay.noteId).content).toContain('A real explanation.');
      expect((second.prepare('SELECT COUNT(*) n FROM notes WHERE active=1').get() as any).n).toBe(
        1,
      );
    } finally {
      newTodo.close();
    }
  } finally {
    second?.close();
    todo.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not invent a recovery operation for an unsubmitted stale outcome intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-outcome-preflight-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-outcome-preflight-secret-thirty-two',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    todo = createToDooService(config, db, notes);
  try {
    const id = todo.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'Evidence target' },
    }).ids[0];
    const occurrence = todo.snapshot().occurrences.find((item) => item.taskId === id)!;
    const workflow = createOutcomeNoteService(config, db, notes, todo);
    const input = {
      requestId: randomUUID(),
      occurrenceId: occurrence.id,
      expectedRevision: 'stale-revision',
      title: 'Evidence',
      folderPath: '00-Inbox',
      content: '# Evidence',
      complete: true,
    };
    try {
      workflow.create(input);
      throw Error('Expected stale intent rejection');
    } catch (error: any) {
      expect(error.statusCode).toBe(409);
      expect(error.details.operationId).toBeNull();
      expect(error.details.needsReconciliation).toBe(false);
    }
    expect(todo.snapshot({ kind: 'operation' }).operations).toHaveLength(0);
    const result = workflow.create({ ...input, expectedRevision: occurrence.revision });
    expect(notes.getNote(result.noteId).content).toBe('# Evidence');
  } finally {
    todo.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains a saved note after a late task conflict and resumes without a second note', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-outcome-conflict-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'fixture-only-outcome-conflict-secret-thirty-two',
  };
  await mkdir(join(config.knowledgeRoot, '00-Inbox'), { recursive: true });
  const db = openDatabase(config.dataRoot),
    notes = noteService(config, db),
    todo = createToDooService(config, db, notes);
  try {
    const task = todo.command({
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'Task' },
    }).ids[0];
    const occurrence = todo.snapshot().occurrences.find((item) => item.taskId === task)!;
    const input = {
      requestId: randomUUID(),
      occurrenceId: occurrence.id,
      expectedRevision: occurrence.revision,
      title: 'Evidence',
      folderPath: '00-Inbox',
      content: '# Saved before conflict',
      verification: 'delivered' as const,
      complete: true,
    };
    let interrupted = false;
    const workflow = createOutcomeNoteService(config, db, notes, {
      ...todo,
      command(input) {
        if ((input as any)?.action === 'save_outcome' && !interrupted) {
          interrupted = true;
          const current = todo.getEntity('occurrence', occurrence.id)!;
          todo.command({
            requestId: randomUUID(),
            action: 'save_entity',
            payload: {
              kind: 'occurrence',
              entity: { ...current, resultSummary: 'A newer edit' },
              expectedRevision: current.revision,
            },
          });
        }
        return todo.command(input);
      },
    });
    let operationId = '',
      noteId = '';
    try {
      workflow.create(input);
      throw Error('Expected conflict');
    } catch (error: any) {
      expect(error.statusCode).toBe(409);
      expect(error.details.needsReconciliation).toBe(true);
      operationId = error.details.operationId;
      noteId = error.details.noteId;
    }
    expect(notes.getNote(noteId).content).toContain('Saved before conflict');
    const resumed = createOutcomeNoteService(config, db, notes, todo).create({
      ...input,
      requestId: randomUUID(),
      operationId,
      expectedRevision: todo.getEntity('occurrence', occurrence.id)!.revision,
    });
    expect(resumed.noteId).toBe(noteId);
    expect((db.prepare('SELECT COUNT(*) n FROM notes WHERE active=1').get() as any).n).toBe(1);
  } finally {
    todo.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
