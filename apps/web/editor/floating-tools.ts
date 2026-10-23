import {
  autoUpdate,
  computePosition,
  flip,
  offset,
  shift,
  size,
  type Boundary,
  type Padding,
  type Placement,
  type ReferenceElement,
  type VirtualElement,
} from '@floating-ui/vue';
import type { CSSProperties } from 'vue';

export type FloatingToolsOptions = {
  placement?: Placement;
  padding?: Padding;
  gap?: number;
  maxHeight?: number;
  boundary?: Boundary;
  flip?: boolean;
};

export function virtualAnchor(rect: () => DOMRect, contextElement?: Element): VirtualElement {
  return { getBoundingClientRect: rect, contextElement };
}

/** Positioning only. The caller owns selection, dismissal, and keyboard focus. */
export function createFloatingTools(
  reference: ReferenceElement,
  floating: HTMLElement,
  options: FloatingToolsOptions = {},
  positioned: (style: CSSProperties) => void = () => {},
) {
  let live = true,
    epoch = 0,
    last: CSSProperties | undefined;
  async function update() {
    if (!live) return last;
    const request = ++epoch;
    let maxWidth = '',
      maxHeight = '';
    const overflow = { padding: options.padding ?? 8, boundary: options.boundary };
    const result = await computePosition(reference, floating, {
      strategy: 'fixed',
      placement: options.placement ?? 'bottom-start',
      middleware: [
        offset(options.gap ?? 6),
        ...(options.flip === false ? [] : [flip(overflow)]),
        shift({ ...overflow, crossAxis: true }),
        size({
          ...overflow,
          apply({ availableWidth, availableHeight }) {
            maxWidth = `${Math.max(0, availableWidth)}px`;
            maxHeight = `${Math.max(0, Math.min(options.maxHeight ?? Infinity, availableHeight))}px`;
            if (live && request === epoch) Object.assign(floating.style, { maxWidth, maxHeight });
          },
        }),
      ],
    });
    if (!live || request !== epoch) return last;
    last = {
      position: result.strategy,
      left: `${result.x}px`,
      top: `${result.y}px`,
      maxWidth,
      maxHeight,
    };
    positioned(last);
    return last;
  }
  const cleanup = autoUpdate(reference, floating, () => {
    void update();
  });
  return {
    update,
    stop() {
      live = false;
      epoch++;
      cleanup();
    },
  };
}
