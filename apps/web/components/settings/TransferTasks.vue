<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Progress as AProgress,
  Tag as ATag,
} from 'ant-design-vue';
import { api } from '../../api';
import { createPageWindow } from './paged-records';
import type {
  TransferKind,
  TransferTask,
  TransferTaskList,
} from '../../../../shared/transfer-contracts';
const props = withDefaults(
  defineProps<{
    kinds?: TransferKind[];
    pollInterval?: number;
    pollAlways?: boolean;
    compact?: boolean;
  }>(),
  {
    pollInterval: 2500,
  },
);
const emit = defineEmits<{ 'open-note': [id: string]; updated: []; changed: [] }>();
const tasks = ref<TransferTask[]>([]),
  error = ref(''),
  loading = ref(false),
  busy = ref(''),
  cursor = ref<string>();
const showHistory = ref(false);
const matching = computed(() =>
  tasks.value.filter((task) => !props.kinds || props.kinds.includes(task.kind)),
);
const historyCount = computed(
  () => matching.value.filter((task) => ['succeeded', 'cancelled'].includes(task.state)).length,
);
const visible = computed(() => {
  if (!props.compact) return matching.value;
  const priority = (task: TransferTask) =>
    ['queued', 'running'].includes(task.state)
      ? 0
      : ['failed', 'interrupted'].includes(task.state)
        ? 1
        : 2;
  return matching.value
    .filter((task) => showHistory.value || priority(task) < 2)
    .sort((a, b) => priority(a) - priority(b));
});
const stateLabels: Record<string, string> = {
  queued: '等待开始',
  running: '进行中',
  succeeded: '已完成',
  failed: '未完成',
  cancelled: '已取消',
  interrupted: '上次执行已中断',
};
const kindLabels: Record<string, string> = {
  import: '导入',
  export: '导出',
  backup: '加密备份',
  restore: '独立恢复',
};
const retryRequests = new Map<string, string>();
const itemLabels: Record<string, string> = {
  pending: '待处理',
  succeeded: '成功',
  skipped: '已跳过',
  failed: '失败',
};
const pageWindow = createPageWindow<TransferTask>((cursor) =>
  api<TransferTaskList>(
    '/api/manage/tasks' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
  ),
);
const completionNotices = new Set<string>();
async function refresh(more = false, reset = false) {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await pageWindow.read(more, reset);
    let changed = false;
    for (const task of data.items) {
      const successfulItems = task.items?.filter((item) => item.state === 'succeeded').length || 0;
      if (
        task.kind !== 'import' ||
        !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.state) ||
        (task.state !== 'succeeded' && !successfulItems)
      )
        continue;
      const completion = task.id + ':' + successfulItems;
      if (!completionNotices.has(completion)) {
        completionNotices.add(completion);
        changed = true;
      }
    }
    tasks.value = data.items;
    cursor.value = data.nextCursor || undefined;
    error.value = '';
    if (changed) emit('changed');
    emit('updated');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function action(task: TransferTask, command: 'cancel' | 'retry') {
  if (busy.value) return;
  busy.value = task.id;
  error.value = '';
  try {
    const requestId = retryRequests.get(task.id) || crypto.randomUUID();
    if (command === 'retry') retryRequests.set(task.id, requestId);
    await api(
      '/api/manage/tasks/' + encodeURIComponent(task.id) + '/' + command,
      'POST',
      command === 'retry' ? { requestId } : {},
    );
    retryRequests.delete(task.id);
    await refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
function progress(task: TransferTask) {
  return task.progress.total
    ? Math.min(100, Math.round((task.progress.completed / task.progress.total) * 100))
    : 0;
}
defineExpose({ refresh, loading });
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void refresh();
  timer = setInterval(() => {
    if (props.pollAlways || tasks.value.some((task) => ['queued', 'running'].includes(task.state)))
      void refresh();
  }, props.pollInterval);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <section class="settings-card transfer-tasks" :class="{ 'transfer-tasks-compact': compact }">
    <div class="settings-item-header">
      <div>
        <h2>任务与结果</h2>
        <p v-if="!compact">离开此页后任务仍会继续，也可从左下角「状态」查看。</p>
        <p v-else>关闭面板后，任务仍会继续。</p>
      </div>
      <AButton v-if="!compact" size="small" :loading="loading" @click="refresh(false, true)"
        >刷新任务</AButton
      >
    </div>
    <AAlert v-if="error" type="error" :message="error" show-icon>
      <template v-if="compact" #action>
        <AButton size="small" :loading="loading" @click="refresh(false, true)"
          >重新读取任务</AButton
        >
      </template>
    </AAlert>
    <p v-if="!visible.length && !error" class="settings-muted" role="status">
      {{
        loading && !tasks.length ? '正在读取任务…' : compact ? '暂无进行中的任务' : '暂无相关任务。'
      }}
    </p>
    <ul class="settings-list">
      <li v-for="task in visible" :key="task.id">
        <div class="settings-item-header">
          <div>
            <strong>{{ kindLabels[task.kind] }}</strong>
            <ATag
              :color="
                task.state === 'succeeded' ? 'green' : task.state === 'failed' ? 'red' : undefined
              "
              >{{ stateLabels[task.state] }}</ATag
            >
            <p>
              {{ new Date(task.createdAt).toLocaleString('zh-CN')
              }}<template v-if="task.progress.total">
                · {{ task.progress.completed }} / {{ task.progress.total }}</template
              >
            </p>
          </div>
          <div class="settings-actions" style="margin: 0">
            <AButton
              v-if="task.cancellable && ['queued', 'running'].includes(task.state)"
              size="small"
              :loading="busy === task.id"
              :disabled="!!busy"
              @click="action(task, 'cancel')"
              >取消任务</AButton
            ><AButton
              v-if="
                task.kind !== 'restore' &&
                ['failed', 'interrupted', 'cancelled'].includes(task.state)
              "
              size="small"
              :loading="busy === task.id"
              :disabled="!!busy"
              @click="action(task, 'retry')"
              >{{ task.kind === 'import' ? '重试未完成项目' : '重试任务' }}</AButton
            ><AButton
              v-if="task.downloadAvailable"
              size="small"
              :href="'/api/manage/tasks/' + encodeURIComponent(task.id) + '/download'"
              >下载结果</AButton
            >
          </div>
        </div>
        <AProgress
          v-if="task.state === 'running' && task.progress.total"
          :percent="progress(task)"
          size="small"
          :show-info="false"
        />
        <div v-if="task.error" class="settings-field-error" role="alert">
          任务未完成，请保留已完成的结果并重试支持的项目。
          <details>
            <summary>错误详情</summary>
            {{ task.error }}
          </details>
        </div>
        <p v-if="task.result?.scope" class="settings-muted">导出范围：{{ task.result.scope }}</p>
        <ul v-if="task.result?.warnings?.length" class="settings-muted">
          <li v-for="warning in task.result.warnings" :key="warning">{{ warning }}</li>
        </ul>
        <template v-if="task.result?.verification"
          ><AAlert type="success" message="独立副本已恢复并通过校验" show-icon />
          <p class="settings-muted">
            {{ task.result.verification.notes }} 篇笔记 ·
            {{ task.result.verification.assets }} 个附件。当前服务继续使用原有数据。
          </p>
          <p class="settings-muted">{{ task.result.verification.guidance }}</p>
          <details>
            <summary>恢复副本位置与校验回执</summary>
            <p>
              原文目录：<code>{{
                task.result.verification.knowledgeRoot || '备份未包含原文'
              }}</code>
            </p>
            <p>
              数据目录：<code>{{ task.result.verification.dataRoot }}</code>
            </p>
            <p>
              配置文件：<code>{{ task.result.verification.profileFile }}</code>
            </p>
            <p>
              校验回执：<code>{{ task.result.verification.restoreReceipt }}</code>
            </p>
            <p>副本已退出旧会话、撤销共享并停用插件；启用前需要重新准备搜索并检查部署绑定。</p>
          </details></template
        >
        <details v-if="task.items?.length">
          <summary>逐项结果（{{ task.items.length }}）</summary>
          <ul class="settings-list">
            <li v-for="(item, index) in task.items" :key="index">
              <span>{{ item.targetPath || item.path }} · {{ itemLabels[item.state] }}</span
              ><AButton
                v-if="item.noteId && item.state === 'succeeded'"
                size="small"
                type="link"
                @click="emit('open-note', item.noteId)"
                >打开笔记</AButton
              >
              <details v-if="item.error">
                <summary>此项目失败的详细原因</summary>
                <p class="settings-field-error">{{ item.error }}</p>
              </details>
            </li>
          </ul>
        </details>
        <details>
          <summary>任务编号</summary>
          <code>{{ task.id }}</code>
        </details>
      </li>
    </ul>
    <AButton
      v-if="compact && historyCount"
      type="text"
      size="small"
      class="transfer-history-toggle"
      :aria-expanded="showHistory"
      @click="showHistory = !showHistory"
      >{{ showHistory ? '收起' : '查看' }}已完成与已取消（{{ historyCount }}）</AButton
    >
    <AButton v-if="cursor" :loading="loading" @click="refresh(true)">加载更多任务</AButton>
  </section>
</template>
<style scoped>
.transfer-tasks-compact > .settings-item-header h2 {
  font-size: 14px;
}
.transfer-tasks-compact > .settings-muted {
  margin: 20px 0 4px;
  padding: 14px 12px;
  border: 1px dashed var(--border, #e3e6ec);
  border-radius: 8px;
  text-align: center;
}
.transfer-tasks-compact > .settings-list:empty {
  margin: 0;
}
.transfer-tasks-compact .settings-item-header {
  flex-wrap: wrap;
  gap: 8px;
}
.transfer-tasks-compact .settings-item-header strong {
  margin-right: 8px;
  font-size: 13px;
}
.transfer-history-toggle {
  margin-top: 12px;
  color: var(--muted, #687486);
}
</style>
