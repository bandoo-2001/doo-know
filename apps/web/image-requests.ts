type Sources = { src: string | null; srcset?: string | null };
const sources = new WeakMap<HTMLImageElement, (() => Sources) | null>();
type Scope = ReturnType<typeof createScope>;
const scopes = new WeakMap<Document, Scope>();

function imagesIn(element: Element): HTMLImageElement[] {
  return [
    ...(element.tagName === 'IMG' ? [element as HTMLImageElement] : []),
    ...element.querySelectorAll<HTMLImageElement>('img'),
  ];
}
function createScope(document: Document) {
  const view = document.defaultView!;
  const roots = new Set<HTMLElement>(),
    owned = new Set<HTMLImageElement>();
  const versions = new WeakMap<HTMLImageElement, object>(),
    timers = new Set<number>();
  let disposed = false;
  function release(image: HTMLImageElement) {
    const token = {};
    versions.set(image, token);
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    return token;
  }
  function beforeUnload() {
    const images = new Set([...owned, ...[...roots].flatMap(imagesIn)]);
    const pending = [...images]
      .filter(
        (image) =>
          image.isConnected &&
          !image.complete &&
          (image.hasAttribute('src') || image.hasAttribute('srcset')),
      )
      .map((image) => {
        const previous = { src: image.getAttribute('src'), srcset: image.getAttribute('srcset') };
        return { image, previous, token: release(image) };
      });
    if (!pending.length) return;
    // A canceled leave keeps the same document alive. Restore the displayed
    // source without changing editor nodes; an accepted leave discards this task.
    const timer = view.setTimeout(() => {
      timers.delete(timer);
      if (disposed) return;
      for (const { image, previous, token } of pending) {
        if (
          !image.isConnected ||
          versions.get(image) !== token ||
          image.hasAttribute('src') ||
          image.hasAttribute('srcset')
        )
          continue;
        const owner = sources.get(image);
        if (owner === null) continue;
        let desired: Sources;
        try {
          desired = owner ? owner() : previous;
        } catch {
          continue;
        }
        if (desired.src !== null) image.setAttribute('src', desired.src);
        if (desired.srcset != null) image.setAttribute('srcset', desired.srcset);
      }
    }, 0);
    timers.add(timer);
  }
  function releaseRemoved(records: MutationRecord[]) {
    for (const record of records)
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        for (const image of imagesIn(node as Element)) if (!image.isConnected) release(image);
      }
  }
  const observer = new view.MutationObserver(releaseRemoved);
  function observeRoots() {
    releaseRemoved(observer.takeRecords());
    observer.disconnect();
    for (const root of roots) observer.observe(root, { childList: true, subtree: true });
  }
  function stopIfUnused() {
    if (roots.size || owned.size) return;
    disposed = true;
    observer.disconnect();
    view.removeEventListener('beforeunload', beforeUnload);
    for (const timer of timers) view.clearTimeout(timer);
    timers.clear();
    scopes.delete(document);
  }
  view.addEventListener('beforeunload', beforeUnload);
  return { roots, owned, release, observeRoots, stopIfUnused };
}
function scopeFor(document: Document) {
  if (!document.defaultView) return;
  let scope = scopes.get(document);
  if (!scope) {
    scope = createScope(document);
    scopes.set(document, scope);
  }
  return scope;
}

export function trackImageRequest(image: HTMLImageElement, currentSources: () => Sources) {
  const scope = scopeFor(image.ownerDocument);
  sources.set(image, currentSources);
  scope?.owned.add(image);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    // Keep the tombstone weakly associated with the DOM node so a pending
    // canceled-navigation callback cannot restore an already destroyed view.
    sources.set(image, null);
    scope?.release(image);
    scope?.owned.delete(image);
    scope?.stopIfUnused();
  };
}

export function bindImageRequests(root: HTMLElement) {
  const scope = scopeFor(root.ownerDocument);
  scope?.roots.add(root);
  scope?.observeRoots();
  return () => {
    if (!scope?.roots.delete(root)) return;
    for (const image of imagesIn(root)) scope.release(image);
    scope.observeRoots();
    scope.stopIfUnused();
  };
}
