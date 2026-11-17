<script setup lang="ts">
import ToDooIcon from './ToDooIcon.vue';

withDefaults(
  defineProps<{
    list: { kind?: string; color?: string; icon?: string | null };
    size?: number;
  }>(),
  { size: 18 },
);
</script>

<template>
  <span
    class="todo-list-icon"
    :class="{ 'todo-list-icon-emoji': list.icon && !['dot', 'folder'].includes(list.icon) }"
    :style="{
      color: list.color || 'var(--todo-muted)',
      width: size + 'px',
      height: size + 'px',
      fontSize: size + 'px',
    }"
    aria-hidden="true"
  >
    <span v-if="list.icon === 'dot'" class="todo-list-icon-dot" />
    <ToDooIcon
      v-else-if="!list.icon || list.icon === 'folder'"
      :name="list.icon === 'folder' ? 'folder' : list.kind === 'goal' ? 'overview' : 'list'"
      :size="size"
    />
    <span v-else>{{ list.icon }}</span>
  </span>
</template>

<style scoped>
.todo-list-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  vertical-align: middle;
  line-height: 1;
}
.todo-list-icon-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: currentColor;
}
.todo-list-icon-emoji {
  font-family: 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji', sans-serif;
}
</style>
