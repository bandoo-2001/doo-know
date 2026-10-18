<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import type { MaintenanceStorage } from '../../../shared/platform-contracts';
import { api } from '../api';
const state = ref<MaintenanceStorage>(),
  busy = ref(false),
  error = ref('');
const sections = [
  { key: 'history', title: '历史版本', detail: '修改前的版本，用于找回以前的内容。' },
  { key: 'trash', title: '回收站', detail: '已归档的原文，可从回收站恢复。' },
  { key: 'backups', title: '升级备份', detail: '安装目录内的备份文件，不包含自选位置的备份。' },
] as const;
function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    state.value = await api<MaintenanceStorage>('/api/maintenance/storage');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(refresh);
</script>
<template>
  <section class="storage-settings" aria-labelledby="storage-title">
    <header>
      <div>
        <h2 id="storage-title">空间与备份</h2>
        <p>查看历史、回收站和升级备份的占用，决定何时安排维护。</p>
      </div>
      <AButton size="small" :loading="busy" @click="refresh">刷新</AButton>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" role="alert" />
    <p v-if="!state && busy" role="status">正在统计空间…</p>
    <template v-if="state">
      <div class="storage-cards">
        <article v-for="section in sections" :key="section.key">
          <h3>{{ section.title }}</h3>
          <strong>{{ bytes(state[section.key].bytes) }}</strong>
          <span
            >{{ state[section.key].count }} 个文件{{
              state[section.key].truncated ? ' · 部分统计' : ''
            }}</span
          >
          <p>{{ section.detail }}</p>
        </article>
      </div>
      <p v-if="state.backups.lastCreatedAt" class="storage-time">
        最近备份文件时间：{{ new Date(state.backups.lastCreatedAt).toLocaleString() }}
      </p>
      <ul class="storage-notes">
        <li v-for="warning in state.warnings" :key="warning">{{ warning }}</li>
      </ul>
    </template>
    <details class="storage-help">
      <summary>如何备份与恢复</summary>
      <p>
        在安装这套知识库的本机终端运行管理命令。备份时暂停外部编辑，选择知识库和数据目录之外的新文件。
      </p>
      <pre><code>dooknow backup --destination /独立备份目录/本次备份.dooknow</code></pre>
      <p>
        命令会显示恢复私钥的位置；将私钥另行受控保存，重要备份再复制到独立设备。历史版本和同盘备份不能代替它。
      </p>
      <p>需要恢复时，保留现有资料，使用新的配置文件和空目录。</p>
      <pre><code>dooknow restore --source /备份目录/本次备份.dooknow \
  --key-file /受控目录/backup-key.pem --profile /新配置目录/profile.json \
  --data-root /新数据目录 --knowledge-root /新知识库目录</code></pre>
      <p>
        随后从原安装来源重新运行安装器，指定恢复后的配置、新程序目录和管理命令目录。先选择前台方式与独立端口，登录核对原文、附件和历史后再切换服务。
      </p>
    </details>
  </section>
</template>
<style scoped>
.storage-settings {
  display: grid;
  gap: 14px;
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
article p,
.storage-time {
  margin: 0;
  color: #687486;
  font-size: 12px;
}
.storage-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
article {
  border: 1px solid #e3e6ec;
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
.storage-help {
  font-size: 12px;
  color: #687486;
}
.storage-notes {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
}
.storage-help {
  border-top: 1px solid #e3e6ec;
  padding-top: 12px;
  line-height: 1.8;
}
summary {
  cursor: pointer;
  color: #4566c6;
}
pre {
  padding: 10px;
  overflow: auto;
  background: #f5f6f8;
  border-radius: 6px;
}
@media (max-width: 600px) {
  .storage-cards {
    grid-template-columns: 1fr;
  }
}
</style>
