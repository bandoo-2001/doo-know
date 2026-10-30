import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../packages/core/db';
import {
  getToDooInstallationId,
  resetToDooLocalConnections,
} from '../apps/server/to-doo/installation';

it('preserves identity on restart but resets external activation on a restored copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'to-doo-installation-'));
  const db = openDatabase(root);
  try {
    const before = getToDooInstallationId(db);
    expect(getToDooInstallationId(db)).toBe(before);
    for (const name of [
      'to_doo_push_config',
      'to_doo_push_devices',
      'to_doo_push_outbox',
      'to_doo_push_seen',
      'to_doo_reminder_actions',
      'to_doo_reminder_event_actions',
      'to_doo_feed_tokens',
      'to_doo_calendar_connections',
      'to_doo_import_previews',
      'to_doo_import_jobs',
      'todo_instance_state',
    ]) {
      db.exec(`CREATE TABLE ${name}(id TEXT); INSERT INTO ${name} VALUES('local-activation')`);
    }
    db.exec("CREATE TABLE todo_entities(id TEXT); INSERT INTO todo_entities VALUES('user-task')");
    resetToDooLocalConnections(db);
    expect(getToDooInstallationId(db)).not.toBe(before);
    expect((db.prepare('SELECT COUNT(*) n FROM to_doo_push_devices').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM to_doo_reminder_actions').get() as any).n).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) n FROM to_doo_reminder_event_actions').get() as any).n,
    ).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM to_doo_feed_tokens').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM to_doo_calendar_connections').get() as any).n).toBe(
      0,
    );
    expect((db.prepare('SELECT COUNT(*) n FROM todo_instance_state').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM todo_entities').get() as any).n).toBe(1);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
