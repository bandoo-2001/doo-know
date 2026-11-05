import { onBeforeUnmount, ref, watch } from 'vue';

/** Keep the current form field above its own measured sticky actions. */
export function useBlogSavebar() {
  const form = ref<HTMLElement>(),
    savebar = ref<HTMLElement>();
  let frame = 0;
  function protect(target: HTMLElement) {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const root = form.value,
        bar = savebar.value;
      if (
        !root?.isConnected ||
        !bar?.isConnected ||
        !target.isConnected ||
        !root.contains(target) ||
        bar.contains(target) ||
        document.activeElement !== target ||
        root.closest('[inert], [aria-hidden="true"]')
      )
        return;
      const field = target.getBoundingClientRect(),
        actions = bar.getBoundingClientRect();
      if (
        !field.width ||
        !field.height ||
        !actions.height ||
        field.right <= actions.left ||
        field.left >= actions.right ||
        actions.top >= innerHeight ||
        actions.bottom <= 0 ||
        field.bottom <= actions.top - 12
      )
        return;
      // Start at the form, excluding nested pickers' independent scroll bodies.
      // The chosen ancestor owns both this field and its sticky savebar.
      let owner: HTMLElement | null = root;
      while (
        owner &&
        (!/(auto|scroll)/.test(getComputedStyle(owner).overflowY) ||
          owner.scrollHeight <= owner.clientHeight)
      )
        owner = owner.parentElement;
      const distance = field.bottom - actions.top + 12;
      if (owner) owner.scrollBy({ top: distance, behavior: 'instant' });
      else window.scrollBy({ top: distance, behavior: 'instant' });
    });
  }
  function focusin(event: FocusEvent) {
    if (event.target instanceof HTMLElement) protect(event.target);
  }
  watch(
    [form, savebar],
    ([root, bar], _previous, cleanup) => {
      if (!root || !bar) return;
      const property = '--blog-savebar-clearance',
        previous = root.style.getPropertyValue(property);
      const measure = () => {
        root.style.setProperty(property, Math.ceil(bar.getBoundingClientRect().height + 24) + 'px');
        if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement))
          protect(document.activeElement);
      };
      const observer = new ResizeObserver(measure);
      observer.observe(bar);
      measure();
      cleanup(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        if (previous) root.style.setProperty(property, previous);
        else root.style.removeProperty(property);
      });
    },
    { flush: 'post' },
  );
  onBeforeUnmount(() => cancelAnimationFrame(frame));
  return { form, savebar, focusin };
}
