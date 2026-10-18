export type WorkspaceRoute = {
  note?: string;
  line?: number;
  folder?: string;
  view?: 'trash' | 'settings';
  section?:
    | 'editor'
    | 'library'
    | 'account'
    | 'search'
    | 'plugins'
    | 'backup'
    | 'about'
    | 'maintenance';
};
export type WorkspaceNavigationState = { canBack: boolean; canForward: boolean };
export function readWorkspaceRoute(href = window.location.href): WorkspaceRoute {
  const url = new URL(href),
    query = url.searchParams;
  const parsed = Number(url.hash.match(/^#L([1-9]\d*)$/)?.[1]);
  return {
    ...(query.get('note') ? { note: query.get('note')! } : {}),
    ...(Number.isSafeInteger(parsed) && parsed <= 20 * 1024 * 1024 ? { line: parsed } : {}),
    ...(query.get('folder') ? { folder: query.get('folder')! } : {}),
    ...(query.get('view') === 'trash' || query.get('view') === 'settings'
      ? { view: query.get('view') as 'trash' | 'settings' }
      : {}),
    ...([
      'editor',
      'library',
      'account',
      'search',
      'plugins',
      'backup',
      'about',
      'maintenance',
    ].includes(query.get('section') || '')
      ? {
          section: (query.get('section') === 'maintenance'
            ? 'backup'
            : query.get('section')) as WorkspaceRoute['section'],
        }
      : {}),
  };
}
export function createWorkspaceNavigation(options: {
  dirty: () => boolean;
  canPreserveDraft?: (route: WorkspaceRoute) => boolean;
  guard: (apply: () => Promise<void>) => Promise<void>;
  apply: (route: WorkspaceRoute) => Promise<void>;
  error: (cause: unknown) => void;
  onState?: (state: WorkspaceNavigationState) => void;
}) {
  type Entry = { href: string; index: number };
  let generation = 0,
    replaying: { target: Entry; generation: number } | undefined;
  let undoing: { target: Entry; done: () => void; promise: Promise<void> } | undefined;
  let pendingCommit: { route: WorkspaceRoute; replace: boolean } | undefined;
  let disposed = false;
  let active = { href: location.href, index: Number(history.state?.dooknowIndex) || 0 };
  let furthestIndex = active.index;
  function notify() {
    options.onState?.({ canBack: active.index > 0, canForward: active.index < furthestIndex });
  }
  history.replaceState({ ...history.state, dooknowIndex: active.index }, '', active.href);
  notify();
  function commit(route: WorkspaceRoute, replace = false) {
    if (disposed) return;
    if (undoing) {
      generation++;
      pendingCommit = { route, replace };
      return;
    }
    const url = new URL(location.href);
    for (const key of ['note', 'folder', 'view', 'section']) url.searchParams.delete(key);
    if (route.note) url.searchParams.set('note', route.note);
    if (route.folder) url.searchParams.set('folder', route.folder);
    if (route.view) url.searchParams.set('view', route.view);
    if (route.section) url.searchParams.set('section', route.section);
    url.hash = route.line ? 'L' + route.line : '';
    if (url.href === active.href) return;
    generation++;
    const index = replace ? active.index : active.index + 1;
    history[replace ? 'replaceState' : 'pushState'](
      { ...history.state, dooknowIndex: index },
      '',
      url.href,
    );
    active = { href: url.href, index };
    if (!replace) furthestIndex = index;
    notify();
  }
  function restoreHistory(from: Entry): Promise<void> {
    if (undoing) return undoing.promise;
    const delta = active.index - from.index;
    if (!delta) {
      history.replaceState({ ...history.state, dooknowIndex: active.index }, '', active.href);
      return Promise.resolve();
    }
    let done!: () => void;
    const promise = new Promise<void>((resolve) => {
      done = resolve;
    });
    undoing = { target: { ...active }, done, promise };
    // Restore the browser's actual pointer. Replacing the failed entry with
    // active.index would make future index differences disagree with distances.
    history.go(delta);
    return promise;
  }
  async function apply(target: Entry) {
    if (disposed) return;
    const current = ++generation;
    try {
      await options.apply(readWorkspaceRoute(target.href));
      if (current === generation) {
        active = target;
        furthestIndex = Math.max(furthestIndex, target.index);
        notify();
      }
    } catch (cause) {
      if (current !== generation) return;
      void restoreHistory(target);
      options.error(cause);
    }
  }
  function pop(event: PopStateEvent) {
    const target = { href: location.href, index: Number(event.state?.dooknowIndex) || 0 };
    if (undoing) {
      const restoration = undoing;
      if (target.index !== restoration.target.index || target.href !== restoration.target.href) {
        const delta = restoration.target.index - target.index;
        if (delta) history.go(delta);
        return;
      }
      undoing = undefined;
      restoration.done();
      if (pendingCommit) {
        const pending = pendingCommit;
        pendingCommit = undefined;
        commit(pending.route, pending.replace);
      }
      return;
    }
    if (replaying) {
      const replay = replaying;
      replaying = undefined;
      if (
        replay.generation === generation &&
        replay.target.href === target.href &&
        replay.target.index === target.index
      )
        void apply(target);
      else void restoreHistory(target);
      return;
    }
    if (options.dirty() && !options.canPreserveDraft?.(readWorkspaceRoute(target.href))) {
      const current = ++generation;
      const delta = active.index - target.index;
      const restored = restoreHistory(target);
      void options.guard(async () => {
        await restored;
        if (current !== generation) return;
        if (delta) {
          replaying = { target, generation: current };
          history.go(-delta);
        } else {
          await apply(target);
          history.replaceState({ ...history.state, dooknowIndex: target.index }, '', target.href);
        }
      });
    } else void apply(target);
  }
  window.addEventListener('popstate', pop);
  return {
    commit,
    currentRoute: () => readWorkspaceRoute(active.href),
    back() {
      if (active.index > 0 && !undoing && !replaying) history.back();
    },
    forward() {
      if (active.index < furthestIndex && !undoing && !replaying) history.forward();
    },
    dispose() {
      disposed = true;
      generation++;
      pendingCommit = undefined;
      replaying = undefined;
      undoing?.done();
      undoing = undefined;
      window.removeEventListener('popstate', pop);
    },
  };
}
