<script setup lang="ts">
import ToDooDisclosure from './ToDooDisclosure.vue';
import { useToDooConfirm } from '../../to-doo-controls';
import ToDooDateField from './ToDooDateField.vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooInlineListCreate from './ToDooInlineListCreate.vue';
import ToDooTimeBlockFields from './ToDooTimeBlockFields.vue';
import { guardToDooTaskAction } from '../../to-doo-action-guard';
import { validateToDooTaskDraft, type ToDooDraftIssue } from '../../to-doo-draft-validation';

import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import {
  Button as AButton,
  Checkbox as ACheckbox,
  Input as AInput,
  InputNumber as AInputNumber,
  Modal as AModal,
  Dropdown as ADropdown,
  Menu as AMenu,
  MenuItem as AMenuItem,
  Select as ASelect,
  Tag as ATag,
  Textarea as ATextarea,
} from 'ant-design-vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooDateTime, ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import {
  toDooLocalDate,
  toDooDisplayTime,
  parseToDooQuickEntry,
  toDooStatusLabels,
  toDooPriorityLabels,
  toDooDependencies,
  toDooDeadlineOverdue,
  type ToDooWorkbench,
  type ToDooItem,
} from '../../to-doo-workbench';
import ToDooNotes from './ToDooNotes.vue';
import ToDooReminders from './ToDooReminders.vue';
import ToDooDateExceptions from './ToDooDateExceptions.vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooTaskMenu from './ToDooTaskMenu.vue';
import {
  toDooDateLabel,
  toDooDraftPayload,
  type ToDooTaskPlacement,
} from '../../to-doo-presentation';
const confirmAction = useToDooConfirm();
const props = defineProps<{
  model: ToDooWorkbench;
  tree: TreeEntry[];
  creating?: boolean;
  parentTaskId?: string;
  listId?: string;
  createdNoteId?: string;
  adjacentTasks?: { previous?: ToDooItem; next?: ToDooItem };
}>();
const emit = defineEmits<{
  close: [];
  step: [direction: 'previous' | 'next'];
  created: [id: string];
  select: [id: string, occurrence?: string];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  'open-note': [id: string];
  focus: [occurrenceId?: string];
  child: [id: string];
  'outcome-note': [];
  'list-created': [id: string];
  saved: [value: ToDooTaskPlacement];
  retry: [];
}>();
const state = props.model.state,
  form = computed(() => props.model.draft());
void props.model.ensureListCatalog();
const detailElement = ref<HTMLElement>();
const deadlineSummaryId = 'todo-deadline-summary-' + useId();
const deadlineFields = ref<HTMLElement>();
const editingDue = ref(false);
const createFormId = 'todo-create-task-' + useId();
const savingTask = ref(false);
const inlineListOpen = ref(false);
const propertyFields = ref<HTMLElement>();
type DetailPanel = 'due' | 'priority' | 'list' | 'plan' | 'repeat' | 'reminders' | 'resources' | 'classification' | 'attachments' | 'results' | 'properties' | 'records' | 'history';
const detailPanel = ref<DetailPanel>();
const propertyOpen = ref(false);
const panelLabels: Record<DetailPanel, string> = {
  due: '截止日期', priority: '优先级', list: '所属清单', plan: '时间安排', repeat: '重复规则', reminders: '任务提醒', resources: '关联资料', classification: '四象限归类',
  attachments: '任务附件', results: '完成标准与成果', properties: '其他属性', records: '推进记录', history: '操作历史',
};
const descriptionOpen = ref(false);
const descriptionLabel = ref<HTMLLabelElement>();
async function editDescription() {
  descriptionOpen.value = true;
  await nextTick();
  descriptionLabel.value?.querySelector('textarea')?.focus();
}
const showChildren = ref(false);
let propertyBaseline: { key: string; task: Record<string, any>; occurrence: Record<string, any>; blocks?: any[]; scope: 'all' | 'future' } | undefined;
const propertyTaskFields: Partial<Record<DetailPanel, string[]>> = {
  priority: ['priority'], list: ['listId', 'sectionId'], repeat: ['recurrence', 'inheritRecurrence'],
  reminders: ['reminders'], resources: ['noteRefs'], classification: ['importance', 'urgentOverride'],
  results: ['criteria'], properties: ['sectionId', 'estimateMinutes', 'tagIds', 'dependencies', 'source'],
};
const propertyOccurrenceFields: Partial<Record<DetailPanel, string[]>> = { due: ['due'], properties: ['blockedReason', 'titleOverride'] };
const cloneProperty = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function captureProperty(section: DetailPanel) {
  const draft = form.value;
  if (!draft) return;
  const pick = (value: any, fields: string[]) => Object.fromEntries(fields.map(field => [field, cloneProperty(value?.[field])]));
  propertyBaseline = { key: state.selectedTaskId + '@' + state.selectedOccurrenceId,
    task: pick(draft.task, propertyTaskFields[section] || []),
    occurrence: pick(draft.occurrence, propertyOccurrenceFields[section] || []),
    ...(section === 'plan' ? { blocks: cloneProperty(draft.blocks) } : {}), scope: scope.value };
}
function cancelProperty() {
  const draft = form.value, baseline = propertyBaseline;
  if (draft && baseline?.key === state.selectedTaskId + '@' + state.selectedOccurrenceId) {
    Object.assign(draft.task, cloneProperty(baseline.task));
    if (draft.occurrence) Object.assign(draft.occurrence, cloneProperty(baseline.occurrence));
    if (baseline.blocks) draft.blocks = cloneProperty(baseline.blocks);
    scope.value = baseline.scope;
  }
  detailPanel.value = undefined;
  propertyOpen.value = false;
  propertyBaseline = undefined;
  validationError.value = '';
}
function completeProperty() {
  if (!validateDetail(true)) return;
  propertyOpen.value = false;
  propertyBaseline = undefined;
}
function closeProperty() { propertyOpen.value = false; }
function addPlan() {
  const draft = form.value;
  if (!draft?.occurrence || state.busy) return;
  const now = new Date().toISOString();
  draft.blocks.push({ id: 'plan-' + crypto.randomUUID(), revision: '', createdAt: now, updatedAt: now,
    deletedAt: null, occurrenceId: draft.occurrence.id, title: '',
    start: { date: today.value, time: null, timeZone: zone.value },
    durationMinutes: state.snapshot?.settings.defaultDurationMinutes || 30, allDay: false, dateEndExclusive: null });
}
function removePlan(id: string) {
  const draft = form.value, block = draft?.blocks.find(value => value.id === id);
  if (!block || state.busy) return;
  if (block.revision) {
    const baseline = propertyBaseline?.key === state.selectedTaskId + '@' + state.selectedOccurrenceId
      ? propertyBaseline.blocks?.find(value => value.id === id) : undefined;
    const saved = [baseline, state.snapshot?.timeBlocks.find(value => value.id === id)].find(value =>
      value && !validateToDooTaskDraft({ task: draft!.task, occurrence: draft!.occurrence, blocks: [value] }, { panel: 'plan' }).length,
    );
    // A removed plan still needs a valid tombstone for saving and recovery.
    if (saved) Object.assign(block, cloneProperty(saved));
    block.deletedAt = new Date().toISOString();
  }
  else draft!.blocks = draft!.blocks.filter(value => value.id !== id);
}
const currentConflicts = computed(() => state.draftConflicts.filter(entry => entry.draftKey === state.selectedTaskId + '@' + state.selectedOccurrenceId));
function conflictValue(value: unknown) {
  if (value == null || value === '') return '（空）';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
const repeatDetails = ref<InstanceType<typeof ToDooDisclosure>>();
const advancedRepeatDetails = ref<InstanceType<typeof ToDooDisclosure>>();
const moreOptions = ref<InstanceType<typeof ToDooDisclosure>>();
const linkedResources = ref<InstanceType<typeof ToDooDisclosure>>();
const repeatFields = ref<HTMLElement>();
const reminderFields = ref<HTMLElement>();
const resourceFields = ref<HTMLElement>();
const menuItem = computed<ToDooItem | null>(() =>
  form.value
    ? {
        key: form.value.task.id + '@' + (form.value.occurrence?.id ?? ''),
        task: form.value.task,
        occurrence: form.value.occurrence,
        blocks: form.value.blocks,
        title: form.value.task.title,
        status: form.value.occurrence?.status ?? 'unavailable',
        list: state.snapshot?.lists.find((list) => list.id === form.value?.task.listId),
        date: form.value.occurrence?.due?.date ?? '',
        depth: 0,
      }
    : null,
);
const repeatSummary = computed(() =>
  form.value?.task.parentTaskId && form.value.task.inheritRecurrence
    ? '跟随父任务'
    : form.value?.task.recurrence
      ? {
          daily: '每天',
          weekly: '每周',
          monthly: '每月',
          yearly: '每年',
          after_completion: '完成后重复',
        }[form.value.task.recurrence.frequency]
      : '不重复',
);
async function revealDetail(section: DetailPanel) {
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  if (detailPanel.value && detailPanel.value !== section && (
    propertyFields.value?.querySelector('input:invalid, textarea:invalid, [aria-invalid="true"]') ||
    validateToDooTaskDraft(form.value, { panel: detailPanel.value as any, allowEmptyTitle: true }).length
  )) {
    propertyOpen.value = true;
    validateDetail(true);
    return;
  }
  if (detailPanel.value !== section || !propertyBaseline) captureProperty(section);
  detailPanel.value = section;
  propertyOpen.value = true;
  if (section === 'due') editingDue.value = true;
  await nextTick();
  if (!currentDetail(taskId, occurrenceId)) return;
  const firstInput = propertyFields.value?.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
  (firstInput || propertyFields.value?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]'))?.focus?.({ preventScroll: true });
}
const validationError = ref('');
const releaseDraftValidation = props.creating ? () => {} : props.model.registerTaskDraftValidator(
  state.selectedTaskId + '@' + state.selectedOccurrenceId, () => validateDetail(),
);
onBeforeUnmount(releaseDraftValidation);
function validateDetail(propertyOnly = false) {
  const invalid = (!propertyOnly && detailElement.value?.querySelector<HTMLInputElement>(
    'input:invalid, textarea:invalid, [aria-invalid="true"]',
  )) || propertyFields.value?.querySelector<HTMLInputElement>('input:invalid, textarea:invalid, [aria-invalid="true"]');
  if (invalid) {
    if (propertyFields.value?.contains(invalid)) propertyOpen.value = true;
    validationError.value = '请检查日期、时间或其他输入后再保存';
    if (deadlineFields.value?.contains(invalid)) editingDue.value = true;
    void nextTick(async () => {
      if (detailPanel.value === 'repeat' && propertyFields.value?.contains(invalid)) {
        advancedRepeatDetails.value?.expand({ immediate: true });
        await nextTick();
      }
      if (!detailAlive || !invalid.isConnected) return;
      invalid.focus();
      invalid.reportValidity?.();
    });
    return false;
  }
  const issue = props.creating ? undefined : validateToDooTaskDraft(form.value, {
    ...(propertyOnly ? { panel: detailPanel.value as any } : {}),
  })[0];
  if (issue) {
    validationError.value = issue.message;
    if (issue.panel !== 'title' && issue.panel !== 'description') {
      // Reopening validation must preserve the baseline captured when the user began this panel.
      if (detailPanel.value !== issue.panel) {
        captureProperty(issue.panel);
        detailPanel.value = issue.panel;
      }
      propertyOpen.value = true;
    } else if (issue.panel === 'description') descriptionOpen.value = true;
    void nextTick(async () => {
      if (!detailAlive) return;
      if (issue.panel === 'repeat') {
        advancedRepeatDetails.value?.expand({ immediate: true });
        await nextTick();
      }
      focusDraftIssue(issue);
    });
    return false;
  }
  validationError.value = '';
  return true;
}
function focusDraftIssue(issue: ToDooDraftIssue) {
  let root = issue.panel === 'title' || issue.panel === 'description' ? detailElement.value : propertyFields.value;
  if (issue.kind === 'timeBlock') {
    const index = form.value?.blocks.filter(block => !block.deletedAt).findIndex(block => block.id === issue.entityId) ?? -1;
    if (index >= 0) root = root?.querySelectorAll<HTMLElement>('.todo-plan-editor')[index] || root;
  }
  const candidates = Array.from(root?.querySelectorAll<HTMLInputElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])') || []);
  const matches = (input: HTMLInputElement) => (input.getAttribute('aria-label') || '').includes(issue.label) || (input.closest('label')?.textContent || '').includes(issue.label);
  const input = candidates.find(matches) || candidates[0];
  input?.focus?.({ preventScroll: true });
  input?.reportValidity?.();
}
async function save() {
  if (state.busy || savingTask.value || inlineListOpen.value || !validateDetail()) return;
  if (!form.value?.task.title.trim()) {
    validationError.value = '请填写任务标题';
    return;
  }
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  savingTask.value = true;
  try {
    const result = await props.model.saveTask(scope.value);
    if (result && currentDetail(taskId, occurrenceId) && !props.model.dirty()) {
      editingDue.value = false;
      const saved = form.value!;
      emit('saved', {
        taskId,
        title: saved.task.title,
        listId: saved.task.listId,
        planDates: saved.blocks
          .filter((block) => !block.deletedAt)
          .map((block) => toDooDisplayTime(block.start, zone.value).date),
      });
    }
    return result;
  } finally {
    savingTask.value = false;
  }
}
async function editDeadline() {
  editingDue.value = !editingDue.value;
  if (editingDue.value) {
    await nextTick();
    if (detailAlive) deadlineFields.value?.querySelector<HTMLInputElement>('input')?.focus();
  }
}
function shortcut(event: KeyboardEvent) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  if (propertyOpen.value) completeProperty();
  else void (props.creating ? create() : save());
}
function changeList(listId: string | null) {
  if (!form.value) return;
  form.value.task.listId = listId;
  form.value.task.sectionId = null;
}
function useCreatedList(id: string) {
  if (props.creating) {
    local.listId = id;
    local.sectionId = null;
  } else changeList(id);
  emit('list-created', id);
}
let detailAlive = true;
onBeforeUnmount(() => {
  detailAlive = false;
});
function currentDetail(taskId: string, occurrenceId: string) {
  return (
    detailAlive && state.selectedTaskId === taskId && state.selectedOccurrenceId === occurrenceId
  );
}
const priorityOptions = ['high', 'normal', 'low', 'none'].map((value) => ({
  value,
  label:
    toDooPriorityLabels[value as keyof typeof toDooPriorityLabels] +
    (value === 'none' ? '' : '优先级'),
}));
function priorityPopupContainer(trigger: HTMLElement): HTMLElement {
  return trigger.closest<HTMLElement>('.to-doo-workspace') || trigger.parentElement || trigger;
}
const local = props.model.newTaskDraft(props.parentTaskId, props.listId);
const quick = computed(() =>
  parseToDooQuickEntry(
    local.title,
    toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
    state.snapshot?.tags.filter((t) => !t.deletedAt) || [],
  ),
);
function adoptQuick() {
  const value = quick.value;
  local.title = value.title;
  if (value.date) {
    if (value.due) {
      local.dueDate = value.date;
      local.dueTime = value.time || '';
    } else {
      local.planDate = value.date;
      local.planTime = value.time || '';
    }
  } else if (value.time) {
    local.planDate = toDooLocalDate(new Date(), zone.value);
    local.planTime = value.time;
  }
  local.tagIds = [...new Set([...local.tagIds, ...value.tagIds])];
  if (value.frequency) {
    local.frequency = value.frequency;
    local.weekdays = value.weekdays;
  }
  local.literalTitle = true;
}
const scope = computed<'all' | 'future'>({
    get: () => props.model.getDraftRecurrenceScope(),
    set: value => props.model.setDraftRecurrenceScope(value),
  }),
  previewAsset = ref('');
watch(
  () => [state.selectedTaskId, state.selectedOccurrenceId],
  () => {
    previewAsset.value = '';
    validationError.value = '';
    editingDue.value = false;
    detailPanel.value = undefined;
    propertyOpen.value = false;
    descriptionOpen.value = false;
    showChildren.value = false;
  },
);
const zone = computed(() => state.snapshot?.settings.timeZone || 'UTC');
const today = computed(() => toDooLocalDate(new Date(), zone.value));
function displaySchedule(value: ToDooDateTime) {
  const shown = toDooDisplayTime(value, zone.value);
  return toDooDateLabel(shown.date, today.value) + (shown.time ? ' ' + shown.time : '');
}
const scheduledBlocks = computed(() => form.value?.blocks.filter(value => !value.deletedAt) || []);
const planSummary = computed(() => {
  const blocks = scheduledBlocks.value;
  if (!blocks.length) return '添加计划';
  return displaySchedule(blocks[0].start) + (blocks.length > 1 ? ' 等' + blocks.length + '段' : '');
});
const deadlineSummary = computed(() =>
  form.value?.occurrence?.due ? displaySchedule(form.value.occurrence.due) : '设置截止日期',
);
const deadlineOverdue = computed(() =>
  toDooDeadlineOverdue(
    form.value?.occurrence?.due,
    form.value?.occurrence?.status || 'unavailable',
    today.value,
  ),
);
const currentListName = computed(() =>
  form.value?.task.listId
    ? state.snapshot?.lists.find((list) => list.id === form.value?.task.listId)?.name || '所属清单'
    : '收集箱',
);
const occurrences = computed(
  () =>
    state.snapshot?.occurrences.filter((o) => !o.deletedAt && o.taskId === state.selectedTaskId) ||
    [],
);
const children = computed(
  () =>
    state.snapshot?.tasks.filter((t) => !t.deletedAt && t.parentTaskId === state.selectedTaskId) ||
    [],
);
const outcomes = computed(
  () =>
    state.snapshot?.outcomes.filter(
      (o) => !o.deletedAt && o.occurrenceId === form.value?.occurrence?.id,
    ) || [],
);
const records = computed(
  () =>
    state.snapshot?.records.filter((o) => !o.deletedAt && o.taskId === state.selectedTaskId) || [],
);
const history = computed(
  () =>
    state.snapshot?.activities
      .filter(
        (a) => a.entityId === state.selectedTaskId || a.occurrenceId === form.value?.occurrence?.id,
      )
      .sort((a, b) => b.at.localeCompare(a.at)) || [],
);
const detailCollectionLabels: Record<string, string> = {
  task: '子任务',
  occurrence: '重复任务记录',
  timeBlock: '时间安排',
  activity: '操作历史',
  record: '推进记录',
  outcome: '成果',
  exception: '例外',
  focusSession: '专注记录',
};
const dependencies = computed({
  get: () => form.value?.task.dependencies.map((d) => d.taskId) || [],
  set: (ids: string[]) => {
    if (form.value)
      form.value.task.dependencies = toDooDependencies(form.value.task.dependencies, ids);
  },
});
function due(value: string, field: 'date' | 'time') {
  if (!form.value?.occurrence) return;
  if (!value && field === 'date') {
    form.value.occurrence.due = null;
    return;
  }
  const current = form.value.occurrence.due || {
    date: toDooLocalDate(new Date(), zone.value),
    time: null,
    timeZone: zone.value,
  };
  form.value.occurrence.due = { ...current, [field]: value || null };
}
function repeat(frequency: string) {
  if (!form.value) return;
  form.value.task.recurrence = frequency
    ? {
        id: crypto.randomUUID(),
        frequency: frequency as any,
        interval: 1,
        anchorDate: form.value.occurrence?.scheduledDate || toDooLocalDate(new Date(), zone.value),
        time: null,
        timeZone: zone.value,
        weekdays: [],
        until: null,
        count: null,
        shortMonth: 'last_day',
        excludedDates: [],
        additionalDates: [],
        endedAt: null,
        completionUnit: 'day',
      }
    : null;
}
function monthly(mode: string) {
  const rule = form.value?.task.recurrence;
  if (!rule) return;
  if (mode === 'weekday') {
    delete rule.monthDay;
    rule.weekOrdinal = 1;
    rule.weekdays = [1];
  } else {
    delete rule.weekOrdinal;
    rule.monthDay = Number(rule.anchorDate.slice(8));
  }
}
function addReminder() {
  form.value?.task.reminders.push({
    id: crypto.randomUUID(),
    anchor: 'due',
    offsetMinutes: -30,
    allDayTime: '09:00',
  });
}
async function create() {
  if (state.busy || inlineListOpen.value || !validateDetail()) return;
  if (!local.title.trim()) {
    validationError.value = '请填写任务标题';
    return;
  }
  const result = await props.model.createTask(toDooDraftPayload(local, zone.value));
  if (result) emit('created', state.selectedTaskId);
}
async function status(value: string) {
  if (!form.value?.occurrence) return;
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  const targetOccurrence = form.value.occurrence.id;
  if (!(await guardToDooTaskAction(props.model, [taskId], confirmAction, {
    current: () => currentDetail(taskId, occurrenceId), save,
  }))) return;
  const descendants = value === 'done' ? await props.model.statusChildCount(taskId) : 0;
  if (descendants === null || !currentDetail(taskId, occurrenceId)) return;
  let cascade = false;
  if (value === 'done' && descendants) {
    if (
      !(await confirmAction(`这个任务有 ${descendants} 个子任务。是否同时完成其未完成的子任务？`))
    )
      return;
    cascade = true;
  }
  if (!currentDetail(taskId, occurrenceId)) return;
  await props.model.setStatus(targetOccurrence, value as any, cascade);
  if (currentDetail(taskId, occurrenceId) && !props.model.dirty())
    props.model.selectTask(taskId, occurrenceId);
}
async function materializeToday() {
  if (!form.value || state.busy || state.pendingMutation) return;
  const taskId = state.selectedTaskId, occurrenceId = state.selectedOccurrenceId;
  if (!(await guardToDooTaskAction(props.model, [taskId], confirmAction, {
    current: () => currentDetail(taskId, occurrenceId), save,
  }))) return;
  const today = toDooLocalDate(new Date(), zone.value);
  const result = await props.model.execute({
    action: 'materialize_occurrences', payload: { taskId, from: today, to: today },
  });
  if (result && currentDetail(taskId, occurrenceId)) props.model.selectTask(taskId);
}
async function makeOutcome() {
  const taskId = state.selectedTaskId, occurrenceId = state.selectedOccurrenceId;
  if (!(await guardToDooTaskAction(props.model, [taskId], confirmAction, {
    current: () => currentDetail(taskId, occurrenceId), save,
  }))) return;
  emit('edit', 'outcome', undefined, {
    occurrenceId: form.value?.occurrence?.id || null,
    listId: form.value?.task.listId || null,
    criteriaResults: (form.value?.task.criteria || '')
      .split('\n')
      .map((s) => s.replace(/^[-*\s\[\]x]+/, '').trim())
      .filter(Boolean)
      .map((label) => ({ label, passed: false })),
  });
}
function assetUrl(hash: string, preview = false) {
  return (
    '/api/to-doo/tasks/' +
    encodeURIComponent(state.selectedTaskId) +
    '/assets/' +
    encodeURIComponent(hash) +
    (preview ? '?preview=true' : '')
  );
}
async function uploadAsset(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  if (!file || !form.value) return;
  if (props.model.dirty()) {
    state.error = '请先保存任务内容，再上传附件';
    input.value = '';
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    state.error = '单个附件不能超过 10 MB';
    input.value = '';
    return;
  }
  const taskId = form.value.task.id, occurrenceId = state.selectedOccurrenceId,
    datasetId = state.snapshot?.datasetId;
  const receiptContext = props.model.captureCommandResultContext();
  const data = new FormData();
  data.set('file', file);
  data.set('requestId', crypto.randomUUID());
  data.set('expectedRevision', form.value.task.revision);
  state.busy = true;
  state.error = '';
  state.notice = '';
  try {
    const result = await props.model.request(
      '/api/to-doo/tasks/' + encodeURIComponent(taskId) + '/assets',
      'POST',
      data,
    );
    if (!(await props.model.acceptCommandResult(result, receiptContext))) return;
    if (currentDetail(taskId, occurrenceId)) state.notice = '附件已上传';
  } catch (e) {
    if (state.snapshot?.datasetId === datasetId) state.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (state.snapshot?.datasetId === datasetId) state.busy = false;
    input.value = '';
  }
}
async function removeAsset(hash: string) {
  if (!form.value || props.model.dirty()) {
    state.error = '请先保存任务内容，再调整附件关联';
    return;
  }
  const taskId = form.value.task.id, occurrenceId = state.selectedOccurrenceId,
    datasetId = state.snapshot?.datasetId;
  const receiptContext = props.model.captureCommandResultContext();
  state.busy = true;
  state.error = '';
  state.notice = '';
  try {
    const result = await props.model.request(assetUrl(hash), 'DELETE', {
      requestId: crypto.randomUUID(),
      expectedRevision: form.value.task.revision,
    });
    if (!(await props.model.acceptCommandResult(result, receiptContext))) return;
    if (currentDetail(taskId, occurrenceId)) {
      if (previewAsset.value === hash) previewAsset.value = '';
      state.notice = '附件关联已移除';
    }
  } catch (e) {
    if (state.snapshot?.datasetId === datasetId) state.error = e instanceof Error ? e.message : String(e);
  } finally {
    if (state.snapshot?.datasetId === datasetId) state.busy = false;
  }
}
async function discardNew() {
  const parent = props.parentTaskId,
    list = props.listId;
  const hasContent = !!(local.title.trim() || local.description.trim() || local.criteria.trim());
  if (hasContent && !(await confirmAction('取消创建并清除已填写的内容？'))) return;
  if (!detailAlive || !props.creating || props.parentTaskId !== parent || props.listId !== list)
    return;
  props.model.clearNewTaskDraft(parent, list);
  emit('close');
}
function close() {
  emit('close');
}
async function discardConflict() {
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  if (!(await confirmAction('放弃这份本地输入，改用服务端当前内容？'))) return;
  if (!currentDetail(taskId, occurrenceId)) return;
  if (!(await props.model.ensureTask(taskId))) return;
  if (!currentDetail(taskId, occurrenceId)) return;
  props.model.discardDraft();
  state.conflict = false;
  state.error = '';
}
async function remove() {
  if (!form.value) return;
  const taskId = state.selectedTaskId,
    occurrenceId = state.selectedOccurrenceId;
  if (!(await guardToDooTaskAction(props.model, [taskId], confirmAction, {
    current: () => currentDetail(taskId, occurrenceId), save,
  }))) return;
  const target = { ...form.value!.task };
  if (!(await confirmAction('将任务及其子任务移入回收站？', { danger: true }))) return;
  if (!currentDetail(taskId, occurrenceId)) return;
  const r = await props.model.removeEntity('task', target, false, true);
  if (r && detailAlive && (!state.selectedTaskId || state.selectedTaskId === taskId)) emit('close');
}
defineExpose({
  validate: validateDetail,
  openProperty: revealDetail,
  hasInvalidInput: () => !!(detailElement.value?.querySelector('input:invalid:not([data-todo-required-title]), textarea:invalid, [aria-invalid="true"]') || propertyFields.value?.querySelector('input:invalid, textarea:invalid, [aria-invalid="true"]') || (!props.creating && validateToDooTaskDraft(form.value, { allowEmptyTitle: true }).length)),
  hasUnsavedChanges: () =>
    (props.creating ? !!local.title || !!local.description : props.model.dirty()) ||
    !!detailElement.value?.querySelector('[aria-invalid="true"]'),
});
</script>
<template>
  <aside
    ref="detailElement"
    class="todo-detail"
    :class="{ 'todo-document-detail': !creating }"
    tabindex="-1"
    aria-label="任务详情"
    @keydown="shortcut"
  >
    <header class="todo-between todo-reader-header">
      <AButton html-type="button" class="todo-icon-button" aria-label="关闭任务详情"
        title="关闭任务详情 (Esc)" type="text" @click="close"><ToDooIcon name="close" :size="16" /></AButton>
      <span class="todo-reader-heading">{{ creating ? '新建任务' : '任务详情' }}</span
      ><span
        v-if="!creating"
        class="todo-small todo-reader-save-state"
        :class="model.dirty() ? 'todo-warning' : 'todo-muted'"
      >
        <ToDooIcon v-if="!savingTask && !model.dirty()" name="check" :size="14" />
        {{ savingTask ? '保存中…' : model.dirty() ? '未保存的更改' : '已保存' }}
      </span>
      <div v-if="adjacentTasks" class="todo-reader-navigation" role="group" aria-label="按列表顺序浏览">
        <AButton type="text" class="todo-icon-button" data-step="previous" aria-label="上一个任务"
          :title="adjacentTasks.previous ? '上一个：' + adjacentTasks.previous.title : '已是第一项'"
          :disabled="state.busy || !!state.pendingMutation || !adjacentTasks.previous" @click="emit('step', 'previous')">
          <ToDooIcon name="back" :size="16" />
        </AButton>
        <AButton type="text" class="todo-icon-button" data-step="next" aria-label="下一个任务"
          :title="adjacentTasks.next ? '下一个：' + adjacentTasks.next.title : '已是最后一项'"
          :disabled="state.busy || !!state.pendingMutation || !adjacentTasks.next" @click="emit('step', 'next')">
          <ToDooIcon name="chevron" :size="16" />
        </AButton>
      </div>
    </header>
    <p v-if="validationError" class="todo-detail-validation todo-danger" role="alert">
      {{ validationError }}
    </p>
    <p v-if="state.error && !state.conflict" class="todo-detail-validation todo-danger" role="alert">{{ state.error }}</p>
    <div v-if="state.pendingMutation" class="todo-detail-validation todo-warning" role="alert">
      <span>上次提交的结果待核对，修改仍保留。</span><AButton type="link" :disabled="state.busy" @click="emit('retry')">核对原操作</AButton>
    </div>
    <section v-if="!creating && state.conflict" class="todo-conflict-panel todo-alert" role="alert" aria-label="比较任务更新">
      <strong>这份任务有更新，本地输入仍保留</strong>
      <p>{{ state.error || '先载入最新版本，比较后再保存。' }}</p>
      <div class="todo-actions">
        <AButton :disabled="state.busy || !!state.pendingMutation" @click="model.rebaseDraft()">载入最新并比较</AButton>
        <AButton type="text" danger :disabled="state.busy" @click="discardConflict">放弃本地修改</AButton>
      </div>
      <div v-for="entry in currentConflicts" :key="entry.id" class="todo-conflict-field">
        <strong>{{ entry.label }}</strong>
        <div class="todo-conflict-values">
          <section><span>我的输入</span><pre>{{ conflictValue(entry.local) }}</pre><AButton @click="model.resolveDraftConflict(entry.id, 'local')">保留我的输入</AButton></section>
          <section><span>最新内容</span><pre>{{ conflictValue(entry.remote) }}</pre><AButton @click="model.resolveDraftConflict(entry.id, 'remote')">使用最新内容</AButton></section>
        </div>
      </div>
    </section>
    <form
      v-if="creating"
      :id="createFormId"
      class="todo-form todo-detail-body"
      @submit.prevent="create"
    >
      <fieldset class="todo-create-fields" :disabled="state.busy">
        <label
          >任务标题<AInput
            v-model:value="local.title"
            data-todo-required-title
            @update:value="local.literalTitle = false"
            required
            :maxlength="256"
            autofocus
            placeholder="要做什么？"
        /></label>
        <div v-if="quick.recognized && !local.literalTitle" class="todo-quick-preview">
          <p>
            识别到 {{ quick.date || '' }} {{ quick.time || '' }}
            {{
              quick.frequency === 'daily'
                ? '每天重复'
                : quick.frequency === 'weekly'
                  ? '每周重复'
                  : ''
            }}{{ quick.tagIds.length ? ' · ' + quick.tagIds.length + ' 个标签' : '' }}
          </p>
          <AButton html-type="button" class="todo-link" @click="adoptQuick" type="link"
            >采用识别结果</AButton
          >
        </div>
        <label>任务说明<ATextarea v-model:value="local.description" :rows="3"></ATextarea></label
        ><label
          >清单<ToDooSelect
            aria-label="目标或清单"
            v-model="local.listId"
            :disabled="!!parentTaskId"
            @change="local.sectionId = null"
          >
            <option :value="null">收集箱</option>
            <option v-for="l in model.taskLists()" :key="l.id" :value="l.id">
              {{ l.name }}
            </option>
          </ToDooSelect></label
        >
        <ToDooInlineListCreate
          v-if="!parentTaskId"
          :model="model"
          @created="useCreatedList"
          @open-change="inlineListOpen = $event"
        />
        <div class="todo-form-grid">
          <label>计划日期<ToDooDateField v-model="local.planDate" type="date" /></label>
          <label
            >优先级<ToDooSelect v-model="local.priority" aria-label="优先级"
              ><option v-for="(label, value) in toDooPriorityLabels" :key="value" :value="value">
                {{ label }}{{ value === 'none' ? '' : '优先级' }}
              </option></ToDooSelect
            ></label
          >
        </div>
        <ToDooDisclosure class="todo-disclosure" :open="!!local.dueDate || !!local.criteria">
          <template #header><span>更多选项</span></template>
          <div class="todo-disclosure-content todo-form">
            <label
              >初始状态<ToDooSelect v-model="local.initialStatus" aria-label="初始状态"
                ><option v-for="(label, value) in toDooStatusLabels" :key="value" :value="value">
                  {{ label }}
                </option></ToDooSelect
              ></label
            >
            <label
              v-if="
                local.listId &&
                state.snapshot?.sections.some(
                  (section) => !section.deletedAt && section.listId === local.listId,
                )
              "
              >分组<ToDooSelect v-model="local.sectionId" aria-label="分组"
                ><option :value="null">{{ parentTaskId ? '跟随父任务分组' : '未分组' }}</option>
                <option
                  v-for="section in state.snapshot?.sections.filter(
                    (section) => !section.deletedAt && section.listId === local.listId,
                  )"
                  :key="section.id"
                  :value="section.id"
                >
                  {{ section.name }}
                </option></ToDooSelect
              ></label
            >
            <div class="todo-form-grid">
              <label>计划时间<ToDooDateField v-model="local.planTime" type="time" /></label>
              <label>截止日期<ToDooDateField v-model="local.dueDate" type="date" /></label>
              <label>截止时间<ToDooDateField v-model="local.dueTime" type="time" /></label>
              <label
                >预计分钟<AInputNumber
                  aria-label="预计分钟"
                  v-model:value="local.estimate"
                  :min="0"
              /></label>
            </div>
            <label
              >重复<ToDooSelect v-model="local.frequency" aria-label="重复"
                ><option :value="null">不重复</option>
                <option value="daily">每天</option>
                <option value="weekly">每周</option></ToDooSelect
              ></label
            >
            <div v-if="local.frequency === 'weekly'" class="todo-actions" aria-label="重复星期">
              <label v-for="(day, index) in ['日', '一', '二', '三', '四', '五', '六']" :key="index"
                ><ACheckbox
                  :checked="local.weekdays.includes(index)"
                  @change="
                    local.weekdays = local.weekdays.includes(index)
                      ? local.weekdays.filter((value) => value !== index)
                      : [...local.weekdays, index]
                  "
                />周{{ day }}</label
              >
            </div>
            <ToDooReminders v-model="local.reminders" :date-based="false" />
            <label>完成标准<ATextarea v-model:value="local.criteria" :rows="3"></ATextarea></label>
          </div>
        </ToDooDisclosure>
      </fieldset>
    </form>
    <div v-else-if="form" class="todo-detail-body todo-form">
      <fieldset class="todo-create-fields todo-document-fields" :disabled="state.busy">
        <div class="todo-document-intro">
          <div class="todo-document-title-row">
            <AButton
              html-type="button"
              type="text"
              class="todo-detail-complete"
              :class="['todo-priority-' + form.task.priority, { 'is-complete': form.occurrence?.status === 'done' }]"
              :aria-label="form.occurrence?.status === 'done' ? '重新打开' : '标记完成'"
              :aria-pressed="form.occurrence?.status === 'done'"
              :disabled="state.busy || !form.occurrence"
              @click="status(form.occurrence?.status === 'done' ? 'todo' : 'done')"
            >
              <span aria-hidden="true" class="todo-check-indicator">{{ form.occurrence?.status === 'done' ? '✓' : '' }}</span>
              <span class="todo-accessible-label">{{ form.occurrence?.status === 'done' ? '重新打开' : '标记完成' }}</span>
            </AButton>
            <label class="todo-title-input">
              <span class="todo-accessible-label">任务标题</span>
              <ATextarea
                aria-label="任务标题"
                v-model:value="form.task.title"
                :maxlength="256"
                :auto-size="{ minRows: 1 }"
                :rows="1"
                @keydown.enter="
                  !$event.isComposing && !$event.ctrlKey && !$event.metaKey && $event.preventDefault()
                "
              />
            </label>
          </div>
          <AButton v-if="!form.task.description && !descriptionOpen" type="text" class="todo-add-property" @click="editDescription">＋ 添加说明</AButton>
          <label v-else ref="descriptionLabel" class="todo-document-description">
            <span class="todo-accessible-label">任务说明</span>
            <ATextarea aria-label="任务说明" v-model:value="form.task.description"
              :auto-size="{ minRows: 1, maxRows: 12 }" :rows="1" placeholder="添加说明，或记下下一步…" />
          </label>
        </div>
        <label v-if="form.task.recurrence || occurrences.length > 1"
          >重复任务记录<ToDooSelect
            aria-label="重复任务记录"
            :value="state.selectedOccurrenceId"
            @change="emit('select', form.task.id, $event)"
            ><option v-for="o in occurrences" :key="o.id" :value="o.id">
              {{ o.scheduledDate || o.due?.date || '普通任务' }} · {{ toDooStatusLabels[o.status] }}
            </option></ToDooSelect
          ></label
        >
        <AButton
          v-if="!form.occurrence"
          html-type="button"
          class="todo-button"
          :disabled="state.busy || !!state.pendingMutation"
          @click="materializeToday"
          type="default"
          >添加本次任务记录</AButton
        >
        <div class="todo-detail-property-chips" role="group" aria-label="任务安排">
          <div class="todo-detail-context">
            <AButton type="text" :disabled="state.busy" :title="currentListName" @click="revealDetail('list')">
              <ToDooIcon :name="form.task.listId ? 'list' : 'inbox'" :size="16" />
              <span class="todo-detail-property-value">{{ currentListName }}</span>
              <span class="todo-list-chevron">⌄</span>
            </AButton>
            <span v-if="form.occurrence && !['todo', 'done'].includes(form.occurrence.status)" class="todo-muted">{{ toDooStatusLabels[form.occurrence.status] }}</span>
          </div>
          <AButton type="text" class="todo-detail-schedule" aria-label="编辑计划日期" :title="planSummary"
            :class="{ 'is-empty': !scheduledBlocks.length }"
            :disabled="state.busy || !form.occurrence" @click="revealDetail('plan')">
            <ToDooIcon name="calendar" :size="16" />
            <span class="todo-detail-property-value"><template v-if="scheduledBlocks.length">计划 </template>{{ planSummary }}</span>
          </AButton>
          <AButton type="text" class="todo-detail-schedule" aria-label="编辑截止日期" :aria-describedby="deadlineSummaryId"
            :title="deadlineSummary" :class="{ 'is-empty': !form.occurrence?.due, 'is-overdue': deadlineOverdue }"
            :disabled="state.busy || !form.occurrence" @click="revealDetail('due')">
            <ToDooIcon name="calendar" :size="16" />
            <span class="todo-detail-property-value"><template v-if="form.occurrence?.due">截止 </template>{{ deadlineSummary }}</span>
          </AButton>
          <span :id="deadlineSummaryId" class="todo-accessible-label">{{ deadlineSummary }}</span>
          <AButton type="text" aria-label="编辑优先级" :class="'todo-priority-' + form.task.priority"
            :disabled="state.busy" @click="revealDetail('priority')">
            <ToDooIcon name="flag" :size="16" />
            <span class="todo-detail-property-value">{{ form.task.priority === 'none' ? '设置优先级' : toDooPriorityLabels[form.task.priority] + '优先级' }}</span>
          </AButton>
        </div>
        <AButton v-if="!children.length && !showChildren" type="text" class="todo-add-property" @click="emit('child', form.task.id)">＋ 添加子任务</AButton>
        <ToDooDisclosure v-else class="todo-disclosure todo-primary-children" :open="!!children.length">
          <template #header
            ><span>子任务</span
            ><small v-if="children.length" class="todo-muted">{{
              children.length
            }}</small></template
          >
          <div class="todo-disclosure-content">
            <AButton
              v-for="t in children"
              :key="t.id"
              class="todo-saved-row todo-text-button"
              html-type="button"
              @click="emit('select', t.id)"
              type="text"
            >
              <span>{{ t.title }}</span><span aria-hidden="true">↗</span></AButton
            ><AButton
              html-type="button"
              class="todo-link"
              @click="emit('child', form.task.id)"
              type="link"
            >
              ＋ 添加子任务
            </AButton>
          </div>
        </ToDooDisclosure>
        <section
          v-if="form.task.noteRefs.length"
          class="todo-primary-resources"
          aria-label="任务资料"
        >
          <h3>资料</h3>
          <AButton
            v-for="note in form.task.noteRefs"
            :key="note.noteId + ':' + note.role"
            type="link"
            class="todo-link"
            @click="emit('open-note', note.noteId)"
            ><ToDooIcon name="link" :size="16" /><span>{{ note.title || '关联资料' }}</span> ↗</AButton
          >
        </section>
        <section v-if="form.task.tagIds.length || form.task.dependencies.length || form.task.criteria || form.task.attachments.length || outcomes.length" class="todo-detail-value-summary" aria-label="任务补充信息">
          <AButton v-if="form.task.tagIds.length" type="text" @click="revealDetail('properties')">标签：{{ form.task.tagIds.map(id => state.snapshot?.tags.find(tag => tag.id === id)?.name || '标签').join('、') }}</AButton>
          <AButton v-if="form.task.dependencies.length" type="text" @click="revealDetail('properties')">前置任务：{{ form.task.dependencies.map(entry => model.taskDefinitions().find(task => task.id === entry.taskId)?.title || '关联任务').join('、') }}</AButton>
          <AButton v-if="form.task.attachments.length" type="text" @click="revealDetail('attachments')">附件 {{ form.task.attachments.length }} 份</AButton>
          <AButton v-if="form.task.criteria" type="text" class="todo-detail-criteria-summary" @click="revealDetail('results')">完成标准：{{ form.task.criteria }}</AButton>
          <AButton v-if="outcomes.length" type="text" @click="revealDetail('results')">成果 {{ outcomes.length }} 份 · {{ outcomes[0].summary }}</AButton>
        </section>
        <div class="todo-detail-shortcuts" role="group" aria-label="任务快捷设置">
          <AButton
            html-type="button"
            type="text"
            aria-label="编辑重复规则"
            :title="repeatSummary"
            @click="revealDetail('repeat')"
            ><ToDooIcon name="repeat" :size="16" /><span>重复</span><small :class="{ 'todo-accessible-label': repeatSummary === '不重复' }">{{ repeatSummary }}</small></AButton
          >
          <AButton
            html-type="button"
            type="text"
            aria-label="编辑任务提醒"
            @click="revealDetail('reminders')"
            ><ToDooIcon name="notifications" :size="16" /><span>提醒</span
            ><small v-if="form.task.reminders.length"
              >{{ form.task.reminders.length }} 条</small
            ></AButton
          >
          <AButton
            html-type="button"
            type="text"
            aria-label="编辑关联资料"
            @click="revealDetail('resources')"
            ><ToDooIcon name="link" :size="16" /><span>关联资料</span
            ><small v-if="form.task.noteRefs.length"
              >{{ form.task.noteRefs.length }} 份</small
            ></AButton
          >
        <ADropdown :trigger="['click']" overlay-class-name="todo-ant-popup">
          <AButton type="text" aria-label="更多任务属性" title="更多属性"><ToDooIcon name="more" :size="16" />更多</AButton>
          <template #overlay><AMenu :selectable="false">
            <AMenuItem v-for="(label, key) in panelLabels" :key="key" @click="revealDetail(key)">{{ label }}</AMenuItem>
          </AMenu></template>
        </ADropdown>
        </div>
        <AModal :open="propertyOpen" :title="detailPanel ? panelLabels[detailPanel] : ''" :footer="null" :width="560" wrap-class-name="todo-ant-modal todo-property-modal" @cancel="closeProperty">
          <fieldset ref="propertyFields" class="todo-form todo-create-fields todo-detail-options" :disabled="state.busy" @keydown="shortcut">
            <p v-if="validationError" class="todo-danger" role="alert">{{ validationError }}</p>
            <section v-if="detailPanel === 'list'" class="todo-form">
        <div class="todo-document-meta">
          <label
            ><span class="todo-document-field-label">清单</span
            ><ToDooSelect
              aria-label="所属目标或清单"
              :value="form.task.listId"
              @change="changeList"
              :disabled="!!form.task.parentTaskId"
              ><option :value="null">收集箱</option>
              <option v-for="l in model.taskLists()" :key="l.id" :value="l.id">
                {{ l.name }}
              </option></ToDooSelect
            ></label
          >
        </div>
        <ToDooInlineListCreate
          v-if="!form.task.parentTaskId"
          :model="model"
          @created="useCreatedList"
          @open-change="inlineListOpen = $event"
        />

            </section>
            <section v-if="detailPanel === 'due'" ref="deadlineFields" class="todo-form">
              <div class="todo-form-grid">
                <label>截止日期<ToDooDateField type="date" aria-label="截止日期" :value="form.occurrence?.due?.date || ''" @input="due($event, 'date')" /></label>
                <label>截止时间<ToDooDateField type="time" aria-label="截止时间" :value="form.occurrence?.due?.time || ''" @input="due($event, 'time')" /></label>
              </div>
              <label v-if="form.occurrence?.due">截止时区<AInput v-model:value="form.occurrence.due.timeZone" /></label>
              <AButton :disabled="state.busy || !form.occurrence?.due" @click="due('', 'date')">清除截止日期</AButton>
            </section>
            <section v-if="detailPanel === 'priority'" class="todo-form">
              <label>优先级<ASelect v-model:value="form.task.priority" aria-label="优先级" :options="priorityOptions" :disabled="state.busy" dropdown-class-name="todo-ant-popup todo-priority-popup" /></label>
            </section>
            <section v-if="detailPanel === 'plan'" class="todo-form">
              <div v-for="block in form.blocks.filter(value => !value.deletedAt)" :key="block.id" class="todo-form todo-plan-editor">
                <ToDooTimeBlockFields :block="block" :disabled="state.busy" />
                <AButton type="text" danger :disabled="state.busy" @click="removePlan(block.id)">移除这段安排</AButton>
              </div>
              <p v-if="!form.blocks.some(value => !value.deletedAt)" class="todo-muted">还没有安排时间，可添加一段或多段安排。</p>
              <AButton :disabled="state.busy || !form.occurrence" @click="addPlan">＋ 添加一段时间</AButton>
            </section>
            <ToDooDisclosure v-if="detailPanel === 'classification'" :open="detailPanel === 'classification'" class="todo-disclosure todo-classification">
              <template #header
                ><span>四象限归类</span
                ><small class="todo-muted"
                  >{{ form.task.importance === 'important' ? '重要' : '普通' }} ·
                  {{
                    form.task.urgentOverride === null
                      ? '自动判断紧急程度'
                      : form.task.urgentOverride
                        ? '紧急'
                        : '不紧急'
                  }}</small
                ></template
              >
              <div class="todo-disclosure-content">
                <div class="todo-form-grid">
                  <label
                    >重要程度<ToDooSelect v-model="form.task.importance" aria-label="重要程度">
                      <option value="normal">普通</option>
                      <option value="important">重要</option>
                    </ToDooSelect></label
                  >
                  <label
                    >紧急程度<ToDooSelect v-model="form.task.urgentOverride" aria-label="紧急程度">
                      <option :value="null">根据截止时间判断</option>
                      <option :value="true">设为紧急</option>
                      <option :value="false">设为不紧急</option>
                    </ToDooSelect></label
                  >
                </div>
                <small class="todo-muted">重要和紧急程度决定象限，优先级决定执行顺序。</small>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="repeatDetails" v-if="detailPanel === 'repeat'" :open="detailPanel === 'repeat'" class="todo-disclosure">
              <template #header
                ><span>重复规则</span
                ><small class="todo-muted">{{ repeatSummary }}</small></template
              >
              <div ref="repeatFields" class="todo-disclosure-content todo-form">
                <label v-if="form.task.parentTaskId" class="todo-checkbox"
                  ><ACheckbox
                    v-model:checked="form.task.inheritRecurrence"
                  />跟随父任务的重复周期</label
                >
                <label
                  >重复<ToDooSelect
                    :value="form.task.recurrence?.frequency || ''"
                    @change="repeat($event)"
                  >
                    <option value="">不重复</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                    <option value="monthly">每月</option>
                    <option value="yearly">每年</option>
                    <option value="after_completion">完成后重复</option>
                  </ToDooSelect></label
                ><template v-if="form.task.recurrence">
                  <label v-if="form.task.recurrence.frequency === 'weekly'"
                    >每周日期<ToDooSelect v-model="form.task.recurrence.weekdays" multiple>
                      <option
                        v-for="(day, i) in ['日', '一', '二', '三', '四', '五', '六']"
                        :key="i"
                        :value="i"
                      >
                        星期{{ day }}
                      </option>
                    </ToDooSelect></label
                  >
                  <ToDooDisclosure ref="advancedRepeatDetails" class="todo-repeat-advanced">
                    <template #header><span>高级重复规则</span></template>
                    <div class="todo-form todo-repeat-advanced-fields">
                      <div class="todo-form-grid">
                    <label
                      >间隔<AInputNumber
                        aria-label="间隔"
                        v-model:value="form.task.recurrence.interval"
                        :min="1" :max="1000" :step="1" :precision="0" required /></label
                    ><label
                      >开始日期<ToDooDateField
                        v-model="form.task.recurrence.anchorDate" required :allow-clear="false"
                        type="date" /></label
                    ><label
                      >重复时间<ToDooDateField
                        :model-value="form.task.recurrence.time" @update:model-value="form.task.recurrence.time = $event || null"
                        type="time" /></label
                    ><label>时区<AInput v-model:value="form.task.recurrence.timeZone" /></label
                    ><label
                      >结束日期<ToDooDateField
                        :model-value="form.task.recurrence.until" @update:model-value="form.task.recurrence.until = $event || null"
                        type="date" /></label
                    ><label
                      >最多次数<AInputNumber
                        aria-label="最多次数"
                        :value="form.task.recurrence.count ?? undefined"
                        @update:value="
                          form.task.recurrence.count = $event == null ? null : Number($event)
                        "
                        :min="1" :max="100000" :precision="0"
                    /></label>
                  </div>

                  <div v-if="form.task.recurrence.frequency === 'monthly'" class="todo-form">
                    <label
                      >每月方式<ToDooSelect
                        :value="form.task.recurrence.weekOrdinal ? 'weekday' : 'date'"
                        @change="monthly($event)"
                      >
                        <option value="date">固定日期</option>
                        <option value="weekday">第几个星期</option>
                      </ToDooSelect></label
                    ><label v-if="!form.task.recurrence.weekOrdinal"
                      >每月日期<AInputNumber
                        aria-label="每月日期"
                        v-model:value="form.task.recurrence.monthDay"
                        :min="1"
                        :max="31"
                    /></label>
                    <div v-else class="todo-form-grid">
                      <label
                        >第几个<ToDooSelect v-model.number="form.task.recurrence.weekOrdinal">
                          <option v-for="n in [1, 2, 3, 4, 5, -1]" :key="n" :value="n">
                            {{ n === -1 ? '最后一个' : '第 ' + n + ' 个' }}
                          </option>
                        </ToDooSelect></label
                      ><label
                        >星期<ToDooSelect
                          :value="form.task.recurrence.weekdays[0] ?? 1"
                          @change="form.task.recurrence.weekdays = [Number($event)]"
                        >
                          <option
                            v-for="(d, i) in ['日', '一', '二', '三', '四', '五', '六']"
                            :key="i"
                            :value="i"
                          >
                            星期{{ d }}
                          </option>
                        </ToDooSelect></label
                      >
                    </div>
                  </div>
                  <label v-if="form.task.recurrence.frequency === 'after_completion'"
                    >完成后间隔单位<ToDooSelect v-model="form.task.recurrence.completionUnit">
                      <option value="day">天</option>
                      <option value="week">周</option>
                      <option value="month">月</option>
                    </ToDooSelect></label
                  ><label
                    >短月处理<ToDooSelect v-model="form.task.recurrence.shortMonth">
                      <option value="last_day">使用月末</option>
                      <option value="skip">跳过当月</option>
                    </ToDooSelect></label
                  ><ToDooDateExceptions
                    v-model="form.task.recurrence.excludedDates"
                    label="排除这些日期"
                  /><ToDooDateExceptions
                    v-model="form.task.recurrence.additionalDates"
                    label="额外安排这些日期"
                  />
                    </div>
                  </ToDooDisclosure>
                </template>
                <label v-if="form.task.recurrence || propertyBaseline?.task.recurrence || occurrences.length > 1"
                  >修改范围<ToDooSelect v-model="scope">
                    <option value="all">整个系列（保留完成历史）</option>
                    <option value="future">本次及以后</option>
                  </ToDooSelect></label>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="linkedResources" v-if="detailPanel === 'resources'" :open="detailPanel === 'resources'" class="todo-disclosure">
              <template #header
                ><span>关联资料</span
                ><small v-if="form.task.noteRefs.length" class="todo-muted">{{
                  form.task.noteRefs.length
                }}</small></template
              >
              <div ref="resourceFields" class="todo-disclosure-content">
                <ToDooNotes
                  v-model="form.task.noteRefs"
                  :tree="tree"
                  @open-note="emit('open-note', $event)"
                />
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure v-if="detailPanel === 'attachments'" :open="detailPanel === 'attachments'" class="todo-disclosure">
              <template #header
                ><span>任务附件</span
                ><small v-if="form.task.attachments.length" class="todo-muted">{{
                  form.task.attachments.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <p class="todo-muted todo-small">支持图片、PDF 和纯文本，每个文件最多 10 MB。</p>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/markdown,text/csv,.md,.txt,.csv"
                  aria-label="上传任务附件"
                  :disabled="state.busy || model.dirty()"
                  @change="uploadAsset"
                />
                <p v-if="model.dirty()" class="todo-muted todo-small">
                  先保存当前更改，再上传或移除附件。
                </p>
                <div
                  v-for="asset in form.task.attachments"
                  :key="asset.hash"
                  class="todo-attachment"
                >
                  <div class="todo-between">
                    <span
                      >{{ asset.name
                      }}<small class="todo-muted"
                        >{{ (asset.size / 1024).toFixed(1) }} KB</small
                      ></span
                    >
                    <div class="todo-actions">
                      <a class="todo-link" :href="assetUrl(asset.hash)" :download="asset.name"
                        >下载</a
                      ><AButton
                        v-if="
                          ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(
                            asset.mime,
                          )
                        "
                        html-type="button"
                        class="todo-link"
                        @click="previewAsset = previewAsset === asset.hash ? '' : asset.hash"
                        type="link"
                      >
                        {{ previewAsset === asset.hash ? '收起预览' : '预览' }}</AButton
                      ><AButton
                        html-type="button"
                        class="todo-link todo-danger"
                        :disabled="state.busy || model.dirty()"
                        @click="removeAsset(asset.hash)"
                        type="link"
                        danger
                      >
                        移除关联
                      </AButton>
                    </div>
                  </div>
                  <img
                    v-if="previewAsset === asset.hash"
                    :src="assetUrl(asset.hash, true)"
                    :alt="asset.name + '，任务附件预览'"
                    loading="lazy"
                  />
                </div>
                <p v-if="!form.task.attachments.length" class="todo-muted todo-small">
                  还没有上传附件
                </p>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure v-if="detailPanel === 'results'" :open="detailPanel === 'results'" class="todo-disclosure">
              <template #header
                ><span>完成标准与成果</span
                ><small v-if="outcomes.length" class="todo-muted">{{
                  outcomes.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <label
                  >完成标准<ATextarea
                    v-model:value="form.task.criteria"
                    :rows="4"
                    placeholder="每行一条，普通任务也可以留空"
                  ></ATextarea>
                </label>
                <div v-for="o in outcomes" :key="o.id" class="todo-saved-row">
                  <span
                    >{{ o.summary
                    }}<small>{{
                      {
                        self_assessed: '自评',
                        practice: '练习验证',
                        reviewed: '经过评审',
                        delivered: '已交付',
                      }[o.verification]
                    }}</small></span
                  ><AButton
                    html-type="button"
                    class="todo-link"
                    @click="emit('edit', 'outcome', o)"
                    type="link"
                  >
                    编辑
                  </AButton>
                </div>
                <AButton class="todo-link" html-type="button" @click="makeOutcome" type="link"
                  >＋ 记录成果与证据</AButton
                >
                <AButton
                  html-type="button"
                  class="todo-button"
                  :disabled="state.busy || model.dirty() || !form.occurrence"
                  @click="emit('outcome-note')"
                  type="default"
                >
                  创建成果笔记并关联
                </AButton>
                <AButton
                  v-if="createdNoteId"
                  html-type="button"
                  class="todo-link"
                  aria-label="打开成果笔记"
                  @click="emit('open-note', createdNoteId)"
                  type="link"
                >
                  打开成果笔记 ↗
                </AButton>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure ref="moreOptions" v-if="detailPanel === 'properties' || detailPanel === 'reminders'" :open="detailPanel === 'properties' || detailPanel === 'reminders'" class="todo-disclosure">
              <template #header><span>{{ detailPanel === 'reminders' ? '任务提醒' : '其他属性' }}</span></template>
              <div class="todo-disclosure-content todo-form">
                <template v-if="detailPanel !== 'reminders'">
                <div class="todo-form-grid">
                  <label
                    >分组<ToDooSelect v-model="form.task.sectionId">
                      <option :value="null">
                        {{ form.task.parentTaskId ? '跟随父任务分组' : '未分组' }}
                      </option>
                      <option
                        v-for="s in state.snapshot?.sections.filter(
                          (s) => !s.deletedAt && s.listId === form!.task.listId,
                        )"
                        :key="s.id"
                        :value="s.id"
                      >
                        {{ s.name }}
                      </option>
                    </ToDooSelect></label
                  >
                  <label
                    >预计分钟<AInputNumber
                      aria-label="预计分钟"
                      :value="form.task.estimateMinutes ?? undefined"
                      @update:value="
                        form.task.estimateMinutes = $event == null ? null : Number($event)
                      "
                      :min="0"
                  /></label>
                </div>
                <label
                  >标签<ToDooSelect v-model="form.task.tagIds" multiple>
                    <option
                      v-for="tag in state.snapshot?.tags.filter((t) => !t.deletedAt)"
                      :key="tag.id"
                      :value="tag.id"
                    >
                      {{ tag.name }}
                    </option>
                  </ToDooSelect></label
                ><AButton
                  class="todo-link"
                  html-type="button"
                  @click="emit('edit', 'tag')"
                  type="link"
                >
                  ＋ 新建标签
                </AButton>
                <label
                  >前置任务<ToDooSelect v-model="dependencies" multiple>
                    <option
                      v-for="t in state.snapshot?.tasks.filter(
                        (t) => !t.deletedAt && t.id !== form!.task.id,
                      )"
                      :key="t.id"
                      :value="t.id"
                    >
                      {{ t.title }}
                    </option>
                  </ToDooSelect></label
                ><label v-for="dependency in form.task.dependencies" :key="dependency.taskId"
                  >{{
                    state.snapshot?.tasks.find((t) => t.id === dependency.taskId)?.title ||
                    dependency.taskId
                  }}
                  完成后等待（分钟）<AInputNumber
                    :aria-label="
                      String(
                        state.snapshot?.tasks.find((t) => t.id === dependency.taskId)?.title ||
                          dependency.taskId,
                      ) + ' 完成后等待（分钟）'
                    "
                    v-model:value="dependency.lagMinutes" required :precision="0"
                    :min="0"
                    :max="525600"
                    :step="1" /></label
                ><label v-if="form.occurrence"
                  >受阻原因<ATextarea
                    v-model:value="form.occurrence.blockedReason"
                    :rows="2"
                  ></ATextarea
                ></label>
                </template>
                <div ref="reminderFields" v-if="detailPanel === 'reminders'">
                  <ToDooReminders v-model="form.task.reminders" :date-based="false" />
                </div>
                <template v-if="detailPanel !== 'reminders'">
                <label
                  >来源资料<ToDooSelect
                    :value="form.task.source?.noteId || ''"
                    @change="
                      form.task.source = $event
                        ? {
                            noteId: $event,
                            quote: form.task.source?.quote || '',
                            contentHash: null,
                            draft: false,
                          }
                        : null
                    "
                  >
                    <option value="">不关联来源</option>
                    <option v-for="n in form.task.noteRefs" :key="n.noteId" :value="n.noteId">
                      {{ n.title || n.noteId }}
                    </option>
                  </ToDooSelect></label
                ><label
                  >来源引用<ATextarea
                    :value="form.task.source?.quote || ''"
                    :rows="2"
                    :disabled="!form.task.source"
                    placeholder="先关联一份来源资料，可在这里保存原文引用"
                    @input="
                      form.task.source &&
                      (form.task.source = {
                        noteId: form.task.source.noteId,
                        quote: ($event.target as HTMLTextAreaElement).value,
                        contentHash: null,
                        draft: false,
                      })
                    "
                  ></ATextarea></label
                ><label v-if="form.occurrence && form.task.recurrence"
                  >仅本次标题<AInput
                    :value="form.occurrence.titleOverride || ''"
                    @update:value="form.occurrence.titleOverride = $event"
                    placeholder="留空使用系列标题"
                /></label>
                </template>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure v-if="detailPanel === 'records'" :open="detailPanel === 'records'" class="todo-disclosure">
              <template #header
                ><span>推进记录</span
                ><small v-if="records.length" class="todo-muted">{{
                  records.length
                }}</small></template
              >
              <div class="todo-disclosure-content todo-form">
                <div v-for="r in records" :key="r.id" class="todo-saved-row">
                  <span
                    >{{ r.content
                    }}<small
                      >{{ new Date(r.occurredAt).toLocaleString()
                      }}{{ r.minutes !== null ? ' · ' + r.minutes + ' 分钟' : '' }}</small
                    ></span
                  ><AButton
                    class="todo-link"
                    html-type="button"
                    @click="emit('edit', 'record', r)"
                    type="link"
                  >
                    编辑
                  </AButton>
                </div>
                <AButton
                  class="todo-link"
                  html-type="button"
                  @click="
                    emit('edit', 'record', undefined, {
                      taskId: form.task.id,
                      occurrenceId: form.occurrence?.id || null,
                      listId: form.task.listId,
                    })
                  "
                  type="link"
                >
                  ＋ 记录进展
                </AButton>
              </div>
            </ToDooDisclosure>
            <ToDooDisclosure v-if="detailPanel === 'history'" :open="detailPanel === 'history'" class="todo-disclosure">
              <template #header><span>操作历史</span></template>
              <div class="todo-disclosure-content todo-form">
                <template
                  v-for="(page, kind) in state.detailCollectionPages[state.selectedTaskId]"
                  :key="kind"
                  ><AButton
                    v-if="page?.nextCursor"
                    class="todo-button"
                    html-type="button"
                    :disabled="state.collectionLoading"
                    @click="model.nextTaskCollectionPage(state.selectedTaskId, kind)"
                    type="default"
                  >
                    继续载入此任务的{{ detailCollectionLabels[kind] || '关联记录' }}
                  </AButton></template
                >
                <div v-for="h in history" :key="h.id" class="todo-history">
                  <time>{{ new Date(h.at).toLocaleString() }}</time
                  ><span>{{ h.summary || h.action }}</span>
                </div>
                <p v-if="!history.length" class="todo-muted todo-small">当前范围没有历史记录</p>
              </div>
            </ToDooDisclosure>
            <div class="todo-property-footer">
              <span class="todo-muted">设置完成后，请在任务详情中保存。</span>
              <AButton :disabled="state.busy" @click="cancelProperty">取消本次设置</AButton>
              <AButton type="primary" :disabled="state.busy || inlineListOpen" @click="completeProperty">完成设置</AButton>
            </div>
          </fieldset>
        </AModal>
      </fieldset>
    </div>
    <p v-else class="todo-empty">任务暂不可用，可能尚未载入或已被移除。</p>
    <footer v-if="creating" class="todo-detail-footer todo-create-footer">
      <AButton html-type="button" class="todo-button" :disabled="state.busy" @click="discardNew"
        >取消</AButton
      >
      <AButton
        :form="createFormId"
        class="todo-button todo-primary"
        html-type="submit"
        :disabled="state.busy || inlineListOpen || !local.title.trim()"
        :loading="state.busy"
        type="primary"
        >创建任务</AButton
      >
    </footer>
    <footer
      v-else-if="form"
      class="todo-detail-footer"
      :class="{ 'has-unsaved': model.dirty() || savingTask }"
    >
      <AButton
        html-type="button"
        type="text"
        class="todo-detail-focus"
        :disabled="state.busy || !form.occurrence"
        @click="emit('focus', form.occurrence?.id)"
        ><ToDooIcon name="focus" :size="16" />专注</AButton
      >
      <ToDooTaskMenu
        v-if="menuItem"
        :model="model"
        :item="menuItem"
        label="更多操作"
        parent-delete
        :remove-task="remove"
        @open="emit('select', $event.task.id, $event.occurrence?.id)"
        @child="emit('child', $event)"
        @edit="(kind, entity, seed) => emit('edit', kind, entity, seed)"
        @remove="remove"
      />
      <AButton
        html-type="button"
        class="todo-button todo-detail-close"
        :disabled="state.busy"
        @click="close"
        >关闭</AButton
      >
      <AButton
        html-type="button"
        class="todo-button todo-primary todo-detail-save"
        :disabled="state.busy || inlineListOpen || !model.dirty() || !form.task.title.trim()"
        :loading="savingTask"
        @click="save"
        type="primary"
        >保存任务</AButton
      >
    </footer>
  </aside>
</template>
