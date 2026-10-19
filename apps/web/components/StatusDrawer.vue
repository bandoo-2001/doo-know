<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NDrawer, NDrawerContent } from 'naive-ui';
import { Alert as AAlert, Button as AButton, Progress as AProgress } from 'ant-design-vue';
import type { SettingsSection } from '../../../shared/settings-contracts';
import type { WriteConflictList } from '../../../shared/knowledge-contracts';
import { api } from '../api';
import Icon from './Icon.vue';
import TransferTasks from './settings/TransferTasks.vue';
import {
  indexSummary,
  searchSummary,
  type IndexOverview,
  type RuntimeOverview,
} from './settings/status-model';
import './settings/settings.css';
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  settings: [section: SettingsSection];
  'open-note': [id: string];
  changed: [];
}>();
const index = ref<IndexOverview>(),
  runtime = ref<RuntimeOverview>(),
  conflicts = ref<WriteConflictList>();
const errors = ref({ index: '', runtime: '', conflicts: '' }),
  loading = ref(false),
  refreshing = ref(false),
  busy = ref(''),
  actionError = ref(''),
  notice = ref('');
const tasks = ref<InstanceType<typeof TransferTasks>>();
const runtimeLabels: Record<string, string> = {
  queued: '等待准备',
  downloading: '下载搜索组件',
  verifying: '校验搜索组件',
  creating_venv: '准备运行环境',
  installing: '安装搜索组件',
  validating_model: '校验本地模型',
  starting: '启动搜索',
  ready: '准备完成',
  failed: '准备未完成',
  cancelled: '已取消准备',
  interrupted: '上次准备被中断',
};
const activePreparation = computed(
  () => !!runtime.value?.task && ['queued', 'running'].includes(runtime.value.task.state),
);
const preparationProgress = computed(() => {
  const task = runtime.value?.task;
  return task?.totalBytes
    ? Math.min(100, Math.round((task.completedBytes / task.totalBytes) * 100))
    : 0;
});
const writeCount = computed(() =>
  conflicts.value ? conflicts.value.items.length + conflicts.value.syncConflicts.length : undefined,
);
const searchNeedsAttention = computed(() => !!errors.value.runtime || !!runtime.value?.task?.error);
const indexNeedsAttention = computed(
  () =>
    !!errors.value.index ||
    !!index.value?.error ||
    !!index.value?.failed ||
    !!index.value?.conflicts ||
    index.value?.sync.status === 'needs_reconciliation',
);
const indexUpdating = computed(
  () =>
    !!index.value &&
    !indexNeedsAttention.value &&
    (!!index.value.pending || !!index.value.retrying || index.value.sync.status !== 'idle'),
);
let generation = 0,
  timer: ReturnType<typeof setInterval> | undefined;
let refreshRequest = crypto.randomUUID(),
  prepareRequest = crypto.randomUUID();
async function load() {
  if (!props.open || loading.value) return;
  loading.value = true;
  const current = generation;
  const results = await Promise.allSettled([
    api<IndexOverview>('/api/index/status'),
    api<RuntimeOverview>('/api/platform/search-runtime'),
    api<WriteConflictList>('/api/maintenance/conflicts'),
  ]);
  if (current !== generation) {
    loading.value = false;
    return;
  }
  const [indexResult, runtimeResult, conflictResult] = results;
  if (indexResult.status === 'fulfilled') {
    index.value = indexResult.value;
    errors.value.index = '';
  } else
    errors.value.index =
      indexResult.reason instanceof Error ? indexResult.reason.message : '无法获取索引状态';
  if (runtimeResult.status === 'fulfilled') {
    runtime.value = runtimeResult.value;
    errors.value.runtime = '';
  } else
    errors.value.runtime =
      runtimeResult.reason instanceof Error ? runtimeResult.reason.message : '无法获取搜索能力';
  if (conflictResult.status === 'fulfilled') {
    conflicts.value = conflictResult.value;
    errors.value.conflicts = '';
  } else
    errors.value.conflicts =
      conflictResult.reason instanceof Error ? conflictResult.reason.message : '无法获取写入状态';
  loading.value = false;
}
async function perform(kind: 'refresh' | 'prepare' | 'cancel') {
  if (busy.value) return;
  busy.value = kind;
  actionError.value = '';
  notice.value = '';
  try {
    if (kind === 'refresh') {
      await api('/api/index/refresh', 'POST', { requestId: refreshRequest });
      refreshRequest = crypto.randomUUID();
      notice.value = '已请求重新检查原文并更新索引。';
    } else if (kind === 'prepare') {
      await api('/api/platform/search-runtime/prepare', 'POST', { requestId: prepareRequest });
      prepareRequest = crypto.randomUUID();
      notice.value = '搜索准备已提交。';
    } else if (runtime.value?.task) {
      await api(
        '/api/platform/search-runtime/tasks/' +
          encodeURIComponent(runtime.value.task.id) +
          '/cancel',
        'POST',
        {},
      );
      notice.value = '已请求取消搜索准备。';
    }
    emit('changed');
    await load();
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : '操作未完成，请重试。';
  } finally {
    busy.value = '';
  }
}
function navigate(section: SettingsSection) {
  emit('update:open', false);
  emit('settings', section);
}
function openNote(id: string) {
  emit('update:open', false);
  emit('open-note', id);
}
async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    await Promise.allSettled([load(), tasks.value?.refresh()]);
  } finally {
    refreshing.value = false;
  }
}
watch(
  () => props.open,
  (shown) => {
    generation++;
    if (timer) clearInterval(timer);
    if (shown) {
      void load();
      timer = setInterval(() => void load(), 4000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  if (timer) clearInterval(timer);
});
</script>
<template>
  <NDrawer
    :show="open"
    aria-label="后台状态"
    width="min(460px, 100vw)"
    placement="right"
    :auto-focus="true"
    :trap-focus="true"
    :close-on-esc="true"
    :theme-overrides="{
      color: 'var(--panel, #fff)',
      textColor: 'var(--text, #262b36)',
      titleTextColor: 'var(--text, #262b36)',
      headerPadding: '16px 20px',
      footerPadding: '12px 20px',
      headerBorderBottom: '1px solid var(--border, #e3e6ec)',
      footerBorderTop: '1px solid var(--border, #e3e6ec)',
      closeIconColor: 'var(--muted, #687486)',
      closeIconColorHover: 'var(--text, #262b36)',
    }"
    @update:show="emit('update:open', $event)"
  >
    <NDrawerContent
      class="status-drawer-shell"
      title="后台状态"
      closable
      :body-content-style="{
        padding: '20px',
        background: 'var(--panel, #fff)',
        color: 'var(--text, #262b36)',
      }"
    >
      <template #header>
        <div class="status-drawer-heading">
          <strong>后台状态</strong>
          <AButton
            type="text"
            size="small"
            :loading="refreshing || loading || tasks?.loading"
            aria-label="刷新状态"
            title="刷新状态"
            @click="refreshAll"
            ><template #icon><Icon name="refresh" :size="16" /></template
          ></AButton>
        </div>
      </template>
      <div v-if="open" class="settings-workspace status-drawer-content">
        <div class="settings-stack">
          <AAlert v-if="actionError" type="error" :message="actionError" show-icon />
          <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
          <TransferTasks
            ref="tasks"
            compact
            :poll-interval="4000"
            :poll-always="true"
            @open-note="openNote"
            @changed="emit('changed')"
          />
          <div class="status-services">
            <div class="status-services-heading">
              <h2>服务状态</h2>
              <span>每 4 秒自动更新</span>
            </div>
            <details class="status-row" :open="searchNeedsAttention || activePreparation">
              <summary>
                <span
                  class="status-row-icon"
                  :class="{
                    warning: searchNeedsAttention,
                    active: activePreparation,
                    ready:
                      !searchNeedsAttention &&
                      runtime?.components.tokenizerReady &&
                      runtime?.components.vectorReady,
                  }"
                  ><Icon name="search" :size="17"
                /></span>
                <span class="status-row-copy">
                  <span class="status-row-title" role="heading" aria-level="3">搜索准备</span>
                  <span class="status-row-description" role="status">{{
                    errors.runtime
                      ? '搜索能力暂时无法确认'
                      : activePreparation
                        ? runtimeLabels[runtime?.task?.phase || ''] || '正在准备搜索'
                        : searchSummary(runtime?.components)
                  }}</span>
                </span>
                <Icon name="chevron" :size="15" class="status-row-chevron" />
              </summary>
              <div class="status-row-body">
                <AAlert
                  v-if="errors.runtime"
                  type="warning"
                  message="搜索能力暂时无法确认"
                  show-icon
                  ><template #description
                    >请刷新后重试。
                    <details>
                      <summary>详细原因</summary>
                      {{ errors.runtime }}
                    </details></template
                  ></AAlert
                >
                <template v-if="runtime && !errors.runtime"
                  ><p v-if="runtime.task" class="settings-muted">
                    {{ runtimeLabels[runtime.task.phase] || '正在处理搜索准备'
                    }}<template v-if="runtime.task.phase === 'downloading'">
                      · {{ Math.floor(runtime.task.completedBytes / 1024 / 1024) }} /
                      {{ Math.ceil(runtime.task.totalBytes / 1024 / 1024) }} MiB</template
                    >
                  </p>
                  <AProgress
                    v-if="runtime.task?.phase === 'downloading' && runtime.task.totalBytes"
                    :percent="preparationProgress"
                    size="small"
                    :show-info="false"
                  /><AAlert
                    v-if="runtime.task?.error"
                    type="warning"
                    message="最近一次搜索准备未完成"
                    show-icon
                    ><template #description
                      >可以重新准备，已验证的下载会复用。
                      <details>
                        <summary>详细原因</summary>
                        {{ runtime.task.error }}
                      </details></template
                    ></AAlert
                  >
                  <p v-if="runtime.externallyManaged" class="settings-muted">
                    搜索组件由部署配置管理。
                  </p>
                  <p v-else-if="!runtime.distributionAvailable" class="settings-muted">
                    当前安装源未提供可下载的搜索组件。
                  </p></template
                >
                <div class="settings-actions">
                  <AButton
                    v-if="activePreparation && !errors.runtime"
                    :loading="busy === 'cancel'"
                    :disabled="!!busy"
                    @click="perform('cancel')"
                    >取消搜索准备</AButton
                  ><AButton
                    v-else-if="
                      runtime &&
                      !errors.runtime &&
                      !runtime.externallyManaged &&
                      runtime.distributionAvailable &&
                      (!runtime.components.tokenizerReady || !runtime.components.vectorReady)
                    "
                    :loading="busy === 'prepare'"
                    :disabled="!!busy"
                    @click="perform('prepare')"
                    >{{ runtime.task ? '重新准备搜索' : '准备内容搜索' }}</AButton
                  ><AButton type="link" @click="navigate('search')">打开搜索设置</AButton>
                </div>
              </div>
            </details>
            <details class="status-row" :open="indexNeedsAttention || indexUpdating">
              <summary>
                <span
                  class="status-row-icon"
                  :class="{
                    warning: indexNeedsAttention,
                    active: indexUpdating,
                    ready: index && !indexNeedsAttention && !indexUpdating,
                  }"
                  ><Icon name="refresh" :size="17"
                /></span>
                <span class="status-row-copy">
                  <span class="status-row-title" role="heading" aria-level="3">索引更新</span>
                  <span class="status-row-description" role="status">{{
                    errors.index ? '索引状态暂时无法确认' : indexSummary(index)
                  }}</span>
                </span>
                <Icon name="chevron" :size="15" class="status-row-chevron" />
              </summary>
              <div class="status-row-body">
                <AAlert v-if="errors.index" type="warning" message="索引状态暂时无法确认" show-icon
                  ><template #description
                    ><details>
                      <summary>详细原因</summary>
                      {{ errors.index }}
                    </details></template
                  ></AAlert
                >
                <template v-if="index && !errors.index"
                  ><p class="settings-muted">
                    待处理 {{ index.pending }} · 等待重试 {{ index.retrying }} · 失败
                    {{ index.failed }} · 冲突 {{ index.conflicts }}
                  </p>
                  <p v-if="runtime && !runtime.components.tokenizerReady" class="settings-muted">
                    关键词搜索依赖未准备，相关索引任务会等待组件就绪。
                  </p>
                  <details v-if="index.error">
                    <summary>原文状态的详细原因</summary>
                    {{ index.error }}
                  </details>
                  <details v-if="index.documents?.length">
                    <summary>最近检查的笔记（最多 10 篇）</summary>
                    <ul class="settings-list">
                      <li v-for="document in index.documents" :key="document.noteId">
                        <strong>{{ document.relativePath }}</strong>
                        <p class="settings-muted">
                          {{
                            document.conflict
                              ? '写入状态需要核对'
                              : document.sourceHash &&
                                  document.sourceHash === document.textIndexedHash
                                ? '文本索引已更新'
                                : '文本索引待更新'
                          }}
                        </p>
                        <AButton size="small" @click="openNote(document.noteId)">打开笔记</AButton>
                      </li>
                    </ul>
                  </details></template
                >
                <div class="settings-actions">
                  <AButton
                    :loading="busy === 'refresh'"
                    :disabled="!!busy || !!errors.index"
                    @click="perform('refresh')"
                    >检查并更新索引</AButton
                  ><AButton
                    v-if="index?.conflicts || index?.sync.status === 'needs_reconciliation'"
                    type="link"
                    @click="navigate('backup')"
                    >核对写入与同步</AButton
                  >
                </div>
              </div>
            </details>
            <details class="status-row" :open="!!errors.conflicts || !!writeCount">
              <summary>
                <span
                  class="status-row-icon"
                  :class="{
                    warning: errors.conflicts || writeCount,
                    ready: !errors.conflicts && writeCount === 0,
                  }"
                  ><Icon name="save" :size="17"
                /></span>
                <span class="status-row-copy">
                  <span class="status-row-title" role="heading" aria-level="3">写入与恢复</span>
                  <span class="status-row-description" role="status">{{
                    errors.conflicts
                      ? '写入状态暂时无法确认'
                      : writeCount === undefined
                        ? '正在读取写入状态…'
                        : writeCount
                          ? writeCount + ' 项写入或同步需要人工核对'
                          : '没有需要人工核对的写入。'
                  }}</span>
                </span>
                <Icon name="chevron" :size="15" class="status-row-chevron" />
              </summary>
              <div class="status-row-body">
                <AAlert
                  v-if="errors.conflicts"
                  type="warning"
                  message="写入状态暂时无法确认"
                  show-icon
                  ><template #description
                    ><details>
                      <summary>详细原因</summary>
                      {{ errors.conflicts }}
                    </details></template
                  ></AAlert
                >
                <template v-else-if="writeCount !== undefined">
                  <p v-if="!writeCount" class="settings-muted">
                    笔记写入与同步没有需要核对的项目。
                  </p>
                  <ul v-if="conflicts?.items.length" class="settings-list">
                    <li v-for="item in conflicts.items.slice(0, 5)" :key="item.id">
                      <strong>{{ item.relativePath }}</strong>
                      <p class="settings-muted">
                        {{
                          item.resolvable
                            ? '当前磁盘版本可以核对。'
                            : '请保留现场材料后进一步检查。'
                        }}
                      </p>
                    </li>
                  </ul>
                  <div v-if="writeCount" class="settings-actions">
                    <AButton @click="navigate('backup')">打开异常写入恢复</AButton>
                  </div></template
                >
              </div>
            </details>
          </div>
        </div>
      </div>
      <template #footer>
        <div class="status-management-links">
          <AButton type="text" size="small" @click="navigate('library')"
            >导入与导出<Icon name="forward" :size="13"
          /></AButton>
          <AButton type="text" size="small" @click="navigate('backup')"
            >备份与恢复<Icon name="forward" :size="13"
          /></AButton>
        </div>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>
<style scoped>
.status-drawer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.status-drawer-heading strong {
  font-size: 17px;
  font-weight: 600;
}
.status-drawer-heading .ant-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  color: var(--muted, #687486);
}
.status-drawer-shell :deep(.n-drawer-header__main) {
  flex: 1;
  min-width: 0;
  margin-right: 10px;
}
.status-drawer-content {
  padding: 0;
  max-width: none;
  width: 100%;
  margin: 0;
}
.status-drawer-content .settings-stack {
  gap: 24px;
}
.status-drawer-content .settings-card {
  padding: 0;
  border: 0;
  border-radius: 0;
}
.status-services-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 10px;
}
.status-services-heading h2 {
  margin: 0;
  font-size: 14px;
}
.status-services-heading > span {
  font-size: 11px;
  color: var(--muted, #687486);
}
.status-drawer-content .status-row {
  margin: 0;
  border-top: 1px solid var(--border, #e3e6ec);
}
.status-row > summary {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
  list-style: none;
  color: var(--text, #262b36);
  border-radius: 6px;
}
.status-row > summary::-webkit-details-marker {
  display: none;
}
.status-row > summary:hover {
  background: var(--surface-soft, #fafbfc);
}
.status-row > summary:focus-visible {
  outline: 2px solid var(--blue, #4566c6);
  outline-offset: 3px;
}
.status-row-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  color: var(--muted, #687486);
  background: var(--surface, #f1f3f6);
}
.status-row-icon.ready {
  color: #34815a;
  background: #34815a12;
}
.status-row-icon.active {
  color: var(--blue, #4566c6);
  background: var(--blue-soft, #eef2ff);
}
.status-row-icon.warning {
  color: #b27c41;
  background: #b27c4112;
}
.status-row-copy {
  flex: 1;
  min-width: 0;
}
.status-row-title {
  display: block;
  font-size: 13px;
  font-weight: 500;
}
.status-row-description {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
  font-weight: 400;
  color: var(--muted, #687486);
}
.status-row-chevron {
  flex-shrink: 0;
  margin-right: 4px;
  color: var(--muted, #687486);
  transition: transform 0.15s;
}
.status-row[open] > summary .status-row-chevron {
  transform: rotate(90deg);
}
.status-row-body {
  padding: 0 0 16px 44px;
}
.status-row-body > :first-child {
  margin-top: 0;
}
.status-row-body .settings-actions {
  gap: 8px;
  margin-top: 12px;
}
.status-row-body .settings-actions .ant-btn {
  height: 30px;
  padding: 0 10px;
  font-size: 12px;
}
.status-row-body .settings-actions .ant-btn-link {
  padding-inline: 0;
}
.status-management-links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  width: 100%;
}
.status-management-links .ant-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-inline: 0;
  color: var(--muted, #687486);
  font-size: 12px;
}
@media (max-width: 380px) {
  .status-row-body {
    padding-left: 0;
  }
}
</style>
