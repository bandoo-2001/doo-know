import type { AppDatabase } from '../db.js';
export function folderRestorePending(db: AppDatabase) {
  return (
    !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='folder_native_restore_plans'").get() &&
    !!db
      .prepare(
        "SELECT 1 FROM folder_trash f JOIN folder_native_restore_plans p ON p.operation_id=f.operation_id WHERE f.state='restoring' LIMIT 1",
      )
      .get()
  );
}
