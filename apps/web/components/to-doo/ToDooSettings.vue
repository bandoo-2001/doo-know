<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import ToDooFormLayout from './ToDooFormLayout.vue';
import {
  Alert as AAlert,
  Button as AButton,
  Checkbox as ACheckbox,
  Empty as AEmpty,
  Input as AInput,
  InputNumber as AInputNumber,
  Progress as AProgress,
  Tabs as ATabs,
  TabPane as ATabPane,
  Textarea as ATextarea,
} from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import {
  enableCurrentToDooPushDevice,
  loadToDooPushStatus,
  type ToDooCurrentPushDevice,
  type ToDooPushHost,
} from '../../to-doo-push';
import { computed, nextTick, onMounted, onActivated, onUnmounted, reactive, ref, watch } from 'vue';
import { toDooEntitySchemas } from '../../../../shared/to-doo-contracts';
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
const activeTab = ref('preferences');
const importFileInput = ref<HTMLInputElement>();
const fileDecoding = ref(false);
const timeZoneSuggestions = [
  ...new Set([
    'UTC',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Europe/London',
    'America/New_York',
    ...Intl.supportedValuesOf('timeZone'),
  ]),
];
const preferencesForm = ref<InstanceType<typeof ToDooFormLayout>>();
const dateRules = ref<InstanceType<typeof ToDooDisclosure>>();
const taskRules = ref<InstanceType<typeof ToDooDisclosure>>();
const focusRules = ref<InstanceType<typeof ToDooDisclosure>>();
const validationError = ref('');
const invalidPreferences = ref(false);
const savingPreferences = ref(false);
const preferenceLabels: Record<string, string> = {
  defaultDurationMinutes: '默认安排分钟',
  timeZone: '显示时区',
  weekStartsOn: '一周开始于',
  urgentHours: '紧急阈值（小时）',
  maxDepth: '任务层级上限',
  focusMinutes: '专注分钟',
  shortBreakMinutes: '短休息分钟',
  longBreakMinutes: '长休息分钟',
  longBreakAfter: '长休息间隔（次）',
  quietHours: '免打扰开始时间',
  'quietHours.start': '免打扰开始时间',
  'quietHours.end': '免打扰结束时间',
};
async function revealPreference(key: string, message: string) {
  activeTab.value = 'preferences';
  validationError.value = message;
  if (['timeZone', 'weekStartsOn'].includes(key) || key.startsWith('quietHours'))
    dateRules.value?.expand({ immediate: true });
  if (['urgentHours', 'maxDepth'].includes(key)) taskRules.value?.expand({ immediate: true });
  if (['focusMinutes', 'shortBreakMinutes', 'longBreakMinutes', 'longBreakAfter'].includes(key))
    focusRules.value?.expand({ immediate: true });
  await nextTick();
  const field = preferencesForm.value?.element?.querySelector<HTMLElement>(
    `[aria-label="${preferenceLabels[key]}"]`,
  );
  field?.focus();
  field?.scrollIntoView?.({ block: 'nearest' });
}
function revealInvalid(event: Event) {
  const field = event.target as HTMLInputElement;
  const label = field.getAttribute('aria-label') || '';
  const key = Object.keys(preferenceLabels).find((key) => preferenceLabels[key] === label) || '';
  void revealPreference(key, `请检查${label || '偏好设置'}：${field.validationMessage}`);
}
async function submitPreferences() {
  activeTab.value = 'preferences';
  await nextTick();
  preferencesForm.value?.requestSubmit();
}
const state = props.model.state,
  settings = ref<ToDooSettings>(),
  settingsBaseline = ref(''),
  busy = ref(false),
  push = ref<ToDooPushHost | null>(null),
  currentPushDevice = ref<ToDooCurrentPushDevice | null>(null),
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
// A confirmation belongs to every input used to parse this exact draft.
const importInputSnapshot = computed(() =>
  JSON.stringify({
    content: content.value,
    format: format.value,
    mergeMode: mergeMode.value,
    target: target.value,
    timeZone: importZone.value,
    listId: importList.value,
    mapping,
    encoding: encoding.value,
    name: sourceName.value,
    file: file.value && {
      name: file.value.name,
      size: file.value.size,
      lastModified: file.value.lastModified,
    },
  }),
);
const importBaseline = ref(importInputSnapshot.value);
const confirmedImport = ref<{ snapshot: string; requestId: string }>();
const previewPage = ref(1);
const previewPageSize = 20;
const previewPageCount = computed(() =>
  Math.max(1, Math.ceil((preview.value?.items.length || 0) / previewPageSize)),
);
const previewItems = computed(
  () =>
    preview.value?.items.slice(
      (previewPage.value - 1) * previewPageSize,
      previewPage.value * previewPageSize,
    ) || [],
);
let importGeneration = 0;
function cancelPreview() {
  preview.value = null;
  confirmedImport.value = undefined;
  previewPage.value = 1;
}
watch(
  importInputSnapshot,
  () => {
    importGeneration++;
    cancelPreview();
  },
  { flush: 'sync' },
);
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
const importKindLabels: Record<string, string> = {
  settings: '应用偏好',
  list: '目标与清单',
  section: '清单分组',
  tag: '标签',
  task: '任务',
  occurrence: '重复任务实例',
  exception: '重复例外',
  timeBlock: '时间安排',
  outcome: '成果',
  record: '执行记录',
  activity: '活动记录',
  focusTopic: '专注主题',
  focusSession: '专注记录',
  habit: '习惯',
  habitEntry: '习惯打卡',
  anniversary: '纪念日',
  view: '保存的视图',
  template: '任务模板',
  review: '复盘',
  plan: '规划',
  reminderEvent: '提醒记录',
  calendarSource: '日历来源',
  calendarEvent: '日历事件',
  calendarFeed: '日历订阅',
  operation: '成果笔记操作',
  import: '导入记录',
};
function importRelatedTask(item: any): any {
  return item.kind === 'task'
    ? item.entity
    : item.entity.taskId
      ? preview.value?.items.find(
          (row: any) => row.kind === 'task' && row.entity.id === item.entity.taskId,
        )?.entity || state.snapshot?.tasks.find((row) => row.id === item.entity.taskId)
      : undefined;
}
function importItemTitle(item: any): string {
  return (
    item.entity.title ||
    item.entity.name ||
    item.entity.summary ||
    importRelatedTask(item)?.title ||
    importKindLabels[item.kind] ||
    '记录'
  );
}
function importItemDate(item: any): string {
  const entity =
    item.kind === 'task'
      ? preview.value?.items.find(
          (row: any) => row.kind === 'occurrence' && row.entity.taskId === item.entity.id,
        )?.entity || item.entity
      : item.entity;
  const dates = [
    entity.scheduledDate && '计划 ' + diffValue(entity.scheduledDate),
    entity.due && '截止 ' + diffValue(entity.due),
    entity.start && '开始 ' + diffValue(entity.start),
    entity.end && '结束 ' + diffValue(entity.end),
    entity.date && diffValue(entity.date),
    entity.scheduledAt && diffValue(entity.scheduledAt),
  ].filter(Boolean);
  return dates.join('；') || '无日期';
}
function importItemDestination(item: any): string {
  const entity = importRelatedTask(item) || item.entity;
  if (entity.listId) {
    const list =
      preview.value?.items.find(
        (row: any) => row.kind === 'list' && row.entity.id === entity.listId,
      )?.entity || state.snapshot?.lists.find((row) => row.id === entity.listId);
    return '清单：' + (list?.name || entity.listId);
  }
  if (item.kind === 'task') return '收集箱';
  if (entity.sourceId) {
    const source =
      preview.value?.items.find(
        (row: any) => row.kind === 'calendarSource' && row.entity.id === entity.sourceId,
      )?.entity || state.snapshot?.calendarSources.find((row) => row.id === entity.sourceId);
    return '日历来源：' + (source?.name || entity.sourceId);
  }
  return 'To Doo / ' + (importKindLabels[item.kind] || '记录');
}
const warningMessages: Record<string, string> = {
  'unrecognized date retained for review':
    '日期无法识别，原值已保留在来源信息中，请核对后再安排日期。',
  'empty title skipped': '标题为空，此行已跳过。',
  'repeat expression is retained in source metadata and checked before task mapping':
    '重复表达式已保留在来源信息中，并在生成任务前检查。',
  'unrecognized priority retained; mapped to none':
    '优先级无法识别，原值已保留，导入后暂不设优先级。',
  'unrecognized status retained; mapped to todo': '状态无法识别，原值已保留，导入后暂记为待办。',
  'missing stable external identity; existing content was not matched by title':
    '缺少稳定的外部身份，未按标题匹配已有内容。',
  'existing entity differs; default merge preserves it':
    '已有记录与导入内容不同，本次保留已有内容。',
  'unsupported recurrence retained as a read-only calendar layer; no one-off task was substituted':
    '此重复规则暂不支持转为任务，已保留为只读日历内容。',
  'orphan recurrence exception retained as an independent calendar event':
    '找不到对应的重复系列，此例外已保留为独立日历事件。',
  'missing parent retained in import source; task will be a root':
    '找不到父任务，原关联已保留在来源信息中，将作为顶级任务导入。',
  'unsupported repetition remains in source metadata; review the rule before enabling repetition':
    '此重复规则暂不支持，已保留原值，请核对后再启用重复。',
  'no stable external ID; similar titles are not used to infer an update':
    '缺少稳定的外部 ID，未按相似标题推断更新对象。',
  'fine-grained recurrence remains a read-only source rule; task mapping requires bounded expansion':
    '高频重复规则已保留为只读来源，转为任务前需要限定展开范围。',
  'nested alarms/components are preserved but not activated':
    '内嵌提醒与组件已保留，导入后不会自动启用。',
  'Copies receive independent identities; original request receipts and active cross-content operations are not copied':
    '副本使用独立身份；原请求回执及进行中的跨内容操作不会复制。',
  'The empty destination will adopt the imported application settings':
    '目标工作空间为空，将采用导入文件中的应用偏好。',
  'Import comes from another dataset; identities are preserved and existing entities are not overwritten':
    '来源属于另一数据集；保留原始身份，已有记录不会被覆盖。',
};
function importWarning(raw: string): { subject: string; message: string } {
  if (warningMessages[raw]) return { subject: '', message: warningMessages[raw] };
  const row = raw.match(/^Row (\d+): (.*)$/);
  const uid = raw.match(/^UID (.*?): (.*)$/);
  const separator = raw.indexOf(': ');
  const subject = row
    ? '第 ' + row[1] + ' 行'
    : uid
      ? '日历条目 ' + uid[1]
      : separator >= 0
        ? raw.slice(0, separator)
        : '';
  const message = row ? row[2] : uid ? uid[2] : separator >= 0 ? raw.slice(separator + 2) : raw;
  const property = message.match(
    /^([A-Z0-9-]+) is preserved in source content; remote resources are not fetched$/,
  );
  return {
    subject,
    message:
      warningMessages[message] ||
      (property ? property[1] + ' 字段已保留在来源内容中，不会抓取外部资源。' : message),
  };
}
const previewWarnings = computed(() => (preview.value?.warnings || []).map(importWarning));
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
    if (
      value &&
      !savingPreferences.value &&
      (!settings.value ||
        (!invalidPreferences.value && JSON.stringify(settings.value) === settingsBaseline.value))
    ) {
      const pristineImport = importInputSnapshot.value === importBaseline.value;
      settings.value = JSON.parse(JSON.stringify(value));
      settingsBaseline.value = JSON.stringify(value);
      if (pristineImport) {
        importZone.value = value.timeZone;
        importBaseline.value = importInputSnapshot.value;
      }
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
  () =>
    invalidPreferences.value ||
    (!!settings.value && JSON.stringify(settings.value) !== settingsBaseline.value),
);
const hasDraft = computed(
  () =>
    dirty.value ||
    importInputSnapshot.value !== importBaseline.value ||
    !!connection.name ||
    !!connection.url ||
    !!feedName.value ||
    !!feedLists.value.length ||
    feedDescription.value,
);
watch(
  hasDraft,
  (value) => {
    state.externalDirty.settings = value;
  },
  { immediate: true },
);
const capability = computed(() => currentPushDevice.value?.capability === 'supported');
const pushReasons: Record<string, string> = {
  https_required: '主机需要配置安全的站点地址',
  host_inactive: '此主机尚未启用桌面提醒',
  server_keys_missing: '此主机尚未准备好推送密钥',
  device_subscription_required: '主机已启用，等待设备登记',
  ready: '主机已启用，可向已登记设备发送提醒',
};
const pushReason = computed(() => pushReasons[push.value?.reason || ''] || '正在检查服务状态');
const pushPermission = computed(() => {
  if (!currentPushDevice.value) return '正在检查';
  return {
    granted: '已允许',
    denied: '已阻止，请在浏览器的站点设置中允许通知',
    default: '尚未允许，点击下方按钮后可授权',
    unsupported: '当前浏览器不支持',
  }[currentPushDevice.value.permission];
});
const currentPushReason = computed(() => {
  const device = currentPushDevice.value;
  if (!device) return '正在检查当前设备';
  if (device.capability === 'insecure') return '当前设备需要通过 HTTPS 或本机安全地址打开本站';
  if (device.capability === 'unsupported') return '当前浏览器不支持桌面提醒，站内通知中心仍可使用';
  if (device.permission !== 'granted') return '当前设备尚未启用桌面提醒';
  if (device.ready) return '当前设备桌面提醒已启用';
  if (device.subscription === 'expired') return '当前设备订阅已过期，请重新启用';
  if (device.subscription === 'unregistered') return '当前设备尚未登记到此主机，请重新启用';
  if (device.subscription === 'missing') return '当前设备尚未启用桌面提醒';
  return '当前设备已登记，等待主机准备就绪';
});
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
  currentPushDevice.value = null;
  const results = await Promise.all([
    loadToDooPushStatus(props.model.request),
    props.model.request('/api/to-doo/calendars/feeds'),
    props.model.request('/api/to-doo/calendars/connections'),
  ]);
  push.value = results[0].host;
  currentPushDevice.value = results[0].currentDevice;
  feeds.value = results[1];
  connections.value = results[2];
}
onMounted(() => void work(refreshConnections));
onActivated(() => void props.model.loadPendingOperations());
async function save() {
  if (!settings.value || state.busy) return;
  const parsed = toDooEntitySchemas.settings.safeParse(settings.value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue.path.join('.');
    await revealPreference(
      key,
      `请检查${preferenceLabels[key] || '偏好设置'}，填写有效值后再保存。`,
    );
    return;
  }
  validationError.value = '';
  const submitted = JSON.parse(JSON.stringify(parsed.data)) as ToDooSettings;
  savingPreferences.value = true;
  try {
    const result = await props.model.saveEntity(
      'settings',
      submitted,
      submitted.revision,
      '偏好已保存',
    );
    if (result) {
      const saved = JSON.parse(JSON.stringify(state.snapshot!.settings)) as ToDooSettings;
      const laterEdits = Object.fromEntries(
        (Object.keys(settings.value) as (keyof ToDooSettings)[])
          .filter((key) => JSON.stringify(settings.value![key]) !== JSON.stringify(submitted[key]))
          .map((key) => [key, settings.value![key]]),
      );
      settingsBaseline.value = JSON.stringify(saved);
      settings.value = { ...saved, ...laterEdits };
      if (dirty.value) state.notice = '偏好已保存，后续修改仍未保存';
    }
  } finally {
    savingPreferences.value = false;
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
function setDisplayTimeZone(value: string) {
  if (!settings.value) return;
  const previous = settings.value.timeZone;
  settings.value.timeZone = value;
  if (settings.value.quietHours?.timeZone === previous) settings.value.quietHours.timeZone = value;
}
function quiet(enabled: boolean) {
  if (!settings.value) return;
  settings.value.quietHours = {
    enabled,
    start: settings.value.quietHours?.start || '22:00',
    end: settings.value.quietHours?.end || '08:00',
    timeZone: settings.value.quietHours?.timeZone || settings.value.timeZone,
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
let decodeGeneration = 0;
async function decodeFile() {
  const selected = file.value;
  if (!selected) return;
  const generation = ++decodeGeneration;
  const selectedEncoding = encoding.value;
  cancelPreview();
  content.value = '';
  fileDecoding.value = true;
  try {
    const decoded = new TextDecoder(selectedEncoding, { fatal: true }).decode(
      await selected.arrayBuffer(),
    );
    if (generation !== decodeGeneration) return;
    content.value = decoded;
    state.error = '';
  } catch {
    if (generation !== decodeGeneration) return;
    state.error = '文件解码失败，请选择正确的文件编码后重试';
  } finally {
    if (generation === decodeGeneration) fileDecoding.value = false;
  }
}
async function chooseFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0];
  if (!selected) return;
  cancelPreview();
  decodeGeneration++;
  fileDecoding.value = false;
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
}
async function previewImport() {
  if (fileDecoding.value) return;
  const snapshot = importInputSnapshot.value;
  const generation = importGeneration;
  const input = {
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
  };
  cancelPreview();
  await work(async () => {
    const result = await props.model.request('/api/to-doo/import/preview', 'POST', input);
    if (generation !== importGeneration || snapshot !== importInputSnapshot.value) return;
    preview.value = result;
    confirmedImport.value = { snapshot, requestId: crypto.randomUUID() };
  });
}
async function applyImport() {
  const confirmed = confirmedImport.value;
  if (!preview.value || !confirmed || confirmed.snapshot !== importInputSnapshot.value) return;
  const previewId = preview.value.id;
  await work(async () => {
    const result = await props.model.request('/api/to-doo/import/apply', 'POST', {
      previewId,
      requestId: confirmed.requestId,
    });
    // Only consume the submitted draft; later edits belong to the next import.
    if (confirmed.snapshot === importInputSnapshot.value) {
      cancelPreview();
      content.value = '';
      file.value = undefined;
      sourceName.value = '';
      if (importFileInput.value) importFileInput.value.value = '';
      importBaseline.value = importInputSnapshot.value;
    }
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
    await refreshConnections();
    state.notice = enabled ? '此主机桌面提醒已启用' : '此主机桌面提醒已停用';
  });
}
async function subscribe() {
  await work(async () => {
    if (!push.value) throw Error('请等待服务状态读取完成');
    await enableCurrentToDooPushDevice(props.model.request, push.value);
    await refreshConnections();
    state.notice = '当前设备已登记；请发送测试通知确认桌面提醒实际送达';
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
    const submitted = {
      name: feedName.value,
      listIds: [...feedLists.value],
      includeDescription: feedDescription.value,
    };
    const result = await props.model.request('/api/to-doo/calendars/feeds', 'POST', submitted);
    feed.value = new URL(result.url, location.origin).href;
    if (feedName.value === submitted.name) feedName.value = '';
    if (JSON.stringify(feedLists.value) === JSON.stringify(submitted.listIds)) feedLists.value = [];
    if (feedDescription.value === submitted.includeDescription) feedDescription.value = false;
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
    const submitted = { ...connection };
    await props.model.request('/api/to-doo/calendars/connect', 'POST', submitted);
    if (connection.name === submitted.name) connection.name = '';
    if (connection.url === submitted.url) connection.url = '';
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
defineExpose({
  hasUnsavedChanges: () => hasDraft.value,
  activeTab,
  submitPreferences,
  dirty,
});
</script>
<template>
  <div class="todo-settings">
    <datalist id="to-doo-timezones">
      <option v-for="zone in timeZoneSuggestions" :key="zone" :value="zone" />
    </datalist>
    <ATabs v-model:active-key="activeTab" class="todo-settings-tabs" aria-label="设置分类">
      <ATabPane key="preferences" tab="偏好" />
      <ATabPane key="connections" tab="提醒与连接" />
      <ATabPane key="data" tab="数据与恢复" />
      <ATabPane key="lists" tab="清单管理" />
    </ATabs>
    <AAlert
      v-if="
        activeTab !== 'data' &&
        (state.pendingOperations.length ||
          state.operationError ||
          state.operationPage?.nextCursor ||
          importJob)
      "
      type="info"
      :show-icon="true"
    >
      <template #message
        >{{ state.operationError ? '成果笔记恢复需要处理' : '有待继续的数据操作' }}
        <AButton type="link" @click="activeTab = 'data'">查看进度</AButton></template
      >
    </AAlert>
    <section v-show="activeTab === 'data'" class="todo-panel">
      <ToDooDisclosure
        :open="
          !!(
            state.pendingOperations.length ||
            state.operationLoading ||
            state.operationError ||
            state.operationPage?.nextCursor
          )
        "
      >
        <template #header>
          <span>成果笔记恢复</span>
          <span v-if="state.pendingOperations.length" class="todo-muted todo-small">
            · {{ state.pendingOperations.length }} 项待继续
          </span>
        </template>
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
          v-if="
            !state.operationLoading &&
            !state.operationError &&
            !state.pendingOperations.length &&
            !state.operationPage?.nextCursor
          "
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
      </ToDooDisclosure>
    </section>
    <section v-if="settings" v-show="activeTab === 'preferences'" class="todo-panel">
      <div class="todo-panel-header">
        <h2>日常偏好</h2>
        <span v-if="dirty" class="todo-warning todo-small">有未保存的更改</span>
      </div>
      <ToDooFormLayout
        ref="preferencesForm"
        @validity-change="invalidPreferences = $event"
        class="todo-pad"
        @submit="save"
        @invalid="revealInvalid"
        @input="validationError = ''"
      >
        <AAlert v-if="validationError" type="error" :message="validationError" show-icon />
        <section class="todo-form-section">
          <h3>日常使用</h3>
          <div class="todo-form-grid">
            <label
              >默认视图<ToDooSelect v-model="settings.defaultView">
                <option
                  v-for="(n, k) in {
                    overview: '目标总览',
                    tasks: '任务列表',
                    calendar: '日历',
                    board: '看板',
                    matrix: '四象限',
                    timeline: '时间线',
                    focus: '专注',
                    habits: '习惯',
                    anniversaries: '纪念日',
                    stats: '复盘',
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
                :max="1440"
            /></label>
          </div>
        </section>
        <ToDooDisclosure ref="dateRules">
          <template #header>
            <span>日期与提醒</span>
            <span v-if="settings.quietHours?.enabled" class="todo-muted todo-small">
              · 免打扰 {{ settings.quietHours.start }} — {{ settings.quietHours.end }} ·
              {{ settings.quietHours.timeZone }}
            </span>
          </template>
          <div class="todo-form-grid">
            <label
              >显示时区<AInput
                :value="settings.timeZone"
                @update:value="setDisplayTimeZone"
                list="to-doo-timezones"
                aria-label="显示时区"
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
            >
          </div>
          <ACheckbox
            :checked="settings.quietHours?.enabled"
            @change="quiet(($event.target as HTMLInputElement).checked)"
            class="todo-checkbox"
            >开启免打扰时段</ACheckbox
          >
          <p v-if="settings.quietHours?.enabled" class="todo-form-help">
            免打扰实际时区：{{ settings.quietHours.timeZone }}
          </p>
          <div v-if="settings.quietHours?.enabled" class="todo-form-grid">
            <label
              >开始<ToDooDateField
                v-model="settings.quietHours.start"
                type="time"
                aria-label="免打扰开始时间" /></label
            ><label
              >结束<ToDooDateField
                v-model="settings.quietHours.end"
                type="time"
                aria-label="免打扰结束时间"
            /></label>
          </div>
        </ToDooDisclosure>
        <ToDooDisclosure ref="taskRules">
          <template #header>
            <span>任务规则</span>
            <span
              v-if="settings.urgentHours !== 48 || settings.maxDepth !== 8"
              class="todo-muted todo-small"
            >
              · 紧急 {{ settings.urgentHours }} 小时 · 最多 {{ settings.maxDepth }} 层
            </span>
          </template>
          <p class="todo-form-help">调整紧急任务的判定范围与子任务层级。</p>
          <div class="todo-form-grid">
            <label
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
                :max="32"
            /></label>
          </div>
        </ToDooDisclosure>
        <ToDooDisclosure ref="focusRules">
          <template #header>
            <span>专注节奏</span>
            <span
              v-if="
                settings.focusMinutes !== 25 ||
                settings.shortBreakMinutes !== 5 ||
                settings.longBreakMinutes !== 15 ||
                settings.longBreakAfter !== 4
              "
              class="todo-muted todo-small"
            >
              · 专注 {{ settings.focusMinutes }} 分钟 · 休息 {{ settings.shortBreakMinutes }} /
              {{ settings.longBreakMinutes }} 分钟 · 每 {{ settings.longBreakAfter }} 次长休
            </span>
          </template>
          <p class="todo-form-help">选择休息时按已结束的番茄次数推荐时长，0 分钟表示跳过休息。</p>
          <div class="todo-form-grid">
            <label
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
        </ToDooDisclosure>
      </ToDooFormLayout>
    </section>
    <section v-show="activeTab === 'data'" class="todo-panel">
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
        <p class="todo-form-help">选择文件或粘贴内容，预览核对后再确认导入。</p>
        <div class="todo-actions">
          <AButton
            html-type="button"
            :disabled="busy || fileDecoding"
            @click="importFileInput?.click()"
            >选择导入文件</AButton
          >
          <span>{{ file?.name || '尚未选择文件' }}</span>
          <span v-if="fileDecoding" role="status">正在读取文件…</span>
        </div>
        <input
          ref="importFileInput"
          hidden
          type="file"
          accept=".json,.ics,.csv"
          aria-label="选择导入文件"
          @change="chooseFile"
        />
        <label v-if="!file"
          >或粘贴文件内容<ATextarea
            v-model:value="content"
            :rows="4"
            placeholder="粘贴 JSON、CSV 或 ICS 内容"
          ></ATextarea
        ></label>
        <ToDooDisclosure :open="!!file && !content">
          <template #header>
            <span>导入选项</span>
            <span class="todo-muted todo-small">
              · {{ format.toUpperCase() }} ·
              {{ { skip: '跳过重复', copy: '保留副本', update: '更新已有内容' }[mergeMode] }} ·
              {{ target === 'tasks' ? '转为任务' : '日历事件' }}
              <template v-if="encoding !== 'utf-8'"> · {{ encoding.toUpperCase() }}</template>
              <template v-if="importZone !== settings?.timeZone"> · {{ importZone }}</template>
              <template v-if="importList">
                · {{ state.snapshot?.lists.find((l) => l.id === importList)?.name || '指定清单' }}
              </template>
            </span>
          </template>
          <p class="todo-form-help">需要调整文件解析、重复处理或导入位置时再修改。</p>
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
        </ToDooDisclosure>
        <ToDooDisclosure v-if="format === 'csv'">
          <template #header
            ><span>CSV 列映射（留空自动识别）</span
            ><span v-if="Object.values(mapping).some(Boolean)" class="todo-muted todo-small">
              · 已指定 {{ Object.values(mapping).filter(Boolean).length }} 列
            </span></template
          >
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
        <AButton
          html-type="button"
          class="todo-button"
          :disabled="busy || fileDecoding || !content"
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
          <ul v-if="preview.warnings.length" aria-label="导入核对提示">
            <li v-for="(warning, i) in previewWarnings" :key="i" class="todo-warning">
              <strong v-if="warning.subject">{{ warning.subject }}：</strong>{{ warning.message }}
            </li>
          </ul>
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
          <ul aria-label="待导入条目">
            <li v-for="(item, i) in previewItems" :key="item.kind + ':' + (item.entity.id || i)">
              <strong>{{ importItemTitle(item) }}</strong>
              <p class="todo-muted todo-small">
                {{ importKindLabels[item.kind] || '记录' }} · {{ importItemDate(item) }} ·
                {{ importItemDestination(item) }}
              </p>
            </li>
          </ul>
          <div v-if="previewPageCount > 1" class="todo-actions" aria-label="导入预览分页">
            <AButton aria-label="上一页预览" :disabled="previewPage === 1" @click="previewPage--"
              >上一页</AButton
            >
            <span
              >第 {{ previewPage }} / {{ previewPageCount }} 页 · 共
              {{ preview.items.length }} 项</span
            >
            <AButton
              aria-label="下一页预览"
              :disabled="previewPage === previewPageCount"
              @click="previewPage++"
              >下一页</AButton
            >
          </div>
          <AButton
            html-type="button"
            class="todo-button todo-primary"
            :disabled="busy || !preview.items.length"
            :loading="busy"
            @click="applyImport"
            type="primary"
          >
            确认导入 {{ preview.items.length }} 项</AButton
          ><AButton html-type="button" class="todo-button" @click="cancelPreview" type="default"
            >取消预览</AButton
          >
        </div>
      </div>
    </section>
    <section v-if="importJob" v-show="activeTab === 'data'" class="todo-panel">
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
    <section v-show="activeTab === 'connections'" class="todo-panel">
      <div class="todo-panel-header">
        <h2>桌面提醒</h2>
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
        <p>
          <strong>{{ currentPushReason }}</strong>
        </p>
        <AAlert v-if="push?.lastError" type="error" :message="push.lastError" show-icon />
        <div class="todo-actions">
          <AButton
            html-type="button"
            class="todo-button todo-primary"
            :disabled="busy || !capability || !push || currentPushDevice?.permission === 'denied'"
            @click="subscribe"
            type="primary"
          >
            {{ currentPushDevice?.ready ? '更新当前设备订阅' : '启用当前设备桌面提醒' }}
          </AButton>
        </div>
        <ToDooDisclosure :open="!!push?.lastError">
          <template #header><span>主机与设备管理</span></template>
          <p class="todo-form-help">
            启用后，关闭网页仍可收到桌面提醒；网页打开时也会显示可操作的提醒卡片。
          </p>
          <p>当前浏览器通知权限：{{ pushPermission }}</p>
          <p class="todo-muted todo-small">{{ pushReason }}</p>
          <p class="todo-muted todo-small">
            需要允许本站通知和浏览器后台运行。浏览器被系统彻底终止、系统通知关闭或设备关机时，提醒可能延迟或无法送达。通知外观由操作系统决定。
          </p>
          <AButton
            html-type="button"
            class="todo-button"
            :disabled="busy || !push"
            @click="configurePush(!push?.enabled)"
            type="default"
            >{{ push?.enabled ? '停用此主机桌面提醒' : '启用此主机桌面提醒' }}</AButton
          >
          <label v-if="push" class="todo-checkbox"
            ><ACheckbox
              v-model:checked="push.showContent"
              @change="configurePush(push.enabled)"
            />在桌面提醒中显示任务内容</label
          >
          <div v-for="device in push?.devices" :key="device.id" class="todo-setting-row">
            <div>
              <h3>
                {{ device.deviceName
                }}{{ device.id === currentPushDevice?.deviceId ? '（当前设备）' : '' }}
              </h3>
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
        </ToDooDisclosure>
      </div>
    </section>
    <section v-show="activeTab === 'connections'" class="todo-panel">
      <div class="todo-panel-header"><h2>日历连接与订阅</h2></div>
      <ToDooDisclosure class="todo-connection-disclosure">
        <template #header><span>连接外部只读日历</span></template>
        <form class="todo-form todo-pad" @submit.prevent="connect">
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
      </ToDooDisclosure>
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
      <ToDooDisclosure class="todo-connection-disclosure" :open="!!feed">
        <template #header><span>创建 To Doo 只读订阅链接</span></template>
        <form class="todo-form todo-pad" @submit.prevent="createFeed">
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
          ><ACheckbox v-model:checked="feedDescription" class="todo-checkbox"
            >包含任务说明</ACheckbox
          >
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
      </ToDooDisclosure>
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
    <section v-show="activeTab === 'lists'" class="todo-panel">
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
          编辑分组
        </AButton>
      </div>
    </section>
  </div>
</template>
