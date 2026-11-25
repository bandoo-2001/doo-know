<script setup lang="ts">
import GitRemotePanel from './GitRemotePanel.vue';
const emit = defineEmits<{ refresh: [] }>();
</script>
<template>
  <GitRemotePanel mode="import" @imported="emit('refresh')" />
</template>
