import { createApp, type App } from 'vue';
import DiagramPreview from '../components/DiagramPreview.vue';
type Options = { noteId?: string; shareToken?: string; readOnly?: boolean };
const mounted = new WeakMap<HTMLElement, { element: HTMLElement; app: App }[]>();
export function clearDiagrams(container: HTMLElement) {
  for (const item of mounted.get(container) || []) item.app.unmount();
  mounted.delete(container);
}
export function syncDiagrams(container: HTMLElement, options: Options = {}) {
  clearDiagrams(container);
  const items: { element: HTMLElement; app: App }[] = [];
  for (const element of container.querySelectorAll<HTMLElement>('[data-diagram]')) {
    let code = '';
    try {
      code = decodeURIComponent(element.dataset.code || '');
    } catch {
      code = '';
    }
    const app = createApp(DiagramPreview, { kind: element.dataset.diagram!, code, ...options });
    app.mount(element);
    items.push({ element, app });
  }
  mounted.set(container, items);
}
