<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="todo-panel-header todo-section-header">
    <h2>{{ title }}</h2>
    <slot />
  </div>
</template>
