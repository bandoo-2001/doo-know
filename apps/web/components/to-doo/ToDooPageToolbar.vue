<script setup lang="ts">
withDefaults(defineProps<{ tag?: 'div' | 'form' }>(), { tag: 'div' });
</script>

<template>
  <component :is="tag" class="todo-page-toolbar" :role="tag === 'div' ? 'group' : undefined"><slot /></component>
</template>
