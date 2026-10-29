<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import {
  Alert as AAlert,
  Button as AButton,
  Checkbox as ACheckbox,
  Empty as AEmpty,
  Input as AInput,
  InputNumber as AInputNumber,
  Progress as AProgress,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import { computed, onMounted, onActivated, onUnmounted, reactive, ref, watch } from 'vue';
import type {
  ToDooEntityKind,
  ToDooEntityMap,
  ToDooSettings,
} from '../../../../shared/to-doo-contracts';
import type { ToDooWorkbench } from '../../to-doo-workbench';
const props = defineProps<{ model: ToDooWorkbench }>();
const emit = defineEmits<{
  'resume-outcome': [operation: ToDooEntityMap['operation']];
  'open-note': [id: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
}>();
const confirmAction = useToDooConfirm();
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
onActivated(() => void props.model.loadPendingOperations());
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
type NumericSetting =
  | 'defaultDurationMinutes'
  | 'urgentHours'
  | 'maxDepth'
  | 'focusMinutes'
  | 'shortBreakMinutes'
  | 'longBreakMinutes'
  | 'longBreakAfter';
function setSettingNumber(key: NumericSetting, value: number | string | null) {
  if (settings.value) settings.value[key] = (value ?? '') as number;
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
  if (!(await confirmAction('撤销此日历订阅链接？原链接将立即失效。', { danger: true }))) return;
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
  <div class="todo-settings">
    <section class="todo-panel">
      <div class="todo-panel-header">
        <h2>待继续的成果笔记</h2>
        <AButton
          html-type="button"
          class="todo-link"
          :disabled="state.operationLoading"
          @click="model.loadPendingOperations()"
          type="link"
          >刷新</AButton
        >
      </div>
      <p class="todo-pad todo-muted todo-small">
        已经保存的正文与操作进度会保留，可核对当前任务版本后继续关联。
      </p>
      <div
        v-for="operation in state.pendingOperations"
        :key="operation.id"
        class="todo-setting-row"
      >
        <div>
          <h3>{{ operation.title }}</h3>
          <p>
            {{
              {
                prepared: '准备保存笔记',
                note_saved: '笔记已保存，等待关联',
                needs_reconciliation: '需要核对任务版本',
                completed: '已完成',
              }[operation.state]
            }}
            · {{ new Date(operation.updatedAt).toLocaleString() }}
          </p>
        </div>
        <div class="todo-actions">
          <AButton
            v-if="operation.noteId"
            html-type="button"
            class="todo-link"
            @click="emit('open-note', operation.noteId)"
            type="link"
            >打开已保存笔记</AButton
          ><AButton
            html-type="button"
            class="todo-button todo-primary"
            @click="emit('resume-outcome', operation)"
            type="primary"
            >核对并继续</AButton
          >
        </div>
      </div>
      <p v-if="state.operationLoading" class="todo-pad todo-muted">正在读取成果进度…</p>
      <AAlert
        v-if="state.operationError"
        class="todo-pad"
        type="error"
        :message="state.operationError"
        show-icon
      /><AEmpty
        v-if="!state.operationLoading && !state.pendingOperations.length"
        class="todo-pad"
        description="当前已读取的记录没有待继续项。"
        :image="AEmpty.PRESENTED_IMAGE_SIMPLE"
      />
      <div v-if="state.operationPage?.nextCursor" class="todo-panel-footer">
        <span>历史记录按批读取</span
        ><AButton
          html-type="button"
          class="todo-button"
          :disabled="state.operationLoading"
          @click="model.loadPendingOperations(true)"
          type="default"
          >继续检查历史成果进度</AButton
        >
      </div>
    </section>
    <section v-if="settings" class="todo-panel">
      <div class="todo-panel-header">
        <h2>偏好与提醒</h2>
        <span v-if="dirty" class="todo-warning todo-small">有未保存的更改</span>
      </div>
      <form class="todo-form todo-pad" @submit.prevent="save">
        <div class="todo-form-grid">
          <label
            >显示时区<AInput
              v-model:value="settings.timeZone"
              required
              placeholder="Asia/Shanghai" /></label
          ><label
            >一周开始于<ToDooSelect v-model="settings.weekStartsOn">
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
            </ToDooSelect></label
          ><label
            >默认视图<ToDooSelect v-model="settings.defaultView">
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
            </ToDooSelect></label
          ><label
            >默认安排分钟<AInputNumber
              aria-label="默认安排分钟"
              :value="settings.defaultDurationMinutes"
              @update:value="setSettingNumber('defaultDurationMinutes', $event)"
              :min="1"
              :max="1440" /></label
          ><label
            >紧急阈值（小时）<AInputNumber
              aria-label="紧急阈值（小时）"
              :value="settings.urgentHours"
              @update:value="setSettingNumber('urgentHours', $event)"
              :min="1" /></label
          ><label
            >任务层级上限<AInputNumber
              aria-label="任务层级上限"
              :value="settings.maxDepth"
              @update:value="setSettingNumber('maxDepth', $event)"
              :min="1"
              :max="32" /></label
          ><label
            >专注分钟<AInputNumber
              aria-label="专注分钟"
              :value="settings.focusMinutes"
              @update:value="setSettingNumber('focusMinutes', $event)"
              :min="1"
              :max="1440" /></label
          ><label
            >短休息分钟<AInputNumber
              aria-label="短休息分钟"
              :value="settings.shortBreakMinutes"
              @update:value="setSettingNumber('shortBreakMinutes', $event)"
              :min="0"
              :max="1440" /></label
          ><label
            >长休息分钟<AInputNumber
              aria-label="长休息分钟"
              :value="settings.longBreakMinutes"
              @update:value="setSettingNumber('longBreakMinutes', $event)"
              :min="0"
              :max="1440" /></label
          ><label
            >长休息间隔（次）<AInputNumber
              aria-label="长休息间隔（次）"
              :value="settings.longBreakAfter"
              @update:value="setSettingNumber('longBreakAfter', $event)"
              :min="1"
          /></label>
        </div>
        <ACheckbox
          :checked="settings.quietHours?.enabled"
          @change="quiet(($event.target as HTMLInputElement).checked)"
          class="todo-checkbox"
          >开启免打扰时段</ACheckbox
        >
        <div v-if="settings.quietHours?.enabled" class="todo-form-grid">
          <label>开始<ToDooDateField v-model="settings.quietHours.start" type="time" /></label
          ><label>结束<ToDooDateField v-model="settings.quietHours.end" type="time" /></label>
        </div>
        <div>
          <AButton
            html-type="submit"
            class="todo-button todo-primary"
            :disabled="state.busy || !dirty"
            :loading="state.busy"
            type="primary"
          >
            保存偏好
          </AButton>
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
        <AButton
          class="todo-button"
          html-type="button"
          :disabled="busy"
          @click="exportFile('json')"
          type="default"
        >
          导出 JSON
        </AButton>
      </div>
      <div class="todo-setting-row">
        <div>
          <h3>日历导出</h3>
          <p>把计划或任务导入其他日历。</p>
        </div>
        <div class="todo-actions">
          <ToDooSelect v-model="exportMode" aria-label="日历导出方式">
            <option value="events">时间事件</option>
            <option value="todos">待办任务</option></ToDooSelect
          ><AButton
            class="todo-button"
            html-type="button"
            :disabled="busy"
            @click="exportFile('ics')"
            type="default"
          >
            导出 ICS
          </AButton>
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
            >文件编码<ToDooSelect v-model="encoding" @change="decodeFile">
              <option value="utf-8">UTF-8</option>
              <option value="gb18030">GB18030 / GBK</option>
              <option value="utf-16le">UTF-16 LE</option>
            </ToDooSelect></label
          ><label
            >格式<ToDooSelect v-model="format">
              <option value="json">To Doo JSON</option>
              <option value="csv">滴答 CSV</option>
              <option value="ics">iCalendar ICS</option>
            </ToDooSelect></label
          ><label
            >重复处理<ToDooSelect v-model="mergeMode">
              <option value="skip">跳过重复，保留已有内容</option>
              <option value="copy">保留独立副本</option>
              <option value="update">按原始身份明确更新</option>
            </ToDooSelect></label
          ><label>导入时区<AInput v-model:value="importZone" required /></label
          ><label
            >内容用途<ToDooSelect v-model="target">
              <option value="tasks">转为任务</option>
              <option value="calendar">作为日历事件</option>
            </ToDooSelect></label
          ><label
            >目标清单<ToDooSelect v-model="importList">
              <option :value="null">使用原清单 / 收集箱</option>
              <option
                v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
                :key="l.id"
                :value="l.id"
              >
                {{ l.name }}
              </option>
            </ToDooSelect></label
          >
        </div>
        <ToDooDisclosure v-if="format === 'csv'">
          <template #header><span>CSV 列映射（留空自动识别）</span></template>
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
              >{{ label }}<AInput v-model:value="mapping[key]" placeholder="填写原文件表头名称"
            /></label>
          </div>
        </ToDooDisclosure>
        <label v-if="!file"
          >或粘贴文件内容<ATextarea
            v-model:value="content"
            :rows="4"
            placeholder="粘贴 JSON、CSV 或 ICS 内容"
          ></ATextarea></label
        ><AButton
          html-type="button"
          class="todo-button"
          :disabled="busy || !content"
          :loading="busy"
          @click="previewImport"
          type="default"
        >
          预览导入
        </AButton>
        <div v-if="preview" class="todo-import-preview">
          <h3>{{ preview.items.length }} 项待导入 · {{ preview.duplicates }} 项重复</h3>
          <p v-if="preview.batchCount > 1">
            将分 {{ preview.batchCount }} 批处理，每批最多
            {{ preview.batchSize }} 项；停止后会保留已完成批次。
          </p>
          <p v-for="w in preview.warnings" :key="w" class="todo-warning">{{ w }}</p>
          <ToDooDisclosure v-if="preview.changes?.length">
            <template #header
              ><span>核对 {{ preview.changes.length }} 项更新差异</span></template
            >
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
          </ToDooDisclosure>
          <ul>
            <li v-for="(item, i) in preview.items.slice(0, 20)" :key="i">
              {{ item.entity.title || item.entity.name || item.entity.summary || item.kind }}
            </li>
          </ul>
          <p v-if="preview.items.length > 20" class="todo-muted">
            还有 {{ preview.items.length - 20 }} 项
          </p>
          <AButton
            html-type="button"
            class="todo-button todo-primary"
            :disabled="busy || !preview.items.length"
            :loading="busy"
            @click="applyImport"
            type="primary"
          >
            确认导入 {{ preview.items.length }} 项</AButton
          ><AButton html-type="button" class="todo-button" @click="preview = null" type="default"
            >取消预览</AButton
          >
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
        <AProgress
          :percent="Math.round(((importJob.completed || 0) / (importJob.total || 1)) * 100)"
          :status="
            importJob.status === 'failed'
              ? 'exception'
              : importJob.status === 'completed'
                ? 'success'
                : 'active'
          "
        />
        <AAlert v-if="importJob.error" type="error" :message="importJob.error" show-icon />
        <div class="todo-actions todo-top-gap">
          <AButton
            v-if="['queued', 'running'].includes(importJob.status)"
            class="todo-button"
            html-type="button"
            :disabled="busy"
            @click="controlJob('cancel')"
            type="default"
          >
            停止后续批次</AButton
          ><AButton
            v-if="['cancelled', 'failed'].includes(importJob.status)"
            class="todo-button todo-primary"
            html-type="button"
            :disabled="busy"
            @click="controlJob('resume')"
            type="primary"
          >
            继续剩余批次</AButton
          ><AButton class="todo-button" html-type="button" @click="pollJob" type="default"
            >刷新进度</AButton
          >
        </div>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header">
        <h2>设备通知</h2>
        <AButton
          class="todo-link"
          html-type="button"
          :disabled="busy"
          @click="work(refreshConnections)"
          type="link"
        >
          刷新状态
        </AButton>
      </div>
      <div class="todo-pad todo-form">
        <p>{{ pushReason }}</p>
        <p v-if="!capability" class="todo-muted todo-small">
          当前浏览器或站点地址不支持设备推送，站内通知中心仍可使用。
        </p>
        <AAlert v-if="push?.lastError" type="error" :message="push.lastError" show-icon />
        <div class="todo-actions">
          <AButton
            html-type="button"
            class="todo-button"
            :disabled="busy"
            @click="configurePush(!push?.enabled)"
            type="default"
          >
            {{ push?.enabled ? '停用此主机推送' : '启用此主机推送' }}</AButton
          ><AButton
            html-type="button"
            class="todo-button todo-primary"
            :disabled="busy || !capability || !push?.publicKey"
            @click="subscribe"
            type="primary"
          >
            订阅当前设备
          </AButton>
        </div>
        <label v-if="push" class="todo-checkbox"
          ><ACheckbox
            v-model:checked="push.showContent"
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
            <AButton
              class="todo-button"
              html-type="button"
              :disabled="busy || device.status === 'expired'"
              @click="testDevice(device.id)"
              type="default"
            >
              发送测试</AButton
            ><AButton
              class="todo-link todo-danger"
              html-type="button"
              :disabled="busy"
              @click="revokeDevice(device.id)"
              type="link"
            >
              撤销
            </AButton>
          </div>
        </div>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header"><h2>日历连接与订阅</h2></div>
      <form class="todo-form todo-pad" @submit.prevent="connect">
        <h3>连接外部只读日历</h3>
        <label>来源名称<AInput v-model:value="connection.name" required :maxlength="256" /></label
        ><label
          >HTTPS 日历地址<AInput
            v-model:value="connection.url"
            type="url"
            required
            placeholder="https://…/calendar.ics"
            autocomplete="off"
        /></label>
        <div>
          <AButton class="todo-button" html-type="submit" :disabled="busy" type="default"
            >连接日历</AButton
          >
        </div>
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
          <AButton
            class="todo-button"
            html-type="button"
            :disabled="busy"
            @click="refreshSource(c.sourceId)"
            type="default"
          >
            刷新</AButton
          ><AButton
            class="todo-button"
            html-type="button"
            :disabled="busy"
            @click="pauseSource(c.sourceId, c.status !== 'paused')"
            type="default"
          >
            {{ c.status === 'paused' ? '恢复刷新' : '暂停刷新' }}</AButton
          ><AButton
            class="todo-link"
            html-type="button"
            :disabled="busy"
            @click="disconnect(c.sourceId)"
            type="link"
          >
            断开
          </AButton>
        </div>
      </div>
      <form class="todo-form todo-pad todo-divider" @submit.prevent="createFeed">
        <h3>创建 To Doo 只读订阅链接</h3>
        <label>订阅名称<AInput v-model:value="feedName" required /></label
        ><label
          >包含的清单（不选表示全部）<ToDooSelect v-model="feedLists" multiple>
            <option
              v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
              :key="l.id"
              :value="l.id"
            >
              {{ l.name }}
            </option>
          </ToDooSelect></label
        ><ACheckbox v-model:checked="feedDescription" class="todo-checkbox">包含任务说明</ACheckbox>
        <div>
          <AButton class="todo-button" html-type="submit" :disabled="busy" type="default"
            >创建订阅链接</AButton
          >
        </div>
        <label v-if="feed"
          >新建链接（仅本次显示）<AInput
            :value="feed"
            readonly
            @focus="($event.target as HTMLInputElement).select()"
          /><small>持有此链接可以读取所选日历；可随时撤销。</small></label
        >
      </form>
      <div v-for="f in feeds.filter((f) => !f.deletedAt)" :key="f.id" class="todo-setting-row">
        <span>{{ f.name }}</span
        ><AButton
          class="todo-link todo-danger"
          html-type="button"
          :disabled="busy"
          @click="revokeFeed(f.id)"
          type="link"
        >
          撤销订阅链接
        </AButton>
      </div>
    </section>
    <section class="todo-panel">
      <div class="todo-panel-header"><h2>清单、标签与模板</h2></div>
      <div class="todo-setting-row">
        <span>新建与管理</span>
        <div class="todo-actions">
          <AButton
            class="todo-button"
            html-type="button"
            @click="emit('edit', 'list')"
            type="default"
            >目标与清单</AButton
          ><AButton
            class="todo-button"
            html-type="button"
            @click="emit('edit', 'tag')"
            type="default"
            >标签</AButton
          ><AButton
            class="todo-button"
            html-type="button"
            @click="emit('edit', 'template')"
            type="default"
          >
            任务模板
          </AButton>
        </div>
      </div>
      <div
        v-for="l in state.snapshot?.lists.filter((l) => !l.deletedAt)"
        :key="l.id"
        class="todo-setting-row"
      >
        <span>{{ l.name }}</span
        ><AButton class="todo-link" html-type="button" @click="emit('edit', 'list', l)" type="link"
          >编辑清单</AButton
        >
      </div>
      <div
        v-for="t in state.snapshot?.tags.filter((t) => !t.deletedAt)"
        :key="t.id"
        class="todo-setting-row"
      >
        <span># {{ t.name }}</span
        ><AButton class="todo-link" html-type="button" @click="emit('edit', 'tag', t)" type="link"
          >编辑标签</AButton
        >
      </div>
      <div
        v-for="s in state.snapshot?.sections.filter((s) => !s.deletedAt)"
        :key="s.id"
        class="todo-setting-row"
      >
        <span>{{ s.name }}</span
        ><AButton
          class="todo-link"
          html-type="button"
          @click="emit('edit', 'section', s)"
          type="link"
        >
          编辑章节
        </AButton>
      </div>
    </section>
  </div>
</template>
