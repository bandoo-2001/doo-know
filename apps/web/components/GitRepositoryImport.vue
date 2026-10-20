<script setup lang="ts">
import GitRemotePanel from './GitRemotePanel.vue';
defineProps<{ timeZone?: string }>();
const emit = defineEmits<{ refresh: [] }>();
</script>
<template>
  <GitRemotePanel mode="import" :time-zone="timeZone" @imported="emit('refresh')" />
</template>
