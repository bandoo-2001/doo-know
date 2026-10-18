<script setup lang="ts">
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
        <h2 id="storage-title">存储占用</h2>
        <p>按类别统计当前可读取的文件。统计有数量和深度上限，不能作为完整备份证明。</p>
      </div>
      <AButton size="small" :loading="busy" @click="refresh">刷新统计</AButton>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" />
    <p v-if="busy && !state" role="status">正在统计空间…</p>
    <template v-if="state"
      ><div class="storage-cards">
        <article v-for="section in sections" :key="section.key">
          <h3>{{ section.title }}</h3>
          <strong>{{ bytes(state.categories[section.key].bytes) }}</strong
          ><span
            >{{ state.categories[section.key].count }} 个文件{{
              state.categories[section.key].truncated ? ' · 部分统计' : ''
            }}</span
          >
        </article>
      </div>
      <p class="storage-time">统计时间：{{ new Date(state.scannedAt).toLocaleString('zh-CN') }}</p>
      <ul class="storage-notes">
        <li v-for="warning in state.warnings" :key="warning">{{ warning }}</li>
      </ul>
      <details>
        <summary>统计范围</summary>
        <p>
          每类最多检查 {{ state.limits.entriesPerCategory }} 个条目，目录深度上限
          {{
            state.limits.depth
          }}。升级备份仅指程序维护留下的副本；加密备份在「备份与恢复」中管理。无法读取或超出上限的项目不计入完整总量。
        </p>
      </details></template
    >
  </section>
</template>
<style scoped>
.storage-settings {
  display: grid;
  gap: 14px;
  min-width: 0;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0 0 6px;
  font-size: 17px;
}
header p,
.storage-time {
  margin: 0;
  color: var(--muted, #687486);
  font-size: 12px;
  line-height: 1.7;
}
.storage-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
article {
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  padding: 14px;
  display: grid;
  gap: 7px;
}
h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}
strong {
  font-size: 21px;
  font-weight: 600;
}
article span,
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
summary {
  cursor: pointer;
  color: var(--blue, #4566c6);
}
@media (max-width: 600px) {
  .storage-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  header {
    flex-direction: column;
  }
}
@media (max-width: 420px) {
  .storage-cards {
    grid-template-columns: 1fr;
  }
}
</style>
