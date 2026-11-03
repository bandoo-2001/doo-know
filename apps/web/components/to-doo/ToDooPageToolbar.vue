<script setup lang="ts">
withDefaults(defineProps<{ tag?: 'div' | 'form' }>(), { tag: 'div' });
</script>

<template>
  <component :is="tag" class="todo-page-toolbar"><slot /></component>
</template>
