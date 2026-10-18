<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Select as ASelect,
  Popconfirm as APopconfirm,
  Tag as ATag,
} from 'ant-design-vue';
import { api } from '../../api';
import type {
  ManagementShare,
  ManagementPage,
  ManagementBatchResult,
} from '../../../../shared/management-contracts';
const items = ref<ManagementShare[]>([]),
  q = ref(''),
  filter = ref('all'),
  cursor = ref<string | null>(null),
  loading = ref(false),
  busy = ref(''),
  error = ref(''),
  notice = ref('');
async function load(more = false) {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (q.value) params.set('q', q.value);
    if (filter.value !== 'all') params.set('enabled', filter.value);
    if (more && cursor.value) params.set('cursor', cursor.value);
    const result = await api<ManagementPage<ManagementShare>>('/api/manage/shares?' + params);
    items.value = more ? [...items.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function revoke(id: string) {
  busy.value = id;
  error.value = '';
  notice.value = '';
  try {
    const result = await api<ManagementBatchResult>('/api/manage/shares/revoke', 'POST', {
      ids: [id],
      requestId: crypto.randomUUID(),
    });
    const failure = result.results.find((i) => !i.ok);
    if (failure) throw Error(failure.code || '链接暂时无法撤销');
    notice.value = '共享链接已撤销，持有旧链接的人将无法继续访问。';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
async function copy(url: string) {
  try {
    await navigator.clipboard.writeText(new URL(url, location.origin).href);
    notice.value = '共享链接已复制';
  } catch {
    error.value = '无法访问剪贴板，请从下方链接手动复制。';
  }
}
onMounted(() => void load());
</script>
<template>
  <section class="settings-card">
    <h2>共享链接</h2>
    <p class="settings-muted">查看已创建的链接，并撤销不再需要的访问。</p>
    <form class="settings-actions" @submit.prevent="load(false)">
      <AInput
        v-model:value="q"
        aria-label="查找共享链接"
        placeholder="按标题或路径查找"
        style="flex: 1; min-width: 140px"
      /><ASelect
        v-model:value="filter"
        aria-label="共享链接状态"
        style="min-width: 120px"
        :options="[
          { value: 'all', label: '全部状态' },
          { value: 'true', label: '可访问' },
          { value: 'false', label: '已撤销' },
        ]"
      /><AButton html-type="submit" :loading="loading">查找链接</AButton>
    </form>
    <AAlert v-if="error" type="error" :message="error" show-icon />
    <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
    <p v-if="loading && !items.length" role="status">正在读取共享链接…</p>
    <p v-else-if="!items.length && !error" class="settings-muted">没有符合条件的共享链接。</p>
    <ul class="settings-list">
      <li v-for="item in items" :key="item.id">
        <div class="settings-item-header">
          <div>
            <strong>{{ item.title }}</strong>
            <ATag :color="item.enabled ? 'blue' : undefined">{{
              item.enabled ? '可访问' : '已撤销'
            }}</ATag>
            <p>{{ item.relativePath }}</p>
            <a
              v-if="item.enabled && item.url"
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
              >打开共享页面</a
            >
          </div>
          <div class="settings-actions" style="margin-top: 0">
            <AButton v-if="item.enabled && item.url" size="small" @click="copy(item.url)"
              >复制链接</AButton
            ><APopconfirm
              v-if="item.enabled"
              title="撤销此共享链接？"
              ok-text="撤销链接"
              cancel-text="取消"
              @confirm="revoke(item.id)"
              ><AButton size="small" danger :disabled="!!busy" :loading="busy === item.id"
                >撤销</AButton
              ></APopconfirm
            >
          </div>
        </div>
      </li>
    </ul>
    <div class="settings-actions">
      <AButton v-if="cursor" :loading="loading" @click="load(true)">加载更多链接</AButton
      ><AButton v-if="error" :loading="loading" @click="load(false)">重新读取</AButton>
    </div>
  </section>
</template>
