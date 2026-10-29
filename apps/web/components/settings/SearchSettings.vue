<script setup lang="ts">
import Icon from '../Icon.vue';
import SearchRuntimeSettings from '../SearchRuntimeSettings.vue';
</script>
<template>
  <div class="settings-stack">
    <SearchRuntimeSettings />
    <section class="settings-card">
      <h2 class="settings-section-title"><Icon name="search" :size="18" />索引与搜索</h2>
      <p class="settings-muted">
        文件名搜索可以直接使用；关键词与语义搜索的实际可用情况以上方检查结果为准。新笔记保存后会进入索引队列，进度可从设置中的「后台状态」查看。
      </p>
    </section>
  </div>
</template>
