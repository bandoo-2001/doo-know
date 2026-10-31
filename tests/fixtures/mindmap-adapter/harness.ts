import {
  mountMindmap,
  readMindmapTree,
  renderMindmapPng,
} from '../../../apps/web/diagrams/mindmap';
import { parseMindmapOutline, type MindmapNode } from '../../../shared/mindmap-outline';
let instance: ReturnType<typeof mountMindmap>;
const adapter = {
  mount(source: string) {
    instance?.destroy();
    instance = mountMindmap(document.querySelector('#map')!, parseMindmapOutline(source));
  },
  mountTree(root: MindmapNode) {
    instance?.destroy();
    instance = mountMindmap(document.querySelector('#map')!, root);
  },
  setRootStyle() {instance.nodeData.style={fontWeight:'bold'};},
  tree() {
    return readMindmapTree(instance);
  },
  undo() {
    instance.undo();
  },
  async snapshotConsistency() {
    const root = { id: 'stable', topic: '固定快照', children: [] };
    const reference = await renderMindmapPng(root);
    const pending = renderMindmapPng(root);
    root.topic = '异步期间的新修改';
    const output = await pending;
    const digest = async (blob: Blob) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
      ).join(',');
    return (await digest(reference)) === (await digest(output));
  },
  async render() {
    const before = JSON.stringify(instance.getData());
    const view = instance.map.style.transform;
    const blob = await renderMindmapPng(readMindmapTree(instance));
    const bitmap = await createImageBitmap(blob);
    const dimensions = {
      width: bitmap.width,
      height: bitmap.height,
      size: blob.size,
      type: blob.type,
    };
    bitmap.close();
    (document.querySelector('#result') as HTMLImageElement).src = URL.createObjectURL(blob);
    return {
      ...dimensions,
      stateUnchanged: before === JSON.stringify(instance.getData()),
      viewUnchanged: view === instance.map.style.transform,
    };
  },
};
declare global {
  interface Window {
    diagramAdapter: typeof adapter;
  }
}
window.diagramAdapter = adapter;
adapter.mount('# 中文根\n\n- 分支\n  - 离屏子节点\n- 另一个分支\n');
