<script setup lang="ts">
import { computed, onMounted, onActivated, onUnmounted, reactive, ref, watch } from 'vue';
import type {
  ToDooEntityKind,
  ToDooEntityMap,
  ToDooSettings,
} from '../../../../shared/to-doo-contracts';
import type { ToDooWorkbench } from '../../to-doo-workbench';
const props = defineProps<{ model: ToDooWorkbench }>();
const emit = defineEmits<{
  'resume-outcome':[operation:ToDooEntityMap['operation']];
  'open-note':[id:string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
}>();
const state = props.model.state,
  settings = ref<ToDooSettings>(),
  settingsBaseline = ref(''),
  busy = ref(false),
  push = ref<any>(null),
  connections = ref<any[]>([]),
  feed = ref(''),
  feeds = ref<ToDooEntityMap['calendarFeed'][]>([]),
  feedName = ref(''),
  feedLists = ref<string[]>([]),
  feedDescription = ref(false),
  connection = reactive({ name: '', url: '' }),
  file = ref<File>(),
  encoding = ref('utf-8'),
  content = ref(''),
  format = ref<'json' | 'ics' | 'csv'>('json'),
  mergeMode = ref<'skip' | 'copy' | 'update'>('skip'),
  target = ref<'calendar' | 'tasks'>('tasks'),
  importZone = ref('UTC'),
  importList = ref<string | null>(null),
  preview = ref<any>(null),
  mapping = reactive<Record<string, string>>({}),
  sourceName = ref(''),
  exportMode = ref('events');
const fieldLabels: Record<string, string> = {
  title: '标题',
  name: '名称',
  description: '说明',
  status: '状态',
  due: '截止时间',
  start: '开始时间',
  priority: '优先级',
  listId: '所属清单',
  tagIds: '标签',
  parentTaskId: '父任务',
  recurrence: '重复规则',
  criteria: '完成标准',
  noteRefs: '关联资料',
  attachments: '附件',
  durationMinutes: '时长（分钟）',
  completedAt: '完成时间',
  date: '日期',
  time: '时间',
};
function diffValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.map(diffValue).join('、') || '无';
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.date) return [v.date, v.time, v.timeZone].filter(Boolean).join(' ');
    return String(v.title || v.name || v.summary || '已设置的内容');
  }
  return String(value);
}
watch(
  () => state.snapshot?.settings,
  (value) => {
    if (value && (!settings.value || JSON.stringify(settings.value) === settingsBaseline.value)) {
      settings.value = JSON.parse(JSON.stringify(value));
      settingsBaseline.value = JSON.stringify(value);
      importZone.value = value.timeZone;
    }
  },
  { immediate: true },
);
const jobStatusLabels: Record<string, string> = {
  queued: '等待处理',
  running: '处理中',
  completed: '全部完成',
  cancelled: '已停止',
  failed: '需要处理',
};
const importJob = ref<any>(null);
let jobTimer: ReturnType<typeof setInterval> | undefined;
const jobStorage = () => 'dooknow.to-doo.import-job:' + state.snapshot?.datasetId;
async function pollJob() {
  if (!importJob.value?.jobId) return;
  try {
    const status = await props.model.request(
      '/api/to-doo/import/' + encodeURIComponent(importJob.value.jobId) + '/status',
    );
    importJob.value = { ...status, jobId: importJob.value.jobId };
    if (!['queued', 'running'].includes(status.status)) {
      clearInterval(jobTimer);
      jobTimer = undefined;
      if (status.status === 'completed') {
        await props.model.load();
        state.notice = '导入全部完成';
        localStorage.removeItem(jobStorage());
      } else if (status.status === 'failed')
        state.error = status.error || '导入失败，已完成的批次仍保留';
    }
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
}
function trackJob(value: any) {
  importJob.value = value;
  localStorage.setItem(jobStorage(), value.jobId);
  clearInterval(jobTimer);
  jobTimer = setInterval(() => void pollJob(), 1500);
  void pollJob();
}
onMounted(() => {
  const id = localStorage.getItem(jobStorage());
  if (id) trackJob({ jobId: id, status: 'queued', completed: 0, total: 0 });
});
onUnmounted(() => {
  clearInterval(jobTimer);
  delete state.externalDirty.settings;
});
async function controlJob(operation: 'cancel' | 'resume') {
  if (!importJob.value) return;
  await work(async () => {
    const value = await props.model.request(
      '/api/to-doo/import/' + importJob.value.jobId + '/' + operation,
      'POST',
    );
    if (operation === 'resume') trackJob({ ...value, jobId: importJob.value.jobId });
    else {
      await pollJob();
      state.notice = '已请求停止后续批次，已完成的内容保留';
    }
  });
}
const dirty = computed(
  () => !!settings.value && JSON.stringify(settings.value) !== settingsBaseline.value,
);
watch(
  () => dirty.value || !!content.value || !!connection.url,
  (value) => {
    state.externalDirty.settings = value;
  },
  { immediate: true },
);
const capability = computed(
  () =>
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window &&
    window.isSecureContext,
);
const pushReasons: Record<string, string> = {
  https_required: '需要使用安全的站点地址',
  host_inactive: '此主机尚未启用推送',
  server_keys_missing: '服务尚未准备好推送密钥',
  device_subscription_required: '请先订阅当前设备',
  ready: '服务已就绪，设备已订阅',
};
const pushReason = computed(() => pushReasons[push.value?.reason] || '正在检查服务状态');
async function work(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  state.error = '';
  state.notice = '';
  try {
    await action();
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function refreshConnections() {
  const results = await Promise.all([
    props.model.request('/api/to-doo/push'),
    props.model.request('/api/to-doo/calendars/feeds'),
    props.model.request('/api/to-doo/calendars/connections'),
  ]);
  push.value = results[0];
  feeds.value = results[1];
  connections.value = results[2];
}
onMounted(() => void work(refreshConnections));
onActivated(()=>void props.model.loadPendingOperations());
async function save() {
  if (!settings.value) return;
  const result = await props.model.saveEntity(
    'settings',
    settings.value,
    settings.value.revision,
    '偏好已保存',
  );
  if (result) {
    settings.value = JSON.parse(JSON.stringify(state.snapshot!.settings));
    settingsBaseline.value = JSON.stringify(settings.value);
  }
}
function quiet(enabled: boolean) {
  if (!settings.value) return;
  settings.value.quietHours = {
    enabled,
    start: settings.value.quietHours?.start || '22:00',
    end: settings.value.quietHours?.end || '08:00',
    timeZone: settings.value.timeZone,
  };
}
async function exportFile(kind: 'json' | 'ics') {
  await work(async () => {
    const result = await props.model.request(
      '/api/to-doo/export?format=' + kind + (kind === 'ics' ? '&mode=' + exportMode.value : ''),
    );
    if (typeof result.content !== 'string') throw Error('导出响应缺少文件内容');
    const url = URL.createObjectURL(new Blob([result.content], { type: result.contentType }));
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    state.notice = '导出文件已生成';
  });
}
async function decodeFile() {
  if (!file.value) return;
  preview.value = null;
  try {
    content.value = new TextDecoder(encoding.value, { fatal: true }).decode(
      await file.value.arrayBuffer(),
    );
    state.error = '';
  } catch {
    content.value = '';
    state.error = '文件解码失败，请选择正确的文件编码后重试';
  }
}
async function chooseFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (!selected) return;
  if (selected.size > 64 * 1024 * 1024) {
    state.error = '导入文件不能超过 64 MB';
    return;
  }
  file.value = selected;
  sourceName.value = selected.name;
  format.value = selected.name.toLowerCase().endsWith('.ics')
    ? 'ics'
    : selected.name.toLowerCase().endsWith('.csv')
      ? 'csv'
      : 'json';
  await decodeFile();
  preview.value = null;
}
async function previewImport() {
  await work(async () => {
    preview.value = await props.model.request('/api/to-doo/import/preview', 'POST', {
      format: format.value,
      mergeMode: mergeMode.value,
      content: content.value,
      name: sourceName.value || file.value?.name || '手动导入',
      timeZone: importZone.value,
      target: target.value,
      listId: importList.value,
      ...(format.value === 'csv'
        ? { mapping: Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)) }
        : {}),
    });
  });
}
async function applyImport() {
  if (!preview.value) return;
  await work(async () => {
    const result = await props.model.request('/api/to-doo/import/apply', 'POST', {
      previewId: preview.value.id,
      requestId: crypto.randomUUID(),
    });
    preview.value = null;
    content.value = '';
    file.value = undefined;
    if (result.jobId) {
      trackJob(result);
      state.notice = '导入作业已开始，可在下方查看批次进度';
    } else {
      await props.model.load();
      state.notice = '导入已保存';
    }
  });
}
async function configurePush(enabled: boolean) {
  await work(async () => {
    push.value = await props.model.request('/api/to-doo/push/configure', 'POST', {
      enabled,
      showContent: !!push.value?.showContent,
    });
    state.notice = enabled ? '此主机推送已启用' : '此主机推送已停用';
  });
}
async function subscribe() {
  await work(async () => {
    if (!capability.value) throw Error('当前浏览器或站点地址不支持 Web Push');
    if (!push.value?.publicKey) throw Error('请先启用此主机推送');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw Error('尚未获得通知权限，可以在浏览器中调整后重试');
    const registration = await navigator.serviceWorker.register('/to-doo-sw.js');
    const publicKey = String(push.value.publicKey).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(publicKey.padEnd(Math.ceil(publicKey.length / 4) * 4, '='));
    const key = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer,
      }));
    await props.model.request('/api/to-doo/push/subscribe', 'POST', {
      subscription: subscription.toJSON(),
      deviceName: navigator.platform || '当前浏览器',
    });
    await refreshConnections();
    state.notice = '当前设备已订阅；可发送测试通知确认实际送达';
  });
}
async function testDevice(id: string) {
  await work(async () => {
    await props.model.request('/api/to-doo/push/devices/' + id + '/test', 'POST');
    state.notice = '测试请求已提交，请在目标设备确认通知';
    await refreshConnections();
  });
}
async function revokeDevice(id: string) {
  await work(async () => {
    await props.model.request('/api/to-doo/push/devices/' + id, 'DELETE');
    await refreshConnections();
    state.notice = '设备订阅已撤销';
  });
}
async function createFeed() {
  await work(async () => {
    const result = await props.model.request('/api/to-doo/calendars/feeds', 'POST', {
      name: feedName.value,
      listIds: feedLists.value,
      includeDescription: feedDescription.value,
    });
    feed.value = new URL(result.url, location.origin).href;
    feedName.value = '';
    await refreshConnections();
    state.notice = '只读订阅链接已创建';
  });
}
async function revokeFeed(id: string) {
  if (!confirm('撤销此日历订阅链接？原链接将立即失效。')) return;
  await work(async () => {
    await props.model.request('/api/to-doo/calendars/feeds/' + id, 'DELETE');
    feed.value = '';
    await refreshConnections();
  });
}
async function connect() {
  await work(async () => {
    await props.model.request('/api/to-doo/calendars/connect', 'POST', { ...connection });
    connection.url = '';
    await refreshConnections();
    await props.model.load();
    state.notice = '外部日历已连接';
  });
}
async function refreshSource(id: string) {
  await work(async () => {
    await props.model.request('/api/to-doo/calendars/' + id + '/refresh', 'POST');
    await refreshConnections();
    await props.model.load();
    state.notice = '外部日历已刷新';
  });
}
async function pauseSource(id: string, paused: boolean) {
  await work(async () => {
    await props.model.request('/api/to-doo/calendars/' + id + '/pause', 'POST', { paused });
    await refreshConnections();
  });
}
async function disconnect(id: string) {
  await work(async () => {
    await props.model.request('/api/to-doo/calendars/' + id + '/connection', 'DELETE');
    await refreshConnections();
    state.notice = '连接已断开，已载入事件保留';
  });
}
defineExpose({ hasUnsavedChanges: () => dirty.value || !!content.value || !!connection.url });
</script>
<template>
  <div class="todo-settings"><section class="todo-panel"><div class="todo-panel-header"><h2>待继续的成果笔记</h2><button type="button" class="todo-link" :disabled="state.operationLoading" @click="model.loadPendingOperations()">刷新</button></div><p class="todo-pad todo-muted todo-small">已经保存的正文与操作进度会保留，可核对当前任务版本后继续关联。</p><div v-for="operation in state.pendingOperations" :key="operation.id" class="todo-setting-row"><div><h3>{{ operation.title }}</h3><p>{{ {prepared:'准备保存笔记',note_saved:'笔记已保存，等待关联',needs_reconciliation:'需要核对任务版本',completed:'已完成'}[operation.state] }} · {{ new Date(operation.updatedAt).toLocaleString() }}</p></div><div class="todo-actions"><button v-if="operation.noteId" type="button" class="todo-link" @click="emit('open-note',operation.noteId)">打开已保存笔记</button><button type="button" class="todo-button todo-primary" @click="emit('resume-outcome',operation)">核对并继续</button></div></div><p v-if="state.operationLoading" class="todo-pad todo-muted">正在读取成果进度…</p><p v-if="state.operationError" class="todo-pad todo-error" role="alert">{{ state.operationError }}</p><p v-if="!state.operationLoading&&!state.pendingOperations.length" class="todo-pad todo-muted">当前已读取的记录没有待继续项。</p><div v-if="state.operationPage?.nextCursor" class="todo-panel-footer"><span>历史记录按批读取</span><button type="button" class="todo-button" :disabled="state.operationLoading" @click="model.loadPendingOperations(true)">继续检查历史成果进度</button></div></section>
    <section v-if="settings" class="todo-panel">
      <div class="todo-panel-header">
        <h2>偏好与提醒</h2>
        <span v-if="dirty" class="todo-warning todo-small">有未保存的更改</span>
      </div>
      <form class="todo-form todo-pad" @submit.prevent="save">
        <div class="todo-form-grid">
          <label
            >显示时区<input
              v-model="settings.timeZone"
              required
              placeholder="Asia/Shanghai" /></label
          ><label
            >一周开始于<select v-model.number="settings.weekStartsOn">
              <option
                v-for="(n, i) in [
                  '星期日',
                  '星期一',
                  '星期二',
                  '星期三',
                  '星期四',
                  '星期五',
                  '星期六',
                ]"
                :key="i"
                :value="i"
              >
                {{ n }}
              </option>
            </select></label
          ><label
            >默认视图<select v-model="settings.defaultView">
              <option
                v-for="(n, k) in {
                  overview: '目标总览',
                  tasks: '任务列表',
                  calendar: '日历',
                  board: '看板',
                  matrix: '四象限',
                }"
                :key="k"
                :value="k"
              >
                {{ n }}
              </option>
            </select></label
          ><label
            >默认安排分钟<input
              v-model.number="settings.defaultDurationMinutes"
              type="number"
              min="1"
              max="1440" /></label
          ><label
            >紧急阈值（小时）<input
              v-model.number="settings.urgentHours"
              type="number"
              min="1" /></label
          ><label
            >任务层级上限<input
              v-model.number="settings.maxDepth"
              type="number"
              min="1"
              max="32" /></label
          ><label
            >专注分钟<input
              v-model.number="settings.focusMinutes"
              type="number"
              min="1"
              max="1440" /></label
          ><label
            >短休息分钟<input
              v-model.number="settings.shortBreakMinutes"
              type="number"
              min="0"
              max="1440" /></label
          ><label
            >长休息分钟<input
              v-model.number="settings.longBreakMinutes"
              type="number"
              min="0"
              max="1440" /></label
          ><label
            >长休息间隔（次）<input v-model.number="settings.longBreakAfter" type="number" min="1"
          /></label>
        </div>
        <label class="todo-checkbox"
          ><input
            type="checkbox"
            :checked="settings.quietHours?.enabled"
            @change="quiet(($event.target as HTMLInputElement).checked)"
          />开启免打扰时段</label
        >
        <div v-if="settings.quietHours?.enabled" class="todo-form-grid">
          <label>开始<input v-model="settings.quietHours.start" type="time" /></label
          ><label>结束<input v-model="settings.quietHours.end" type="time" /></label>
        </div>
        <div>
          <button type="submit" class="todo-button todo-primary" :disabled="state.busy || !dirty">
            保存偏好
          </button>
        </div>
      </form>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header"><h2>数据与备份</h2></div>
      <div class="todo-setting-row">
        <div>
          <h3>完整导出</h3>
          <p>JSON 包含目标、任务、习惯、成果与复盘；可用于迁移与恢复。</p>
        </div>
        <button class="todo-button" type="button" :disabled="busy" @click="exportFile('json')">
          导出 JSON
        </button>
      </div>
      <div class="todo-setting-row">
        <div>
          <h3>日历导出</h3>
          <p>把计划或任务导入其他日历。</p>
        </div>
        <div class="todo-actions">
          <select v-model="exportMode" aria-label="日历导出方式">
            <option value="events">时间事件</option>
            <option value="todos">待办任务</option></select
          ><button class="todo-button" type="button" :disabled="busy" @click="exportFile('ics')">
            导出 ICS
          </button>
        </div>
      </div>
      <div class="todo-pad todo-form">
        <h3>从文件导入</h3>
        <input
          type="file"
          accept=".json,.ics,.csv"
          aria-label="选择导入文件"
          @change="chooseFile"
        />
        <div class="todo-form-grid">
          <label
            >文件编码<select v-model="encoding" @change="decodeFile">
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030 / GBK</option>
              <option value="utf-16le">UTF-16 LE</option>
            </select></label
          ><label
            >格式<select v-model="format">
              <option value="json">To Doo JSON</option>
              <option value="csv">滴答 CSV</option>
              <option value="ics">iCalendar ICS</option>
            </select></label
          ><label
            >重复处理<select v-model="mergeMode">
              <option value="skip">跳过重复，保留已有内容</option>
              <option value="copy">保留独立副本</option>
              <option value="update">按原始身份明确更新</option>
            </select></label
          ><label>导入时区<input v-model="importZone" required /></label
          ><label
            >内容用途<select v-model="target">
              <option value="tasks">转为任务</option>
              <option value="calendar">作为日历事件</option>
            </select></label
          ><label
            >目标清单<select v-model="importList">
              <option :value="null">使用原清单 / 收集箱</option>
              <option
                v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </select></label
          >
        </div>
        <details v-if="format === 'csv'">
          <summary>CSV 列映射（留空自动识别）</summary>
          <div class="todo-form-grid">
            <label
              v-for="(label, key) in {
                title: '任务标题列',
                description: '备注列',
                list: '清单列',
                parent: '父任务 ID 列',
                tags: '标签列',
                priority: '优先级列',
                status: '状态列',
                due: '截止列',
                start: '开始日期列',
                repeat: '重复列',
              }"
              :key="key"
              >{{ label }}<input v-model="mapping[key]" placeholder="填写原文件表头名称"
            /></label>
          </div>
        </details>
        <label v-if="!file"
          >或粘贴文件内容<textarea
            v-model="content"
            rows="4"
            placeholder="粘贴 JSON、CSV 或 ICS 内容"
          ></textarea></label
        ><button
          type="button"
          class="todo-button"
          :disabled="busy || !content"
          @click="previewImport"
        >
          预览导入
        </button>
        <div v-if="preview" class="todo-import-preview">
          <h3>{{ preview.items.length }} 项待导入 · {{ preview.duplicates }} 项重复</h3>
          <p v-if="preview.batchCount > 1">
            将分 {{ preview.batchCount }} 批处理，每批最多
            {{ preview.batchSize }} 项；停止后会保留已完成批次。
          </p>
          <p v-for="w in preview.warnings" :key="w" class="todo-warning">{{ w }}</p>
          <details v-if="preview.changes?.length">
            <summary>核对 {{ preview.changes.length }} 项更新差异</summary>
            <article v-for="(change, i) in preview.changes" :key="i" class="todo-import-change">
              <h3>
                {{ change.after.title || change.after.name || change.after.summary || '记录' }}
              </h3>
              <div v-for="(diff, j) in change.diff" :key="j" class="todo-diff-row">
                <span>{{ fieldLabels[diff.field] || '其他信息' }}</span
                ><span
                  ><del>{{ diffValue(diff.before) }}</del
                  ><span aria-label="更新为"> → </span
                  ><strong>{{ diffValue(diff.after) }}</strong></span
                >
              </div>
            </article>
          </details>
          <ul>
            <li v-for="(item, i) in preview.items.slice(0, 20)" :key="i">
              {{ item.entity.title || item.entity.name || item.entity.summary || item.kind }}
            </li>
          </ul>
          <p v-if="preview.items.length > 20" class="todo-muted">
            还有 {{ preview.items.length - 20 }} 项
          </p>
          <button
            type="button"
            class="todo-button todo-primary"
            :disabled="busy || !preview.items.length"
            @click="applyImport"
          >
            确认导入 {{ preview.items.length }} 项</button
          ><button type="button" class="todo-button" @click="preview = null">取消预览</button>
        </div>
      </div>
    </section>
    <section v-if="importJob" class="todo-panel">
      <div class="todo-panel-header">
        <h2>导入进度</h2>
        <span class="todo-badge">{{ jobStatusLabels[importJob.status] || importJob.status }}</span>
      </div>
      <div class="todo-pad">
        <p>
          {{ importJob.completed || 0 }} / {{ importJob.total || 0 }} 项已完成。已提交的批次会保留。
        </p>
        <progress :value="importJob.completed || 0" :max="importJob.total || 1"></progress>
        <p v-if="importJob.error" class="todo-error">{{ importJob.error }}</p>
        <div class="todo-actions todo-top-gap">
          <button
            v-if="['queued', 'running'].includes(importJob.status)"
            class="todo-button"
            type="button"
            :disabled="busy"
            @click="controlJob('cancel')"
          >
            停止后续批次</button
          ><button
            v-if="['cancelled', 'failed'].includes(importJob.status)"
            class="todo-button todo-primary"
            type="button"
            :disabled="busy"
            @click="controlJob('resume')"
          >
            继续剩余批次</button
          ><button class="todo-button" type="button" @click="pollJob">刷新进度</button>
        </div>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header">
        <h2>设备通知</h2>
        <button class="todo-link" type="button" :disabled="busy" @click="work(refreshConnections)">
          刷新状态
        </button>
      </div>
      <div class="todo-pad todo-form">
        <p>{{ pushReason }}</p>
        <p v-if="!capability" class="todo-muted todo-small">
          当前浏览器或站点地址不支持设备推送，站内通知中心仍可使用。
        </p>
        <p v-if="push?.lastError" class="todo-error">{{ push.lastError }}</p>
        <div class="todo-actions">
          <button
            type="button"
            class="todo-button"
            :disabled="busy"
            @click="configurePush(!push?.enabled)"
          >
            {{ push?.enabled ? '停用此主机推送' : '启用此主机推送' }}</button
          ><button
            type="button"
            class="todo-button todo-primary"
            :disabled="busy || !capability || !push?.publicKey"
            @click="subscribe"
          >
            订阅当前设备
          </button>
        </div>
        <label v-if="push" class="todo-checkbox"
          ><input
            v-model="push.showContent"
            type="checkbox"
            @change="configurePush(push.enabled)"
          />在设备通知中显示任务内容</label
        >
        <div v-for="device in push?.devices" :key="device.id" class="todo-setting-row">
          <div>
            <h3>{{ device.deviceName }}</h3>
            <p>
              {{ device.status === 'expired' ? '订阅已过期' : '订阅有效' }} ·
              {{
                device.lastSuccessAt
                  ? '最近送达 ' + new Date(device.lastSuccessAt).toLocaleString()
                  : '尚无成功送达记录'
              }}
            </p>
          </div>
          <div class="todo-actions">
            <button
              class="todo-button"
              type="button"
              :disabled="busy || device.status === 'expired'"
              @click="testDevice(device.id)"
            >
              发送测试</button
            ><button
              class="todo-link todo-danger"
              type="button"
              :disabled="busy"
              @click="revokeDevice(device.id)"
            >
              撤销
            </button>
          </div>
        </div>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header"><h2>日历连接与订阅</h2></div>
      <form class="todo-form todo-pad" @submit.prevent="connect">
        <h3>连接外部只读日历</h3>
        <label>来源名称<input v-model="connection.name" required maxlength="256" /></label
        ><label
          >HTTPS 日历地址<input
            v-model="connection.url"
            type="url"
            required
            placeholder="https://…/calendar.ics"
            autocomplete="off"
        /></label>
        <div><button class="todo-button" type="submit" :disabled="busy">连接日历</button></div>
      </form>
      <div v-for="c in connections" :key="c.sourceId" class="todo-setting-row">
        <div>
          <h3>
            {{
              state.snapshot?.calendarSources.find((s) => s.id === c.sourceId)?.name || '日历来源'
            }}
          </h3>
          <p>
            {{ c.error || c.status
            }}{{ c.lastFetchedAt ? ' · ' + new Date(c.lastFetchedAt).toLocaleString() : '' }}
          </p>
        </div>
        <div class="todo-actions">
          <button
            class="todo-button"
            type="button"
            :disabled="busy"
            @click="refreshSource(c.sourceId)"
          >
            刷新</button
          ><button
            class="todo-button"
            type="button"
            :disabled="busy"
            @click="pauseSource(c.sourceId, c.status !== 'paused')"
          >
            {{ c.status === 'paused' ? '恢复刷新' : '暂停刷新' }}</button
          ><button class="todo-link" type="button" :disabled="busy" @click="disconnect(c.sourceId)">
            断开
          </button>
        </div>
      </div>
      <form class="todo-form todo-pad todo-divider" @submit.prevent="createFeed">
        <h3>创建 To Doo 只读订阅链接</h3>
        <label>订阅名称<input v-model="feedName" required /></label
        ><label
          >包含的清单（不选表示全部）<select v-model="feedLists" multiple>
            <option
              v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </select></label
        ><label class="todo-checkbox"
          ><input v-model="feedDescription" type="checkbox" />包含任务说明</label
        >
        <div><button class="todo-button" type="submit" :disabled="busy">创建订阅链接</button></div>
        <label v-if="feed"
          >新建链接（仅本次显示）<input
            :value="feed"
            readonly
            @focus="($event.target as HTMLInputElement).select()"
          /><small>持有此链接可以读取所选日历；可随时撤销。</small></label
        >
      </form>
      <div v-for="f in feeds.filter((f) => !f.deletedAt)" :key="f.id" class="todo-setting-row">
        <span>{{ f.name }}</span
        ><button
          class="todo-link todo-danger"
          type="button"
          :disabled="busy"
          @click="revokeFeed(f.id)"
        >
          撤销订阅链接
        </button>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header"><h2>清单、标签与模板</h2></div>
      <div class="todo-setting-row">
        <span>新建与管理</span>
        <div class="todo-actions">
          <button class="todo-button" type="button" @click="emit('edit', 'list')">目标与清单</button
          ><button class="todo-button" type="button" @click="emit('edit', 'tag')">标签</button
          ><button class="todo-button" type="button" @click="emit('edit', 'template')">
            任务模板
          </button>
        </div>
      </div>
      <div
        v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
        :key="l.id"
        class="todo-setting-row"
      >
        <span>{{ l.name }}</span
        ><button class="todo-link" type="button" @click="emit('edit', 'list', l)">编辑清单</button>
      </div>
      <div
        v-for="t in state.snapshot?.tags.filter((t) => !t.deletedAt)"
        :key="t.id"
        class="todo-setting-row"
      >
        <span># {{ t.name }}</span
        ><button class="todo-link" type="button" @click="emit('edit', 'tag', t)">编辑标签</button>
      </div>
      <div
        v-for="s in state.snapshot?.sections.filter((s) => !s.deletedAt)"
        :key="s.id"
        class="todo-setting-row"
      >
        <span>{{ s.name }}</span
        ><button class="todo-link" type="button" @click="emit('edit', 'section', s)">
          编辑章节
        </button>
      </div>
    </section>
  </div>
</template>
