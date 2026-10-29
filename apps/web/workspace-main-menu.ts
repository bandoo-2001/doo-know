import {
  computed,
  inject,
  onScopeDispose,
  provide,
  shallowRef,
  toValue,
  watchEffect,
  type InjectionKey,
  type MaybeRefOrGetter,
} from 'vue';
import type { WorkspaceRoute } from './navigation';

export type WorkspaceMainMenuItem = {
  id: string;
  label: string;
  icon: string;
  title?: string;
  badge?: number;
  disabled?: boolean;
  separated?: boolean;
};
export type WorkspaceMainMenuDefinition = {
  id: string;
  label: string;
  icon?: string;
  activeId?: string;
  items: readonly WorkspaceMainMenuItem[];
  utilities: readonly WorkspaceMainMenuItem[];
  onSelect: (id: string) => void | Promise<void>;
};

/** Registration order gives nested application customizations stable precedence. */
export function createWorkspaceMainMenuHost() {
  const entries = new Map<symbol, WorkspaceMainMenuDefinition>();
  const current = shallowRef<WorkspaceMainMenuDefinition>();
  function refresh() {
    current.value = [...entries.values()].at(-1);
  }
  return {
    current: computed(() => current.value),
    set(owner: symbol, definition: WorkspaceMainMenuDefinition | undefined) {
      if (definition) entries.set(owner, definition);
      else entries.delete(owner);
      refresh();
    },
    remove(owner: symbol) {
      entries.delete(owner);
      refresh();
    },
  };
}
type WorkspaceMainMenuHost = ReturnType<typeof createWorkspaceMainMenuHost>;
const menuKey: InjectionKey<WorkspaceMainMenuHost> = Symbol('dooknow.main-menu');

export function provideWorkspaceMainMenu() {
  const host = createWorkspaceMainMenuHost();
  provide(menuKey, host);
  return host;
}

/** Returns whether a workspace host is available; independent app previews keep their own navigation. */
export function useWorkspaceMainMenu(
  definition: MaybeRefOrGetter<WorkspaceMainMenuDefinition | undefined>,
) {
  const host = inject(menuKey, undefined);
  if (!host) return false;
  const owner = Symbol('app-menu-owner');
  watchEffect(() => host.set(owner, toValue(definition)));
  onScopeDispose(() => host.remove(owner));
  return true;
}

export function useInjectedWorkspaceMainMenu() {
  const host = inject(menuKey, undefined);
  return computed(() => host?.current.value);
}

/** Session-local to the mounted account workspace; never persists note or credential data. */
export function createAppNavigationMemory() {
  const locations = new Map<NonNullable<WorkspaceRoute['app']>, WorkspaceRoute>();
  return {
    remember(route: WorkspaceRoute) {
      if (route.view !== 'apps' || !route.app) return;
      locations.set(route.app, { ...route });
    },
    recall(app: NonNullable<WorkspaceRoute['app']>) {
      const route = locations.get(app);
      return route ? { ...route } : undefined;
    },
  };
}
