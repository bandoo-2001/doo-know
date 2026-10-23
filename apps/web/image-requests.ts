import { SVG_MIME, SVG_POLICY, validateSvgSource } from '../../shared/svg-policy.js';

type Sources = { src: string | null; srcset?: string | null };
type Getter = () => Sources;
export const deferredImageSource = 'data-dooknow-image-src';
export function deferImageSource(
  token: { attrs: [string, string | number][] | null; attrSet(name: string, value: string): void },
  source: string,
) {
  token.attrs = (token.attrs || []).filter(([name]) => name !== 'src' && name !== 'srcset');
  token.attrSet(deferredImageSource, source);
}
function allowedSource(source: string | null) {
  if (!source || new URLSearchParams(source.slice(source.indexOf('?') + 1)).has('download'))
    return null;
  return source &&
    (/^\/api\/assets\/[a-zA-Z0-9-]+(?:\?[^#]*)?$/.test(source) ||
      /^\/api\/public\/shares\/[a-zA-Z0-9_-]+\/(?:assets\/[a-zA-Z0-9-]+(?:\?[^#]*)?|asset\?source=[^#]*)$/.test(
        source,
      ))
    ? source
    : null;
}
export function deferRenderedImages(html: string) {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const image of template.content.querySelectorAll('img')) {
    const source = allowedSource(image.getAttribute('src'));
    image.removeAttribute(deferredImageSource);
    if (source) {
      image.removeAttribute('src');
      image.removeAttribute('srcset');
      image.setAttribute(deferredImageSource, source);
    }
  }
  return template.innerHTML;
}
function imagesIn(element: Element): HTMLImageElement[] {
  return [
    ...(element.tagName === 'IMG' ? [element as HTMLImageElement] : []),
    ...element.querySelectorAll<HTMLImageElement>('img'),
  ];
}
type Owner = {
  image: HTMLImageElement;
  getter: Getter;
  token: object;
  alive: boolean;
  connected: boolean;
  source: string | null;
  resource?: Resource;
};
type Resource = {
  source: string;
  owners: Set<Owner>;
  state: 'queued' | 'loading' | 'loaded' | 'failed' | 'released';
  controller?: AbortController;
  timer?: number;
  url?: string;
};
type Scope = ReturnType<typeof createScope>;
const scopes = new WeakMap<Document, Scope>();
function createScope(document: Document) {
  const view = document.defaultView!;
  const roots = new Set<HTMLElement>(),
    owners = new Map<HTMLImageElement, Owner>(),
    tombstones = new WeakSet<HTMLImageElement>();
  const pending = new Map<string, Resource>(),
    queue = new Set<Resource>(),
    timers = new Set<number>(),
    legacyVersions = new WeakMap<HTMLImageElement, object>();
  let active = 0,
    leaving = false,
    disposed = false;
  function forget(resource: Resource) {
    if (pending.get(resource.source) === resource) pending.delete(resource.source);
  }
  function detach(owner: Owner) {
    const resource = owner.resource;
    owner.resource = undefined;
    if (!resource) return;
    resource.owners.delete(owner);
    if (resource.owners.size) return;
    forget(resource);
    queue.delete(resource);
    resource.state = 'released';
    resource.controller?.abort();
    if (resource.timer !== undefined) view.clearTimeout(resource.timer);
    if (resource.url) view.URL.revokeObjectURL(resource.url);
  }
  function display(owner: Owner, resource: Resource) {
    if (owner.image.ownerDocument !== document) {
      dispose(owner);
      return;
    }
    if (!owner.alive || owner.resource !== resource || !owner.image.isConnected || !resource.url)
      return;
    // The attachment resolver may change without an editor transaction.
    // Never publish bytes for a source that is no longer authorized/current.
    let current: string | null;
    try {
      current = allowedSource(owner.getter().src);
    } catch {
      current = null;
    }
    if (current !== resource.source) {
      refresh(owner);
      return;
    }
    owner.image.src = resource.url;
    owner.image.removeAttribute('aria-busy');
  }
  function pump() {
    if (disposed || leaving) return;
    // Reserve HTTP/1.1 connections for document reads, identity checks and saves.
    while (active < 3 && queue.size) {
      const resource = queue.values().next().value!;
      queue.delete(resource);
      if (!resource.owners.size || resource.state !== 'queued') continue;
      active++;
      resource.state = 'loading';
      resource.controller = new view.AbortController();
      const resetIdleDeadline = () => {
        if (resource.timer !== undefined) view.clearTimeout(resource.timer);
        resource.timer = view.setTimeout(() => resource.controller?.abort(), 15000);
      };
      resetIdleDeadline();
      void (async () => {
        try {
          const response = await view.fetch(resource.source, {
            signal: resource.controller!.signal,
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'error',
          });
          const contentType = response.headers.get('content-type') || '',
            svg = /^image\/svg\+xml(?:;|$)/i.test(contentType),
            limit = svg ? SVG_POLICY.maxBytes : 10 * 1024 * 1024;
          if (
            !response.ok ||
            /^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '') ||
            !/^image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;|$)/i.test(contentType)
          )
            throw Error('Image unavailable');
          if (!response.body) throw Error('Image unavailable');
          const reader = response.body.getReader(),
            chunks: BlobPart[] = [];
          let bytes = 0;
          resetIdleDeadline();
          try {
            for (;;) {
              const next = await reader.read();
              if (next.done) break;
              bytes += next.value.byteLength;
              // Match the existing server attachment limit, without timing out
              // a legitimate slow transfer that continues making progress.
              if (bytes > limit) throw Error('Image too large');
              chunks.push(next.value.slice().buffer as ArrayBuffer);
              resetIdleDeadline();
            }
          } finally {
            reader.releaseLock();
          }
          let blob = new view.Blob(chunks, { type: contentType });
          if (svg) {
            const result = validateSvgSource(new Uint8Array(await blob.arrayBuffer()));
            if (!result.ok) throw Error('SVG unavailable');
            blob = new view.Blob([result.presentation], { type: SVG_MIME });
          }
          if (resource.state !== 'loading' || !resource.owners.size) return;
          resource.url = view.URL.createObjectURL(blob);
          resource.state = 'loaded';
          forget(resource);
          for (const owner of resource.owners) display(owner, resource);
        } catch {
          resource.controller?.abort();
          if (resource.state === 'loading') {
            resource.state = 'failed';
            forget(resource);
            for (const owner of resource.owners) owner.image.removeAttribute('aria-busy');
          }
        } finally {
          if (resource.timer !== undefined) view.clearTimeout(resource.timer);
          resource.controller = undefined;
          active--;
          pump();
        }
      })();
    }
  }
  function refresh(owner: Owner) {
    if (!owner.alive) return;
    if (owner.image.ownerDocument !== document) {
      dispose(owner);
      return;
    }
    let source: string | null;
    try {
      source = allowedSource(owner.getter().src);
    } catch {
      source = null;
    }
    if (source === owner.source && owner.resource) return;
    detach(owner);
    owner.source = source;
    owner.image.removeAttribute('src');
    owner.image.removeAttribute('srcset');
    if (!source) {
      owner.image.removeAttribute(deferredImageSource);
      owner.image.removeAttribute('aria-busy');
      return;
    }
    owner.image.setAttribute(deferredImageSource, source);
    if (!owner.image.isConnected) return;
    owner.connected = true;
    owner.image.setAttribute('aria-busy', 'true');
    let resource = pending.get(source);
    if (!resource) {
      resource = { source, owners: new Set(), state: 'queued' };
      pending.set(source, resource);
      queue.add(resource);
    }
    owner.resource = resource;
    resource.owners.add(owner);
    pump();
  }
  function releaseNative(image: HTMLImageElement) {
    const token = {};
    legacyVersions.set(image, token);
    image.removeAttribute('src');
    image.removeAttribute('srcset');
    return token;
  }
  function stopIfUnused() {
    if (owners.size || roots.size) return;
    disposed = true;
    observer.disconnect();
    view.removeEventListener('beforeunload', beforeUnload);
    for (const timer of timers) view.clearTimeout(timer);
    timers.clear();
    scopes.delete(document);
  }
  function dispose(owner: Owner) {
    if (!owner.alive) return;
    owner.alive = false;
    detach(owner);
    owners.delete(owner.image);
    tombstones.add(owner.image);
    // A new Document may already have taken ownership of this element.
    // Release our resource without clearing the new owner's current source.
    if (owner.image.ownerDocument === document) {
      owner.image.removeAttribute(deferredImageSource);
      owner.image.removeAttribute('aria-busy');
      releaseNative(owner.image);
    }
    stopIfUnused();
  }
  function own(image: HTMLImageElement, getter: Getter) {
    let owner = owners.get(image);
    if (owner) {
      owner.getter = getter;
      owner.token = {};
    } else {
      owner = { image, getter, token: {}, alive: true, connected: false, source: null };
      owners.set(image, owner);
      tombstones.delete(image);
    }
    refresh(owner);
    const current = owner;
    view.queueMicrotask(() => {
      if (current.alive) refresh(current);
    });
    return owner;
  }
  function scan(element: Element) {
    for (const image of imagesIn(element)) {
      const owner = owners.get(image);
      if (owner) refresh(owner);
      else if (
        !tombstones.has(image) &&
        image.hasAttribute(deferredImageSource) &&
        [...roots].some((root) => root.contains(image))
      )
        own(image, () => ({ src: image.getAttribute(deferredImageSource) }));
    }
  }
  function mutations(records: MutationRecord[]) {
    const ownedTrees: Element[] = [...roots];
    for (const record of records)
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (ownedTrees.some((root) => root.contains(record.target))) {
          ownedTrees.push(element);
          for (const image of imagesIn(element))
            if (!image.isConnected && !owners.has(image)) releaseNative(image);
        } else
          for (const root of roots)
            if (element.contains(root))
              for (const image of imagesIn(root))
                if (!image.isConnected && !owners.has(image)) releaseNative(image);
      }
    for (const owner of [...owners.values()])
      if (owner.image.ownerDocument !== document || (owner.connected && !owner.image.isConnected))
        dispose(owner);
    for (const record of records)
      for (const node of record.addedNodes) if (node.nodeType === 1) scan(node as Element);
  }
  function beforeUnload() {
    leaving = true;
    const interrupted = [...owners.values()].filter(
      (owner) => owner.resource?.state === 'queued' || owner.resource?.state === 'loading',
    );
    for (const owner of interrupted) detach(owner);
    const native = [...new Set([...roots].flatMap(imagesIn))]
      .filter(
        (image) =>
          !owners.has(image) &&
          image.isConnected &&
          !image.complete &&
          (image.hasAttribute('src') || image.hasAttribute('srcset')),
      )
      .map((image) => {
        const previous = { src: image.getAttribute('src'), srcset: image.getAttribute('srcset') };
        return { image, previous, token: releaseNative(image) };
      });
    if (!interrupted.length && !native.length) {
      leaving = false;
      return;
    }
    const timer = view.setTimeout(() => {
      timers.delete(timer);
      if (disposed) return;
      leaving = false;
      for (const owner of interrupted)
        if (owner.alive && owners.get(owner.image) === owner && owner.image.isConnected)
          refresh(owner);
      for (const { image, previous, token } of native) {
        if (
          !image.isConnected ||
          legacyVersions.get(image) !== token ||
          image.hasAttribute('src') ||
          image.hasAttribute('srcset')
        )
          continue;
        if (previous.src !== null) image.setAttribute('src', previous.src);
        if (previous.srcset !== null) image.setAttribute('srcset', previous.srcset);
      }
      pump();
    }, 0);
    timers.add(timer);
  }
  const observer = new view.MutationObserver(mutations);
  observer.observe(document, { childList: true, subtree: true });
  view.addEventListener('beforeunload', beforeUnload);
  function drain() {
    mutations(observer.takeRecords());
  }
  return { roots, owners, own, refresh, dispose, releaseNative, drain, scan, stopIfUnused };
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
export function trackImageRequest(image: HTMLImageElement, getter: Getter) {
  const scope = scopeFor(image.ownerDocument),
    owner = scope?.own(image, getter),
    token = owner?.token;
  const stop = () => {
    if (owner?.token === token && owner) scope?.dispose(owner);
  };
  return Object.assign(stop, {
    refresh: () => {
      if (owner?.token === token && owner) scope?.refresh(owner);
    },
  });
}
export function bindImageRequests(root: HTMLElement) {
  const scope = scopeFor(root.ownerDocument);
  scope?.roots.add(root);
  scope?.scan(root);
  return () => {
    if (!scope?.roots.has(root)) return;
    scope.drain();
    scope.roots.delete(root);
    for (const image of imagesIn(root)) {
      const owner = scope.owners.get(image);
      if (owner) scope.dispose(owner);
      else scope.releaseNative(image);
    }
    scope.stopIfUnused();
  };
}
