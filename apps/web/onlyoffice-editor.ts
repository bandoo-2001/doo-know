export type OfficeEditor = {
  destroyEditor(): void;
  requestClose(): void;
};

type EditorConstructor = new (placeholderId: string, config: object) => OfficeEditor;

declare global {
  interface Window {
    DocsAPI?: { DocEditor: EditorConstructor };
  }
}

let current: { source: string; load: Promise<EditorConstructor> } | undefined;

export function loadOfficeEditor(editorUrl: string): Promise<EditorConstructor> {
  const base = new URL(editorUrl);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error('ONLYOFFICE 服务地址无效');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const source = new URL('web-apps/apps/api/documents/api.js', base).href;
  if (current) {
    if (current.source !== source) throw new Error('ONLYOFFICE 服务地址已变化，请刷新后重新打开');
    return current.load;
  }

  const load = new Promise<EditorConstructor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = source;
    script.async = true;
    const timer = window.setTimeout(() => fail('连接 ONLYOFFICE 超时，请重试'), 20_000);
    function cleanEvents() {
      window.clearTimeout(timer);
      script.onload = null;
      script.onerror = null;
    }
    function fail(message: string) {
      cleanEvents();
      script.remove();
      reject(new Error(message));
    }
    script.onload = () => {
      const Editor = window.DocsAPI?.DocEditor;
      if (typeof Editor !== 'function') return fail('ONLYOFFICE 服务未返回可用的编辑器');
      cleanEvents();
      resolve(Editor);
    };
    script.onerror = () => fail('无法连接 ONLYOFFICE，请检查服务地址和网络');
    document.head.append(script);
  }).catch((error) => {
    current = undefined;
    throw error;
  });
  current = { source, load };
  return load;
}
