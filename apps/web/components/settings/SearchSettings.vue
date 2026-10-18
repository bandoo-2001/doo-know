<script setup lang="ts">
import SearchRuntimeSettings from '../SearchRuntimeSettings.vue';
</script>
<template>
  <div class="settings-stack">
    <SearchRuntimeSettings />
    <section class="settings-card">
      <h2>索引与搜索</h2>
      <p class="settings-muted">
        文件名搜索可以直接使用；关键词与语义搜索的实际可用情况以上方检查结果为准。新笔记保存后会进入索引队列，进度可从左下角「状态」查看。
      </p>
    </section>
  </div>
</template>
