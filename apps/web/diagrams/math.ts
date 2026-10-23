import DOMPurify from 'dompurify';
const generations = new WeakMap<HTMLElement, number>();
export function clearMath(root: HTMLElement) {
  generations.set(root, (generations.get(root) || 0) + 1);
}
export async function syncMath(root: HTMLElement) {
  const generation = (generations.get(root) || 0) + 1;
  generations.set(root, generation);
  const nodes = [...root.querySelectorAll<HTMLElement>('[data-math-source]')];
  if (!nodes.length) return;
  const { renderToString } = await import('katex');
  for (const node of nodes) {
    if (generations.get(root) !== generation || !root.contains(node)) return;
    const encoded = node.dataset.mathSource || '';
    try {
      const source = decodeURIComponent(encoded);
      if (source.length > 10_000) throw Error('公式内容过长');
      const html = renderToString(source, {
        displayMode: node.dataset.mathDisplay === 'block',
        output: 'mathml',
        trust: false,
        throwOnError: true,
        maxExpand: 1000,
        maxSize: 20,
      });
      if (node.dataset.mathSource === encoded) {
        node.innerHTML = DOMPurify.sanitize(html);
        node.removeAttribute('title');
      }
    } catch (cause) {
      node.title = '公式暂时无法预览：' + (cause instanceof Error ? cause.message : '格式错误');
      node.classList.add('knowledge-math-error');
    }
  }
}
