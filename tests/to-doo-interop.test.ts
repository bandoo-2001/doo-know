import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createToDooInterop,
  exportPortableJson,
  parseTickTickCsv,
  validatePortableJson,
} from '../packages/core/to-doo/interop.js';
import { toDooEntitySchemas, type ToDooSnapshot } from '../shared/to-doo-contracts.js';
import { openDatabase } from '../packages/core/db.js';
import { noteService } from '../packages/core/notes.js';
import { createToDooService } from '../packages/core/to-doo/service.js';
import { createToDooNetwork } from '../packages/core/to-doo/network.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function domain() {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-interop-'));
  const config = {
    knowledgeRoot: join(root, 'knowledge'),
    dataRoot: join(root, 'data'),
    origin: 'http://localhost:3010',
    secret: 'test-only-secret',
  };
  await mkdir(config.knowledgeRoot);
  const db = openDatabase(config.dataRoot);
  const service = createToDooService(config, db, noteService(config, db));
  cleanups.push(async () => {
    service.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  });
  return { config, db, service };
}

function snapshot(): ToDooSnapshot {
  const at = '2026-10-29T09:00:00.000Z';
  return {
    datasetId: 'dataset',
    version: 'v1',
    now: at,
    settings: toDooEntitySchemas.settings.parse({
      id: 'settings',
      revision: 's1',
      createdAt: at,
      updatedAt: at,
    }),
    lists: [],
    sections: [],
    tags: [],
    tasks: [],
    occurrences: [],
    exceptions: [],
    timeBlocks: [],
    outcomes: [],
    records: [],
    activities: [],
    focusSessions: [],
    habits: [],
    habitEntries: [],
    anniversaries: [],
    reminderEvents: [],
    views: [],
    templates: [],
    reviews: [],
    plans: [],
    calendarSources: [],
    calendarEvents: [],
    calendarFeeds: [],
    imports: [],
    operations: [],
    statistics: {
      scope: 'library',
      completed: 0,
      pending: 0,
      overdue: 0,
      focusMinutes: 0,
      habitAmount: 0,
      outcomes: 0,
      byList: {},
    },
    page: {
      kind: null,
      total: 0,
      limit: 200,
      nextCursor: null,
      truncated: false,
      counts: {},
      from: '2026-09-29',
      to: '2027-01-27',
    },
    warnings: [],
  } as ToDooSnapshot;
}
describe('portable JSON and TickTick mapping', () => {
  it.each(['checkpoint', 'legacy', 'batched checkpoint'] as const)(
    'interrupts a running focus on %s JSON import while preserving measured time and receipts',
    async (format) => {
      const source = await domain(),
        destination = await domain();
      const command = (action: string, payload: unknown) =>
        source.service.command({ requestId: randomUUID(), action, payload });
      const finishedId = command('start_focus', {
        mode: 'stopwatch',
        at: '2026-10-01T08:00:00.000Z',
      }).ids[0];
      command('control_focus', {
        id: finishedId,
        expectedRevision: source.service.getEntity('focusSession', finishedId)!.revision,
        operation: 'finish',
        at: '2026-10-01T08:07:00.000Z',
        note: 'Completed work',
      });
      const start = {
        requestId: randomUUID(),
        action: 'start_focus',
        payload: { mode: 'stopwatch', at: '2026-10-01T09:00:00.000Z' },
      };
      const id = source.service.command(start).ids[0];
      command('control_focus', {
        id,
        expectedRevision: source.service.getEntity('focusSession', id)!.revision,
        operation: 'pause',
        at: '2026-10-01T09:12:00.000Z',
      });
      command('control_focus', {
        id,
        expectedRevision: source.service.getEntity('focusSession', id)!.revision,
        operation: 'resume',
        at: '2026-10-01T09:20:00.000Z',
      });
      const original = source.service.exportCheckpoint();
      const exporter = createToDooInterop(source.service, {
        db: source.db,
        dataRoot: source.config.dataRoot,
      });
      const importer = createToDooInterop(destination.service, {
        db: destination.db,
        dataRoot: destination.config.dataRoot,
        ...(format === 'batched checkpoint' ? { importBatchSize: 1 } : {}),
      });
      try {
        const content =
          format === 'legacy'
            ? exportPortableJson(source.service.snapshot({ all: true }), {
                transactions: original.transactions,
              })
            : exporter.exportJson();
        const preview = importer.previewImport({ format: 'json', content });
        const applied = importer.applyImport({ previewId: preview.id, requestId: 'restore-focus' });
        await importer.processImportJobs();
        expect(destination.service.getEntity('focusSession', id)).toMatchObject({
          status: 'interrupted',
          segments: [
            { start: '2026-10-01T09:00:00.000Z', end: '2026-10-01T09:12:00.000Z' },
            { start: '2026-10-01T09:20:00.000Z', end: '2026-10-01T09:20:00.000Z' },
          ],
        });
        expect(destination.service.getEntity('focusSession', finishedId)).toMatchObject({
          status: 'finished',
          segments: [{ start: '2026-10-01T08:00:00.000Z', end: '2026-10-01T08:07:00.000Z' }],
        });
        expect(destination.service.snapshot({ all: true }).statistics.focusMinutes).toBe(19);
        expect(preview.changes.find((entry) => entry.id === id)?.after.status).toBe('interrupted');
        const revision = destination.service.getEntity('focusSession', id)!.revision;
        if (format !== 'legacy') {
          expect(destination.service.command(start).replayed).toBe(true);
          expect(destination.service.getEntity('focusSession', id)!.revision).toBe(revision);
          const restored = destination.service.exportCheckpoint();
          const importTransaction = restored.transactions.find(
            (tx: any) => tx.importedTransactions?.length,
          ) as any;
          expect(importTransaction.importedTransactions).toEqual(original.transactions);
          for (const receipt of original.receipts)
            expect(destination.service.getReceipt(receipt.requestId)).toEqual(receipt);
        }
        const repeated = importer.applyImport({
          previewId: preview.id,
          requestId: 'restore-focus',
        });
        if (format === 'batched checkpoint') {
          expect(importer.importStatus(preview.id).status).toBe('completed');
          expect(repeated.transactionId).toBe(
            importer.importStatus(preview.id).result.transactionId,
          );
        } else expect(repeated.transactionId).toBe(applied.transactionId);
        expect(destination.service.getEntity('focusSession', id)!.revision).toBe(revision);
        expect(() =>
          destination.service.command({
            requestId: randomUUID(),
            action: 'start_focus',
            payload: { mode: 'stopwatch' },
          }),
        ).not.toThrow();
      } finally {
        await importer.close();
        await exporter.close();
      }
    },
  );

  it('round-trips versioned entities, tombstones and transaction receipts with an integrity inventory', () => {
    const state = snapshot();
    state.tasks.push(
      toDooEntitySchemas.task.parse({
        id: 'task-a',
        revision: 'r1',
        createdAt: state.now,
        updatedAt: state.now,
        deletedAt: state.now,
        title: 'Deleted task',
      }),
    );
    const receipt = { id: 'tx-1', requestId: 'r-1', members: [{ id: 'task-a' }] };
    const content = exportPortableJson(state, { transactions: [receipt] });
    const imported = validatePortableJson(content);
    expect(imported.entities.find((item) => item.kind === 'task')?.entity.deletedAt).toBe(
      state.now,
    );
    expect(imported.transactions).toEqual([receipt]);
    const altered = JSON.parse(content);
    altered.entities[0].entity.timeZone = 'Asia/Shanghai';
    expect(() => validatePortableJson(JSON.stringify(altered))).toThrow(/hash|integrity/i);
    const missing = JSON.parse(content);
    missing.entities.pop();
    expect(() => validatePortableJson(JSON.stringify(missing))).toThrow(
      /inventory|integrity|hash/i,
    );
  });
  it('maps quoted/multiline CSV fields and preserves unknown columns without guessing dates', () => {
    const result = parseTickTickCsv(
      '"Task ID","List Name","Title","Content","Due Date","Status","Mystery"\r\n"42","Work","Design, review","First\nSecond","2026-10-30","2","retained"\r\n',
      { timeZone: 'Asia/Shanghai' },
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceKey: '42',
      title: 'Design, review',
      description: 'First\nSecond',
      listName: 'Work',
      status: 'done',
      due: { date: '2026-10-30', time: null, timeZone: 'Asia/Shanghai' },
      unknown: { Mystery: 'retained' },
    });
    const uncertain = parseTickTickCsv('Title,Due Date\nTask,next banana', { timeZone: 'UTC' });
    expect(uncertain.items[0].due).toBeNull();
    expect(uncertain.warnings.join(' ')).toMatch(/date|日期/i);
  });
  it('rejects malformed CSV and unknown JSON protocol versions', () => {
    expect(() =>
      parseTickTickCsv('Title,Content\nTask,"unterminated', { timeZone: 'UTC' }),
    ).toThrow(/CSV/);
    const value = JSON.parse(exportPortableJson(snapshot()));
    value.version = 99;
    expect(() => validatePortableJson(JSON.stringify(value))).toThrow(/version/i);
  });
  it('imports a full checkpoint and preserves the original request receipt', async () => {
    const source = await domain(),
      destination = await domain();
    const request = {
      requestId: randomUUID(),
      action: 'create_task',
      payload: { title: 'Portable receipt' },
    };
    source.service.command(request);
    const exporter = createToDooInterop(source.service, {
      db: source.db,
      dataRoot: source.config.dataRoot,
    });
    const importer = createToDooInterop(destination.service, {
      db: destination.db,
      dataRoot: destination.config.dataRoot,
    });
    const preview = importer.previewImport({ format: 'json', content: exporter.exportJson() });
    importer.applyImport({ previewId: preview.id, requestId: 'full-import' });
    expect(destination.service.command(request).replayed).toBe(true);
    expect(destination.service.snapshot({ all: true }).tasks).toHaveLength(1);
  });
  it('deduplicates a repeated CSV import and a retried apply after domain persistence', async () => {
    const f = await domain();
    const interop = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot });
    const input = {
      format: 'csv' as const,
      content: 'Task ID,List Name,Title,Status\n42,Work,One task,2',
      timeZone: 'UTC',
    };
    const preview = interop.previewImport(input);
    const result = interop.applyImport({ previewId: preview.id, requestId: 'csv-apply' });
    expect(
      interop.applyImport({ previewId: preview.id, requestId: 'csv-apply' }).transactionId,
    ).toBe(result.transactionId);
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
    expect(f.service.snapshot({ all: true }).occurrences).toHaveLength(1);
    const repeat = interop.previewImport(input);
    expect(repeat.duplicates).toBeGreaterThan(0);
    interop.applyImport({ previewId: repeat.id, requestId: 'csv-again' });
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
  });
  it('retains external snapshots on failed refresh and revokes independent private-feed tokens', async () => {
    const f = await domain();
    let failed = false;
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => ({
        status: failed ? 500 : 200,
        headers: {},
        body: Buffer.from(
          'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event-one\r\nDTSTART:20261029T090000Z\r\nSUMMARY:Meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
        ),
      }),
    });
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      network,
    });
    const connection = await interop.connectCalendar({
      name: 'Remote',
      url: 'https://calendar.example/private-token',
    });
    failed = true;
    await expect(interop.refreshCalendar(connection.sourceId)).rejects.toThrow(/retained/);
    expect(
      f.service.snapshot({ all: true }).calendarEvents.filter((e) => !e.deletedAt),
    ).toHaveLength(1);
    const feed = interop.createFeed({ name: 'Private' });
    expect(interop.readFeed(feed.token)).toContain('Meeting');
    interop.revokeFeed(feed.id);
    expect(() => interop.readFeed(feed.token)).toThrow(/not found/);
    expect(JSON.stringify(interop.connections())).not.toContain('private-token');
    expect(interop.exportJson()).not.toContain('https://calendar.example');
  });
  it('stores an external recurring master and independently addressed visible occurrences', async () => {
    const f = await domain();
    const content =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:weekly\r\nDTSTART:20261029T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Weekly\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      now: () => new Date('2026-10-29T00:00:00Z'),
    });
    const preview = interop.previewImport({ format: 'ics', content, timeZone: 'UTC' });
    interop.applyImport({ previewId: preview.id, requestId: 'repeat-ics' });
    const events = f.service.snapshot({ all: true }).calendarEvents;
    expect(events.filter((e) => e.seriesMaster)).toHaveLength(1);
    expect(events.filter((e) => !e.seriesMaster)).toHaveLength(3);
    expect(new Set(events.map((e) => e.id)).size).toBe(4);
    expect(interop.exportIcs().match(/BEGIN:VEVENT/g) ?? []).toHaveLength(3);
  });
  it('pauses local calendar polling without deleting its snapshots', async () => {
    const f = await domain();
    let fetched = 0;
    const network = createToDooNetwork({
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      send: async () => {
        fetched++;
        return {
          status: 200,
          headers: {},
          body: Buffer.from('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'),
        };
      },
    });
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      network,
    });
    const { sourceId } = await interop.connectCalendar({
      name: 'Paused calendar',
      url: 'https://calendar.example/feed',
    });
    interop.pauseCalendar(sourceId, true);
    await interop.refreshConnectedCalendars();
    expect(fetched).toBe(1);
    expect(interop.connections()[0]).toMatchObject({ status: 'paused' });
    interop.pauseCalendar(sourceId, false);
    await interop.refreshConnectedCalendars();
    expect(fetched).toBe(2);
    interop.close();
  });
  it('maps a supported ICS series to a task with original-period occurrence identities', async () => {
    const f = await domain();
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      now: () => new Date('2026-10-29T00:00:00Z'),
    });
    const content =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:task-repeat\r\nDTSTART:20261029T090000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3;BYDAY=TH\r\nEXDATE:20261105T090000Z\r\nSUMMARY:Practice\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:task-repeat\r\nRECURRENCE-ID:20261112T090000Z\r\nDTSTART:20261112T110000Z\r\nSUMMARY:Moved practice\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const preview = interop.previewImport({
      format: 'ics',
      target: 'tasks',
      content,
      timeZone: 'UTC',
    });
    interop.applyImport({ previewId: preview.id, requestId: 'tasks-series' });
    const state = f.service.snapshot({ all: true });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].recurrence).toMatchObject({
      frequency: 'weekly',
      weekdays: [4],
      shortMonth: 'skip',
      excludedDates: ['2026-11-05'],
    });
    expect(state.occurrences).toHaveLength(2);
    expect(state.occurrences.find((o) => o.due?.date === '2026-11-12')?.due?.time).toBe('11:00');
    expect(state.occurrences.find((o) => o.due?.date === '2026-11-12')?.cycleKey).toContain(
      '2026-11-12',
    );
  });
  it('recovers an apply whose portable commit succeeded before its local receipt was saved', async () => {
    const f = await domain();
    const interop = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot });
    const preview = interop.previewImport({
      format: 'csv',
      content: 'Task ID,Title\n42,Recover',
      timeZone: 'UTC',
    });
    const first = interop.applyImport({ previewId: preview.id, requestId: 'crash-gap' });
    f.db
      .prepare('UPDATE to_doo_import_previews SET applied_result=NULL WHERE id=?')
      .run(preview.id);
    const replay = interop.applyImport({ previewId: preview.id, requestId: 'crash-gap' });
    expect(replay.transactionId).toBe(first.transactionId);
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
  });
  it('persists large-import progress and honors cancellation between explicit batches', async () => {
    const f = await domain();
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      importBatchSize: 4,
    });
    const preview = interop.previewImport({
      format: 'csv',
      content: 'Task ID,Title\n1,One\n2,Two\n3,Three',
      timeZone: 'UTC',
    });
    const queued = interop.applyImport({ previewId: preview.id, requestId: 'batched-import' });
    expect(queued).toMatchObject({ jobId: preview.id, status: 'queued' });
    interop.cancelImport(preview.id);
    await interop.processImportJobs();
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(0);
    expect(interop.importStatus(preview.id)).toMatchObject({ status: 'cancelled', completed: 0 });
    interop.resumeImport(preview.id);
    await interop.processImportJobs();
    expect(interop.importStatus(preview.id)).toMatchObject({
      status: 'completed',
      completed: preview.items.length,
    });
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(3);
    await interop.close();
  });
  it('maps an explicit CSV recurrence and rejects colliding source identities', async () => {
    const f = await domain();
    const interop = createToDooInterop(f.service, {
      db: f.db,
      dataRoot: f.config.dataRoot,
      now: () => new Date('2026-10-29T00:00:00Z'),
    });
    const preview = interop.previewImport({
      format: 'csv',
      content: 'Task ID,Title,Due Date,Repeat\n42,Daily practice,2026-10-29,FREQ=DAILY;COUNT=3',
      timeZone: 'UTC',
    });
    interop.applyImport({ previewId: preview.id, requestId: 'csv-repeat' });
    expect(f.service.snapshot({ all: true }).tasks[0].recurrence?.frequency).toBe('daily');
    expect(f.service.snapshot({ all: true }).occurrences).toHaveLength(3);
    expect(() =>
      interop.previewImport({
        format: 'csv',
        content: 'Task ID,Title\n99,First\n99,Different',
        timeZone: 'UTC',
      }),
    ).toThrow(/duplicate|identity/i);
  });
  it('previews a stable-ID update with field differences and refuses a stale confirmation', async () => {
    const f = await domain(),
      interop = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot });
    const original = interop.previewImport({
      format: 'csv',
      content: 'Task ID,Title\n42,Original',
      timeZone: 'UTC',
    });
    interop.applyImport({ previewId: original.id, requestId: 'update-original' });
    const before = f.service.snapshot({ all: true }).tasks[0];
    const input = {
      format: 'csv' as const,
      content: 'Task ID,Title\n42,Imported change',
      timeZone: 'UTC',
      mergeMode: 'update' as const,
    };
    const preview = interop.previewImport(input);
    expect(preview.changes.find((change) => change.kind === 'task')).toMatchObject({
      id: before.id,
      expectedRevision: before.revision,
      diff: [{ field: 'title', before: 'Original', after: 'Imported change' }],
    });
    f.service.command({
      requestId: 'manual-between-preview',
      action: 'update_task',
      payload: { id: before.id, expectedRevision: before.revision, patch: { title: 'User edit' } },
    });
    expect(() => interop.applyImport({ previewId: preview.id, requestId: 'stale-update' })).toThrow(
      /stale|变化/i,
    );
    expect(f.service.snapshot({ all: true }).tasks[0].title).toBe('User edit');
    const refreshed = interop.previewImport(input);
    interop.applyImport({ previewId: refreshed.id, requestId: 'confirmed-update' });
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(1);
    expect(f.service.snapshot({ all: true }).tasks[0].title).toBe('Imported change');
  });
  it('copies a source under a preview-stable job identity and does not guess updates without external IDs', async () => {
    const f = await domain(),
      interop = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot });
    const input = {
      format: 'csv' as const,
      content: 'Title,Content\nSame title,Original',
      timeZone: 'UTC',
    };
    const first = interop.previewImport(input);
    interop.applyImport({ previewId: first.id, requestId: 'copy-original' });
    const uncertain = interop.previewImport({
      ...input,
      content: 'Title,Content\nSame title,Changed',
      mergeMode: 'update',
    });
    expect(uncertain.warnings.join(' ')).toMatch(/stable|external|identity/i);
    expect(uncertain.items.filter((item) => item.kind === 'task')).toHaveLength(0);
    const copy = interop.previewImport({ ...input, mergeMode: 'copy' });
    expect(copy.copyJobId).toBeTruthy();
    const result = interop.applyImport({ previewId: copy.id, requestId: 'copy-confirm' });
    expect(
      interop.applyImport({ previewId: copy.id, requestId: 'copy-confirm' }).transactionId,
    ).toBe(result.transactionId);
    expect(f.service.snapshot({ all: true }).tasks).toHaveLength(2);
    expect(
      new Set(f.service.snapshot({ all: true }).occurrences.map((item) => item.taskId)).size,
    ).toBe(2);
  });
  it('copies full JSON relationships without importing original request receipts into the copies', async () => {
    const f = await domain(),
      g = await domain();
    const task = f.service.command({
      requestId: 'json-copy-original',
      action: 'create_task',
      payload: { title: 'Parent' },
    }).ids[0];
    f.service.command({
      requestId: 'json-copy-child',
      action: 'create_task',
      payload: { title: 'Child', parentTaskId: task },
    });
    const source = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot }),
      target = createToDooInterop(g.service, { db: g.db, dataRoot: g.config.dataRoot });
    const preview = target.previewImport({
      format: 'json',
      content: source.exportJson(),
      mergeMode: 'copy',
    });
    target.applyImport({ previewId: preview.id, requestId: 'json-copy-confirm' });
    const state = g.service.snapshot({ all: true });
    expect(state.tasks).toHaveLength(2);
    const parent = state.tasks.find((t) => t.title === 'Parent')!;
    expect(parent.id).not.toBe(task);
    expect(state.tasks.find((t) => t.title === 'Child')?.parentTaskId).toBe(parent.id);
    expect(state.occurrences.every((o) => state.tasks.some((t) => t.id === o.taskId))).toBe(true);
    expect(g.service.getReceipt('json-copy-original')).toBeUndefined();
    g.service.command({
      requestId: 'copy-re-materialize',
      action: 'materialize_occurrences',
      payload: { taskId: parent.id, from: '2026-10-29', to: '2026-10-29' },
    });
    expect(g.service.snapshot({ all: true }).occurrences).toHaveLength(2);
  });
  it('applies an explicit full-JSON update and matches ICS updates only by source and UID', async () => {
    const f = await domain(),
      g = await domain(),
      source = createToDooInterop(f.service, { db: f.db, dataRoot: f.config.dataRoot }),
      target = createToDooInterop(g.service, { db: g.db, dataRoot: g.config.dataRoot });
    const created = f.service.command({
      requestId: 'json-update-original',
      action: 'create_task',
      payload: { title: 'Before' },
    });
    const first = target.previewImport({ format: 'json', content: source.exportJson() });
    target.applyImport({ previewId: first.id, requestId: 'json-initial' });
    const original = f.service.snapshot({ all: true }).tasks[0];
    f.service.command({
      requestId: 'json-update-new',
      action: 'update_task',
      payload: { id: original.id, expectedRevision: original.revision, patch: { title: 'After' } },
    });
    const updated = target.previewImport({
      format: 'json',
      content: source.exportJson(),
      mergeMode: 'update',
    });
    expect(updated.changes.find((change) => change.kind === 'task')?.diff).toContainEqual({
      field: 'title',
      before: 'Before',
      after: 'After',
    });
    target.applyImport({ previewId: updated.id, requestId: 'json-update-confirm' });
    expect(g.service.snapshot({ all: true }).tasks).toHaveLength(1);
    expect(g.service.getEntity('task', created.ids[0])).toMatchObject({ title: 'After' });
    const calendar = (title: string, time: string) =>
      `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:stable-uid\r\nDTSTART:20261029T${time}0000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const initial = target.previewImport({
      format: 'ics',
      sourceId: 'stable-source',
      content: calendar('First event', '09'),
      timeZone: 'UTC',
    });
    target.applyImport({ previewId: initial.id, requestId: 'ics-first' });
    const event = g.service.snapshot({ all: true }).calendarEvents[0];
    const next = target.previewImport({
      format: 'ics',
      sourceId: 'stable-source',
      content: calendar('Changed event', '11'),
      timeZone: 'UTC',
      mergeMode: 'update',
    });
    expect(next.changes.find((change) => change.kind === 'calendarEvent')).toMatchObject({
      id: event.id,
      expectedRevision: event.revision,
    });
    target.applyImport({ previewId: next.id, requestId: 'ics-update' });
    expect(g.service.snapshot({ all: true }).calendarEvents).toHaveLength(1);
    expect(g.service.snapshot({ all: true }).calendarEvents[0].start.time).toBe('11:00');
  });
});
