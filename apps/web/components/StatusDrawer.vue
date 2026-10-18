<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { NDrawer, NDrawerContent } from 'naive-ui';
import { Alert as AAlert, Button as AButton, Progress as AProgress } from 'ant-design-vue';
import type { SettingsSection } from '../../../shared/settings-contracts';
import type { WriteConflictList } from '../../../shared/knowledge-contracts';
import { api } from '../api';
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
  () => runtime.value?.task && ['queued', 'running'].includes(runtime.value.task.state),
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
  await Promise.allSettled([load(), tasks.value?.refresh()]);
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
    width="min(580px, 100vw)"
    placement="right"
    :auto-focus="true"
    :trap-focus="true"
    :close-on-esc="true"
    @update:show="emit('update:open', $event)"
  >
    <NDrawerContent
      title="后台状态"
      closable
      :body-content-style="{
        padding: '20px',
        background: 'var(--bg, #f7f8fa)',
        color: 'var(--text, #262b36)',
      }"
    >
      <div v-if="open" class="settings-workspace status-drawer-content">
        <div class="settings-stack">
          <div class="status-drawer-intro">
            <p class="settings-muted">
              任务在后台执行。关闭此面板后继续处理，重新打开可查看最新结果。
            </p>
            <AButton :loading="loading" @click="refreshAll">刷新状态</AButton>
          </div>
          <AAlert v-if="actionError" type="error" :message="actionError" show-icon />
          <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
          <section class="settings-card">
            <h2>搜索准备</h2>
            <AAlert v-if="errors.runtime" type="warning" message="搜索能力暂时无法确认" show-icon
              ><template #description
                >请刷新后重试。
                <details>
                  <summary>详细原因</summary>
                  {{ errors.runtime }}
                </details></template
              ></AAlert
            >
            <p role="status">
              {{ searchSummary(errors.runtime ? undefined : runtime?.components) }}
            </p>
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
          </section>
          <section class="settings-card">
            <h2>索引更新</h2>
            <AAlert v-if="errors.index" type="warning" message="索引状态暂时无法确认" show-icon
              ><template #description
                ><details>
                  <summary>详细原因</summary>
                  {{ errors.index }}
                </details></template
              ></AAlert
            >
            <p role="status">{{ indexSummary(errors.index ? undefined : index) }}</p>
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
                          : document.sourceHash && document.sourceHash === document.textIndexedHash
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
          </section>
          <section class="settings-card">
            <h2>写入与恢复</h2>
            <AAlert v-if="errors.conflicts" type="warning" message="写入状态暂时无法确认" show-icon
              ><template #description
                ><details>
                  <summary>详细原因</summary>
                  {{ errors.conflicts }}
                </details></template
              ></AAlert
            >
            <p v-else-if="writeCount === undefined" class="settings-muted">正在读取写入状态…</p>
            <template v-else
              ><p role="status">
                {{
                  writeCount ? writeCount + ' 项写入或同步需要人工核对' : '没有需要人工核对的写入。'
                }}
              </p>
              <ul v-if="conflicts?.items.length" class="settings-list">
                <li v-for="item in conflicts.items.slice(0, 5)" :key="item.id">
                  <strong>{{ item.relativePath }}</strong>
                  <p class="settings-muted">
                    {{
                      item.resolvable ? '当前磁盘版本可以核对。' : '请保留现场材料后进一步检查。'
                    }}
                  </p>
                </li>
              </ul>
              <div v-if="writeCount" class="settings-actions">
                <AButton @click="navigate('backup')">打开异常写入恢复</AButton>
              </div></template
            >
          </section>
          <div class="settings-actions status-management-links">
            <AButton @click="navigate('library')">导入与导出</AButton
            ><AButton @click="navigate('backup')">备份与恢复</AButton>
          </div>
          <TransferTasks
            ref="tasks"
            :poll-interval="4000"
            :poll-always="true"
            @open-note="openNote"
            @changed="emit('changed')"
          />
        </div>
      </div> </NDrawerContent
  ></NDrawer>
</template>
<style scoped>
.status-drawer-content {
  padding: 0;
  max-width: none;
  width: 100%;
  margin: 0;
}
.status-drawer-intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.status-drawer-intro p {
  margin: 0;
}
.status-drawer-intro .ant-btn {
  flex-shrink: 0;
}
.status-drawer-content .settings-card {
  padding: 18px;
}
.status-management-links {
  margin: 0;
}
.status-drawer-content :deep(.n-drawer-header) {
  color: var(--text);
}
@media (max-width: 430px) {
  .status-drawer-intro {
    flex-direction: column;
    gap: 10px;
  }
}
</style>
