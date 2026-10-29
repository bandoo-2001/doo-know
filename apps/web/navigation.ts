export const toDooSections = ['overview', 'tasks', 'board', 'calendar', 'timeline', 'matrix', 'focus', 'habits', 'anniversaries', 'stats', 'notifications', 'settings'] as const;
export type ToDooAppSection = (typeof toDooSections)[number];
export type WorkspaceRoute = {
  app?: 'blog' | 'to-doo' | 'graph';
  appSection?: 'overview' | 'articles' | 'taxonomy' | 'settings' | 'design' | ToDooAppSection;
  task?: string;
  list?: string;
  date?: string;
  calendarView?: 'week' | 'month';
  note?: string;
  line?: number;
  fragment?: string;
  folder?: string;
  view?: 'trash' | 'settings' | 'apps' | 'recent' | 'favorites';
  section?:
    | 'editor'
    | 'library'
    | 'account'
    | 'search'
    | 'plugins'
    | 'status'
    | 'backup'
    | 'about'
    | 'maintenance';
};
export type WorkspaceNavigationState = { canBack: boolean; canForward: boolean };
export function readWorkspaceRoute(href = window.location.href): WorkspaceRoute {
  const url = new URL(href),
    query = url.searchParams;
  const parsed = Number(url.hash.match(/^#L([1-9]\d*)$/)?.[1]);
  const toDoo = query.get('view') === 'apps' && query.get('app') === 'to-doo';
  const date = query.get('date') || '';
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date;
  const entity = (key: string) => /^[A-Za-z0-9_-]{1,128}$/.test(query.get(key) || '') ? query.get(key)! : undefined;
  return {
    ...(query.get('view') === 'apps' && query.get('app') === 'graph' ? {
      app: 'graph' as const,
      ...(query.get('appSection') === 'overview' ? { appSection: 'overview' as const } : {}),
    } : {}),
    ...(toDoo ? {
      app: 'to-doo' as const,
      ...(toDooSections.includes(query.get('appSection') as ToDooAppSection) ? { appSection: query.get('appSection') as ToDooAppSection } : {}),
      ...(entity('task') ? { task: entity('task') } : {}),
      ...(entity('list') ? { list: entity('list') } : {}),
      ...(validDate ? { date } : {}),
      ...(['week', 'month'].includes(query.get('calendarView') || '') ? { calendarView: query.get('calendarView') as 'week' | 'month' } : {}),
    } : {}),
    ...(query.get('view') === 'apps' && query.get('app') === 'blog'
      ? {
          app: 'blog' as const,
          ...(['overview', 'articles', 'taxonomy', 'settings', 'design'].includes(
            query.get('appSection') || '',
          )
            ? { appSection: query.get('appSection') as WorkspaceRoute['appSection'] }
            : {}),
        }
      : {}),
    ...(query.get('note') ? { note: query.get('note')! } : {}),
    ...(Number.isSafeInteger(parsed) && parsed <= 20 * 1024 * 1024 ? { line: parsed } : {}),
    ...(!Number.isSafeInteger(parsed) && url.hash ? { fragment: url.hash } : {}),
    ...(query.get('folder') ? { folder: query.get('folder')! } : {}),
    ...(['trash', 'settings', 'apps', 'recent', 'favorites'].includes(query.get('view') || '')
      ? { view: query.get('view') as WorkspaceRoute['view'] }
      : {}),
    ...([
      'editor',
      'library',
      'account',
      'search',
      'plugins',
      'status',
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
    for (const key of ['note', 'folder', 'view', 'section', 'app', 'appSection', 'task', 'list', 'date', 'calendarView'])
      url.searchParams.delete(key);
    if (route.note) url.searchParams.set('note', route.note);
    if (route.folder) url.searchParams.set('folder', route.folder);
    if (route.view) url.searchParams.set('view', route.view);
    if (route.section) url.searchParams.set('section', route.section);
    if (route.view === 'apps' && route.app) url.searchParams.set('app', route.app);
    if (route.view === 'apps' && route.app && route.appSection)
      url.searchParams.set('appSection', route.appSection);
    if (route.view === 'apps' && route.app === 'to-doo') {
      for (const key of ['task', 'list', 'date', 'calendarView'] as const)
        if (route[key]) url.searchParams.set(key, route[key]!);
    }
    url.hash = route.line ? 'L' + route.line : route.fragment || '';
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
