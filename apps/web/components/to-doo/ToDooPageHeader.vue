<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <header class="todo-page-heading">
    <div class="todo-page-heading-copy">
      <h1 :title="title" :aria-label="title">
        <slot name="title">{{ title }}</slot>
      </h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="todo-actions" role="group" :aria-label="title + '操作'"><slot name="actions" /></div>
  </header>
</template>
<style src="../../to-doo-layout.css"></style>
