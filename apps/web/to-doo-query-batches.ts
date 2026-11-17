export const toDooQueryValueLimit = 8192;
export const toDooQueryUrlLimit = 8192;
export const toDooQueryCursorReserve = 2048 + '&cursor='.length;
type IdField = 'ids' | 'taskIds' | 'listIds';
type QueryBudget = { field?: IdField; origin?: string; reserve?: number };

function queryOrigin(origin?: string) {
  return origin ?? (typeof location === 'undefined' ? 'http://localhost:3010' : location.origin);
}
export function checkedToDooQueryUrl(url: string, options: QueryBudget = {}) {
  const parsed = new URL(url, queryOrigin(options.origin));
  if (parsed.href.length + (options.reserve ?? 0) > toDooQueryUrlLimit)
    throw Error('任务查询范围过大，请减少本次选择后重试');
  for (const field of ['ids', 'taskIds', 'listIds'] as const) {
    const csv = parsed.searchParams.get(field);
    if (csv !== null && (csv.length > toDooQueryValueLimit || encodeURIComponent(csv).length > toDooQueryUrlLimit))
      throw Error('任务查询范围过大，请减少本次选择后重试');
  }
  return url;
}

/** Keep each CSV within both the decoded API contract and the actual encoded URL. */
export function toDooIdQueryBatches<T>(
  values: readonly T[],
  identify: (value: T) => string,
  makeUrl: (ids: string[]) => string,
  options: QueryBudget & { maxCount: number },
) {
  if (!Number.isInteger(options.maxCount) || options.maxCount < 1 || options.maxCount > 1000)
    throw Error('任务查询批次无效');
  const batches: { values: T[]; url: string }[] = [];
  let pending: T[] = [];
  const build = (part: T[]) => {
    const ids = part.map(identify);
    if (ids.some(id => !id || id.includes(','))) throw Error('任务标识无效');
    const url = makeUrl(ids);
    const parsed = new URL(url, queryOrigin(options.origin));
    if (parsed.searchParams.get(options.field ?? 'ids') !== ids.join(','))
      throw Error('任务查询标识不完整');
    return { values: part, url };
  };
  const fits = (batch: { url: string }) => {
    try { checkedToDooQueryUrl(batch.url, options); return true; }
    catch { return false; }
  };
  for (const value of values) {
    const candidate = build([...pending, value]);
    if (candidate.values.length <= options.maxCount && fits(candidate)) {
      pending = candidate.values;
      continue;
    }
    if (!pending.length) throw Error('任务查询范围过大，请减少本次选择后重试');
    batches.push(build(pending));
    pending = [value];
    const single = build(pending);
    if (!fits(single)) throw Error('任务查询范围过大，请减少本次选择后重试');
  }
  if (pending.length) batches.push(build(pending));
  return batches;
}
