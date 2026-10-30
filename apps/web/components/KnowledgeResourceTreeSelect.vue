<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { TreeSelect as ATreeSelect } from 'ant-design-vue';
import type { ResourceRef, ResourceSet } from '../../../shared/permissions';
import type { PermissionResourceOption } from '../mcp-permissions';
import {
  buildKnowledgeResourceTree,
  knowledgeResourceKey,
  knowledgeResourceSelection,
  type KnowledgeResourceNode,
} from '../knowledge-resource-tree';
import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{
    id?: string;
    value: ResourceRef[];
    resources: PermissionResourceOption[];
    ceiling?: ResourceSet;
    disabled?: boolean;
    label?: string;
  }>(),
  { label: '选择知识库资源' },
);
const emit = defineEmits<{ 'update:value': [value: ResourceRef[]] }>();
const generatedId = useId();
const controlId = computed(() => props.id || generatedId);
const tree = computed(() =>
  buildKnowledgeResourceTree(props.resources, props.value, props.ceiling),
);
const nodes = computed(() => {
  const walk = (branch: KnowledgeResourceNode[]): KnowledgeResourceNode[] =>
    branch.flatMap((node) => [node, ...walk(node.children)]);
  return walk(tree.value);
});
const byKey = computed(() => new Map(nodes.value.map((node) => [node.key, node])));
const selectedValues = computed(() =>
  props.value.map((ref) => {
    const value = knowledgeResourceKey(ref);
    return { value, label: byKey.value.get(value)?.label || ref.id };
  }),
);
const directoryCount = computed(() => props.value.filter((ref) => ref.kind === 'directory').length);
const noteCount = computed(() => props.value.filter((ref) => ref.kind === 'note').length);
const expanded = ref<string[]>([]);
const query = ref('');
watch(
  [() => props.value, () => props.resources],
  () => {
    const keys = new Set(expanded.value);
    const selected = new Set(props.value.map(knowledgeResourceKey));
    const paths = nodes.value
      .filter((node) => selected.has(node.key) && node.path)
      .map((node) => node.path!);
    for (const node of nodes.value) {
      if (
        node.kind === 'directory' &&
        node.path &&
        paths.some((path) => path === node.path || path.startsWith(node.path + '/'))
      )
        keys.add(node.key);
    }
    expanded.value = [...keys];
  },
  { immediate: true },
);
function search(value: string) {
  query.value = value;
  if (value)
    expanded.value = nodes.value.filter((node) => node.children.length).map((node) => node.key);
}
function change(values: unknown) {
  if (!props.disabled)
    emit(
      'update:value',
      knowledgeResourceSelection(values, props.resources, props.value, props.ceiling),
    );
}

const control = ref<HTMLElement>();
const open = ref(false);
const listHeight = ref(260);
const placement = ref<'topLeft' | 'bottomLeft'>('bottomLeft');
const popupContainer = () => document.body;
function measure() {
  const rect = control.value?.getBoundingClientRect();
  if (!rect) return;
  const above = Math.max(0, rect.top - 12);
  const below = Math.max(0, window.innerHeight - rect.bottom - 12);
  placement.value = below >= above ? 'bottomLeft' : 'topLeft';
  listHeight.value = Math.max(24, Math.min(300, Math.max(above, below) - 20));
}
function visibility(shown: boolean) {
  if (shown) measure();
  open.value = shown;
  if (!shown) query.value = '';
}
function escape(event: KeyboardEvent) {
  if (!open.value) return;
  event.preventDefault();
  event.stopPropagation();
  visibility(false);
}
function resize() {
  if (open.value) measure();
}
onMounted(() => {
  window.addEventListener('resize', resize);
  document.addEventListener('scroll', resize, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  document.removeEventListener('scroll', resize, true);
});
</script>

<template>
  <div class="knowledge-resource-select" @keydown.esc.capture="escape">
    <div ref="control">
      <ATreeSelect
        :id="controlId"
        :value="selectedValues"
        :tree-data="tree"
        v-model:tree-expanded-keys="expanded"
        :search-value="query"
        :aria-label="label"
        :aria-describedby="controlId + '-summary ' + controlId + '-help'"
        :disabled="disabled"
        :open="open"
        tree-checkable
        tree-check-strictly
        show-search
        :tree-line="{ showLeafIcon: false }"
        tree-node-filter-prop="label"
        tree-node-label-prop="label"
        :max-tag-count="2"
        :max-tag-placeholder="(omitted: unknown[]) => '另 ' + omitted.length + ' 项'"
        :list-height="listHeight"
        :placement="placement"
        :get-popup-container="popupContainer"
        :dropdown-style="{ zIndex: 3000, maxHeight: 'calc(100dvh - 16px)', overflow: 'auto' }"
        popup-class-name="knowledge-resource-tree-popup"
        placeholder="搜索或选择目录、笔记"
        not-found-content="没有匹配的目录或笔记"
        @change="change"
        @search="search"
        @dropdown-visible-change="visibility"
      >
        <template #title="node">
          <span class="knowledge-resource-title" :title="node.label">
            <span
              v-if="node.included"
              class="resource-inherited-check"
              role="checkbox"
              aria-label="随父目录包含"
              aria-checked="true"
              aria-disabled="true"
              ><Icon name="check" :size="12"
            /></span>
            <Icon :name="node.kind === 'directory' ? 'folder' : 'file'" :size="15" />
            <span class="knowledge-resource-name">{{ node.title }}</span>
            <span v-if="node.included" class="knowledge-resource-hint">随父目录包含</span>
          </span>
        </template>
      </ATreeSelect>
    </div>
    <p :id="controlId + '-summary'" class="knowledge-resource-summary" aria-live="polite">
      已选 {{ directoryCount }} 个目录 · {{ noteCount }} 篇笔记
    </p>
    <p :id="controlId + '-help'" class="knowledge-resource-help">
      目录包含当前及以后新增的子目录和笔记。取消父目录后，可单独选择其中的资料。
    </p>
  </div>
</template>

<style>
.knowledge-resource-select,
.knowledge-resource-select > div,
.knowledge-resource-select .ant-select {
  width: 100%;
  min-width: 0;
}
.knowledge-resource-select .ant-select-selection-overflow-item {
  max-width: 100%;
}
.knowledge-resource-select .ant-select-selection-item {
  max-width: min(220px, 100%);
}
.knowledge-resource-summary,
.knowledge-resource-help {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.knowledge-resource-tree-popup {
  max-width: calc(100vw - 16px);
  overscroll-behavior: contain;
}
.knowledge-resource-tree-popup .ant-select-tree-node-content-wrapper {
  min-width: 0;
}
.knowledge-resource-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  vertical-align: middle;
}
.knowledge-resource-title > svg {
  flex: none;
  color: var(--muted);
}
.knowledge-resource-name {
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.knowledge-resource-hint {
  flex: none;
  color: var(--muted);
  font-size: 11px;
}
.resource-inherited-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-alt, #f0f2f5);
  color: var(--muted);
}
</style>
