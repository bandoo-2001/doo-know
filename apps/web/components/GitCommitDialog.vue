<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import { NModal } from 'naive-ui';
import { GitCommitForm } from '../git/commit-form';
const show = defineModel<boolean>({ required: true });
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    class="dialog-card git-commit-dialog"
    title="提交全部变更"
    :closable="false"
  >
    <template #header-extra>
      <AButton size="small" type="text" aria-label="关闭提交面板" @click="show = false"
        >关闭</AButton
      >
    </template>
    <div class="git-commit-content"><GitCommitForm /></div>
  </NModal>
</template>

<style>
.git-commit-dialog {
  width: min(820px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  margin: 16px auto;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
}
.git-commit-content {
  min-width: 0;
  max-height: calc(100dvh - 132px);
  overflow: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
}
</style>
