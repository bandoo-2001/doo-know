<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, useAttrs, useId } from 'vue';
import { Tag as ATag, TreeSelect as ATreeSelect } from 'ant-design-vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import { matchesToDooListSearch } from '../../to-doo-list-select-tree';
import {
  prepareToDooListMultiSelection,
  readToDooListMultiChange,
  type ToDooListMultiNode,
} from '../../to-doo-list-multi-select';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import { createToDooPopupEscapeBoundary } from '../../to-doo-controls';
import '../../to-doo-list-select.css';

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    model: ToDooWorkbench;
    modelValue?: string[];
    value?: string[];
    disabled?: boolean;
    includeInbox?: boolean;
    placeholder?: string;
  }>(),
  { disabled: undefined, includeInbox: false, placeholder: '选择清单' },
);
const emit = defineEmits<{
  'update:modelValue': [value: string[]];
  'update:value': [value: string[]];
  change: [value: string[]];
}>();
const attrs = useAttrs();
const popupEscape = createToDooPopupEscapeBoundary();
const generatedId = 'todo-list-tree-multi-' + useId();
const inputId = computed(() => String(attrs.id || generatedId));
const search = ref(''),
  loading = ref(false);
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const selected = computed(() => {
  const value = props.modelValue !== undefined ? props.modelValue : props.value;
  return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
});
const prepared = computed(() =>
  prepareToDooListMultiSelection(props.model.taskLists(), selected.value, props.includeInbox),
);
function selectAttrs() {
  const result = { ...attrs };
  for (const key of ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-required'])
    delete result[key];
  return result;
}
function syncAccessibility() {
  const input = document.getElementById(inputId.value);
  if (!input) return;
  input.setAttribute('aria-label', String(attrs['aria-label'] || '清单'));
  for (const key of ['aria-labelledby', 'aria-describedby', 'aria-required'])
    if (attrs[key] !== undefined) input.setAttribute(key, String(attrs[key]));
}
onMounted(syncAccessibility);
onUpdated(syncAccessibility);
async function loadCatalog() {
  loading.value = true;
  try {
    await props.model.ensureListCatalog();
  } finally {
    if (alive) loading.value = false;
  }
}
onMounted(() => {
  void loadCatalog();
});
function openChanged(open: boolean) {
  if (open) void loadCatalog();
  else search.value = '';
}
function nodeData(node: any): ToDooListMultiNode {
  return node.dataRef || node;
}
function tagData(value: unknown) {
  const id = prepared.value.controlToDomain.get(String(value));
  return id ? prepared.value.byDomain.get(id) : undefined;
}
function tagPointerDown(event: MouseEvent) {
  if (!(event.target instanceof Element) || !event.target.closest('.ant-tag-close-icon')) return;
  event.preventDefault();
  event.stopPropagation();
}
function change(value: unknown) {
  if (props.disabled) return;
  const next = readToDooListMultiChange(value, prepared.value.controlToDomain);
  if (!next) return;
  emit('update:modelValue', next);
  emit('update:value', next);
  emit('change', next);
}
</script>

<template>
  <ATreeSelect
    v-bind="selectAttrs()"
    :id="inputId"
    class="todo-ant-select todo-list-tree-select todo-list-tree-multi-select"
    :value="prepared.values"
    :tree-data="prepared.tree"
    :disabled="disabled"
    :loading="loading"
    :placeholder="placeholder"
    :search-value="search"
    :filter-tree-node="
      (query, node) => matchesToDooListSearch(query, String(node.searchText || node.label || ''))
    "
    tree-node-label-prop="label"
    tree-node-filter-prop="searchText"
    popup-class-name="todo-ant-popup todo-list-tree-popup todo-list-tree-multi-popup"
    multiple
    tree-checkable
    tree-check-strictly
    tree-default-expand-all
    show-search
    allow-clear
    :virtual="false"
    :list-height="260"
    @dropdown-visible-change="openChanged"
    @search="search = $event"
    @change="change"
    @click.prevent
    @keydown.capture="popupEscape.capture"
    @keydown="popupEscape.bubble"
  >
    <template #title="node">
      <span class="todo-list-tree-node" :data-list-id="nodeData(node).list?.id">
        <ToDooListIcon v-if="nodeData(node).list" :list="nodeData(node).list!" :size="18" />
        <ToDooIcon v-else name="inbox" :size="18" />
        <span class="todo-list-tree-node-name" :title="nodeData(node).searchText">{{
          nodeData(node).label
        }}</span>
      </span>
    </template>
    <template #tagRender="{ value, closable, onClose }">
      <ATag
        class="todo-list-tree-tag"
        :closable="closable"
        @close="onClose"
        @mousedown="tagPointerDown"
      >
        <ToDooListIcon v-if="tagData(value)?.list" :list="tagData(value)!.list!" :size="15" />
        <ToDooIcon v-else name="inbox" :size="15" />
        <span>{{ tagData(value)?.label || '当前清单（尚未载入）' }}</span>
      </ATag>
    </template>
  </ATreeSelect>
</template>
