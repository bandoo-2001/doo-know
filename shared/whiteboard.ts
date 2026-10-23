export const MAX_WHITEBOARD_BYTES = 8 * 1024 * 1024;
export const MAX_WHITEBOARD_ELEMENTS = 10_000;
export const isWhiteboard = (path: string) => /\.excalidraw$/i.test(path);
export const isDocument = (path: string) => /\.(?:md|excalidraw)$/i.test(path);
export const documentType = (path: string): 'markdown' | 'whiteboard' =>
  isWhiteboard(path) ? 'whiteboard' : 'markdown';
export function documentTitle(path: string, content = '') {
  return (
    (isWhiteboard(path) ? '' : content.match(/^#\s+(.+)$/m)?.[1]) ||
    path
      .split('/')
      .at(-1)!
      .replace(/\.(?:md|excalidraw)$/i, '')
  );
}
export type WhiteboardScene = {
  dooknow?: { id: string };
  type: 'excalidraw';
  version: number;
  source?: string;
  elements: Record<string, any>[];
  appState: Record<string, any>;
  files: Record<string, { id: string; mimeType: string; dataURL: string; [key: string]: any }>;
};
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function emptyWhiteboard(): WhiteboardScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'DooKnow',
    elements: [],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {},
  };
}
export function parseWhiteboard(content: string): WhiteboardScene {
  const invalid = () => {
    throw Error('白板文件格式不正确，请选择有效的 .excalidraw 文件');
  };
  if (new TextEncoder().encode(content).length > MAX_WHITEBOARD_BYTES)
    throw Error('白板文件不能超过 8 MiB');
  let scene: any;
  try {
    scene = JSON.parse(content);
  } catch {
    return invalid();
  }
  if (
    !object(scene) ||
    scene.type !== 'excalidraw' ||
    !Number.isInteger(scene.version) ||
    scene.version < 1 ||
    !Array.isArray(scene.elements) ||
    scene.elements.length > MAX_WHITEBOARD_ELEMENTS ||
    (scene.appState !== undefined && !object(scene.appState)) ||
    (scene.files !== undefined && !object(scene.files))
  )
    return invalid();
  const stack: { value: unknown; depth: number }[] = [{ value: scene, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (depth > 64) return invalid();
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) return invalid();
        if (child && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
  }
  const ids = new Set<string>();
  if (
    scene.dooknow !== undefined &&
    (!object(scene.dooknow) ||
      typeof scene.dooknow.id !== 'string' ||
      !whiteboardId(scene.dooknow.id))
  )
    return invalid();
  for (const element of scene.elements) {
    if (
      !object(element) ||
      typeof element.id !== 'string' ||
      !element.id ||
      ids.has(element.id) ||
      typeof element.type !== 'string' ||
      ![
        'rectangle',
        'diamond',
        'ellipse',
        'line',
        'arrow',
        'freedraw',
        'text',
        'image',
        'frame',
        'magicframe',
        'embeddable',
        'iframe',
        'selection',
      ].includes(element.type)
    )
      return invalid();
    ids.add(element.id);
    for (const field of ['x', 'y', 'width', 'height', 'angle', 'opacity', 'version', 'seed'])
      if (
        element[field] !== undefined &&
        (typeof element[field] !== 'number' || !Number.isFinite(element[field]))
      )
        return invalid();
    for (const field of ['x', 'y', 'width', 'height'])
      if (element[field] !== undefined && Math.abs(element[field]) > 10_000_000) return invalid();
    if (
      element.points !== undefined &&
      (!Array.isArray(element.points) ||
        element.points.some(
          (point: unknown) =>
            !Array.isArray(point) ||
            point.length !== 2 ||
            point.some(
              (v) => typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 10_000_000,
            ),
        ))
    )
      return invalid();
    for (const field of ['groupIds', 'boundElementIds'])
      if (
        element[field] !== undefined &&
        (!Array.isArray(element[field]) ||
          element[field].some((id: unknown) => typeof id !== 'string'))
      )
        return invalid();
    if (
      element.boundElements != null &&
      (!Array.isArray(element.boundElements) ||
        element.boundElements.some(
          (bound: unknown) =>
            !object(bound) ||
            typeof bound.id !== 'string' ||
            !['arrow', 'text'].includes(bound.type),
        ))
    )
      return invalid();
    for (const field of ['startBinding', 'endBinding']) {
      const binding = element[field];
      if (
        binding != null &&
        (!object(binding) ||
          typeof binding.elementId !== 'string' ||
          ['focus', 'gap'].some(
            (key) =>
              binding[key] !== undefined &&
              (typeof binding[key] !== 'number' || !Number.isFinite(binding[key])),
          ))
      )
        return invalid();
    }
    if (
      element.pressures !== undefined &&
      (!Array.isArray(element.pressures) ||
        element.pressures.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)))
    )
      return invalid();
    if (
      element.fixedSegments != null &&
      (!Array.isArray(element.fixedSegments) ||
        element.fixedSegments.some(
          (part: unknown) =>
            !object(part) ||
            !Number.isInteger(part.index) ||
            ['start', 'end'].some(
              (key) =>
                !Array.isArray(part[key]) ||
                part[key].length !== 2 ||
                part[key].some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n)),
            ),
        ))
    )
      return invalid();
    if (
      element.roundness != null &&
      (!object(element.roundness) || typeof element.roundness.type !== 'number')
    )
      return invalid();
    for (const field of ['fontFamily', 'fontSize', 'lineHeight'])
      if (
        element[field] !== undefined &&
        (typeof element[field] !== 'number' ||
          !Number.isFinite(element[field]) ||
          element[field] <= 0 ||
          element[field] > 10000)
      )
        return invalid();
    if (element.text !== undefined && typeof element.text !== 'string') return invalid();
    if (
      element.link != null &&
      (typeof element.link !== 'string' ||
        /[\u0000-\u001f]/.test(element.link) ||
        (/^[a-z][a-z\d+.-]*:/i.test(element.link) &&
          !/^(https?:|mailto:|tel:)/i.test(element.link)) ||
        element.link.startsWith('//'))
    )
      return invalid();
  }
  for (const [id, file] of Object.entries(scene.files || {}) as [string, any][]) {
    if (
      !object(file) ||
      file.id !== id ||
      typeof file.dataURL !== 'string' ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mimeType) ||
      !file.dataURL.startsWith(`data:${file.mimeType};base64,`) ||
      !/^[A-Za-z\d+/]*={0,2}$/.test(file.dataURL.split(',')[1])
    )
      return invalid();
  }
  const settings = scene.appState || {};
  if (
    settings.viewBackgroundColor !== undefined &&
    (typeof settings.viewBackgroundColor !== 'string' || settings.viewBackgroundColor.length > 200)
  )
    return invalid();
  for (const key of ['gridSize', 'gridStep', 'exportScale'])
    if (
      settings[key] != null &&
      (typeof settings[key] !== 'number' ||
        !Number.isFinite(settings[key]) ||
        settings[key] <= 0 ||
        settings[key] > (key === 'exportScale' ? 32 : 10000))
    )
      return invalid();
  for (const key of ['gridModeEnabled', 'exportBackground', 'exportWithDarkMode'])
    if (settings[key] !== undefined && typeof settings[key] !== 'boolean') return invalid();
  const vector = (value: unknown) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 10_000_000);
  for (const element of scene.elements) {
    if (element.scale !== undefined && !vector(element.scale)) return invalid();
    if (element.lastCommittedPoint != null && !vector(element.lastCommittedPoint)) return invalid();
    for (const key of ['startBinding', 'endBinding'])
      if (element[key]?.fixedPoint != null && !vector(element[key].fixedPoint)) return invalid();
  }
  const appState: Record<string, any> = {};
  for (const key of [
    'viewBackgroundColor',
    'gridSize',
    'gridStep',
    'gridModeEnabled',
    'exportBackground',
    'exportWithDarkMode',
    'exportScale',
  ])
    if (scene.appState?.[key] !== undefined) appState[key] = scene.appState[key];
  return {
    ...scene,
    elements: scene.elements.map((element: Record<string, any>) =>
      element.type === 'text'
        ? {
            fontFamily: 2,
            fontSize: 20,
            lineHeight: 1.25,
            textAlign: 'left',
            verticalAlign: 'top',
            ...element,
          }
        : element,
    ),
    appState,
    files: scene.files || {},
  } as WhiteboardScene;
}
export function whiteboardText(content: string) {
  const scene = parseWhiteboard(content);
  return scene.elements
    .filter((e) => e.type === 'text' && !e.isDeleted)
    .map((e) => (typeof e.text === 'string' ? e.text : ''))
    .join('\n');
}
export function whiteboardId(code: string) {
  const id = code.trim();
  return /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) ? id : undefined;
}
export function withWhiteboardId(content: string, id: string) {
  if (!whiteboardId(id)) throw Error('白板标识无效');
  const { dooknow: _, ...scene } = JSON.parse(content);
  const result = JSON.stringify({ dooknow: { id }, ...scene }, null, 2);
  return result;
}
export function whiteboardReference(code: string) {
  const value = code.trim();
  return (
    whiteboardId(value) ||
    (value.length <= 1000 &&
    !/[\r\n\\:\u0000-\u001f]/.test(value) &&
    !value.startsWith('/') &&
    isWhiteboard(value)
      ? value
      : undefined)
  );
}
export function whiteboardFence(id: string) {
  if (!whiteboardId(id)) throw Error('白板引用无效');
  return '\n\n```excalidraw\n' + id + '\n```\n\n';
}
