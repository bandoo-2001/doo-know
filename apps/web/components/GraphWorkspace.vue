<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { Core, NodeSingular } from 'cytoscape';
import type { TreeEntry } from '../../../shared/contracts';
import {
  graphEntityKinds,
  type GraphModelUpdate,
  type GraphEvidence,
} from '../../../shared/graph-semantic-contracts';
import SettingsOverlay from './settings/SettingsOverlay.vue';
import GraphInspectorContent from './graph/GraphInspector.vue';
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
      <AButton @click="emit('back')">← 返回</AButton>
      <h1 id="graph-title">知识图谱</h1>
      <span class="graph-baseline">{{
        state.status?.provider === 'none' ? '基础词项分析' : '内容感知'
      }}</span
      ><AButton class="graph-status-pill" @click="openPanel('tasks')"
        >{{ statusText }} · {{ state.status?.pending || 0 }} 待处理</AButton
      >
    </header>
    <nav class="graph-toolbar" aria-label="图谱工具栏">
      <select v-model="state.query.view" aria-label="图谱类型" @change="refresh">
        <option value="knowledge">知识</option>
        <option value="notes">笔记</option></select
      ><input
        v-model="state.query.q"
        type="search"
        placeholder="搜索知识或笔记"
        aria-label="搜索图谱"
        @input="search"
      /><AButton @click="openPanel('filters')">筛选</AButton
      ><select v-model="view" aria-label="显示方式">
        <option value="graph">画布</option>
        <option value="list">列表</option></select
      ><AButton @click="openPanel('review')">审核</AButton
      ><AButton @click="openPanel('views')">视图</AButton
      ><AButton @click="openPanel('ask')">问答</AButton
      ><AButton @click="openPanel('model')">模型</AButton>
    </nav>
    <div class="graph-summary" role="status" aria-live="polite">
      <span v-if="state.loading">正在更新…</span
      ><span v-else
        >显示 {{ state.result?.nodes.length || 0 }} 节点 ·
        {{ state.result?.edges.length || 0 }} 关系</span
      ><span v-if="state.result?.truncated"
        >当前为有限子图（最多 120 条关系；范围内共 {{ state.result.totalNodes }} 节点 /
        {{ state.result.totalEdges }} 关系），请缩小范围或探索局部。</span
      ><AButton
        v-if="state.query.focus || state.query.target"
        size="small"
        @click="
          state.query.focus = undefined;
          state.query.target = undefined;
          refresh();
        "
        >清除局部 / 路径</AButton
      ><AButton size="small" :loading="state.loading" @click="refresh">刷新</AButton>
    </div>
    <div v-if="state.error" class="graph-error" role="alert">
      {{ state.error }}<AButton size="small" @click="refresh">重试</AButton>
    </div>
    <div class="graph-body" :class="{ 'has-inspector': !!state.selectedId && !mobile }">
      <main class="graph-main">
        <div v-show="view === 'graph'" class="graph-canvas-wrap">
          <div
            ref="canvas"
            class="graph-canvas"
            role="region"
            aria-label="知识关系画布，使用列表可键盘浏览"
          />
          <div class="graph-canvas-tools">
            <AButton aria-label="放大" @click="cy?.zoom(cy.zoom() * 1.25)">＋</AButton
            ><AButton aria-label="缩小" @click="cy?.zoom(cy.zoom() / 1.25)">−</AButton
            ><AButton @click="cy?.fit(undefined, 40)">适应画布</AButton>
          </div>
          <div class="graph-legend">
            <span
              v-for="kind in colorBy === 'type' ? ['note', ...graphEntityKinds] : []"
              :key="kind"
              ><i :style="{ background: colors[kind] }" />{{ labels[kind] }}</span
            ><span>{{ colorBy === 'community' ? '当前按社区着色 · ' : '' }}虚线：候选 / 相似</span>
          </div>
          <p v-if="graphError" class="graph-error">{{ graphError }}</p>
        </div>
        <div v-if="view === 'list'" class="graph-note-list" aria-label="图谱节点列表">
          <button
            v-for="n in state.result?.nodes || []"
            :key="n.id"
            :aria-pressed="n.id === state.selectedId"
            @click="select(n.id)"
          >
            <strong>{{ n.title }}</strong
            ><span>{{ labels[n.kind] }} · {{ n.sourceCount }} 来源</span
            ><small>{{ n.relativePath }}</small>
          </button>
          <h3 v-if="state.result?.edges.length">关系</h3>
          <button v-for="e in state.result?.edges || []" :key="e.id" @click="select(e.id)">
            {{ state.result?.nodes.find((n) => n.id === e.source)?.title }} → {{ e.label }} →
            {{ state.result?.nodes.find((n) => n.id === e.target)?.title }}
          </button>
        </div>
        <div v-if="state.result && !state.result.nodes.length" class="graph-empty">
          暂无匹配内容。尝试其他搜索或筛选；后台分析会持续更新。
        </div>
      </main>
      <aside v-if="state.selectedId && !mobile" class="graph-details">
        <GraphInspectorContent
          :node="node"
          :edge="edge"
          :nodes="state.result?.nodes || []"
          :busy="state.busy"
          @close="select('')"
          @focus="focus"
          @open="forwardOpenNote"
          @select="select"
          @command="model.command($event)"
        />
      </aside>
    </div>
    <SettingsOverlay
      :show="!!panel"
      :title="title"
      :busy="state.busy"
      :dirty="dirty"
      :width="620"
      @update:show="panel = ''"
    >
      <div class="graph-panel">
        <template v-if="panel === 'filters'"
          ><label
            >目录<select v-model="state.query.folder" @change="refresh">
              <option :value="undefined">全部目录</option>
              <option v-for="f in folders" :key="f">{{ f }}</option>
            </select></label
          ><label
            >节点类型<select v-model="state.query.nodeKinds" multiple @change="refresh">
              <option value="note">笔记</option>
              <option v-for="k in graphEntityKinds" :key="k" :value="k">{{ labels[k] }}</option>
            </select></label
          ><label
            >关系类型<select v-model="state.query.edgeKinds" multiple @change="refresh">
              <option
                v-for="k in [
                  'reference',
                  'mentions',
                  'cooccurs',
                  'similarity',
                  'semantic',
                  'manual',
                ]"
                :key="k"
                :value="k"
              >
                {{ labels[k] }}
              </option>
            </select></label
          ><label
            ><input
              v-model="state.query.includeSuggested"
              type="checkbox"
              @change="refresh"
            />显示待审核候选</label
          ><label
            ><input
              v-model="state.query.includeSimilarity"
              type="checkbox"
              @change="refresh"
            />显示词项相似（辅助线索）</label
          ><label
            >最低置信度<input
              v-model.number="state.query.minConfidence"
              type="range"
              min="0"
              max="1"
              step="0.05"
              @change="refresh"
            />{{ state.query.minConfidence || 0 }}</label
          ><label
            ><input
              type="checkbox"
              :checked="state.query.mode === 'orphans'"
              @change="
                state.query.mode = ($event.target as HTMLInputElement).checked ? 'orphans' : 'all';
                refresh();
              "
            />仅孤立节点</label
          >
          <details>
            <summary>路径与范围</summary>
            <label
              >节点颜色<select v-model="colorBy" @change="renderGraph">
                <option value="type">按类型</option>
                <option value="community">按社区</option>
              </select></label
            >
            <label
              >起点<select v-model="state.query.focus">
                <option :value="undefined">不限</option>
                <option v-for="n in state.result?.nodes" :key="n.id" :value="n.id">
                  {{ n.title }}
                </option>
              </select></label
            ><label
              >终点<select v-model="state.query.target">
                <option :value="undefined">不限</option>
                <option v-for="n in state.result?.nodes" :key="n.id" :value="n.id">
                  {{ n.title }}
                </option>
              </select></label
            ><AButton @click="refresh">查找路径</AButton
            ><label
              >节点上限<input
                v-model.number="state.query.limit"
                type="number"
                min="1"
                max="1000"
                @change="refresh"
            /></label></details
        ></template>
        <template v-else-if="panel === 'tasks'"
          ><p>
            {{ statusText }} · 完成 {{ state.status?.completed || 0 }} /
            {{ state.status?.total || 0 }}
          </p>
          <progress :value="state.status?.completed || 0" :max="state.status?.total || 1" />
          <p>
            自动更新{{ state.status?.automatic ? '开启' : '关闭' }} ·
            {{ state.status?.modelReady ? '模型已配置' : '基础分析可用；模型未就绪' }}
          </p>
          <div class="graph-actions">
            <AButton
              v-for="(label, action) in {
                pause: '暂停',
                resume: '继续',
                retry: '重试失败',
                rebuild: '重建索引',
                cancel: '取消任务',
              }"
              :key="action"
              :disabled="state.busy"
              @click="model.job(action)"
              >{{ label }}</AButton
            >
          </div>
          <article v-for="error in state.status?.errors" :key="error.noteId">
            <p>{{ error.title }} · {{ graphTaskErrorLabel(error.code) }}</p>
            <details>
              <summary>诊断详情</summary>
              <code>{{ error.code }}</code>
            </details>
          </article>
          <small>重建保留人工决定与视图。后台任务无需保持此窗口开启。</small></template
        >
        <template v-else-if="panel === 'model' && draft"
          ><label
            >提供方<select v-model="draft.provider">
              <option value="none">基础本地分析（无需模型）</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI 兼容 API</option>
            </select></label
          ><template v-if="draft.provider !== 'none'"
            ><label
              >服务地址<input v-model="draft.baseUrl" placeholder="http://127.0.0.1:11434" /></label
            ><label
              >模型名称<input v-model="draft.model" placeholder="输入已安装或可用模型" /></label
            ><label
              >API 密钥<input
                v-model="secret"
                type="password"
                autocomplete="new-password"
                :placeholder="
                  state.settings?.apiKeyConfigured ? '已配置；留空保留' : '选填'
                " /></label
            ><label v-if="state.settings?.apiKeyConfigured"
              ><input v-model="clearKey" type="checkbox" />清除已保存密钥</label
            ><label
              ><input
                v-model="draft.remoteContentAllowed"
                type="checkbox"
              />允许将笔记内容发送到非本机模型服务</label
            ><small
              >仅在明确授权后向远端发送正文；测试使用合成文本。密钥只写入本机，不回传。</small
            ></template
          ><label><input v-model="draft.automatic" type="checkbox" />自动分析内容变化</label>
          <details>
            <summary>高级参数</summary>
            <label
              >结构化输出<select v-model="draft.outputFormat">
                <option value="schema">JSON Schema（默认）</option>
                <option value="json">JSON 模式（兼容服务）</option>
              </select></label
            >
            <label
              >超时（毫秒）<input
                v-model.number="draft.timeoutMs"
                type="number"
                min="1000"
                max="120000" /></label
            ><label
              >单次输入字符上限<input
                v-model.number="draft.maxInputCharacters"
                type="number"
                min="1000"
                max="50000"
            /></label>
          </details>
          <div class="graph-actions">
            <AButton type="primary" :loading="state.busy" @click="saveSettings">保存设置</AButton
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
            >
          </div>
          <p role="status">{{ testMessage }}</p></template
        >
        <template v-else-if="panel === 'model'"
          ><p role="status">正在读取模型配置…</p>
          <AButton @click="model.initialize()">重新加载配置</AButton></template
        >
        <template v-else-if="panel === 'review'"
          ><select v-model="reviewStatus" aria-label="审核状态" @change="refreshReview">
            <option value="suggested">待审核</option>
            <option value="accepted">已确认</option>
            <option value="ignored">已忽略</option>
          </select>
          <input
            v-model="reviewSearch"
            type="search"
            aria-label="搜索审核关系"
            placeholder="搜索实体或关系"
            @input="searchReview"
          />
          <p v-if="state.reviewLoading" role="status">正在加载审核关系…</p>
          <p v-if="!state.reviewLoading && !state.reviews.length">当前没有此类关系。</p>
          <article v-for="item in state.reviews" :key="item.id" class="graph-review">
            <strong>{{ item.source.name }} → {{ item.target.name }}</strong
            ><label>关系<input v-model="edits[item.id]" :placeholder="item.predicate" /></label
            ><small>置信度 {{ Math.round(item.confidence * 100) }}%</small>
            <blockquote v-for="ev in item.evidence" :key="ev.id">
              {{ ev.quote
              }}<button @click="openSource(ev)">{{ ev.title }} · L{{ ev.startLine }}</button>
            </blockquote>
            <div class="graph-actions">
              <AButton
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
                @click="model.command({ action: 'review', id: item.id, decision: 'ignore' })"
                >忽略</AButton
              ><AButton
                v-if="reviewStatus !== 'suggested'"
                @click="model.command({ action: 'review', id: item.id, decision: 'reset' })"
                >恢复候选</AButton
              >
            </div>
          </article>
          <AButton
            v-if="state.reviewHasMore"
            :loading="state.reviewLoading"
            @click="model.review(reviewStatus, reviewSearch, true)"
            >加载更多关系</AButton
          ></template
        >
        <template v-else-if="panel === 'views'"
          ><label
            >保存当前视图<input v-model="viewName" maxlength="100" placeholder="视图名称" /></label
          ><AButton
            :disabled="!viewName.trim()"
            @click="
              model
                .command({ action: 'save-view', name: viewName, query: state.query })
                .then((saved) => {
                  if (saved) viewName = '';
                })
            "
            >保存视图</AButton
          >
          <div v-for="saved in state.user.views" :key="saved.id" class="graph-actions">
            <AButton
              @click="
                state.query = JSON.parse(JSON.stringify(saved.query));
                refresh();
                panel = '';
              "
              >{{ saved.name }}</AButton
            ><AButton @click="model.command({ action: 'delete-view', id: saved.id })">删除</AButton>
          </div>
          <hr />
          <div class="graph-actions">
            <AButton
              :disabled="!state.result"
              @click="
                download(
                  JSON.stringify(state.result, null, 2),
                  'knowledge-graph.json',
                  'application/json',
                )
              "
              >导出当前 JSON</AButton
            ><AButton :disabled="!cy" @click="exportPng">导出画布 PNG</AButton>
          </div>
          <small>只导出当前可见、已授权的图谱结果。</small></template
        >
        <template v-else-if="panel === 'ask'"
          ><p>基于{{ node?.title || '问题命中的资料' }}的有限原文证据回答。</p>
          <label
            >问题<textarea
              v-model="question"
              rows="3"
              maxlength="2000"
              placeholder="这些概念之间有什么联系？"
            /></label
          ><AButton
            type="primary"
            :loading="state.busy"
            :disabled="!question.trim()"
            @click="model.ask(question)"
            >提问</AButton
          >
          <p v-if="!state.settings || state.settings.provider === 'none'">
            问答需要先配置模型。基础词项分析不会生成答案。
          </p>
          <template v-if="state.answer"
            ><p class="graph-answer">{{ state.answer.answer }}</p>
            <article
              v-for="ev in state.answer.evidence.filter((e) =>
                state.answer?.citations.includes(e.id),
              )"
              :key="ev.id"
            >
              <blockquote>{{ ev.quote }}</blockquote>
              <AButton @click="openSource(ev)"
                >{{ ev.title }} · L{{ ev.startLine }}–{{ ev.endLine }}</AButton
              >
            </article></template
          ></template
        >
        <p v-if="state.error" class="graph-error" role="alert">{{ state.error }}</p>
      </div></SettingsOverlay
    >
    <SettingsOverlay
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
    /></SettingsOverlay>
  </section>
</template>
