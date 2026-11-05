import type { APIRequestContext, Page, Route } from '@playwright/test';

type Lifecycle = { controller: AbortController; cleanup: (() => void | Promise<unknown>)[]; promise?: Promise<unknown> };
const lifecycles = new WeakMap<Page, Lifecycle>();
export function startSceneLifecycle(page: Page) {
  const value: Lifecycle = { controller: new AbortController(), cleanup: [] };
  lifecycles.set(page, value); return value.controller.signal;
}
export function registerSceneCleanup(page: Page, cleanup: () => void | Promise<unknown>) {
  const value = lifecycles.get(page);
  if (!value) throw Error('Runtime recipe requires the runner scene lifecycle');
  if (value.controller.signal.aborted) throw Error('Scene already cancelled; no new gate may be registered');
  value.cleanup.push(cleanup);
}
export function assertSceneActive(page: Page) {
  const signal = lifecycles.get(page)?.controller.signal;
  if (signal?.aborted) throw Error('SCENE_CANCELLED: ' + String(signal.reason));
}
export async function releaseScene(page: Page, reason: string) {
  const value = lifecycles.get(page);
  if (!value) return { releasedGates: 0, errors: [] as string[] };
  if (!value.promise) value.promise = (async () => {
    value.controller.abort(reason);
    const callbacks = value.cleanup.splice(0).reverse();
    const results = await Promise.allSettled(callbacks.map(cleanup => Promise.resolve().then(cleanup)));
    return { releasedGates: callbacks.length, errors: results.filter(result => result.status === 'rejected').map(result => String((result as PromiseRejectedResult).reason)) };
  })();
  return value.promise as Promise<{ releasedGates: number; errors: string[] }>;
}
/** A held route is explicitly aborted during normal/budget cleanup, never left forever pending. */
export async function holdRouteUntilCleanup(route: Route) {
  const page = route.request().frame().page();
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  registerSceneCleanup(page, release);
  await pending;
  await route.abort('aborted').catch(() => undefined);
}
export function boundAPIRequests(request: APIRequestContext, timeout: number) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch'] as const) {
    const actual = request[method].bind(request) as (url: string, options?: Record<string, unknown>) => Promise<unknown>;
    (request as any)[method] = (url: string, options: Record<string, unknown> = {}) => actual(url, { ...options, timeout: Math.min(Number(options.timeout) || timeout, timeout) });
  }
}
export async function bounded<T>(label: string, work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(Error(label + ' exceeded ' + milliseconds + 'ms')), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export async function runSceneBudget<T>(work: () => Promise<T>, milliseconds: number, cleanup: () => Promise<unknown>, drainMilliseconds: number) {
  const pending = work();
  try { return await bounded('SCENE_BUDGET', pending, milliseconds); }
  catch (error) {
    if (String(error).includes('SCENE_BUDGET')) {
      await cleanup();
      // Actual cleanup releases gates and closes contexts before we wait for
      // callbacks to settle. We do not continue with a live mutating recipe.
      await bounded('SCENE_CALLBACK_DRAIN', pending.then(() => undefined, () => undefined), drainMilliseconds);
    }
    throw error;
  }
}
