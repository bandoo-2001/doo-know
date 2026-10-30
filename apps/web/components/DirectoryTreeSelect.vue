<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch, useId } from 'vue';
import { TreeSelect as ATreeSelect } from 'ant-design-vue';
const props = withDefaults(
  defineProps<{
    value: string;
    folders: { label: string; value: string }[];
    label: string;
    rootLabel?: string;
    // An explicit ID connects the caller's own visible label.
    id?: string;
    disabled?: boolean;
  }>(),
  { rootLabel: '知识库根目录' },
);
const emit = defineEmits<{ 'update:value': [value: string] }>();
const generatedId = useId();
const id = computed(() => props.id || generatedId);
interface DirectoryNode {
  key: string;
  value: string;
  title: string;
  label: string;
  children: DirectoryNode[];
}
const tree = computed(() => {
  const root: DirectoryNode = {
    key: '',
    value: '',
    title: props.rootLabel,
    label: props.rootLabel,
    children: [],
  };
  const nodes = new Map<string, DirectoryNode>([['', root]]);
  for (const folder of props.folders) {
    if (!folder.value) continue;
    nodes.set(folder.value, {
      key: folder.value,
      value: folder.value,
      title: folder.value.split('/').at(-1)!,
      label: folder.label,
      children: [],
    });
  }
  for (const [path, node] of nodes) {
    if (!path) continue;
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    (nodes.get(parent) || root).children.push(node);
  }
  return [root];
});
const control = ref<HTMLElement>();
const open = ref(false);
const expanded = ref<(string | number)[]>(['']);
const listHeight = ref(240);
const placement = ref<'topLeft' | 'bottomLeft'>('bottomLeft');
const popupContainer = () => document.body;
function expandSelected(path: string) {
  const parts = path.split('/').filter(Boolean);
  expanded.value = ['', ...parts.map((_, index) => parts.slice(0, index + 1).join('/'))];
}
watch(() => props.value, expandSelected, { immediate: true });
function search(query: string) {
  if (query) expanded.value = ['', ...props.folders.map((folder) => folder.value)];
  else expandSelected(props.value);
}
function measure() {
  const rect = control.value?.getBoundingClientRect();
  if (!rect) return;
  const above = Math.max(0, rect.top - 12);
  const below = Math.max(0, window.innerHeight - rect.bottom - 12);
  placement.value = below >= above ? 'bottomLeft' : 'topLeft';
  // The list height excludes the popup's 8px top/bottom padding and 4px anchor gap.
  listHeight.value = Math.max(24, Math.min(260, Math.max(above, below) - 20));
}
function visibility(shown: boolean) {
  if (shown) measure();
  open.value = shown;
}
function change(value: unknown) {
  if (typeof value === 'string') emit('update:value', value);
}
function escape(event: KeyboardEvent) {
  if (!open.value) return;
  event.preventDefault();
  event.stopPropagation();
  open.value = false;
}
function resize() {
  if (open.value) measure();
}
function settled(event: Event) {
  if (control.value && event.target instanceof HTMLElement && event.target.contains(control.value))
    resize();
}
onMounted(() => {
  window.addEventListener('resize', resize);
  document.addEventListener('scroll', resize, true);
  document.addEventListener('transitionend', settled, true);
  document.addEventListener('animationend', settled, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize);
  document.removeEventListener('scroll', resize, true);
  document.removeEventListener('transitionend', settled, true);
  document.removeEventListener('animationend', settled, true);
});
</script>
<template>
  <div ref="control" class="directory-select" @keydown.esc.capture="escape">
    <label v-if="!props.id" class="sr-only" :for="id">{{ label }}</label>
    <ATreeSelect
      :id="id"
      :value="value"
      :tree-data="tree"
      v-model:tree-expanded-keys="expanded"
      :disabled="disabled"
      :aria-label="label"
      :open="open"
      show-search
      tree-line
      tree-node-filter-prop="label"
      tree-node-label-prop="label"
      :list-height="listHeight"
      :placement="placement"
      :get-popup-container="popupContainer"
      :dropdown-style="{ zIndex: 3000, maxHeight: 'calc(100dvh - 16px)', overflow: 'auto' }"
      popup-class-name="directory-tree-popup"
      not-found-content="没有匹配的目录"
      @change="change"
      @search="search"
      @dropdown-visible-change="visibility"
    />
  </div>
</template>
<style>
.directory-select,
.directory-select > .ant-select {
  width: 100%;
  min-width: 0;
}
.directory-tree-popup {
  max-width: calc(100vw - 16px);
  overscroll-behavior: contain;
}
.directory-tree-popup .ant-select-tree-node-content-wrapper {
  min-width: 0;
}
.directory-tree-popup .ant-select-tree-title {
  overflow-wrap: anywhere;
}
</style>
