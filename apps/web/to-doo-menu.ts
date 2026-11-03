import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

/** Dropdowns close before the surrounding task reader handles Escape. */
export function useToDooMenu() {
  const open = ref(false);
  const trigger = ref<{ $el?: HTMLElement }>();
  let previous: Element | null = null;
  function escape(event: KeyboardEvent) {
    if (!open.value || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    open.value = false;
    void nextTick(() => {
      const element = trigger.value?.$el ?? previous;
      if (element instanceof HTMLElement) element.focus({ preventScroll: true });
    });
  }
  watch(
    open,
    (visible) => {
      if (typeof document === 'undefined') return;
      if (visible) {
        previous = document.activeElement;
        document.addEventListener('keydown', escape, true);
      } else document.removeEventListener('keydown', escape, true);
    },
    { flush: 'sync' },
  );
  onBeforeUnmount(() => {
    if (typeof document !== 'undefined') document.removeEventListener('keydown', escape, true);
  });
  return { open, trigger };
}
