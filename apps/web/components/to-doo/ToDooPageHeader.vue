<script setup lang="ts">
defineProps<{ title: string; description?: string; dailyCaption?: boolean }>();
</script>

<template>
  <header class="todo-page-heading">
    <div class="todo-page-heading-copy">
      <h1 :title="title">{{ title }}</h1>
      <p v-if="description" :class="{ 'todo-daily-caption': dailyCaption }">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="todo-actions"><slot name="actions" /></div>
  </header>
</template>
