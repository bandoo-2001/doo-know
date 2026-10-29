<script setup lang="ts">
import Icon from '../Icon.vue';
import { onMounted, onBeforeUnmount, ref } from 'vue';
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
const now = ref(Date.now());
let expiryTimer: ReturnType<typeof setInterval> | undefined;
function shareState(item: ManagementShare) {
  if (item.state === 'revoked' || item.state === 'private') return item.state;
  if (item.state === 'expired' || (item.expiresAt && Date.parse(item.expiresAt) <= now.value))
    return 'expired';
  return item.enabled ? 'active' : 'revoked';
}
function validity(item: ManagementShare) {
  if (!item.expiresAt) return '永久有效';
  const date = new Date(item.expiresAt);
  if (!Number.isFinite(date.getTime())) return '有效期待核对';
  return '截止 ' + date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
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
onMounted(() => {
  void load();
  expiryTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});
onBeforeUnmount(() => {
  if (expiryTimer) clearInterval(expiryTimer);
});
</script>
<template>
  <section class="settings-card">
    <h2 class="settings-section-title"><Icon name="share" :size="18" />共享链接</h2>
    <p class="settings-muted">查看链接的访问权限和有效期，并撤销不再需要的访问。</p>
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
          { value: 'false', label: '已失效' },
        ]"
      /><AButton html-type="submit" :loading="loading"
        ><template #icon><Icon class="settings-button-icon" name="search" :size="15" /></template
        >查找链接</AButton
      >
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
            <ATag
              :color="
                shareState(item) === 'active'
                  ? 'blue'
                  : shareState(item) === 'expired'
                    ? 'orange'
                    : undefined
              "
              >{{
                shareState(item) === 'active'
                  ? '可访问'
                  : shareState(item) === 'expired'
                    ? '已过期'
                    : '已撤销'
              }}</ATag
            >
            <p>{{ item.relativePath }}</p>
            <p class="share-access-meta">
              <ATag>{{ item.permission === 'edit' ? '可编辑' : '仅查看' }}</ATag>
              <span>{{ validity(item) }}</span>
            </p>
            <a
              v-if="shareState(item) === 'active' && item.url"
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
              >打开共享页面</a
            >
          </div>
          <div class="settings-actions" style="margin-top: 0">
            <AButton
              v-if="shareState(item) === 'active' && item.url"
              size="small"
              @click="copy(item.url)"
              ><template #icon
                ><Icon class="settings-button-icon" name="copy" :size="15" /></template
              >复制链接</AButton
            ><APopconfirm
              v-if="shareState(item) === 'active' || shareState(item) === 'expired'"
              title="撤销此共享链接？"
              ok-text="撤销链接"
              cancel-text="取消"
              @confirm="revoke(item.id)"
              ><AButton size="small" danger :disabled="!!busy" :loading="busy === item.id"
                ><template #icon
                  ><Icon class="settings-button-icon" name="close" :size="15" /></template
                >撤销</AButton
              ></APopconfirm
            >
          </div>
        </div>
      </li>
    </ul>
    <div class="settings-actions">
      <AButton v-if="cursor" :loading="loading" @click="load(true)">加载更多链接</AButton
      ><AButton v-if="error" :loading="loading" @click="load(false)"
        ><template #icon><Icon class="settings-button-icon" name="refresh" :size="15" /></template
        >重新读取</AButton
      >
    </div>
  </section>
</template>
<style scoped>
.share-access-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  color: var(--muted, #7a8190);
  font-size: 12px;
}
.share-access-meta .ant-tag {
  margin: 0;
}
</style>
