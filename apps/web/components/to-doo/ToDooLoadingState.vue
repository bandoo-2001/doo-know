<script setup lang="ts">
import { computed } from 'vue';
import { Skeleton as ASkeleton } from 'ant-design-vue';
import type { ToDooAppSection } from '../../navigation';
import ToDooIcon from './ToDooIcon.vue';

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{ section?: ToDooAppSection; embedded?: boolean }>(), {
  section: 'tasks',
  embedded: false,
});
const layout = computed(() =>
  props.section === 'matrix'
    ? 'matrix'
    : props.section === 'calendar'
      ? 'calendar'
      : ['overview', 'stats', 'board'].includes(props.section)
        ? 'cards'
        : 'list',
);
const panels = computed(() => (layout.value === 'matrix' ? 4 : layout.value === 'cards' ? 3 : 1));
</script>

<template>
  <div
    class="todo-loading"
    :class="{ 'todo-loading-shell': !embedded }"
    role="status"
    aria-label="正在载入 To Doo…"
    aria-live="polite"
    aria-busy="true"
  >
    <div v-if="!embedded" class="todo-loading-brand">
      <span><ToDooIcon name="check" :size="18" /></span>
      <strong>To Doo</strong>
    </div>
    <div class="todo-loading-caption"><span aria-hidden="true"></span>正在载入…</div>
    <div class="todo-loading-layout" :class="`todo-loading-${layout}`" aria-hidden="true">
      <div v-for="panel in panels" :key="panel" class="todo-loading-panel">
        <ASkeleton
          :active="false"
          :title="{ width: '28%' }"
          :paragraph="{ rows: 5, width: ['74%', '58%', '82%', '68%', '46%'] }"
        />
        <div v-if="layout === 'calendar'" class="todo-loading-days">
          <span v-for="day in 35" :key="day"></span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-loading {
  --loading-ink: var(--todo-muted, var(--muted, #657084));
  --loading-line: var(--todo-line, var(--border, #e6e9f1));
  --loading-paper: var(--todo-paper, var(--panel, #fff));
  --loading-fill: color-mix(in srgb, var(--loading-ink) 10%, var(--loading-paper));
  min-width: 0;
  color: var(--loading-ink);
  animation: todo-loading-appear 220ms ease-out both;
}
.todo-loading-shell {
  box-sizing: border-box;
  width: 100%;
  min-height: 100%;
  padding: 20px 24px;
  background: var(--loading-paper);
}
.todo-loading-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 38px;
  color: var(--todo-ink, var(--text, #272b3a));
  font-size: 15px;
}
.todo-loading-brand > span {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  border-radius: 8px;
  color: white;
  background: var(--todo-accent, var(--blue, #4566c6));
}
.todo-loading-caption {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
  margin-bottom: 16px;
  font-size: 12px;
}
.todo-loading-caption > span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--todo-accent, var(--blue, #4566c6));
  opacity: 0.55;
}
.todo-loading-layout {
  display: grid;
  gap: 16px;
  animation: todo-loading-breathe 2.4s ease-in-out infinite;
}
.todo-loading-panel {
  box-sizing: border-box;
  min-width: 0;
  min-height: 290px;
  padding: 20px;
  border: 1px solid var(--loading-line);
  border-radius: 12px;
  background: var(--loading-paper);
}
.todo-loading :deep(.ant-skeleton-title),
.todo-loading :deep(.ant-skeleton-paragraph > li) {
  background: var(--loading-fill);
  border-radius: 5px;
}
.todo-loading :deep(.ant-skeleton-title) {
  margin-top: 2px;
  height: 12px;
}
.todo-loading :deep(.ant-skeleton-paragraph) {
  margin-top: 30px;
  padding: 0;
}
.todo-loading :deep(.ant-skeleton-paragraph > li) {
  height: 12px;
  margin-top: 26px;
}
.todo-loading-matrix {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.todo-loading-matrix .todo-loading-panel {
  min-height: 230px;
}
.todo-loading-matrix :deep(.ant-skeleton-paragraph > li:nth-child(n + 4)) {
  display: none;
}
.todo-loading-cards {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.todo-loading-calendar :deep(.ant-skeleton-paragraph) {
  display: none;
}
.todo-loading-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 1px;
  margin-top: 22px;
  background: var(--loading-line);
}
.todo-loading-days > span {
  height: 66px;
  padding: 10px;
  background: var(--loading-paper);
}
.todo-loading-days > span::before {
  content: '';
  display: block;
  width: 20%;
  min-width: 10px;
  height: 7px;
  border-radius: 3px;
  background: var(--loading-fill);
}
@keyframes todo-loading-breathe {
  0%,
  100% {
    opacity: 0.65;
  }
  50% {
    opacity: 1;
  }
}
@keyframes todo-loading-appear {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@media (max-width: 600px) {
  .todo-loading-shell {
    padding: 20px 13px;
  }
  .todo-loading-cards,
  .todo-loading-matrix {
    grid-template-columns: minmax(0, 1fr);
  }
  .todo-loading-panel {
    padding: 16px;
  }
  .todo-loading-days > span {
    height: 45px;
    padding: 6px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .todo-loading,
  .todo-loading-layout {
    animation: none;
  }
}
</style>
