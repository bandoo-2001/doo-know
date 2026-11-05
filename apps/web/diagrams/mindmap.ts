import MindElixir, { type MindElixirInstance, type NodeObj } from 'mind-elixir';
import 'mind-elixir/style.css';
import './mindmap-editor.css';
import { installMindmapControls } from './mindmap-controls';
import { snapdom } from '@zumer/snapdom';
import { diagramRendererVersions } from '../../../shared/diagram-primary.js';
import {
  parseMindmapOutline,
  serializeMindmapOutline,
  type MindmapNode,
} from '../../../shared/mindmap-outline.js';

export const MINDMAP_RENDERER = diagramRendererVersions.mindmap;
const fontFamily = '"WenQuanYi Micro Hei", "Microsoft YaHei", "PingFang SC", sans-serif';

function editorTree(root: MindmapNode): NodeObj {
  // Never pass editor-only state, native HTML, links or image fields into the rendering engine.
  return {
    id: root.id,
    topic: root.topic,
    expanded: true,
    children: root.children.map(editorTree),
  };
}
export function mountMindmap(
  el: HTMLElement,
  root: MindmapNode,
  readOnly = false,
): MindElixirInstance {
  serializeMindmapOutline(root);
  el.style.fontFamily = fontFamily;
  if (!readOnly) el.classList.add('dooknow-mindmap-editor');
  const mind = new MindElixir({
    el,
    direction: MindElixir.SIDE,
    editable: !readOnly,
    toolBar: false,
    contextMenu: false,
    keypress: !readOnly,
    allowUndo: !readOnly,
    // Rich clipboard payloads cannot introduce a second, unrepresentable data model.
    pasteHandler: (event) => event.preventDefault(),
    newTopicName: '新节点',
    theme: MindElixir.THEME,
  });
  const error = mind.init({ nodeData: editorTree(root) });
  if (error) {
    mind.destroy();
    throw error;
  }
  mind.container.style.fontFamily = fontFamily;
  if (!readOnly) {
    mind.disposable.push(installMindmapControls(mind));
    let disposed = false, interacted = false, frame = 0;
    const touched = () => { interacted = true; };
    for (const event of ['pointerdown', 'wheel', 'keydown']) mind.container.addEventListener(event, touched, { passive: true, capture: true });
    // Fit only the initial overflowing view after font/layout readiness. Scale
    // events do not rewrite the Markdown tree; later user pan/zoom is retained.
    void document.fonts.ready.then(() => {
      if (disposed) return;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (disposed || interacted) return;
          const bounds = mind.container.getBoundingClientRect();
          const visibleTopics = () => [...mind.container.querySelectorAll('me-tpc')].map(node => node.getBoundingClientRect());
          const topicBounds = () => {
            const rects = visibleTopics();
            return rects.length ? { left: Math.min(...rects.map(rect => rect.left)), top: Math.min(...rects.map(rect => rect.top)),
              right: Math.max(...rects.map(rect => rect.right)), bottom: Math.max(...rects.map(rect => rect.bottom)) } : undefined;
          };
          const topics = topicBounds();
          if (!topics || !bounds.width || !bounds.height) return;
          const outside = topics.left < bounds.left + 16 || topics.right > bounds.right - 16 || topics.top < bounds.top + 16 || topics.bottom > bounds.bottom - 16;
          if (!outside) return;
          // The native nodes box contains large layout margins. Fit the real
          // labels instead, so a tiny child is not the price of avoiding clips.
          const fit = Math.min(1, (bounds.width - 32) / (topics.right - topics.left), (bounds.height - 32) / (topics.bottom - topics.top));
          const proposedScale = Math.min(1, mind.scaleVal * fit);
          const smallestFont = Math.min(...[...mind.container.querySelectorAll<HTMLElement>('me-tpc')].map(node => parseFloat(getComputedStyle(node).fontSize)));
          // A large legal tree cannot be overviewed at readable text size on a
          // phone. Keep the native readable root-centred camera in that case;
          // the user can pan to distant nodes instead of starting at 3px text.
          if (proposedScale < Math.max(mind.scaleMin, 12 / smallestFont)) return;
          mind.scale(proposedScale);
          const fitted = topicBounds();
          if (fitted) mind.move((bounds.left + bounds.right - fitted.left - fitted.right) / 2,
            (bounds.top + bounds.bottom - fitted.top - fitted.bottom) / 2);
        });
      });
    });
    mind.disposable.push(() => {
      disposed = true; cancelAnimationFrame(frame); el.classList.remove('dooknow-mindmap-editor');
      for (const event of ['pointerdown', 'wheel', 'keydown']) mind.container.removeEventListener(event, touched, true);
    });
  }
  // The library consumes its native clipboard protocol before pasteHandler. Guard in
  // capture phase so untrusted image/HTML fields never reach the rendering engine.
  const guardPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData('text/plain') || '';
    const reject = () => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    if (event.target instanceof Element && event.target.closest('#input-box')) {
      reject();
      if (text.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(text))
        document.execCommand('insertText', false, text);
      return;
    }
    if (text.length > 256 * 1024) {
      reject();
      return;
    }
    try {
      const payload = JSON.parse(text);
      if (payload?.magic !== 'MIND-ELIXIR-WAIT-COPY' || !Array.isArray(payload.data)) {
        reject();
        return;
      }
      const allowed = new Set(['id', 'topic', 'children', 'expanded', 'direction']);
      let count = 0;
      const safeNode = (node: Record<string, unknown>, depth: number): MindmapNode => {
        if (
          !node ||
          typeof node !== 'object' ||
          Array.isArray(node) ||
          depth > 64 ||
          ++count > 499 ||
          Object.keys(node).some((key) => !allowed.has(key)) ||
          (node.expanded !== undefined && typeof node.expanded !== 'boolean') ||
          (node.direction !== undefined && node.direction !== 0 && node.direction !== 1) ||
          (node.children !== undefined && !Array.isArray(node.children))
        )
          throw Error('不支持的粘贴');
        return {
          id: node.id as string,
          topic: node.topic as string,
          children: ((node.children || []) as Record<string, unknown>[]).map((child) =>
            safeNode(child, depth + 1),
          ),
        };
      };
      const roots = payload.data.map((node: Record<string, unknown>) => safeNode(node, 0));
      serializeMindmapOutline({ id: 'clipboard-root', topic: '粘贴', children: roots });
      const countCurrent = (node: MindmapNode): number =>
        1 + node.children.reduce((total, child) => total + countCurrent(child), 0);
      if (countCurrent(readMindmapTree(mind)) + count > 500) reject();
    } catch {
      reject();
    }
  };
  mind.container.addEventListener('paste', guardPaste, true);
  mind.disposable.push(() => mind.container.removeEventListener('paste', guardPaste, true));
  return mind;
}
export function readMindmapTree(mind: MindElixirInstance): MindmapNode {
  const data = mind.getData();
  if (data.arrows?.length || data.summaries?.length)
    throw Error('当前 Markdown 脑图不支持关系线或摘要');
  const seen = new Set<string>();
  const read = (node: NodeObj, depth: number): MindmapNode => {
    if (depth > 64 || seen.size >= 500 || seen.has(node.id)) throw Error('脑图节点超限或身份重复');
    seen.add(node.id);
    if ((node.style && Object.keys(node.style).length) || node.branchColor)
      throw Error('当前 Markdown 脑图不支持节点样式，请撤销样式修改后保存');
    if (
      node.image ||
      node.hyperLink ||
      node.dangerouslySetInnerHTML ||
      node.note ||
      node.tags?.length ||
      node.icons?.length
    )
      throw Error('当前 Markdown 脑图仅支持纯文本节点');
    return {
      id: node.id,
      topic: node.topic,
      children: (node.children || []).map((child) => read(child, depth + 1)),
    };
  };
  const root = read(data.nodeData, 0);
  serializeMindmapOutline(root);
  return root;
}

/** Render a fixed copy, fully expanded, without touching the live editor's view/history. */
export async function renderMindmapPng(root: MindmapNode): Promise<Blob> {
  const snapshot = parseMindmapOutline(serializeMindmapOutline(root));
  const host = document.createElement('div');
  Object.assign(host.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    width: '1200px',
    height: '800px',
    pointerEvents: 'none',
  });
  host.setAttribute('aria-hidden', 'true');
  document.body.append(host);
  let mind: MindElixirInstance | undefined;
  try {
    await document.fonts.ready;
    mind = mountMindmap(host, snapshot, true);
    await document.fonts.ready;
    // The capture target sizes itself to the complete tree, including offscreen nodes.
    mind.map.style.transform = 'none';
    const rect = mind.nodes.getBoundingClientRect();
    if (!rect.width || !rect.height) throw Error('脑图尚未完成布局');
    const scale = Math.min(
      1,
      8192 / rect.width,
      8192 / rect.height,
      Math.sqrt(16_777_216 / (rect.width * rect.height)),
    );
    const capture = await snapdom(mind.nodes, {
      backgroundColor: '#ffffff',
      embedFonts: false,
      dpr: 1,
      width: Math.max(1, Math.floor(rect.width * scale)),
      height: Math.max(1, Math.floor(rect.height * scale)),
      exclude: ['me-epd', '.mind-elixir-toolbar', '#input-box'],
      excludeMode: 'hide',
      clip: null,
      fast: false,
    });
    const blob = await capture.toBlob({ type: 'png' });
    if (blob.type !== 'image/png' || blob.size > 10 * 1024 * 1024) throw Error('脑图 PNG 预览超限');
    return blob;
  } finally {
    mind?.destroy();
    host.remove();
  }
}
