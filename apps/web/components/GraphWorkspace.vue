<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Core } from 'cytoscape';
import type { TreeEntry } from '../../../shared/contracts';
import { api } from '../api';
import { createGraphWorkbench } from '../graph-workbench';
import '../graph.css';
const props = defineProps<{ tree: TreeEntry[] }>();
const emit = defineEmits<{ back: []; 'open-note': [id: string] }>();
const model = createGraphWorkbench((url) => api(url));
const { state } = model;
const canvas = ref<HTMLElement>();
const view = ref<'graph' | 'list'>('graph');
const graphError = ref('');
let cy: Core | undefined;
let disposed = false;
let renderGeneration = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let observer: ResizeObserver | undefined;
let themeObserver: MutationObserver | undefined;
const folders = computed(() => {
  const result: TreeEntry[] = [];
  function collect(entries: TreeEntry[]) {
    for (const entry of entries)
      if (entry.type === 'folder') {
        result.push(entry);
        collect(entry.children || []);
      }
  }
  collect(props.tree);
  return result;
});
const previousScope = computed(
  () => state.result && JSON.stringify(state.resultQuery) !== JSON.stringify(state.query),
);
const selected = computed(() => state.result?.nodes.find((node) => node.id === state.selectedId));
const incoming = computed(() => related('incoming'));
const outgoing = computed(() => related('outgoing'));
function related(direction: 'incoming' | 'outgoing') {
  const ids = new Set(
    state.result?.edges
      .filter((edge) =>
        direction === 'incoming'
          ? edge.target === state.selectedId
          : edge.source === state.selectedId,
      )
      .map((edge) => (direction === 'incoming' ? edge.source : edge.target)),
  );
  return state.result?.nodes.filter((node) => ids.has(node.id)) || [];
}
function refresh() {
  clearTimeout(searchTimer);
  void model.load();
}
function search() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 250);
}
function focus(depth: 1 | 2) {
  if (!selected.value) return;
  state.query.focus = selected.value.id;
  state.query.depth = depth;
  refresh();
}
function clearFocus() {
  state.query.focus = undefined;
  refresh();
}
function choose(id: string) {
  model.select(id);
  cy?.nodes().unselect();
  cy?.getElementById(id).select();
}
async function renderGraph() {
  const current = ++renderGeneration;
  await nextTick();
  if (!canvas.value || view.value !== 'graph' || disposed) return;
  try {
    const { default: cytoscape } = await import('cytoscape');
    if (disposed || current !== renderGeneration || !canvas.value) return;
    cy?.destroy();
    const color = getComputedStyle(canvas.value).color;
    cy = cytoscape({
      container: canvas.value,
      elements: [
        ...(state.result?.nodes || []).map((node) => ({
          data: { id: node.id, label: node.title },
        })),
        ...(state.result?.edges || []).map((edge) => ({ data: edge })),
      ],
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': '#1688ff',
            color,
            'font-size': 11,
            'text-valign': 'bottom',
            'text-margin-y': 7,
            'text-max-width': '100px',
            'text-wrap': 'ellipsis',
            width: 24,
            height: 24,
          },
        },
        {
          selector: 'edge',
          style: {
            width: 1.5,
            'line-color': '#91acc7',
            'target-arrow-color': '#91acc7',
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
          },
        },
        {
          selector: ':selected',
          style: { 'background-color': '#ef9b36', 'border-width': 3, 'border-color': '#f4c98c' },
        },
      ],
      layout: { name: 'cose', animate: false, padding: 40 },
      minZoom: 0.1,
      maxZoom: 4,
    });
    cy.on('tap', 'node', (event) => model.select(event.target.id()));
    if (state.selectedId) cy.getElementById(state.selectedId).select();
    graphError.value = '';
  } catch {
    graphError.value = '关系画布加载失败，请重试，或使用笔记列表。';
  }
}
watch(() => state.result, renderGraph);
watch(view, () => {
  if (view.value === 'list') {
    renderGeneration++;
    cy?.destroy();
    cy = undefined;
  } else void renderGraph();
});
onMounted(() => {
  refresh();
  themeObserver = new MutationObserver(() => void renderGraph());
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  observer = new ResizeObserver(() => cy?.resize());
  if (canvas.value) observer.observe(canvas.value);
});
onBeforeUnmount(() => {
  disposed = true;
  renderGeneration++;
  clearTimeout(searchTimer);
  observer?.disconnect();
  themeObserver?.disconnect();
  cy?.destroy();
  model.dispose();
});
</script>
<template>
  <section class="graph-workspace" aria-labelledby="graph-title">
    <header class="graph-header">
      <button type="button" @click="emit('back')">← 返回应用</button>
      <div>
        <h1 id="graph-title">知识图谱</h1>
        <p>沿着笔记中的引用，发现知识之间的联系。</p>
      </div>
      <button type="button" :disabled="state.loading" @click="refresh">刷新图谱</button>
    </header>
    <div class="graph-filters">
      <input
        v-model="state.query.q"
        type="search"
        placeholder="搜索标题或路径"
        aria-label="搜索图谱笔记"
        @input="search"
      />
      <select v-model="state.query.folder" aria-label="图谱目录" @change="refresh">
        <option :value="undefined">全部目录</option>
        <option v-for="folder in folders" :key="folder.path" :value="folder.path">
          {{ folder.path }}
        </option>
      </select>
      <label
        ><input
          type="checkbox"
          :checked="state.query.mode === 'orphans'"
          @change="
            state.query.mode = ($event.target as HTMLInputElement).checked ? 'orphans' : 'all';
            refresh();
          "
        />仅显示孤立笔记</label
      >
      <div class="graph-views" aria-label="显示方式">
        <button type="button" :aria-pressed="view === 'graph'" @click="view = 'graph'">图谱</button
        ><button type="button" :aria-pressed="view === 'list'" @click="view = 'list'">列表</button>
      </div>
    </div>
    <div class="graph-status" role="status" aria-live="polite">
      <span v-if="state.loading">正在更新关系索引…</span>
      <span v-if="previousScope">当前仍显示上次筛选结果，等待刷新完成。</span>
      <span v-else-if="state.error && state.result">更新失败，保留上次成功结果。</span>
      <span v-else-if="state.result"
        >{{ state.result.totalNodes }} 篇笔记 · {{ state.result.totalEdges }} 条引用</span
      >
      <span v-if="state.result && state.result.index.pending > 0"
        >索引尚未完成（待处理 {{ state.result.index.pending }}），可刷新继续。</span
      >
      <span v-else-if="state.result && !state.result.index.complete"
        >部分笔记暂未纳入图谱，修复后可刷新重试。</span
      >
      <span v-if="state.result?.index.skipped">{{ state.result.index.skipped }} 篇暂未索引。</span>
      <span v-if="state.result?.truncated">当前仅显示部分关系，请缩小筛选范围。</span>
      <button v-if="state.query.focus" type="button" @click="clearFocus">清除局部关系筛选</button>
    </div>
    <div v-if="state.error" class="graph-error" role="alert">
      {{ state.error }} <button type="button" @click="refresh">重试</button>
    </div>
    <div class="graph-body">
      <div class="graph-main">
        <div v-show="view === 'graph'" class="graph-canvas-wrap">
          <div ref="canvas" class="graph-canvas" role="region" aria-label="笔记关系图" />
          <div class="graph-canvas-tools">
            <button type="button" aria-label="放大图谱" @click="cy?.zoom(cy.zoom() * 1.25)">
              ＋</button
            ><button type="button" aria-label="缩小图谱" @click="cy?.zoom(cy.zoom() / 1.25)">
              −</button
            ><button type="button" @click="cy?.fit(undefined, 40)">适应画布</button>
          </div>
          <p v-if="graphError" class="graph-error">
            {{ graphError }} <button type="button" @click="renderGraph">重试画布</button>
          </p>
        </div>
        <div
          v-if="!state.loading && state.result && !state.result.nodes.length"
          class="graph-empty"
        >
          <h2>暂无匹配的笔记</h2>
          <p>
            调整目录、关键词或孤立笔记筛选。笔记中添加 Markdown 链接或 [[Wiki 引用]]
            后，刷新即可查看关系。
          </p>
        </div>
        <p v-else-if="state.result?.nodes.length && !state.result.edges.length" class="graph-hint">
          当前范围内还没有引用关系。可在原文中添加笔记链接。
        </p>
        <div
          :class="['graph-note-list', { 'graph-note-list-compact': view === 'graph' }]"
          aria-label="图谱笔记列表"
        >
          <button
            v-for="node in state.result?.nodes || []"
            :key="node.id"
            type="button"
            :aria-pressed="state.selectedId === node.id"
            @click="choose(node.id)"
          >
            <strong>{{ node.title }}</strong
            ><span>{{ node.relativePath }}</span
            ><small>引用 {{ node.outgoing }} · 被引 {{ node.incoming }}</small>
          </button>
        </div>
      </div>
      <aside class="graph-details" aria-label="笔记详情">
        <template v-if="selected"
          ><h2>{{ selected.title }}</h2>
          <p class="graph-path">{{ selected.relativePath }}</p>
          <p>引用 {{ selected.outgoing }} · 被引用 {{ selected.incoming }}</p>
          <button class="graph-open" type="button" @click="emit('open-note', selected.id)">
            打开原文
          </button>
          <div class="graph-depth">
            <button type="button" @click="focus(1)">查看 1 跳关系</button
            ><button type="button" @click="focus(2)">查看 2 跳关系</button>
          </div>
          <h3>引用的笔记</h3>
          <button
            v-for="node in outgoing"
            :key="node.id"
            class="graph-related"
            type="button"
            @click="choose(node.id)"
          >
            {{ node.title }}
          </button>
          <p v-if="!outgoing.length">当前图中暂无引用。</p>
          <h3>引用此笔记</h3>
          <button
            v-for="node in incoming"
            :key="node.id"
            class="graph-related"
            type="button"
            @click="choose(node.id)"
          >
            {{ node.title }}
          </button>
          <p v-if="!incoming.length">当前图中暂无反向引用。</p>
          <small>关联列表展示当前图中可见的笔记；筛选或截断可能隐藏部分关系。</small></template
        >
        <template v-else
          ><h2>探索笔记联系</h2>
          <p>点选图谱节点或列表中的笔记，查看引用关系并打开原文。</p></template
        >
      </aside>
    </div>
  </section>
</template>
