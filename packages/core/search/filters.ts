import type { Principal, SearchInput } from '../../../shared/knowledge-contracts.js';
import { pathFilter } from '../indexing/text.js';
import { validateRelative, categories } from '../files.js';
import { fail } from '../knowledge/errors.js';
export function validateFilters(filters: SearchInput['filters']) {
  if (filters == null) return;
  if (typeof filters !== 'object' || Array.isArray(filters)) fail(400, 'INVALID_FILTER');
  if (filters.directory != null) {
    try {
      validateRelative(filters.directory, 'folder');
    } catch {
      fail(400, 'INVALID_FILTER');
    }
  }
  if (filters.category != null && !categories.includes(filters.category))
    fail(400, 'INVALID_FILTER');
  if (
    filters.updatedAfter != null &&
    (typeof filters.updatedAfter !== 'string' || !Number.isFinite(Date.parse(filters.updatedAfter)))
  )
    fail(400, 'INVALID_FILTER');
  if (
    filters.tags != null &&
    (!Array.isArray(filters.tags) ||
      filters.tags.length > 16 ||
      filters.tags.some(
        (tag) => typeof tag !== 'string' || !tag.trim() || Buffer.byteLength(tag) > 128,
      ))
  )
    fail(400, 'INVALID_FILTER');
}
export function recallFilter(p: Principal, filters: SearchInput['filters'], column = 'c.path') {
  const path = pathFilter(p, column),
    clauses = [`(${path.sql})`],
    values: (string | number)[] = [...path.values];
  for (const prefix of [filters?.directory, filters?.category])
    if (prefix) {
      const part = pathFilter({ ...p, allowedPrefixes: [prefix] }, column);
      clauses.push(`(${part.sql})`);
      values.push(...part.values);
    }
  if (filters?.updatedAfter) {
    clauses.push('CAST(d.mtime_ns AS REAL)>?');
    values.push(Date.parse(filters.updatedAfter) * 1e6);
  }
  for (const tag of filters?.tags || []) {
    clauses.push(
      'EXISTS(SELECT 1 FROM note_tags t WHERE t.note_id=d.note_id AND t.source_revision=d.source_revision AND t.tag=?)',
    );
    values.push(tag.trim().toLowerCase());
  }
  return { sql: clauses.join(' AND '), values };
}
