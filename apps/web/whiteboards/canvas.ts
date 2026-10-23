import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Excalidraw,
  serializeAsJSON,
  exportToSvg,
  exportToBlob,
  restoreElements,
  convertToExcalidrawElements,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, AppState, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { withWhiteboardId, type WhiteboardScene } from '../../../shared/whiteboard';
import '@excalidraw/excalidraw/index.css';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH: string | string[];
  }
}
window.EXCALIDRAW_ASSET_PATH = new URL('/assets/excalidraw/', location.origin).href;
export function mountCanvas(
  container: HTMLElement,
  scene: WhiteboardScene,
  changed: (content: string, initial: boolean) => void,
) {
  let api: ExcalidrawImperativeAPI | undefined,
    root: Root | undefined = createRoot(container),
    first = true;
  const initialData = { ...scene, scrollToContent: true };
  const theme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  const render = () =>
    root?.render(
      createElement(Excalidraw, {
        initialData: initialData as any,
        langCode: 'zh-CN',
        theme: theme(),
        excalidrawAPI: (value: ExcalidrawImperativeAPI) => {
          api = value;
        },
        onChange: (elements: readonly ExcalidrawElement[], state: AppState, files: BinaryFiles) => {
          const content = serializeAsJSON(
            elements,
            {
              viewBackgroundColor: state.viewBackgroundColor,
              gridSize: state.gridSize,
              gridStep: state.gridStep,
              gridModeEnabled: state.gridModeEnabled,
            },
            files,
            'local',
          );
          const initial = first;
          first = false;
          changed(scene.dooknow ? withWhiteboardId(content, scene.dooknow.id) : content, initial);
          if (initial && elements.length)
            requestAnimationFrame(() =>
              api?.scrollToContent(elements, {
                fitToViewport: true,
                viewportZoomFactor: 0.8,
                maxZoom: 1,
              }),
            );
        },
        validateEmbeddable: () => false,
        UIOptions: {
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            export: false,
            saveAsImage: false,
          },
        },
      }),
    );
  render();
  const observer = new MutationObserver(render);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return {
    dispose() {
      observer.disconnect();
      root?.unmount();
      root = undefined;
      api = undefined;
    },
    async png() {
      if (!api) throw Error('画布仍在加载');
      return exportToBlob({
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
        mimeType: 'image/png',
      });
    },
  };
}
export async function sceneSvg(scene: WhiteboardScene) {
  const elements = restoreElements(scene.elements as any, null);
  const svg = await exportToSvg({
    elements,
    files: scene.files as any,
    appState: { ...scene.appState, exportBackground: true, exportWithDarkMode: false },
    exportPadding: 24,
  });
  return svg.outerHTML;
}
export async function mermaidScene(code: string): Promise<WhiteboardScene> {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  const result = await parseMermaidToExcalidraw(code, {
    startOnLoad: false,
    maxEdges: 500,
    maxTextSize: 50000,
  });
  return {
    type: 'excalidraw',
    version: 2,
    source: 'DooKnow',
    elements: convertToExcalidrawElements(result.elements as any) as any,
    files: (result.files || {}) as any,
    appState: { viewBackgroundColor: '#ffffff' },
  };
}
