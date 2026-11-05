/** Keep the app-hosted background HEX popover out of fixed owner navigation.
 * Radix positions against the browser viewport, which includes the app tabbar.
 * This adapter changes only popup geometry, never Excalidraw state or assets. */
export function installCanvasPopoverViewport(container: HTMLElement) {
  let frame = 0, disposed = false;
  const offsets = new WeakMap<HTMLElement, { x: number; y: number }>();
  const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(adjust); };
  function adjust() {
    frame = 0;
    if (disposed) return;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
    const right = left + (viewport?.width ?? innerWidth), bottom = top + (viewport?.height ?? innerHeight);
    const host = container.getBoundingClientRect();
    let usableBottom = Math.min(bottom, host.bottom);
    if (!container.closest('.embedded')) {
      const tabbar = document.querySelector<HTMLElement>('.workspace-tabbar');
      if (tabbar && getComputedStyle(tabbar).display !== 'none') {
        const nav = tabbar.getBoundingClientRect();
        if (nav.height && nav.top < bottom && nav.bottom > top) usableBottom = Math.min(usableBottom, nav.top);
      }
    }
    const bounds = { left: Math.max(left, host.left) + 8, top: Math.max(top, host.top) + 8,
      right: Math.min(right, host.right) - 8, bottom: usableBottom - 8 };
    if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return;
    for (const input of container.querySelectorAll<HTMLInputElement>('input[aria-label="画布背景"]')) {
      const popup = input.closest<HTMLElement>('[data-radix-popper-content-wrapper]');
      if (!popup || !popup.getClientRects().length) continue;
      const content = popup.firstElementChild;
      if (content instanceof HTMLElement) {
        const height = `${Math.floor(bounds.bottom - bounds.top)}px`;
        if (content.style.maxHeight !== height) content.style.maxHeight = height;
        if (content.style.overflowY !== 'auto') content.style.overflowY = 'auto';
      }
      const previous = offsets.get(popup) ?? { x: 0, y: 0 };
      const rect = popup.getBoundingClientRect();
      const origin = { left: rect.left - previous.x, top: rect.top - previous.y };
      const x = Math.max(bounds.left, Math.min(origin.left, bounds.right - rect.width)) - origin.left;
      const y = Math.max(bounds.top, Math.min(origin.top, bounds.bottom - rect.height)) - origin.top;
      if (Math.abs(x - previous.x) > .5 || Math.abs(y - previous.y) > .5) {
        offsets.set(popup, { x, y });
        // Independent translate composes with, rather than replaces, Radix's
        // own transform/placement updates while scroll/resize is in progress.
        popup.style.translate = `${x}px ${y}px`;
      }
    }
  }
  const mutation = new MutationObserver(schedule);
  mutation.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'data-state'] });
  const resize = new ResizeObserver(schedule); resize.observe(container);
  window.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  container.addEventListener('scroll', schedule, true);
  return () => {
    disposed = true; cancelAnimationFrame(frame); mutation.disconnect(); resize.disconnect();
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('scroll', schedule);
    container.removeEventListener('scroll', schedule, true);
  };
}
