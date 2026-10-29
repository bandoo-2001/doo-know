import { watch } from 'node:fs';
import type { AppConfig } from '../../../shared/contracts.js';
import type { AppDatabase } from '../db.js';
import type { reconcileService } from './reconcile.js';
export function startWatcher(
  config: AppConfig,
  db: AppDatabase,
  indexing: ReturnType<typeof reconcileService>,
) {
  let stopped = false,
    running = false,
    pending = false,
    full = false,
    debounce: ReturnType<typeof setTimeout> | undefined;
  const drain = async () => {
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !stopped) {
        const hash = full;
        pending = false;
        full = false;
        if (
          db
            .prepare("SELECT 1 FROM sync_runs WHERE status IN ('running','needs_reconciliation')")
            .get()
        )
          continue;
        await indexing.reconcile(undefined, hash).catch(() => {});
      }
    } finally {
      running = false;
    }
  };
  const schedule = (hash: boolean) => {
    pending = true;
    full = full || hash;
    void drain();
  };
  let watcher: ReturnType<typeof watch> | undefined;
  if (config.indexing?.watch !== false) {
    try {
      watcher = watch(config.knowledgeRoot, { recursive: true }, (_event, name) => {
        const parts = String(name || '').split(/[\\/]/);
        if (
          parts[0] === '_data' ||
          parts[0] !== '.git' &&
          parts.some((p) => p.startsWith('.') || p === 'assets' || p.toLowerCase() === 'agents.md')
        )
          return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => schedule(true), 750);
        debounce.unref();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
      watcher.unref();
    } catch {}
  }
  const quick = setInterval(() => schedule(false), 60000),
    complete = setInterval(() => schedule(true), 300000);
  quick.unref();
  complete.unref();
  return () => {
    stopped = true;
    watcher?.close();
    if (debounce) clearTimeout(debounce);
    clearInterval(quick);
    clearInterval(complete);
  };
}
