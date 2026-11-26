<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { featureAction } from '../features';
import { createPageWindow } from './settings/paged-records';
type Call = {
  id: string;
  at: string;
  tool: string;
  client: string;
  code: string;
  elapsedMs: number;
};
const rows = ref<Call[]>([]);
const cursor = ref<string>();
const busy = ref(false);
const error = ref('');
const pages = createPageWindow<Call>((nextCursor) =>
  featureAction('mcp', 'provider', 'mcp.calls', nextCursor ? { cursor: nextCursor } : {}),
);
async function load(more = false, reset = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const page = await pages.read(more, reset);
    rows.value = page.items;
    cursor.value = page.nextCursor || undefined;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 10_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <div class="settings-item-header">
    <div>
      <h2 class="settings-section-title">最近调用</h2>
      <p>显示工具名、客户端、耗时和结果。</p>
    </div>
    <AButton size="small" :loading="busy" @click="load(false, true)">刷新记录</AButton>
  </div>
  <AAlert v-if="error" type="error" show-icon :message="error" />
  <p v-if="!busy && !error && !rows.length" role="status">暂无调用记录。</p>
  <ul v-if="rows.length" class="mcp-call-list">
    <li v-for="row in rows" :key="row.id">
      <strong>{{ row.tool }}</strong>
      <span>{{ row.code }} · {{ row.elapsedMs }} ms</span>
      <small>{{ new Date(row.at).toLocaleString() }} · {{ row.client }}</small>
    </li>
  </ul>
  <AButton v-if="cursor" size="small" :loading="busy" @click="load(true)">加载更早调用</AButton>
</template>

<style scoped>
.mcp-call-list {
  list-style: none;
  padding: 0;
  display: grid;
  gap: 6px;
}
.mcp-call-list li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius, 8px);
  overflow-wrap: anywhere;
}
.mcp-call-list small {
  grid-column: 1 / -1;
  color: var(--muted);
}
</style>
