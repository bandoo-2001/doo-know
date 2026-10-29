<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Badge as ABadge,
  Button as AButton,
  Card as ACard,
  Checkbox as ACheckbox,
  Collapse as ACollapse,
  CollapsePanel as ACollapsePanel,
  Divider as ADivider,
  Dropdown as ADropdown,
  Empty as AEmpty,
  Form as AForm,
  FormItem as AFormItem,
  FormItemRest as AFormItemRest,
  Input as AInput,
  InputNumber as AInputNumber,
  InputPassword as AInputPassword,
  InputSearch as AInputSearch,
  List as AList,
  ListItem as AListItem,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Progress as AProgress,
  Segmented as ASegmented,
  Select as ASelect,
  Slider as ASlider,
  Space as ASpace,
  Switch as ASwitch,
  Tag as ATag,
  Textarea as ATextarea,
  Tooltip as ATooltip,
} from 'ant-design-vue';
import type { Core, NodeSingular } from 'cytoscape';
import type { TreeEntry } from '../../../shared/contracts';
import {
  graphEntityKinds,
  type GraphModelUpdate,
  type GraphEvidence,
} from '../../../shared/graph-semantic-contracts';
import GraphOverlay from './graph/GraphOverlay.vue';
import GraphInspectorContent from './graph/GraphInspector.vue';
import DirectoryTreeSelect from './DirectoryTreeSelect.vue';
import Icon from './Icon.vue';
import { graphLabels as labels, graphTaskErrorLabel } from './graph/labels';
import { graphApi } from '../graph-request';
import { createGraphWorkbench } from '../graph-workbench';
import '../graph.css';
const props = defineProps<{ tree: TreeEntry[] }>();
const emit = defineEmits<{ back: []; 'open-note': [id: string, line?: number] }>();
const model = createGraphWorkbench(graphApi),
  { state } = model;
const canvas = ref<HTMLElement>();
const view = ref<'graph' | 'list'>('graph');
const colorBy = ref<'type' | 'community'>('type');
const panel = ref('');
const mobile = ref(false);
const graphError = ref('');
const draft = ref<GraphModelUpdate>();
// Ant form slots can finish their closing render after the draft is cleared.
const modelDraft = computed<GraphModelUpdate>(
  () =>
    draft.value || {
      expectedVersion: 0,
      provider: 'none',
      baseUrl: '',
      model: '',
      automatic: true,
      remoteContentAllowed: false,
      timeoutMs: 60000,
      maxInputCharacters: 12000,
      outputFormat: 'schema',
    },
);
const baseline = ref('');
const secret = ref('');
const clearKey = ref(false);
const testMessage = ref('');
const question = ref('');
const viewName = ref('');
const reviewStatus = ref('suggested');
const reviewSearch = ref('');
const edits = ref<Record<string, string>>({});
const node = computed(() => state.result?.nodes.find((n) => n.id === state.selectedId));
const edge = computed(() => state.result?.edges.find((e) => e.id === state.selectedId));
const dirty = computed(
  () =>
    panel.value === 'model' &&
    !!draft.value &&
    (!!secret.value || clearKey.value || JSON.stringify(draft.value) !== baseline.value),
);
const title = computed(
  () =>
    ({
      model: '模型设置',
      tasks: '后台分析',
      review: '关系审核',
      filters: '筛选与路径',
      views: '视图与导出',
      ask: '图谱问答',
    })[panel.value] || '详情',
);

const colors: Record<string, string> = {
  note: '#7188a5',
  concept: '#6b9c9a',
  person: '#a78bba',
  organization: '#b0996a',
  place: '#78a17c',
  event: '#b98780',
  technology: '#779fc0',
};
const statusText = computed(() =>
  state.status?.provider === 'none' &&
  state.status.state === 'waiting-model' &&
  state.status.pending === 0
    ? '基础分析就绪'
    : {
        idle: '已更新',
        running: '分析中',
        paused: '已暂停',
        'waiting-model': '等待模型',
        failed: '部分失败',
        queued: '等待分析',
      }[state.status?.state || 'idle'],
);
const folders = computed(() => {
  const result: string[] = [];
  function walk(entries: TreeEntry[]) {
    for (const item of entries)
      if (item.type === 'folder') {
        result.push(item.path);
        walk(item.children || []);
      }
  }
  walk(props.tree);
  return result;
});
const folderOptions = computed(() => folders.value.map((path) => ({ label: path, value: path })));
const nodeTypeOptions = ['note', ...graphEntityKinds].map((value) => ({
  value,
  label: labels[value],
}));
const relationTypeOptions = [
  'reference',
  'mentions',
  'cooccurs',
  'similarity',
  'semantic',
  'manual',
].map((value) => ({ value, label: labels[value] }));
const availableNodeOptions = computed(() =>
  (state.result?.nodes || []).map((item) => ({ value: item.id, label: item.title })),
);
const providerOptions = [
  { value: 'none', label: '基础本地分析' },
  { value: 'ollama', label: 'Ollama · 本地模型' },
  { value: 'openai-compatible', label: 'OpenAI 兼容 API' },
];
const progressPercent = computed(() =>
  Math.min(
    100,
    Math.round(((state.status?.completed || 0) / Math.max(1, state.status?.total || 0)) * 100),
  ),
);
const statusKind = computed<'default' | 'processing' | 'success' | 'error'>(() =>
  state.status?.state === 'failed'
    ? 'error'
    : state.status?.state === 'running' || state.status?.state === 'queued'
      ? 'processing'
      : state.status?.state === 'paused'
        ? 'default'
        : 'success',
);
const panelDescription = computed(
  () =>
    ({
      filters: '缩小范围，聚焦值得探索的联系。',
      tasks: '查看自动分析进度，管理待处理和失败的资料。',
      model: '选择基础分析，或连接已有的本地模型与模型 API。',
      review: '核对原文证据，再确认、修改或忽略模型建议。',
      views: '保存探索范围，或导出当前图谱。',
      ask: '根据原文证据提问，回答保留可追溯的来源。',
    })[panel.value],
);
function changeGraphView(value: string | number) {
  if (value === 'notes' || value === 'knowledge') {
    state.query.view = value;
    refresh();
  }
}
function changeDisplayView(value: string | number) {
  view.value = value === 'list' ? 'list' : 'graph';
}
function nodeTitle(id: string) {
  return state.result?.nodes.find((item) => item.id === id)?.title || '笔记';
}
let cy: Core | undefined,
  disposed = false,
  renderGeneration = 0;
const positionCache = new Map<string, { x: number; y: number }>();
let hasLaidOut = false;
function rememberPositions() {
  cy?.nodes().forEach((node) => {
    positionCache.delete(node.id());
    positionCache.set(node.id(), { ...node.position() });
  });
  while (positionCache.size > 2000) positionCache.delete(positionCache.keys().next().value!);
}
let timer: ReturnType<typeof setTimeout> | undefined;
let reviewTimer: ReturnType<typeof setTimeout> | undefined;
function refreshReview() {
  clearTimeout(reviewTimer);
  void model.review(reviewStatus.value, reviewSearch.value);
}
function searchReview() {
  clearTimeout(reviewTimer);
  reviewTimer = setTimeout(refreshReview, 300);
}
let resize: ResizeObserver | undefined, theme: MutationObserver | undefined;
function refresh() {
  clearTimeout(timer);
  void model.load();
}
function search() {
  clearTimeout(timer);
  timer = setTimeout(refresh, 300);
}
function openPanel(name: string) {
  panel.value = name;
  if (name === 'model') {
    draft.value = undefined;
    initializeDraft();
  }
  if (name === 'review')
    void model
      .review(reviewStatus.value, reviewSearch.value)
      .catch((e) => (state.error = String(e)));
}
function initializeDraft() {
  if (!state.settings) return;
  {
    const { version, apiKeyConfigured, ...settings } = state.settings;
    draft.value = {
      ...settings,
      outputFormat: settings.outputFormat || 'schema',
      expectedVersion: version,
    };
    baseline.value = JSON.stringify(draft.value);
    secret.value = '';
    clearKey.value = false;
    testMessage.value = '';
  }
}
watch(
  () => state.settings,
  () => {
    if (panel.value === 'model' && !draft.value) initializeDraft();
  },
);
function select(id: string) {
  model.select(id);
  cy?.elements().unselect();
  cy?.nodes().removeClass('neighbor');
  if (id) cy?.getElementById(id).neighborhood('node').addClass('neighbor');
  if (id) cy?.getElementById(id).select();
}
function focus(depth: 1 | 2) {
  if (!node.value) return;
  state.query.q = undefined;
  state.query.target = undefined;
  state.query.mode = 'all';
  state.query.focus = node.value.id;
  state.query.depth = depth;
  refresh();
}
function forwardOpenNote(id: string, line?: number) {
  emit('open-note', id, line);
}
function openSource(item: GraphEvidence) {
  emit('open-note', item.noteId, item.startLine);
}
function download(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportPng() {
  if (!cy) return;
  const a = document.createElement('a');
  a.href = cy.png({ bg: getComputedStyle(canvas.value!).backgroundColor, scale: 2 });
  a.download = 'knowledge-graph.png';
  a.click();
}
async function saveSettings() {
  if (!draft.value) return;
  const saved = await model.saveSettings({
    ...draft.value,
    ...(clearKey.value ? { apiKey: null } : secret.value ? { apiKey: secret.value } : {}),
  });
  if (saved) {
    secret.value = '';
    clearKey.value = false;
    draft.value.expectedVersion = saved.version;
    baseline.value = JSON.stringify(draft.value);
    testMessage.value = '设置已保存';
  }
}
async function renderGraph() {
  const current = ++renderGeneration;
  await nextTick();
  if (!canvas.value || view.value !== 'graph' || disposed) return;
  try {
    const { default: cytoscape } = await import('cytoscape');
    if (disposed || current !== renderGeneration) return;
    const color = getComputedStyle(canvas.value).color;
    const elements = [
      ...(state.result?.nodes || []).map((n, i) => ({
        data: {
          ...n,
          label: n.title,
          color:
            colorBy.value === 'community' && n.community
              ? Object.values(colors)[
                  Array.from(n.community).reduce((sum, c) => sum + c.charCodeAt(0), 0) %
                    Object.values(colors).length
                ]
              : colors[n.kind] || colors.note,
        },
        classes: i < 10 ? 'prominent' : '',
      })),
      ...(state.result?.edges || []).map((e) => ({
        data: { ...e, label: e.label || '引用' },
        classes: e.kind === 'similarity' || e.status === 'suggested' ? 'suggested' : '',
      })),
    ];
    if (!cy) {
      cy = cytoscape({
        container: canvas.value,
        elements: [],
        minZoom: 0.1,
        maxZoom: 4,
        layout: { name: 'preset' },
        style: [
          {
            selector: 'node',
            style: {
              label: '',
              'background-color': 'data(color)',
              color,
              'font-size': 11,
              'text-valign': 'bottom',
              'text-margin-y': 7,
              'text-max-width': '110px',
              'text-wrap': 'ellipsis',
              width: 23,
              height: 23,
            },
          },
          {
            selector: 'node.prominent, node.neighbor, node:selected, node:active',
            style: { label: 'data(label)' },
          },
          {
            selector: 'edge',
            style: {
              width: 1,
              'line-color': '#91a1b4',
              opacity: 0.5,
              'target-arrow-color': '#91a1b4',
              'target-arrow-shape': 'triangle',
              'curve-style': 'bezier',
            },
          },
          {
            selector: 'edge[kind = "cooccurs"], edge[kind = "similarity"]',
            style: { 'target-arrow-shape': 'none' },
          },
          {
            selector: 'edge.suggested',
            style: { 'line-style': 'dashed' },
          },
          {
            selector: ':selected',
            style: { 'border-width': 3, 'border-color': '#d5a15c', opacity: 1 },
          },
          {
            selector: 'edge:selected',
            style: { label: 'data(label)', color, 'font-size': 11, width: 2 },
          },
        ],
      });
      cy.on('tap', 'node, edge', (e) => select(e.target.id()));
      cy.on('tap', (e) => {
        if (e.target === cy) select('');
      });
    }
    rememberPositions();
    const oldIds = new Set(cy.nodes().map((n) => n.id()));
    const zoom = cy.zoom(),
      pan = cy.pan();
    cy.batch(() => {
      const ids = new Set(elements.map((e) => e.data.id));
      cy!
        .elements()
        .filter((e) => !ids.has(e.id()))
        .remove();
      for (const element of elements) {
        const old = cy!.getElementById(element.data.id);
        if (old.length) {
          old.data(element.data);
          old.toggleClass('suggested', element.classes === 'suggested');
          old.toggleClass('prominent', element.classes === 'prominent');
        } else cy!.add(element);
      }
    });
    if (!hasLaidOut && cy.nodes().length) {
      cy.layout({ name: 'cose', animate: false, padding: 45 }).run();
      hasLaidOut = true;
    } else {
      const placed = new Set(oldIds);
      const added = cy.nodes().filter((n) => !oldIds.has(n.id()));
      // Restore returning nodes before placing genuinely new content.
      added.forEach((node) => {
        const cached = positionCache.get(node.id());
        if (cached) {
          node.position(cached);
          placed.add(node.id());
        }
      });
      const anchors = cy.nodes().filter((node) => placed.has(node.id()));
      const center = anchors.length
        ? {
            x:
              anchors.reduce((sum, node) => sum + (node as NodeSingular).position('x'), 0) /
              anchors.length,
            y:
              anchors.reduce((sum, node) => sum + (node as NodeSingular).position('y'), 0) /
              anchors.length,
          }
        : { x: (cy.width() / 2 - pan.x) / zoom, y: (cy.height() / 2 - pan.y) / zoom };
      let unconnected = 0;
      added.forEach((node, index) => {
        if (placed.has(node.id())) return;
        const neighbors = node.neighborhood('node').filter((neighbor) => placed.has(neighbor.id()));
        const origin = neighbors.length
          ? {
              x:
                neighbors.reduce(
                  (sum, neighbor) => sum + (neighbor as NodeSingular).position('x'),
                  0,
                ) / neighbors.length,
              y:
                neighbors.reduce(
                  (sum, neighbor) => sum + (neighbor as NodeSingular).position('y'),
                  0,
                ) / neighbors.length,
            }
          : center;
        const ordinal = neighbors.length ? index + 1 : ++unconnected;
        const angle = ordinal * Math.PI * (3 - Math.sqrt(5));
        const radius = neighbors.length ? 48 + (index % 3) * 13 : 42 * Math.sqrt(ordinal);
        node.position({
          x: origin.x + Math.cos(angle) * radius,
          y: origin.y + Math.sin(angle) * radius,
        });
        placed.add(node.id());
      });
      cy.zoom(zoom);
      cy.pan(pan);
    }
    rememberPositions();
    cy.style().selector('node').style('color', color).update();
    if (state.selectedId) cy.getElementById(state.selectedId).select();
    graphError.value = '';
  } catch {
    graphError.value = '画布加载失败，可使用列表继续探索。';
  }
}
watch(
  () => state.result,
  () => void renderGraph(),
);
watch(view, () => {
  if (view.value === 'list') rememberPositions();
  else void renderGraph();
});
function screen() {
  mobile.value = window.innerWidth < 800;
  cy?.resize();
}
onMounted(() => {
  screen();
  window.addEventListener('resize', screen);
  void model.initialize().then(() => model.startPolling());
  resize = new ResizeObserver(() => cy?.resize());
  if (canvas.value) resize.observe(canvas.value);
  theme = new MutationObserver(() => void renderGraph());
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
});
onBeforeUnmount(() => {
  disposed = true;
  renderGeneration++;
  clearTimeout(timer);
  clearTimeout(reviewTimer);
  resize?.disconnect();
  theme?.disconnect();
  window.removeEventListener('resize', screen);
  cy?.destroy();
  model.dispose();
});
</script>
<template>
  <section class="graph-workspace" aria-labelledby="graph-title">
    <header class="graph-header">
      <ASpace :size="12" align="center">
        <AButton type="text" class="graph-back" @click="emit('back')"
          ><Icon name="back" :size="16" />返回</AButton
        >
        <div class="graph-heading">
          <h1 id="graph-title">知识图谱</h1>
          <span>让资料中的联系清晰可见</span>
        </div>
        <ATag
          class="graph-mode-tag"
          :bordered="false"
          :color="state.status?.provider === 'none' ? 'default' : 'blue'"
          >{{ state.status?.provider === 'none' ? '基础分析' : '模型增强' }}</ATag
        >
      </ASpace>
      <AButton
        class="graph-status-pill"
        type="text"
        :aria-label="`后台分析：${statusText}，${state.status?.pending || 0} 待处理`"
        @click="openPanel('tasks')"
      >
        <ABadge :status="statusKind" /><span>{{ statusText }}</span
        ><ATag v-if="state.status?.pending" :bordered="false"
          >{{ state.status.pending }} 待处理</ATag
        ><Icon name="forward" :size="12" />
      </AButton>
    </header>
    <nav class="graph-toolbar" aria-label="图谱工具栏">
      <ASegmented
        :value="state.query.view || 'knowledge'"
        :options="[
          { label: '知识', value: 'knowledge' },
          { label: '笔记', value: 'notes' },
        ]"
        role="group"
        aria-label="图谱类型"
        @change="changeGraphView"
      />
      <AInputSearch
        v-model:value="state.query.q"
        type="search"
        class="graph-search"
        aria-label="搜索图谱"
        placeholder="搜索概念、实体或笔记"
        allow-clear
        @change="search"
        @search="refresh"
      />
      <AButton class="graph-filter-trigger" aria-label="筛选" @click="openPanel('filters')"
        ><Icon name="settings" :size="15" /><span class="graph-action-label">筛选</span></AButton
      >
      <ADivider type="vertical" class="graph-toolbar-divider" />
      <ASegmented
        :value="view"
        :options="[
          { label: '画布', value: 'graph' },
          { label: '列表', value: 'list' },
        ]"
        role="group"
        aria-label="显示方式"
        @change="changeDisplayView"
      />
      <AButton v-if="!mobile" @click="openPanel('review')"
        >审核<ATag v-if="state.status?.suggested" :bordered="false" color="blue">{{
          state.status.suggested
        }}</ATag></AButton
      >
      <ADropdown :trigger="['click']" placement="bottomRight">
        <AButton class="graph-more-trigger" aria-label="更多图谱操作"
          ><Icon name="more" :size="18" /><span class="graph-action-label">更多</span></AButton
        >
        <template #overlay
          ><AMenu @click="({ key }) => openPanel(String(key))"
            ><AMenuItem v-if="mobile" key="review"
              ><Icon name="check" :size="15" />关系审核</AMenuItem
            ><AMenuItem key="views"><Icon name="star" :size="15" />视图与导出</AMenuItem
            ><AMenuItem key="ask"><Icon name="help" :size="15" />图谱问答</AMenuItem
            ><AMenuItem key="model"><Icon name="plug" :size="15" />模型设置</AMenuItem></AMenu
          ></template
        >
      </ADropdown>
    </nav>
    <div class="graph-summary" role="status" aria-live="polite">
      <ASpace :size="12"
        ><span>{{
          state.loading ? '正在更新图谱…' : `${state.result?.nodes.length || 0} 个节点`
        }}</span
        ><span v-if="!state.loading">{{ state.result?.edges.length || 0 }} 条关系</span
        ><ATag v-if="state.result?.truncated" :bordered="false" color="gold">有限子图</ATag></ASpace
      >
      <ASpace :size="4"
        ><AButton
          v-if="state.query.focus || state.query.target"
          size="small"
          type="link"
          @click="
            state.query.focus = undefined;
            state.query.target = undefined;
            refresh();
          "
          >清除局部 / 路径</AButton
        ><ATooltip title="重新读取当前图谱"
          ><AButton size="small" type="text" :loading="state.loading" @click="refresh"
            ><Icon name="refresh" :size="14" />刷新</AButton
          ></ATooltip
        ></ASpace
      >
    </div>
    <AAlert
      v-if="state.result?.truncated"
      class="graph-notice"
      type="info"
      show-icon
      :message="`当前显示有限子图，范围内共 ${state.result.totalNodes} 个节点、${state.result.totalEdges} 条关系`"
      description="最多展示 120 条关系，可通过筛选或局部探索聚焦内容。"
    />
    <AAlert v-if="state.error" class="graph-notice" type="error" show-icon :message="state.error"
      ><template #action
        ><AButton size="small" type="link" @click="refresh">重试</AButton></template
      ></AAlert
    >
    <div class="graph-body" :class="{ 'has-inspector': !!state.selectedId && !mobile }">
      <main class="graph-main">
        <ACard v-show="view === 'graph'" class="graph-canvas-card" :body-style="{ padding: 0 }">
          <div class="graph-canvas-wrap">
            <div
              ref="canvas"
              class="graph-canvas"
              role="region"
              aria-label="知识关系画布，使用列表可键盘浏览"
            />
            <div class="graph-canvas-tools">
              <ASpace :size="2"
                ><ATooltip title="放大"
                  ><AButton
                    size="small"
                    type="text"
                    aria-label="放大"
                    @click="cy?.zoom(cy.zoom() * 1.25)"
                    ><Icon name="plus" :size="16" /></AButton></ATooltip
                ><ATooltip title="缩小"
                  ><AButton
                    size="small"
                    type="text"
                    aria-label="缩小"
                    @click="cy?.zoom(cy.zoom() / 1.25)"
                    >−</AButton
                  ></ATooltip
                ><ADivider type="vertical" /><AButton
                  size="small"
                  type="text"
                  @click="cy?.fit(undefined, 40)"
                  >适应画布</AButton
                ></ASpace
              >
            </div>
            <div class="graph-legend">
              <span
                v-for="kind in colorBy === 'type' ? ['note', ...graphEntityKinds] : []"
                :key="kind"
                ><i :style="{ background: colors[kind] }" />{{ labels[kind] }}</span
              ><span
                >{{
                  colorBy === 'community' ? '按关系分组着色 · ' : ''
                }}虚线表示候选或相似线索</span
              >
            </div>
            <AAlert
              v-if="graphError"
              class="graph-canvas-error"
              type="warning"
              show-icon
              :message="graphError"
            />
          </div>
        </ACard>
        <ACard v-if="view === 'list'" class="graph-list-card" :body-style="{ padding: '0 16px' }">
          <div class="graph-note-list" aria-label="图谱节点列表">
            <AList
              :data-source="state.result?.nodes || []"
              :loading="state.loading"
              :locale="{ emptyText: '暂无匹配节点' }"
            >
              <template #renderItem="{ item }"
                ><AListItem
                  ><AButton
                    type="text"
                    block
                    class="graph-node-select"
                    :aria-pressed="item.id === state.selectedId"
                    @click="select(item.id)"
                    ><span class="graph-node-dot" :style="{ background: colors[item.kind] }" /><span
                      class="graph-node-copy"
                      ><strong>{{ item.title }}</strong
                      ><span>{{
                        item.relativePath || `${item.sourceCount} 份来源资料`
                      }}</span></span
                    ><ATag :bordered="false">{{ labels[item.kind] }}</ATag
                    ><Icon name="forward" :size="14" /></AButton></AListItem
              ></template>
            </AList>
            <template v-if="state.result?.edges.length"
              ><ADivider orientation="left">关系</ADivider
              ><AList size="small" :data-source="state.result.edges"
                ><template #renderItem="{ item }"
                  ><AListItem
                    ><AButton
                      class="graph-relation-select"
                      type="text"
                      block
                      @click="select(item.id)"
                      ><span>{{ nodeTitle(item.source) }}</span
                      ><ATag :bordered="false">{{ item.label }}</ATag
                      ><span>{{ nodeTitle(item.target) }}</span></AButton
                    ></AListItem
                  ></template
                ></AList
              ></template
            >
          </div>
        </ACard>
        <AEmpty
          v-if="state.result && !state.result.nodes.length && view === 'graph'"
          class="graph-empty"
          description="暂无匹配内容，可调整搜索或筛选条件。"
        />
      </main>
      <aside v-if="state.selectedId && !mobile" class="graph-details">
        <ACard size="small"
          ><GraphInspectorContent
            :node="node"
            :edge="edge"
            :nodes="state.result?.nodes || []"
            :busy="state.busy"
            @close="select('')"
            @focus="focus"
            @open="forwardOpenNote"
            @select="select"
            @command="model.command($event)"
        /></ACard>
      </aside>
    </div>
    <GraphOverlay
      :show="!!panel"
      :title="title"
      :description="panelDescription"
      :busy="state.busy"
      :dirty="dirty"
      :width="620"
      @update:show="panel = ''"
    >
      <div class="graph-panel">
        <AForm
          name="graph-filter"
          :model="state.query"
          v-if="panel === 'filters'"
          layout="vertical"
          :required-mark="false"
          class="graph-form"
        >
          <AFormItem label="目录"
            ><DirectoryTreeSelect
              :value="state.query.folder || ''"
              :folders="folderOptions"
              label="目录"
              @update:value="
                (value) => {
                  state.query.folder = value || undefined;
                  refresh();
                }
              "
          /></AFormItem>
          <div class="graph-form-columns">
            <AFormItem name="nodeKinds" label="节点类型"
              ><ASelect
                v-model:value="state.query.nodeKinds"
                aria-label="节点类型"
                mode="multiple"
                :options="nodeTypeOptions"
                placeholder="全部类型"
                :max-tag-count="'responsive'"
                allow-clear
                @change="refresh" /></AFormItem
            ><AFormItem name="edgeKinds" label="关系类型"
              ><ASelect
                v-model:value="state.query.edgeKinds"
                aria-label="关系类型"
                mode="multiple"
                :options="relationTypeOptions"
                placeholder="全部关系"
                :max-tag-count="'responsive'"
                allow-clear
                @change="refresh"
            /></AFormItem>
          </div>
          <AFormItem label="关系线索"
            ><ASpace direction="vertical" :size="12"
              ><ACheckbox v-model:checked="state.query.includeSuggested" @change="refresh"
                >显示待审核候选</ACheckbox
              ><ACheckbox v-model:checked="state.query.includeSimilarity" @change="refresh"
                >显示词项相似（辅助线索）</ACheckbox
              ><ACheckbox
                :checked="state.query.mode === 'orphans'"
                @update:checked="
                  (checked) => {
                    state.query.mode = checked ? 'orphans' : 'all';
                    refresh();
                  }
                "
                >仅孤立节点</ACheckbox
              ></ASpace
            ></AFormItem
          >
          <AFormItem name="minConfidence" label="最低置信度"
            ><div class="graph-slider-row">
              <ASlider
                v-model:value="state.query.minConfidence"
                aria-label="最低置信度"
                aria-label-for-handle="最低置信度"
                :min="0"
                :max="1"
                :step="0.05"
                @after-change="refresh"
              /><ATag :bordered="false"
                >{{ Math.round((state.query.minConfidence || 0) * 100) }}%</ATag
              >
            </div></AFormItem
          >
          <ACollapse ghost
            ><ACollapsePanel key="path" header="路径与范围"
              ><AFormItem name="colorBy" label="节点颜色"
                ><ASelect
                  v-model:value="colorBy"
                  aria-label="节点颜色"
                  :options="[
                    { value: 'type', label: '按类型' },
                    { value: 'community', label: '按关系分组' },
                  ]"
                  @change="renderGraph"
              /></AFormItem>
              <div class="graph-form-columns">
                <AFormItem name="focus" label="起点"
                  ><ASelect
                    v-model:value="state.query.focus"
                    aria-label="起点"
                    :options="availableNodeOptions"
                    show-search
                    option-filter-prop="label"
                    allow-clear
                    placeholder="选择起点" /></AFormItem
                ><AFormItem name="target" label="终点"
                  ><ASelect
                    v-model:value="state.query.target"
                    aria-label="终点"
                    :options="availableNodeOptions"
                    show-search
                    option-filter-prop="label"
                    allow-clear
                    placeholder="选择终点"
                /></AFormItem>
              </div>
              <ASpace align="end" wrap
                ><AFormItem name="limit" label="节点上限" class="graph-inline-form-item"
                  ><AInputNumber
                    v-model:value="state.query.limit"
                    aria-label="节点上限"
                    :min="1"
                    :max="1000"
                    :precision="0"
                    @change="refresh" /></AFormItem
                ><AButton type="primary" @click="refresh">查找路径</AButton></ASpace
              ></ACollapsePanel
            ></ACollapse
          >
        </AForm>
        <template v-else-if="panel === 'tasks'">
          <div class="graph-task-heading">
            <ABadge :status="statusKind" :text="statusText" /><span
              >{{ state.status?.completed || 0 }} / {{ state.status?.total || 0 }} 份资料</span
            >
          </div>
          <AProgress
            :percent="progressPercent"
            :status="
              state.status?.failed
                ? 'exception'
                : state.status?.state === 'running'
                  ? 'active'
                  : 'normal'
            "
          />
          <ASpace wrap
            ><ATag :bordered="false" :color="state.status?.automatic ? 'green' : 'default'"
              >自动更新{{ state.status?.automatic ? '开启' : '关闭' }}</ATag
            ><ATag :bordered="false" :color="state.status?.modelReady ? 'blue' : 'default'">{{
              state.status?.modelReady ? '模型已配置' : '基础分析可用'
            }}</ATag></ASpace
          >
          <ASpace wrap
            ><AButton :disabled="state.busy" @click="model.job('pause')">暂停</AButton
            ><AButton type="primary" :disabled="state.busy" @click="model.job('resume')"
              >继续</AButton
            ><AButton :disabled="state.busy" @click="model.job('retry')">重试失败</AButton
            ><AButton :disabled="state.busy" @click="model.job('rebuild')">重建索引</AButton
            ><AButton type="text" danger :disabled="state.busy" @click="model.job('cancel')"
              >取消任务</AButton
            ></ASpace
          >
          <ACollapse v-if="state.status?.errors.length" ghost
            ><ACollapsePanel
              v-for="error in state.status.errors"
              :key="error.noteId"
              :header="error.title"
              ><AAlert type="warning" show-icon :message="graphTaskErrorLabel(error.code)" />
              <p class="graph-diagnostic">
                诊断代码：<code>{{ error.code }}</code>
              </p></ACollapsePanel
            ></ACollapse
          >
          <AAlert
            type="info"
            show-icon
            message="重建会保留人工决定与已保存视图，后台任务无需保持此窗口开启。"
          />
        </template>
        <AForm
          name="graph-model"
          :model="modelDraft"
          v-else-if="panel === 'model' && draft"
          layout="vertical"
          :required-mark="false"
          :disabled="state.busy"
          class="graph-form"
        >
          <AFormItem name="provider" label="提供方"
            ><ASelect
              v-model:value="modelDraft.provider"
              aria-label="提供方"
              :options="providerOptions"
          /></AFormItem>
          <template v-if="modelDraft.provider !== 'none'">
            <AFormItem
              name="baseUrl"
              label="服务地址"
              help="填写 DooKnow 服务器能够访问的基础地址。"
              ><AInput
                v-model:value="modelDraft.baseUrl"
                aria-label="服务地址"
                placeholder="http://127.0.0.1:11434"
            /></AFormItem>
            <AFormItem name="model" label="模型名称"
              ><AInput
                v-model:value="modelDraft.model"
                aria-label="模型名称"
                placeholder="输入已经安装或可用的模型"
            /></AFormItem>
            <AFormItem name="apiKey" label="API 密钥"
              ><AInputPassword
                v-model:value="secret"
                aria-label="API 密钥"
                autocomplete="new-password"
                :placeholder="state.settings?.apiKeyConfigured ? '已配置，留空保留' : '选填'"
              /><AFormItemRest
                ><ACheckbox
                  v-if="state.settings?.apiKeyConfigured"
                  v-model:checked="clearKey"
                  class="graph-clear-key"
                  >清除已保存密钥</ACheckbox
                ></AFormItemRest
              ></AFormItem
            >
            <AFormItem
              ><ACheckbox v-model:checked="modelDraft.remoteContentAllowed"
                >允许将笔记内容发送到非本机模型服务</ACheckbox
              >
              <p class="graph-field-help">
                测试连接使用合成文本；密钥仅加密保存在本机。
              </p></AFormItem
            >
          </template>
          <AFormItem name="automatic" label="自动分析内容变化"
            ><ASwitch
              v-model:checked="modelDraft.automatic"
              aria-label="自动分析内容变化"
              checked-children="开启"
              un-checked-children="关闭"
          /></AFormItem>
          <ACollapse ghost
            ><ACollapsePanel key="advanced" header="高级参数"
              ><AFormItem name="outputFormat" label="结构化输出"
                ><ASelect
                  v-model:value="modelDraft.outputFormat"
                  aria-label="结构化输出"
                  :options="[
                    { value: 'schema', label: 'JSON Schema（默认）' },
                    { value: 'json', label: 'JSON 模式（兼容服务）' },
                  ]"
              /></AFormItem>
              <div class="graph-form-columns">
                <AFormItem name="timeoutMs" label="超时（毫秒）"
                  ><AInputNumber
                    v-model:value="modelDraft.timeoutMs"
                    aria-label="超时（毫秒）"
                    :min="100"
                    :max="120000"
                    :step="1000"
                    :precision="0" /></AFormItem
                ><AFormItem name="maxInputCharacters" label="单次输入字符上限"
                  ><AInputNumber
                    v-model:value="modelDraft.maxInputCharacters"
                    aria-label="单次输入字符上限"
                    :min="100"
                    :max="50000"
                    :step="1000"
                    :precision="0"
                /></AFormItem></div></ACollapsePanel
          ></ACollapse>
          <ADivider /><ASpace wrap
            ><AButton type="primary" :loading="state.busy" @click="saveSettings">保存设置</AButton
            ><AButton
              :disabled="dirty || state.busy"
              @click="
                model
                  .testSettings()
                  .then(
                    (value) =>
                      (testMessage = value
                        ? value.ok
                          ? '连接成功'
                          : '连接未成功，请检查服务地址、模型名称与发送许可。'
                        : ''),
                  )
              "
              >测试已保存连接</AButton
            ></ASpace
          >
          <p v-if="testMessage" class="graph-feedback" role="status">{{ testMessage }}</p>
        </AForm>
        <template v-else-if="panel === 'model'"
          ><AEmpty description="正在读取模型配置…" /><AButton @click="model.initialize()"
            >重新加载配置</AButton
          ></template
        >
        <template v-else-if="panel === 'review'">
          <div class="graph-review-toolbar">
            <label for="graph-review-status" class="sr-only">审核状态</label>
            <ASelect
              id="graph-review-status"
              v-model:value="reviewStatus"
              aria-label="审核状态"
              :options="[
                { value: 'suggested', label: '待审核' },
                { value: 'accepted', label: '已确认' },
                { value: 'ignored', label: '已忽略' },
              ]"
              @change="refreshReview"
            /><AInputSearch
              v-model:value="reviewSearch"
              type="search"
              aria-label="搜索审核关系"
              placeholder="搜索实体或关系"
              allow-clear
              @change="searchReview"
              @search="refreshReview"
            />
          </div>
          <AList
            :loading="state.reviewLoading"
            :data-source="state.reviews"
            :locale="{ emptyText: '当前没有此类关系' }"
            class="graph-review-list"
          >
            <template #renderItem="{ item }"
              ><AListItem
                ><ACard class="graph-review" size="small"
                  ><template #title
                    ><span
                      >{{ item.source.name }}<span class="graph-inline-arrow">→</span
                      >{{ item.target.name }}</span
                    ></template
                  ><template #extra
                    ><ATag :bordered="false" color="blue"
                      >置信分 {{ Math.round(item.confidence * 100) }}%</ATag
                    ></template
                  ><AForm
                    :name="'graph-review-' + item.id"
                    :model="{ predicate: edits[item.id] }"
                    layout="vertical"
                    :required-mark="false"
                    ><AFormItem name="predicate" label="关系"
                      ><AInput
                        v-model:value="edits[item.id]"
                        aria-label="关系"
                        :placeholder="item.predicate" /></AFormItem
                  ></AForm>
                  <div v-for="ev in item.evidence" :key="ev.id" class="graph-evidence">
                    <blockquote>{{ ev.quote }}</blockquote>
                    <AButton type="link" size="small" @click="openSource(ev)"
                      >{{ ev.title }} · L{{ ev.startLine }}</AButton
                    >
                  </div>
                  <ASpace wrap
                    ><AButton
                      type="primary"
                      size="small"
                      :disabled="state.busy"
                      @click="
                        model.command({
                          action: 'review',
                          id: item.id,
                          decision: 'accept',
                          predicate: edits[item.id] || item.predicate,
                        })
                      "
                      >确认 / 保存</AButton
                    ><AButton
                      size="small"
                      :disabled="state.busy"
                      @click="model.command({ action: 'review', id: item.id, decision: 'ignore' })"
                      >忽略</AButton
                    ><AButton
                      v-if="reviewStatus !== 'suggested'"
                      size="small"
                      type="text"
                      :disabled="state.busy"
                      @click="model.command({ action: 'review', id: item.id, decision: 'reset' })"
                      >恢复候选</AButton
                    ></ASpace
                  ></ACard
                ></AListItem
              ></template
            >
          </AList>
          <AButton
            v-if="state.reviewHasMore"
            block
            :loading="state.reviewLoading"
            @click="model.review(reviewStatus, reviewSearch, true)"
            >加载更多关系</AButton
          >
        </template>
        <template v-else-if="panel === 'views'">
          <AForm name="graph-view" :model="{ viewName }" layout="vertical" :required-mark="false"
            ><AFormItem name="viewName" label="保存当前视图"
              ><ASpace class="graph-save-view" :size="8"
                ><AInput
                  v-model:value="viewName"
                  aria-label="保存当前视图"
                  :maxlength="100"
                  placeholder="为当前探索命名"
                /><AButton
                  type="primary"
                  :disabled="!viewName.trim() || state.busy"
                  @click="
                    model
                      .command({ action: 'save-view', name: viewName, query: state.query })
                      .then((saved) => {
                        if (saved) viewName = '';
                      })
                  "
                  >保存视图</AButton
                ></ASpace
              ></AFormItem
            ></AForm
          >
          <AList
            :data-source="state.user.views"
            :locale="{ emptyText: '尚未保存视图' }"
            size="small"
            ><template #renderItem="{ item }"
              ><AListItem
                ><AButton
                  type="link"
                  @click="
                    state.query = JSON.parse(JSON.stringify(item.query));
                    refresh();
                    panel = '';
                  "
                  >{{ item.name }}</AButton
                ><template #actions
                  ><AButton
                    type="text"
                    danger
                    size="small"
                    :disabled="state.busy"
                    @click="model.command({ action: 'delete-view', id: item.id })"
                    >删除</AButton
                  ></template
                ></AListItem
              ></template
            ></AList
          >
          <ADivider orientation="left">导出</ADivider
          ><ASpace wrap
            ><AButton
              :disabled="!state.result"
              @click="
                download(
                  JSON.stringify(state.result, null, 2),
                  'knowledge-graph.json',
                  'application/json',
                )
              "
              ><Icon name="download" :size="15" />导出当前 JSON</AButton
            ><AButton :disabled="!cy" @click="exportPng"
              ><Icon name="image" :size="15" />导出画布 PNG</AButton
            ></ASpace
          >
          <p class="graph-field-help">只导出当前可见、已授权的图谱结果。</p>
        </template>
        <template v-else-if="panel === 'ask'">
          <AAlert
            type="info"
            show-icon
            :message="`根据${node?.title ? '「' + node.title + '」' : '问题命中的资料'}中的原文证据回答`"
          />
          <AForm
            name="graph-question"
            :model="{ question }"
            layout="vertical"
            :required-mark="false"
            ><AFormItem name="question" label="问题"
              ><ATextarea
                v-model:value="question"
                aria-label="问题"
                :auto-size="{ minRows: 3, maxRows: 6 }"
                :maxlength="2000"
                show-count
                placeholder="这些概念之间有什么联系？" /></AFormItem
            ><AButton
              type="primary"
              :loading="state.busy"
              :disabled="!question.trim() || !state.settings || state.settings.provider === 'none'"
              @click="model.ask(question)"
              >提问</AButton
            ></AForm
          >
          <AAlert
            v-if="!state.settings || state.settings.provider === 'none'"
            type="warning"
            show-icon
            message="请先配置模型，基础词项分析不会生成答案。"
            ><template #action
              ><AButton type="link" size="small" @click="openPanel('model')"
                >模型设置</AButton
              ></template
            ></AAlert
          >
          <template v-if="state.answer"
            ><ACard size="small" title="回答"
              ><p class="graph-answer">{{ state.answer.answer }}</p></ACard
            ><ADivider orientation="left">引用来源</ADivider
            ><ACard
              v-for="ev in state.answer.evidence.filter((e) =>
                state.answer?.citations.includes(e.id),
              )"
              :key="ev.id"
              size="small"
              class="graph-evidence-card"
              ><blockquote>{{ ev.quote }}</blockquote>
              <AButton type="link" size="small" @click="openSource(ev)"
                >{{ ev.title }} · L{{ ev.startLine }}–{{ ev.endLine }}</AButton
              ></ACard
            ></template
          >
        </template>
        <AAlert v-if="state.error" type="error" show-icon :message="state.error" />
      </div>
    </GraphOverlay>
    <GraphOverlay
      :show="mobile && !!state.selectedId && !panel"
      title="图谱详情"
      kind="drawer"
      :width="380"
      @update:show="select('')"
      ><GraphInspectorContent
        :node="node"
        :edge="edge"
        :nodes="state.result?.nodes || []"
        :busy="state.busy"
        @close="select('')"
        @focus="focus"
        @open="forwardOpenNote"
        @select="select"
        @command="model.command($event)"
    /></GraphOverlay>
  </section>
</template>
