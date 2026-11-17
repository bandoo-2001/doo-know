<script setup lang="ts">
import { computed } from 'vue';
import { toDooTaskValue, type ToDooTaskValueKind } from '../../to-doo-task-values';

const props = defineProps<{ kind: ToDooTaskValueKind; value: string }>();
const presentation = computed(() => toDooTaskValue(props.kind, props.value));
</script>

<template>
  <span class="todo-task-value-label" :data-kind="kind" :data-value="value">
    <svg
      class="todo-task-value-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path :d="presentation.path" />
    </svg>
    <span>{{ presentation.label }}</span>
  </span>
</template>

<style src="../../to-doo-task-values.css"></style>
