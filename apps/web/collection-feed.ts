import { computed, reactive, ref } from 'vue';
import { api, ApiError } from './api';
import type {
  CollectionKind,
  CollectionNote,
  CollectionPage,
  CollectionStatus,
} from '../../shared/collection-contracts';

type Request = (url: string) => Promise<unknown>;
function initial() {
  return {
    items: [] as CollectionNote[],
    head: [] as CollectionNote[],
    nextCursor: null as string | null,
    total: 0,
    version: '',
    headVersion: '',
    loaded: false,
    loading: false,
    checking: false,
    updated: false,
    error: '',
    scrollTop: 0,
    pending: undefined as Promise<void> | undefined,
    failedMore: false,
    generation: 0,
  };
}
export function createCollectionFeed(request: Request = api) {
  const kind = ref<CollectionKind>('recent');
  const states = { recent: reactive(initial()), favorites: reactive(initial()) };
  const state = computed(() => states[kind.value]);
  let mutation = 0,
    observation = 0;
  const favoriteValues = reactive(new Map<string, boolean>());
  const favoriteObservations = new Map<string, number>();
  function reconcileFavorite(id: string, value: boolean, sequence: number) {
    if ((favoriteObservations.get(id) || 0) > sequence) return favoriteValues.get(id)!;
    const previous = favoriteValues.get(id);
    favoriteValues.set(id, value);
    favoriteObservations.set(id, sequence);
    const favorites = states.favorites;
    // Most paged metadata repeats an unchanged flag. Avoid walking all loaded
    // cards for every row in the next page.
    if (previous === value) return value;
    if (previous === undefined) {
      if (favorites.loaded && value) favorites.updated = true;
      return value;
    }
    const existed =
      favorites.items.some((item) => item.id === id) ||
      favorites.head.some((item) => item.id === id);
    for (const current of [states.recent, favorites])
      for (const list of [current.items, current.head])
        for (const item of list) if (item.id === id) item.favorite = value;
    if (!value && existed) {
      favorites.items = favorites.items.filter((item) => item.id !== id);
      favorites.head = favorites.head.filter((item) => item.id !== id);
      favorites.total = Math.max(0, favorites.total - 1);
      favorites.updated = true;
    } else if (favorites.loaded && value && !existed && previous !== true) favorites.updated = true;
    return value;
  }
  function received(items: CollectionNote[], sequence: number, target: CollectionKind) {
    return items
      .map((item) => {
        return { ...item, favorite: reconcileFavorite(item.id, item.favorite, sequence) };
      })
      .filter((item) => target !== 'favorites' || item.favorite);
  }
  function load(target: CollectionKind, more: boolean): Promise<void> {
    const current = states[target];
    if (current.pending) return current.pending;
    if (more && (!current.nextCursor || current.updated)) return Promise.resolve();
    const cursor = more ? current.nextCursor : null;
    const revision = mutation;
    const sequence = ++observation;
    current.generation++;
    current.loading = true;
    current.error = '';
    current.failedMore = more;
    let pending!: Promise<void>;
    pending = (async () => {
      try {
        const query = new URLSearchParams({ kind: target, limit: '24' });
        if (cursor) query.set('cursor', cursor);
        const page = (await request('/api/collections?' + query)) as CollectionPage;
        if (!Array.isArray(page.items) || typeof page.version !== 'string')
          throw Error('Invalid collection page');
        const items = received(page.items, sequence, target);
        if (more) {
          const known = new Set(current.items.map((item) => item.id));
          current.items.push(...items.filter((item) => !known.has(item.id)));
        } else {
          current.items = items;
          current.head = items;
          current.headVersion = page.version;
          current.scrollTop = 0;
        }
        current.nextCursor = page.nextCursor;
        current.total = Math.max(0, page.total - page.items.length + items.length);
        current.version = page.version;
        current.loaded = true;
        current.updated = mutation !== revision;
      } catch (error) {
        if (error instanceof ApiError && error.data.code === 'COLLECTION_CHANGED')
          current.updated = true;
        else
          current.error = error instanceof ApiError ? error.message : '暂时无法加载笔记，请重试。';
      } finally {
        current.loading = false;
        current.pending = undefined;
      }
    })();
    current.pending = pending;
    return pending;
  }
  async function select(target: CollectionKind) {
    kind.value = target;
    if (!states[target].loaded) await load(target, false);
  }
  async function checkForUpdates(target: CollectionKind = kind.value) {
    const current = states[target];
    if (!current.loaded || current.checking || current.loading) return;
    const generation = current.generation,
      revision = mutation,
      sequence = ++observation;
    current.checking = true;
    try {
      const status = (await request('/api/collections/status?kind=' + target)) as CollectionStatus;
      if (generation !== current.generation || revision !== mutation) return;
      if (status.version === current.headVersion) return;
      current.updated = true;
      current.total = status.total;
      const page = (await request(
        '/api/collections?kind=' + target + '&limit=24',
      )) as CollectionPage;
      if (generation !== current.generation || revision !== mutation) return;
      current.head = received(page.items, sequence, target);
      current.headVersion = page.version;
    } catch {
      /* Keep the last readable page when a background freshness check fails. */
    } finally {
      current.checking = false;
    }
  }
  function updateFavorite(id: string, value: boolean) {
    mutation++;
    reconcileFavorite(id, value, ++observation);
    for (const target of ['recent', 'favorites'] as const) {
      const current = states[target];
      if (current.loaded) current.updated = true;
    }
  }
  return {
    kind,
    items: computed(() => state.value.items),
    head: computed(() => state.value.head),
    total: computed(() => state.value.total),
    nextCursor: computed(() => state.value.nextCursor),
    loading: computed(() => state.value.loading),
    loaded: computed(() => state.value.loaded),
    updated: computed(() => state.value.updated),
    error: computed(() => state.value.error),
    scrollTop: computed(() => state.value.scrollTop),
    select,
    refresh: () => load(kind.value, false),
    loadMore: () => load(kind.value, true),
    retry: () => load(kind.value, state.value.failedMore),
    checkForUpdates,
    updateFavorite,
    favoriteStates: computed(() => [...favoriteValues]),
    observeFavorites: (entries: { id?: string; favorite?: boolean }[]) => {
      const sequence = ++observation;
      for (const entry of entries)
        if (entry.id && typeof entry.favorite === 'boolean')
          reconcileFavorite(entry.id, entry.favorite, sequence);
    },
    entriesFor: (target: CollectionKind) => states[target].head,
    rememberScroll: (position: number) => {
      state.value.scrollTop = Math.max(0, position);
    },
  };
}
export type CollectionFeed = ReturnType<typeof createCollectionFeed>;
