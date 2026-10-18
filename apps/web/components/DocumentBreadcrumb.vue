<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { NPopover } from 'naive-ui';
import Icon from './Icon.vue';

const props = defineProps<{ relativePath: string; title: string }>();
const emit = defineEmits<{
  root: [];
  folder: [entry: { type: 'folder'; name: string; path: string }];
}>();
const crumbs = computed(() => {
  const parts = props.relativePath.split('/').slice(0, -1);
  return parts.map((name, index) => ({ name, path: parts.slice(0, index + 1).join('/') }));
});
const parent = computed(() => crumbs.value.at(-1));
const fileName = computed(
  () => props.relativePath.split('/').at(-1)?.replace(/\.md$/i, '') || props.title,
);
const open = ref(false);
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const menuId = useId();
watch(open, async (shown) => {
  if (shown) {
    await nextTick();
    menu.value?.querySelector('button')?.focus();
  }
});
watch(
  () => props.relativePath,
  () => (open.value = false),
);
function close() {
  open.value = false;
  trigger.value?.focus();
}
function select(crumb: { name: string; path: string }) {
  close();
  emit('folder', { type: 'folder', ...crumb });
}
</script>

<template>
  <nav class="document-identity document-breadcrumb" aria-label="笔记路径">
    <button class="breadcrumb-root" type="button" aria-label="返回笔记本" @click="emit('root')">
      <Icon name="book" :size="17" /><span>笔记本</span>
    </button>
    <template v-if="crumbs.length">
      <Icon
        class="breadcrumb-chevron"
        :class="{ 'breadcrumb-overflow-single': crumbs.length === 1 }"
        name="chevron"
        :size="12"
      />
      <NPopover v-model:show="open" trigger="click" placement="bottom-start" :show-arrow="false">
        <template #trigger>
          <button
            ref="trigger"
            class="breadcrumb-overflow"
            :class="{ 'breadcrumb-overflow-single': crumbs.length === 1 }"
            type="button"
            aria-label="展开完整路径"
            title="展开完整路径"
            aria-haspopup="dialog"
            :aria-expanded="open"
            :aria-controls="open ? menuId : undefined"
            @keydown.esc.stop.prevent="close"
          >
            <Icon name="more" :size="18" />
          </button>
        </template>
        <div
          :id="menuId"
          ref="menu"
          class="breadcrumb-menu"
          role="dialog"
          aria-label="完整笔记路径"
          @keydown.esc.stop.prevent="close"
        >
          <button
            v-for="crumb in crumbs"
            :key="crumb.path"
            type="button"
            :aria-label="'打开目录 ' + crumb.path"
            :title="crumb.path"
            @click="select(crumb)"
          >
            <Icon name="folder" :size="16" />
            <span
              ><span class="breadcrumb-menu-name">{{ crumb.name }}</span
              ><span class="breadcrumb-menu-path">{{ crumb.path }}</span></span
            >
          </button>
        </div>
      </NPopover>
      <Icon class="breadcrumb-chevron breadcrumb-parent-chevron" name="chevron" :size="12" />
      <button
        v-if="parent"
        class="breadcrumb-folder"
        type="button"
        :aria-label="'打开目录 ' + parent.name"
        :title="parent.path"
        @click="select(parent)"
      >
        <Icon name="folder" :size="16" /><span>{{ parent.name }}</span>
      </button>
    </template>
    <Icon class="breadcrumb-chevron" name="chevron" :size="12" />
    <h1 class="document-title" :title="relativePath">{{ fileName }}</h1>
  </nav>
</template>
