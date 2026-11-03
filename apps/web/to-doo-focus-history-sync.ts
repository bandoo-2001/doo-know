import type { ToDooEntityMap, ToDooFocusHistory } from '../../shared/to-doo-contracts';

type Session = ToDooEntityMap['focusSession'];
const key = (row: Session) => new Date(row.segments[0]?.start ?? row.createdAt).toISOString();
const compare = (a: Session, b: Session) =>
  key(b).localeCompare(key(a)) || b.id.localeCompare(a.id);
export type FocusHistoryScan = {
  base: ToDooFocusHistory;
  revision: string;
  datasetId: string;
  rows: Session[];
  cursor: string;
};

/** Re-read a bounded, contiguous range before inferring that a loaded row disappeared. */
export async function reconcileFocusHistory(
  old: ToDooFocusHistory,
  head: ToDooFocusHistory,
  read: (cursor: string) => Promise<ToDooFocusHistory>,
  pending?: FocusHistoryScan,
  pageBudget = 20,
  queryChanged = false,
): Promise<{ history: ToDooFocusHistory; pending?: FocusHistoryScan }> {
  if (head.datasetId !== old.datasetId) return { history: head };
  if (!queryChanged && !pending && old.revision === head.revision) {
    const latest = new Map(head.items.map((row) => [row.id, row]));
    return {
      history: {
        ...head,
        items: old.items.map((row) => latest.get(row.id) ?? row),
        page: { ...old.page, total: head.page.total },
      },
    };
  }
  const resume =
    !queryChanged && pending?.revision === head.revision && pending.datasetId === head.datasetId
      ? pending
      : undefined;
  const base = resume?.base ?? old;
  const rows = resume ? [...resume.rows] : [...head.items];
  let page = head;
  let cursor = resume?.cursor ?? head.page.nextCursor;
  const tail = base.items.at(-1);
  const covered = () =>
    !base.page.hasMore || !tail
      ? !cursor
      : !cursor || (!!rows.at(-1) && compare(rows.at(-1)!, tail) >= 0);
  let requests = 1; // The freshly requested head also counts toward this pass.
  while (!covered() && cursor && requests < pageBudget) {
    page = await read(cursor);
    // Do not combine pages from different datasets or mutations during the scan.
    if (page.datasetId !== head.datasetId || page.revision !== head.revision)
      throw new Error('专注记录正在更新，将在下次同步时重试');
    rows.push(...page.items);
    if (page.page.nextCursor === cursor) throw new Error('专注分页未前进，请重试同步');
    cursor = page.page.nextCursor;
    requests++;
  }
  const complete = covered();
  const scannedTail = rows.at(-1);
  const latest = new Map(rows.map((row) => [row.id, row]));
  // Absence proves removal only inside the contiguous range we actually scanned.
  const retained =
    cursor && scannedTail
      ? base.items.filter((row) => compare(row, scannedTail) > 0 && !latest.has(row.id))
      : [];
  const items = [...latest.values(), ...retained].sort(compare);
  return {
    history: {
      ...head,
      items,
      page: complete
        ? { ...page.page, total: head.page.total }
        : { ...base.page, total: head.page.total },
    },
    pending:
      !complete && cursor
        ? { base, rows, cursor, revision: head.revision, datasetId: head.datasetId }
        : undefined,
  };
}
