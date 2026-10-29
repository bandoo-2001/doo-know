<script setup lang="ts">
import Icon from './Icon.vue';
import { ref, onMounted } from 'vue';
import { NModal } from 'naive-ui';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { api, ApiError } from '../api';
import OrganizationRetentionSettings from './OrganizationRetentionSettings.vue';
import type {
  WriteConflict,
  WriteConflictList,
  ResolveConflictResult,
} from '../../../shared/knowledge-contracts';
const emit = defineEmits<{ resolved: [value: { noteId: string; operationId: string }] }>();
const state = ref<WriteConflictList>({ items: [], syncConflicts: [] }),
  loading = ref(false),
  busy = ref(false),
  error = ref(''),
  detailError = ref('');
const selected = ref<WriteConflict>();
let requestId = crypto.randomUUID();
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    state.value = await api<WriteConflictList>('/api/maintenance/conflicts');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '暂时无法读取恢复状态';
  } finally {
    loading.value = false;
  }
}
function inspect(item: WriteConflict) {
  selected.value = item;
  detailError.value = '';
  requestId = crypto.randomUUID();
}
async function resolve() {
  const item = selected.value;
  if (busy.value || !item?.resolvable || !item.disk) return;
  busy.value = true;
  detailError.value = '';
  try {
    const result = await api<ResolveConflictResult>(
      `/api/maintenance/conflicts/${item.id}/resolve`,
      'POST',
      {
        strategy: 'keep_disk',
        expectedModifiedAt: item.disk.modifiedAt,
        expectedContentHash: item.disk.contentHash,
        requestId,
      },
    );
    selected.value = undefined;
    emit('resolved', { noteId: item.noteId, operationId: result.operationId });
    await load();
  } catch (cause) {
    detailError.value =
      cause instanceof ApiError && cause.status === 409
        ? '磁盘版本或操作状态已变化，请重新检查后再决定。现场材料保持不变。'
        : cause instanceof Error
          ? cause.message
          : '暂时无法完成核对，请保留现场并重新检查';
  } finally {
    busy.value = false;
  }
}
async function recheck() {
  const id = selected.value?.id;
  selected.value = undefined;
  await load();
  const current = state.value.items.find((item) => item.id === id);
  if (current?.resolvable) inspect(current);
}
function diskTime(value: string) {
  try {
    const date = new Date(/^\d+$/.test(value) ? Number(BigInt(value) / 1000000n) : value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '需要重新读取';
  } catch {
    return '需要重新读取';
  }
}
function reason(item: WriteConflict) {
  return item.reason === 'MULTI_FILE_RECONCILIATION_REQUIRED'
    ? '此操作涉及多份文件，需要进一步核对。请保留现场与操作编号。'
    : '当前文件缺失、归属不明确或无法安全读取，需要进一步核对。';
}
onMounted(() => void load());
</script>
<template>
  <section class="maintenance-settings" aria-label="数据与恢复">
    <header>
      <div>
        <h2 class="settings-section-title"><Icon name="undo" :size="18" />异常写入恢复</h2>
        <p class="muted">核对未完成的写入，保留当前磁盘内容和冲突材料。</p>
      </div>
      <AButton :loading="loading" :disabled="loading" @click="load"
        ><template #icon><Icon class="settings-button-icon" name="refresh" :size="15" /></template
        >检查恢复状态</AButton
      >
    </header>
    <AAlert v-if="error" type="error" :message="error" role="alert" />
    <p v-if="loading && !state.items.length" role="status">正在读取恢复状态…</p>
    <p
      v-else-if="!state.items.length && !state.syncConflicts.length && !state.organizationConflicts?.length && !error"
      class="muted"
      role="status"
    >
      没有需要人工核对的写入。
    </p>
    <article v-for="item in state.items" :key="item.id" class="maintenance-item">
      <div>
        <strong>{{ item.relativePath }}</strong
        ><small>操作编号：{{ item.id }}</small>
        <p>{{ item.resolvable ? '原操作未完成，当前磁盘版本可以核对。' : reason(item) }}</p>
      </div>
      <AButton v-if="item.resolvable" @click="inspect(item)"
        ><template #icon><Icon class="settings-button-icon" name="eye" :size="15" /></template
        >核对磁盘版本</AButton
      >
    </article>
    <AAlert
      v-for="item in state.syncConflicts"
      :key="item.id"
      type="warning"
      message="Git 工作区需要人工核对"
      :description="'请保留整个工作区和冲突材料，再按 Git 同步恢复流程处理。操作编号：' + item.id"
    />
    <OrganizationRetentionSettings />
    <AAlert
      v-for="item in state.organizationConflicts"
      :key="item.operationId"
      type="warning"
      :message="item.status === 'needs_reconciliation' ? '目录整理需要人工核对' : '目录整理尚未完成'"
      :description="'请保留知识库和恢复材料，重新检查恢复状态。操作编号：' + item.operationId"
    />
    <NModal
      :show="!!selected"
      preset="card"
      class="dialog-card"
      title="采用当前磁盘版本？"
      :closable="!busy"
      :mask-closable="!busy"
      :close-on-esc="!busy"
      @update:show="
        (shown) => {
          if (!shown) selected = undefined;
        }
      "
    >
      <template v-if="selected?.disk">
        <AAlert v-if="detailError" type="error" :message="detailError" role="alert" />
        <p>
          <strong>{{ selected.relativePath }}</strong>
        </p>
        <p>磁盘修改时间：{{ diskTime(selected.disk.modifiedAt) }}</p>
        <p>
          确认后采用此刻的磁盘内容，保留原操作材料并解除这项写入的阻塞。磁盘再次变化时需要重新检查。
        </p>
        <div class="dialog-actions">
          <AButton :disabled="busy" @click="selected = undefined">取消</AButton
          ><AButton :disabled="busy" @click="recheck"
            ><template #icon
              ><Icon class="settings-button-icon" name="refresh" :size="15" /></template
            >重新检查</AButton
          ><AButton
            type="primary"
            aria-label="采用磁盘版本"
            :loading="busy"
            :disabled="busy"
            @click="resolve"
            ><template #icon><Icon class="settings-button-icon" name="check" :size="15" /></template
            >采用磁盘版本</AButton
          >
        </div>
      </template>
    </NModal>
  </section>
</template>
<style scoped>
.maintenance-settings {
  padding: 24px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 10px;
  margin: 24px 0;
  scroll-margin-top: 60px;
}
header {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: flex-start;
}
h2 {
  font-size: 17px;
  margin: 0 0 8px;
}
header p {
  margin: 0 0 16px;
}
.maintenance-item {
  display: flex;
  gap: 16px;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--border);
  padding: 16px 0;
  overflow-wrap: anywhere;
}
.maintenance-item > div {
  min-width: 0;
}
.maintenance-item small {
  display: block;
  color: var(--muted);
  font-size: 11px;
  margin-top: 8px;
}
.maintenance-item p {
  font-size: 12px;
  margin: 8px 0;
}
.maintenance-item .ant-btn {
  flex-shrink: 0;
}
@media (max-width: 720px) {
  header,
  .maintenance-item {
    flex-direction: column;
  }
  .maintenance-settings {
    padding: 18px;
  }
}
</style>
