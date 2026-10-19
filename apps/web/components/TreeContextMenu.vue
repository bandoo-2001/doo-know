<script lang="ts">
export type TreeAction =
  | 'open'
  | 'new-note'
  | 'new-folder'
  | 'import'
  | 'copy'
  | 'move'
  | 'download'
  | 'favorite'
  | 'delete';
</script>
<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import type { TreeEntry } from '../../../shared/contracts';
const props = defineProps<{ path?: string; favoriteIds?: string[]; favoriteBusy?: boolean }>();
const emit = defineEmits<{
  action: [entry: TreeEntry, action: TreeAction];
  'update:path': [path: string];
}>();
const entry = ref<TreeEntry>();
const menu = ref<HTMLElement>();
const x = ref(0),
  y = ref(0),
  positioned = ref(false);
let trigger: HTMLElement | undefined;
let triggerRect: DOMRect | undefined;
let opening = 0;
const items = computed<{ key: TreeAction; label: string }[]>(() => [
  { key: 'open', label: '打开' },
  ...(entry.value?.type === 'folder'
    ? [
        { key: 'new-note' as const, label: '新建笔记' },
        { key: 'new-folder' as const, label: '新建子文件夹' },
        { key: 'import' as const, label: '导入 Markdown' },
      ]
    : [
        {
          key: 'favorite' as const,
          label: props.favoriteIds?.includes(entry.value?.id || '') ? '取消收藏' : '收藏',
        },
        { key: 'move' as const, label: '重命名或移动' },
        { key: 'download' as const, label: '下载 Markdown' },
      ]),
  { key: 'copy', label: '复制路径' },
  ...(entry.value?.type === 'note' ? [{ key: 'delete' as const, label: '移入回收站' }] : []),
]);
function close(restoreFocus = false) {
  opening++;
  entry.value = undefined;
  emit('update:path', '');
  if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
}
async function open(target: TreeEntry, event: MouseEvent | KeyboardEvent) {
  const epoch = ++opening;
  const source = event.target as HTMLElement;
  trigger =
    source.closest<HTMLElement>('button') ||
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.tree-select') ||
    undefined;
  const rect = trigger?.getBoundingClientRect();
  triggerRect = rect;
  const pointer =
    event.type === 'contextmenu' && event instanceof MouseEvent && event.clientX !== 0;
  x.value = pointer ? event.clientX : rect?.left || 8;
  y.value = pointer ? event.clientY : rect?.bottom || 8;
  positioned.value = false;
  entry.value = target;
  emit('update:path', target.path);
  await nextTick();
  if (!menu.value || epoch !== opening) return;
  const box = menu.value.getBoundingClientRect();
  x.value = Math.max(8, Math.min(x.value, window.innerWidth - box.width - 8));
  y.value = Math.max(8, Math.min(y.value, window.innerHeight - box.height - 8));
  positioned.value = true;
  await nextTick();
  if (epoch !== opening) return;
  menu.value.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}
function choose(action: TreeAction) {
  const target = entry.value;
  close(true);
  if (target) emit('action', target, action);
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape' || event.key === 'Tab') {
    if (event.key === 'Escape') event.preventDefault();
    close(true);
    return;
  }
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('button') || [])];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
  else if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault();
  buttons[next]?.focus();
}
function outside(event: Event) {
  if (!entry.value || menu.value?.contains(event.target as Node)) return;
  if (event.type === 'scroll' && trigger?.isConnected && triggerRect) {
    const rect = trigger.getBoundingClientRect();
    // Bringing a row into view can queue a scroll event before its menu opens.
    if (rect.x === triggerRect.x && rect.y === triggerRect.y) return;
  }
  close();
}
function resize() {
  close();
}
onMounted(() => {
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('scroll', outside, true);
  window.addEventListener('resize', resize);
});
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', outside, true);
  document.removeEventListener('scroll', outside, true);
  window.removeEventListener('resize', resize);
});
defineExpose({ open });
</script>
<template>
  <Teleport to="body">
    <div
      v-if="entry"
      id="tree-context-menu"
      ref="menu"
      role="menu"
      :aria-label="`${entry.name} 的操作`"
      class="tree-context-menu"
      :style="{ left: x + 'px', top: y + 'px', visibility: positioned ? 'visible' : 'hidden' }"
      @keydown="keydown"
      @contextmenu.prevent
    >
      <div class="tree-menu-title" :title="entry.path">{{ entry.name }}</div>
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        role="menuitem"
        tabindex="-1"
        :class="{ danger: item.key === 'delete' }"
        :disabled="item.key === 'favorite' && favoriteBusy"
        @click="choose(item.key)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>
<style>
.tree-context-menu {
  position: fixed;
  z-index: 2100;
  width: min(216px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--border, #dce0e7);
  border-radius: 8px;
  background: var(--bg, #fff);
  color: var(--text, #303746);
  box-shadow: 0 8px 28px #0002;
}
.tree-menu-title {
  padding: 5px 10px 8px;
  font-size: 12px;
  opacity: 0.65;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-context-menu button {
  display: block;
  width: 100%;
  min-height: 36px;
  padding: 7px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
}
.tree-context-menu button:hover,
.tree-context-menu button:focus-visible {
  background: var(--blue-soft, #e9ecf2);
  outline: 2px solid var(--blue, #4566c6);
  outline-offset: -2px;
}
.tree-context-menu button.danger {
  color: #d34444;
}
</style>
