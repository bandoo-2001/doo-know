<script setup lang="ts">
import Icon from './Icon.vue';
import { ref, onMounted } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type {
  ManagementStorage,
  ManagementStorageCategory,
} from '../../../shared/management-contracts';
import { api } from '../api';
const state = ref<ManagementStorage>(),
  busy = ref(false),
  error = ref('');
const sections: { key: ManagementStorageCategory; title: string }[] = [
  { key: 'notes', title: '笔记原文' },
  { key: 'assets', title: '附件与其他文件' },
  { key: 'history', title: '历史版本' },
  { key: 'trash', title: '回收站' },
  { key: 'index', title: '搜索索引' },
  { key: 'models', title: '检索模型' },
  { key: 'upgradeBackups', title: '升级备份' },
];
function bytes(value: number) {
  if (value < 1024) return value + ' B';
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return (value / 1024 ** unit).toFixed(1) + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit];
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    state.value = await api<ManagementStorage>('/api/manage/storage');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => void refresh());
</script>
<template>
  <section class="storage-settings" aria-labelledby="storage-title">
    <header>
      <div>
        <h2 id="storage-title" class="settings-section-title">
          <Icon name="hard-drive" :size="18" />存储占用
        </h2>
        <p>按类别统计当前可读取的文件。</p>
      </div>
      <AButton size="small" :loading="busy" @click="refresh"
        ><template #icon><Icon class="settings-button-icon" name="refresh" :size="15" /></template
        >刷新统计</AButton
      >
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" />
    <p v-if="busy && !state" role="status">正在统计空间…</p>
    <template v-if="state">
      <table class="storage-table" aria-label="各类别存储占用">
        <thead>
          <tr>
            <th scope="col">类别</th>
            <th scope="col">占用</th>
            <th scope="col">文件数量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="section in sections" :key="section.key">
            <th scope="row">{{ section.title }}</th>
            <td class="storage-bytes">{{ bytes(state.categories[section.key].bytes) }}</td>
            <td class="storage-count">
              {{ state.categories[section.key].count }} 个文件
              <span v-if="state.categories[section.key].truncated" class="storage-partial"
                >部分统计</span
              >
            </td>
          </tr>
        </tbody>
      </table>
      <p class="storage-time">统计时间：{{ new Date(state.scannedAt).toLocaleString('zh-CN') }}</p>
      <p class="storage-hint">统计可能不完整，查看统计范围与提示。</p>
      <details>
        <summary>
          统计范围<span v-if="state.warnings.length"> · {{ state.warnings.length }} 条提示</span>
        </summary>
        <p>
          统计有数量和深度上限，不能作为完整备份证明。每类最多检查
          {{ state.limits.entriesPerCategory }} 个条目，目录深度上限
          {{
            state.limits.depth
          }}。升级备份仅指程序维护留下的副本；加密备份在「备份与恢复」中管理。无法读取或超出上限的项目不计入完整总量。
        </p>
        <ul v-if="state.warnings.length" class="storage-notes">
          <li v-for="warning in state.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </details>
    </template>
  </section>
</template>
<style scoped>
.storage-settings {
  display: grid;
  gap: 10px;
  min-width: 0;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
header > div {
  min-width: 0;
}
header :deep(.ant-btn) {
  flex-shrink: 0;
}
h2 {
  margin: 0 0 6px;
  font-size: 17px;
}
header p,
.storage-time,
.storage-hint {
  margin: 0;
  color: var(--muted, #687486);
  font-size: 12px;
  line-height: 1.5;
}
.storage-table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.5;
}
.storage-table th,
.storage-table td {
  padding: 6px 8px;
  text-align: right;
  vertical-align: middle;
  border-bottom: 1px solid var(--border, #e3e6ec);
  overflow-wrap: anywhere;
}
.storage-table th:first-child {
  width: 40%;
  padding-left: 0;
  text-align: left;
}
.storage-table th:last-child,
.storage-table td:last-child {
  padding-right: 0;
}
.storage-table thead th {
  color: var(--muted, #687486);
  font-size: 12px;
  font-weight: 400;
}
.storage-table tbody th {
  color: var(--text, #262b36);
  font-weight: 500;
}
.storage-bytes {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.storage-count {
  color: var(--muted, #687486);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.storage-partial {
  display: block;
  color: var(--muted, #687486);
  font-size: 11px;
}
.storage-notes,
details {
  font-size: 12px;
  color: var(--muted, #687486);
}
.storage-notes {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
}
.storage-settings > details {
  margin-top: 0;
}
details p {
  margin: 8px 0;
}
summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
@media (max-width: 360px) {
  .storage-table th,
  .storage-table td {
    padding-inline: 4px;
  }
  .storage-table th:first-child {
    padding-left: 0;
  }
  .storage-table th:last-child,
  .storage-table td:last-child {
    padding-right: 0;
  }
}
</style>
