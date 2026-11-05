import { onBeforeUnmount, ref, watch } from 'vue';

/** Keep the current field within its form's actual unobscured scroll area. */
export function useBlogSavebar() {
  const form = ref<HTMLElement>(),
    savebar = ref<HTMLElement>();
  let frame = 0;
  let lastAction: HTMLElement | undefined;
  // Start at the form: nested pickers do not own the shared savebar.
  function scrollOwner(root: HTMLElement) {
    let owner: HTMLElement | null = root;
    while (
      owner &&
      (!/(auto|scroll)/.test(getComputedStyle(owner).overflowY) ||
        owner.scrollHeight <= owner.clientHeight)
    )
      owner = owner.parentElement;
    return owner;
  }
  function viewport(owner: HTMLElement | null) {
    const box = owner?.getBoundingClientRect();
    return {
      top: Math.max(0, box ? box.top + owner!.clientTop : 0),
      bottom: Math.min(
        innerHeight,
        box ? box.top + owner!.clientTop + owner!.clientHeight : innerHeight,
      ),
    };
  }
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
        (document.activeElement !== target &&
          !(document.activeElement === document.body && lastAction === target)) ||
        root.closest('[inert], [aria-hidden="true"]')
      )
        return;
      const actions = bar.getBoundingClientRect(),
        owner = scrollOwner(root),
        bounds = viewport(owner),
        sticky = getComputedStyle(bar).position === 'sticky',
        inActions = bar.contains(target);
      if (inActions && sticky) return;
      // When a clicked save expands feedback in normal flow, retain the complete
      // action surface if it fits, rather than leaving its new receipt offscreen.
      const field =
        inActions && actions.height <= bounds.bottom - bounds.top
          ? actions
          : target.getBoundingClientRect();
      if (!field.width || !field.height) return;
      // A short scrollport cannot hold a tall error receipt and a field together.
      // In that case the complete savebar stays in normal flow instead of
      // pushing the field behind the app header.
      if (
        sticky &&
        field.right > actions.left &&
        field.left < actions.right &&
        actions.top < bounds.bottom &&
        actions.bottom > bounds.top
      )
        bounds.bottom = Math.min(bounds.bottom, actions.top - 12);
      const distance =
        field.top < bounds.top ? field.top - bounds.top : Math.max(0, field.bottom - bounds.bottom);
      if (!distance) return;
      if (owner) owner.scrollBy({ top: distance, behavior: 'instant' });
      else window.scrollBy({ top: distance, behavior: 'instant' });
    });
  }
  function focusin(event: FocusEvent) {
    if (event.target instanceof HTMLElement) {
      lastAction = savebar.value?.contains(event.target) ? event.target : undefined;
      protect(event.target);
    }
  }
  watch(
    [form, savebar],
    ([root, bar], _previous, cleanup) => {
      if (!root || !bar) return;
      const properties = ['--blog-savebar-clearance', '--blog-savebar-position'],
        previous = properties.map((property) => root.style.getPropertyValue(property)),
        owner = scrollOwner(root);
      const measure = () => {
        const height = bar.getBoundingClientRect().height,
          bounds = viewport(owner),
          tallestField = Math.max(
            0,
            ...Array.from(
              root.querySelectorAll<HTMLElement>('input,textarea,select,button,summary'),
            )
              .filter((field) => !bar.contains(field))
              .map((field) => field.getBoundingClientRect().height),
          ),
          sticky = height + tallestField + 24 <= bounds.bottom - bounds.top;
        root.style.setProperty(properties[0], (sticky ? Math.ceil(height + 24) : 24) + 'px');
        root.style.setProperty(properties[1], sticky ? 'sticky' : 'static');
        if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement))
          protect(document.activeElement);
        // Native disabling of a submitted button may move focus to body. Keep
        // that receipt visible only while no different surface has taken focus.
        else if (document.activeElement === document.body && lastAction) protect(lastAction);
      };
      const leaveActions = (event: FocusEvent) => {
        if (event.target instanceof Node && !bar.contains(event.target)) lastAction = undefined;
      };
      document.addEventListener('focusin', leaveActions);
      const observer = new ResizeObserver(measure);
      observer.observe(bar);
      observer.observe(root);
      if (owner) observer.observe(owner);
      window.addEventListener('resize', measure);
      measure();
      cleanup(() => {
        observer.disconnect();
        cancelAnimationFrame(frame);
        window.removeEventListener('resize', measure);
        document.removeEventListener('focusin', leaveActions);
        lastAction = undefined;
        properties.forEach((property, index) => {
          if (previous[index]) root.style.setProperty(property, previous[index]);
          else root.style.removeProperty(property);
        });
      });
    },
    { flush: 'post' },
  );
  onBeforeUnmount(() => cancelAnimationFrame(frame));
  return { form, savebar, focusin };
}
