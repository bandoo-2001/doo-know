import { randomUUID } from 'node:crypto';
import { realpathSync, lstatSync } from 'node:fs';
import type { AppDatabase } from '../../../packages/core/db.js';
import { platformSettings } from './settings.js';
import {
  invalidateRemoteAuth,
  remoteAuthGeneration,
} from '../../../packages/core/auth/remote-auth.js';
import type { AppConfig } from '../../../shared/contracts.js';
export function resetRestoredState(
  db: AppDatabase,
  config: AppConfig,
  floors: { generation?: number; cutoff?: number } = {},
) {
  platformSettings(config, db);
  db.pragma('foreign_keys=ON');
  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(
      (r) => r.name,
    ),
  );
  const value = (key: string) =>
    (db.prepare('SELECT value FROM index_meta WHERE key=?').get(key) as any)?.value;
  const generation = Math.max(remoteAuthGeneration(db), floors.generation || 0),
    cutoff = Math.max(Number(value('remote_auth_not_before') || 0), floors.cutoff || 0),
    space = value('desired_embedding_space');
  db.transaction(() => {
    if (tables.has('session')) db.prepare('DELETE FROM session').run();
    db.prepare('UPDATE shares SET enabled=0').run();
    db.prepare('UPDATE maintenance SET active=0 WHERE id=1').run();
    for (const name of ['oauthAccessToken', 'oauthRefreshToken', 'oauthConsent', 'verification'])
      if (tables.has(name)) db.exec(`DELETE FROM "${name}"`);
    for (const name of [
      'read_sessions',
      'read_pages',
      'snapshot_offsets',
      'outline_offsets',
      'read_snapshots',
      'read_rates',
      'read_leases',
      'chunks_fts',
      'chunk_terms',
      'chunks',
      'vector_rows',
      'generation_segments',
      'vector_segment_rows',
      'vector_segments',
      'vector_generations',
      'vector_cache',
      'index_jobs',
      'note_write_leases',
      'sync_runs',
      'workspace_guards',
      'workspace_gate',
      'search_processes',
      'search_runtime',
      'database_processes',
      'platform_instance',
      // Managed artifacts and recovery keys live outside the snapshot. Their
      // old job payloads and downloadable records do not belong to this copy.
      'managed_transfer_backups',
      'managed_transfer_jobs',
      'managed_key_attempts',
    ])
      if (tables.has(name)) db.exec(`DELETE FROM "${name}"`);
    if (tables.has('write_intents')) {
      db.prepare(
        "UPDATE operations SET status='needs_reconciliation',error='RESTORED_PENDING_WRITE' WHERE id IN (SELECT id FROM write_intents WHERE status='prepared')",
      ).run();
      db.prepare("UPDATE write_intents SET status='conflicted' WHERE status='prepared'").run();
    }
    if (tables.has('file_operations')) {
      db.prepare(
        "UPDATE operations SET status='needs_reconciliation',error='RESTORED_PENDING_TASK' WHERE id IN (SELECT id FROM file_operations WHERE status IN ('queued','running','committing'))",
      ).run();
      db.prepare(
        "UPDATE file_operations SET status='needs_reconciliation',error='RESTORED_PENDING_TASK',snapshot_ref_released=1 WHERE status IN ('queued','running','committing')",
      ).run();
    }
    if (tables.has('search_preparations')) {
      db.prepare(
        "UPDATE operations SET status='failed',error='RESTORED_PREPARATION_INTERRUPTED' WHERE id IN (SELECT id FROM search_preparations WHERE state IN ('queued','running'))",
      ).run();
      db.prepare(
        "UPDATE search_preparations SET state='failed',phase='interrupted',error='RESTORED_PREPARATION_INTERRUPTED',runner_pid=NULL,runner_start=NULL WHERE state IN ('queued','running')",
      ).run();
    }
    if (tables.has('platform_plugins'))
      db.prepare(
        "UPDATE platform_plugins SET state='disabled',desired_enabled=0,active_version=NULL,restart_required=0,error=NULL",
      ).run();
    if (tables.has('plugin_operation_intents'))
      db.prepare(
        "UPDATE plugin_operation_intents SET details=json_set(details,'$.phase','needs_reconciliation') WHERE plugin_id='git' AND json_extract(details,'$.phase') NOT IN ('finished','acknowledged','aborted')",
      ).run();
    if (tables.has('document_state'))
      db.prepare(
        'UPDATE document_state SET content_hash=NULL,text_indexed_hash=NULL,vector_indexed_hash=NULL,longest_line_bytes=NULL,title=NULL,last_checked_at=NULL,source_revision=source_revision+1,conflict=0',
      ).run();
    db.prepare('DELETE FROM index_meta').run();
    db.prepare("INSERT INTO index_meta VALUES('remote_auth_generation',?)").run(String(generation));
    db.prepare("INSERT INTO index_meta VALUES('remote_auth_not_before',?)").run(
      String(Math.max(cutoff, Math.floor(Date.now() / 1000))),
    );
    if (space) db.prepare("INSERT INTO index_meta VALUES('desired_embedding_space',?)").run(space);
    invalidateRemoteAuth(db);
    const root = realpathSync(config.knowledgeRoot),
      st = lstatSync(root, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error('恢复根目录不可用');
    db.prepare("INSERT INTO index_meta VALUES('root_identity',?)").run(
      JSON.stringify({ path: root, dev: String(st.dev), ino: String(st.ino) }),
    );
    const previous = db.prepare('SELECT * FROM platform_settings WHERE id=1').get() as any,
      id = randomUUID(),
      now = Date.now();
    db.prepare(
      "INSERT INTO operations(id,principal,client_id,kind,request_id,params_hash,status,result,created_at,updated_at) VALUES(?,?,?,?,?,?,'succeeded',?,?,?)",
    ).run(
      id,
      'system:restore',
      'platform-restore',
      'restore_binding',
      id,
      'restore',
      JSON.stringify({ knowledgeRoot: root }),
      now,
      now,
    );
    db.prepare(
      'INSERT INTO platform_settings(id,knowledge_root,time_zone,configured_at,binding_version,setup_operation_id,onboarding_completed_at) VALUES(1,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET knowledge_root=excluded.knowledge_root,binding_version=excluded.binding_version,setup_operation_id=excluded.setup_operation_id',
    ).run(
      root,
      previous?.time_zone || 'Asia/Shanghai',
      previous?.configured_at || now,
      (previous?.binding_version || 0) + 1,
      id,
      previous?.onboarding_completed_at || now,
    );
  }).immediate();
  if (
    db.pragma('integrity_check', { simple: true }) !== 'ok' ||
    (db.pragma('foreign_key_check') as any[]).length
  )
    throw Error('恢复数据库一致性校验失败');
}
