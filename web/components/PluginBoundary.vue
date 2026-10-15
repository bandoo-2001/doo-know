<script setup lang="ts">
import { ref, onErrorCaptured } from 'vue';
import { NAlert } from 'naive-ui';
const failed = ref(false);
onErrorCaptured(() => { failed.value = true; return false; });
</script>
<template><NAlert v-if="failed" type="error">此插件界面运行失败，可以关闭面板或停用插件。</NAlert><slot v-else /></template>
