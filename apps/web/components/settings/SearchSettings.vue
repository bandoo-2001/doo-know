<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import Icon from '../Icon.vue';
import SearchRuntimeSettings from '../SearchRuntimeSettings.vue';
const emit = defineEmits<{ 'open-status': [] }>();
</script>
<template>
  <div class="settings-stack">
    <SearchRuntimeSettings />
    <section class="settings-card">
      <div class="settings-item-header">
        <div>
          <h2 class="settings-section-title"><Icon name="search" :size="18" />索引与搜索</h2>
          <p>保存笔记后会自动更新索引。可以在后台状态中查看进度和需要处理的项目。</p>
        </div>
        <AButton size="small" @click="emit('open-status')">查看索引状态</AButton>
      </div>
    </section>
  </div>
</template>
