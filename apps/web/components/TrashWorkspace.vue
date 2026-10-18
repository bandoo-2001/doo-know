<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Modal as AModal } from 'ant-design-vue';
import { api, ApiError } from '../api';
import type {
  ManagementBatchResult,
  ManagementItemResult,
  ManagementTrashItem,
  ManagementTrashPage,
  ManagementTrashPurgeInput,
  ManagementTrashRestoreInput,
} from '../../../shared/management-contracts';

const emit = defineEmits<{ 'open-note': [id: string]; changed: []; back: [] }>();
type PendingRequest =
  | { kind: 'restore'; input: ManagementTrashRestoreInput; openId?: string; uncertain?: boolean }
  | { kind: 'purge'; input: ManagementTrashPurgeInput; uncertain?: boolean };
const page = ref<ManagementTrashPage>(),
  query = ref(''),
  activeQuery = ref(''),
  availability = ref('all'),
  selected = ref<string[]>([]),
  renames = ref<Record<string, string>>({}),
  renameOpen = ref<string[]>([]),
  fieldErrors = ref<Record<string, string>>({}),
  loading = ref(true),
  busy = ref(false),
  listError = ref(''),
  mutationError = ref(''),
  notice = ref(''),
  storageWarning = ref(''),
  pending = ref<PendingRequest>(),
  results = ref<ManagementItemResult[]>([]),
  resultLabels = ref<Record<string, string>>({}),
  lastKind = ref<'restore' | 'purge'>('restore'),
  lastOpenId = ref<string>(),
  pageCursors = ref<(string | null)[]>([null]),
  pageIndex = ref(0),
  purgeDraft = ref<{ ids: string[]; snapshotId: string; items: ManagementTrashItem[] }>(),
  purgeConfirmation = ref(''),
  purgeError = ref('');
let storageKey = '',
  disposed = false;
const locked = computed(() => busy.value || !!pending.value || !!purgeDraft.value);
const visibleItems = computed(() =>
  (page.value?.items || []).filter(
    (item) =>
      availability.value === 'all' ||
      (availability.value === 'available' ? item.available : !item.available),
  ),
);
const selectableItems = computed(() => visibleItems.value.filter((item) => item.available));
const allSelected = computed(
  () =>
    selectableItems.value.length > 0 &&
    selectableItems.value.every((item) => selected.value.includes(item.id)),
);
const failedIds = computed(() =>
  results.value
    .filter(
      (item) => !item.ok && page.value?.items.some((row) => row.id === item.id && row.available),
    )
    .map((item) => item.id),
);
watch(availability, () => {
  selected.value = [];
});

function formatTime(value: string | null) {
  if (!value) return '删除时间未知';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '删除时间未知';
}
function formatSize(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(1)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
function explain(code?: string) {
  const descriptions: Record<string, string> = {
    NAME_CONFLICT: '原位置已有同名文件，请填写另一个文件名后重试。',
    NOT_FOUND: '项目已不在回收站，请刷新核对。',
    TRASH_CHANGED: '项目已发生变化，本次未移除。请刷新并重新选择。',
    TRASH_UNAVAILABLE: '回收站文件无法安全读取，本次未操作。',
    TRASH_SCOPE_MISMATCH: '所选项目与确认时的列表不一致，请刷新后重新选择。',
    TRASH_SNAPSHOT_EXPIRED: '列表确认已过期，请刷新后重新选择。',
    OPERATION_IN_PROGRESS: '该项目正在处理其他操作，请稍后刷新。',
    INVALID_INPUT: '文件名无效，请使用不含路径的 Markdown 文件名。',
    INVALID_PATH: '文件或目录无法安全访问，本次未操作。',
    WORKSPACE_BUSY: '知识库正在执行其他维护操作，请稍后重试。',
    RECOVERY_REQUIRED: '知识库有待核对的写入，请先在状态面板检查。',
    OPERATION_FAILED: '操作未完成，请刷新后核对项目状态。',
  };
  return descriptions[code || ''] || (code ? `操作未完成（${code}）。` : '操作未完成，请重试。');
}
function requestError(error: unknown) {
  if (error instanceof ApiError && typeof error.data.code === 'string')
    return explain(error.data.code);
  return error instanceof Error ? error.message : '请求失败，请重试。';
}
function rememberPending() {
  if (!storageKey) return;
  try {
    if (pending.value) sessionStorage.setItem(storageKey, JSON.stringify(pending.value));
    else sessionStorage.removeItem(storageKey);
  } catch {
    storageWarning.value = '浏览器无法保存核对状态。若请求中断，请保留本页并核对原请求结果。';
  }
}
function readPending() {
  if (!storageKey) return;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return;
    const value = JSON.parse(raw) as PendingRequest;
    if (
      (value.kind !== 'restore' && value.kind !== 'purge') ||
      !value.input ||
      !Array.isArray(value.input.ids) ||
      value.input.ids.length < 1 ||
      value.input.ids.length > 100 ||
      value.input.ids.some((id) => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
      typeof value.input.requestId !== 'string' ||
      !value.input.requestId ||
      value.input.requestId.length > 128
    )
      throw Error('invalid pending request');
    if (
      value.kind === 'purge' &&
      (value.input.confirm !== 'PERMANENTLY_DELETE' || typeof value.input.snapshotId !== 'string')
    )
      throw Error('invalid pending scope');
    pending.value = { ...value, uncertain: true };
  } catch {
    storageWarning.value = '浏览器中的上次核对记录无法读取。请刷新列表确认项目状态，再重新操作。';
  }
}
async function loadPage(
  cursor: string | null = pageCursors.value[pageIndex.value] || null,
  search = activeQuery.value,
) {
  loading.value = true;
  listError.value = '';
  try {
    const params = new URLSearchParams({ limit: '50' });
    if (search) params.set('q', search);
    if (cursor) params.set('cursor', cursor);
    const next = await api<ManagementTrashPage>('/api/manage/trash?' + params);
    page.value = next;
    activeQuery.value = search;
    selected.value = [];
    return true;
  } catch (e) {
    listError.value = requestError(e);
    return false;
  } finally {
    loading.value = false;
  }
}
async function search() {
  if (locked.value || loading.value) return;
  if (await loadPage(null, query.value.trim())) {
    pageCursors.value = [null];
    pageIndex.value = 0;
  }
}
async function refresh() {
  if (!locked.value && !loading.value) await loadPage();
}
async function nextPage() {
  if (locked.value || loading.value || !page.value?.nextCursor) return;
  const cursor = page.value.nextCursor;
  if (await loadPage(cursor)) {
    pageCursors.value = [...pageCursors.value.slice(0, pageIndex.value + 1), cursor];
    pageIndex.value++;
  }
}
async function previousPage() {
  if (locked.value || loading.value || pageIndex.value < 1) return;
  if (await loadPage(pageCursors.value[pageIndex.value - 1])) pageIndex.value--;
}
function toggle(id: string, checked: boolean) {
  if (locked.value || loading.value) return;
  selected.value = checked
    ? [...new Set([...selected.value, id])]
    : selected.value.filter((value) => value !== id);
}
function toggleAll() {
  if (!locked.value && !loading.value)
    selected.value = allSelected.value ? [] : selectableItems.value.map((item) => item.id);
}
function beginRename(item: ManagementTrashItem) {
  if (locked.value || loading.value) return;
  if (!renameOpen.value.includes(item.id)) renameOpen.value.push(item.id);
  renames.value[item.id] ??= item.relativePath.split('/').at(-1) || '';
  void nextTick(() => {
    if (typeof document !== 'undefined') document.getElementById(`trash-name-${item.id}`)?.focus();
  });
}
function closeRename(id: string) {
  delete renames.value[id];
  delete fieldErrors.value[id];
  renameOpen.value = renameOpen.value.filter((value) => value !== id);
  void nextTick(() => {
    if (typeof document !== 'undefined')
      document.getElementById(`trash-rename-trigger-${id}`)?.focus();
  });
}
function captureLabels(ids: string[]) {
  resultLabels.value = Object.fromEntries(
    ids.map((id) => [id, page.value?.items.find((item) => item.id === id)?.relativePath || id]),
  );
}
async function sendPending() {
  const request = pending.value;
  if (!request || busy.value) return;
  busy.value = true;
  mutationError.value = '';
  notice.value = '';
  try {
    const result = await api<ManagementBatchResult>(
      `/api/manage/trash/${request.kind === 'restore' ? 'restore' : 'purge'}`,
      'POST',
      request.input,
    );
    const received = new Set(result.results?.map((item) => item.id));
    if (
      !Array.isArray(result.results) ||
      result.results.length !== request.input.ids.length ||
      received.size !== request.input.ids.length ||
      request.input.ids.some((id) => !received.has(id)) ||
      result.results.some((item) => typeof item.ok !== 'boolean')
    )
      throw new ApiError(0, { error: '操作响应不完整，请核对原请求。' });
    results.value = result.results;
    lastKind.value = request.kind;
    lastOpenId.value = request.kind === 'restore' ? request.openId : undefined;
    const succeeded = result.results.filter((item) => item.ok);
    const successIds = new Set(succeeded.map((item) => item.id));
    pending.value = undefined;
    rememberPending();
    for (const item of result.results)
      if (!item.ok && item.code === 'NAME_CONFLICT') {
        const row = page.value?.items.find((row) => row.id === item.id);
        if (row) {
          if (!renameOpen.value.includes(row.id)) renameOpen.value.push(row.id);
          renames.value[row.id] ??= row.relativePath.split('/').at(-1) || '';
        }
      }
    notice.value = `${request.kind === 'restore' ? '已恢复' : '已永久移除回收站文件'} ${succeeded.length} 项${result.results.length > succeeded.length ? `，${result.results.length - succeeded.length} 项未完成。` : '。'}`;
    if (page.value) page.value.items = page.value.items.filter((item) => !successIds.has(item.id));
    if (!disposed) {
      if (succeeded.length) emit('changed');
      await loadPage();
      if (
        request.kind === 'restore' &&
        request.openId &&
        successIds.has(request.openId) &&
        !disposed
      )
        emit('open-note', request.openId);
    }
  } catch (e) {
    const code = e instanceof ApiError ? e.data.code : undefined;
    // These scope errors are explicit pre-mutation rejections. A completed purge
    // returns its saved receipt even after expiry; an unresolved operation returns
    // OPERATION_OUTCOME_UNKNOWN instead. A rejected scope can be safely reselected.
    const rejectedScope =
      request.kind === 'purge' &&
      e instanceof ApiError &&
      e.status === 409 &&
      (code === 'TRASH_SNAPSHOT_EXPIRED' || code === 'TRASH_SCOPE_MISMATCH');
    const uncertain =
      !rejectedScope &&
      (request.uncertain ||
        !(e instanceof ApiError) ||
        e.status === 0 ||
        e.status >= 500 ||
        code === 'OPERATION_OUTCOME_UNKNOWN');
    if (uncertain) {
      pending.value = { ...request, uncertain: true };
      rememberPending();
      mutationError.value =
        code === 'WORKSPACE_BUSY'
          ? '知识库正在执行其他维护操作，请稍后按原请求重试。当前选择范围已保留。'
          : code === 'OPERATION_OUTCOME_UNKNOWN'
            ? '服务端尚未确认这次操作的最终结果。请保留原请求，稍后再次核对。'
            : '未收到完整操作结果。部分项目可能已完成，请按原请求核对结果，避免重复操作。';
    } else {
      pending.value = undefined;
      rememberPending();
      mutationError.value = requestError(e);
      if (rejectedScope && !disposed) await loadPage();
    }
  } finally {
    busy.value = false;
  }
}
async function restore(ids: string[], openId?: string) {
  if (locked.value || loading.value || !ids.length) return;
  fieldErrors.value = {};
  mutationError.value = '';
  const valid = ids.every((id) =>
    page.value?.items.some((item) => item.id === id && item.available),
  );
  if (!valid) {
    mutationError.value = '请选择本页中可读取的项目。';
    return;
  }
  const fileNames: Record<string, string> = {};
  for (const id of ids) {
    const name = renames.value[id];
    if (name === undefined || name === '') continue;
    if (
      new TextEncoder().encode(name).length > 180 ||
      /[\x00-\x1f\x7f/\\:]/.test(name) ||
      name.startsWith('.') ||
      name.endsWith(' ') ||
      !name.toLowerCase().endsWith('.md') ||
      name.toLowerCase() === 'agents.md'
    )
      fieldErrors.value[id] =
        '请填写不含路径的 .md 文件名，最长 180 字节，不能以点开头或空格结尾。';
    else fileNames[id] = name;
  }
  if (Object.keys(fieldErrors.value).length) return;
  captureLabels(ids);
  pending.value = {
    kind: 'restore',
    input: {
      ids: [...ids],
      requestId: crypto.randomUUID(),
      ...(Object.keys(fileNames).length ? { fileNames } : {}),
    },
    ...(openId ? { openId } : {}),
  };
  rememberPending();
  await sendPending();
}
function openPurge(ids: string[]) {
  if (locked.value || loading.value || !ids.length || !page.value) return;
  const items = page.value.items.filter((item) => ids.includes(item.id) && item.available);
  if (items.length !== ids.length) {
    mutationError.value = '请选择本页中可读取的项目。';
    return;
  }
  purgeDraft.value = {
    ids: [...ids],
    snapshotId: page.value.snapshotId,
    items: items.map((item) => ({ ...item })),
  };
  purgeConfirmation.value = '';
  purgeError.value = '';
}
async function confirmPurge() {
  const draft = purgeDraft.value;
  if (!draft || busy.value || pending.value) return;
  if (purgeConfirmation.value.trim() !== '永久移除') {
    purgeError.value = '请输入“永久移除”以确认移除上方列出的文件。';
    return;
  }
  captureLabels(draft.ids);
  pending.value = {
    kind: 'purge',
    input: {
      ids: [...draft.ids],
      snapshotId: draft.snapshotId,
      confirm: 'PERMANENTLY_DELETE',
      requestId: crypto.randomUUID(),
    },
  };
  rememberPending();
  purgeDraft.value = undefined;
  await sendPending();
}
async function retryPending() {
  await sendPending();
}
async function retryFailures() {
  if (lastKind.value === 'purge') openPurge(failedIds.value);
  else
    await restore(
      failedIds.value,
      lastOpenId.value && failedIds.value.includes(lastOpenId.value) ? lastOpenId.value : undefined,
    );
}
onMounted(async () => {
  try {
    const session = await api<{ user?: { id?: string } }>('/api/auth/get-session');
    if (session.user?.id) {
      storageKey = `dooknow.trash.pending.v1.${session.user.id}`;
      readPending();
    } else storageWarning.value = '无法保存账户的操作核对状态。请求中断时请保留本页。';
  } catch {
    storageWarning.value = '暂时无法保存账户的操作核对状态。请求中断时请保留本页。';
  }
  await loadPage(null);
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <section class="trash-workspace" aria-labelledby="trash-heading" :aria-busy="loading || busy">
    <header class="trash-heading">
      <div>
        <p class="eyebrow">知识库管理</p>
        <h1 id="trash-heading">回收站</h1>
        <p class="muted">恢复保留原笔记标识；原位置被占用时，可以更换文件名。</p>
      </div>
      <button class="action" type="button" @click="emit('back')">返回笔记</button>
    </header>
    <div v-if="pending" class="callout warning" role="status" aria-live="polite">
      <strong>上次{{ pending.kind === 'restore' ? '恢复' : '移除' }}操作仍待核对</strong>
      <p>
        为避免重复操作，新的恢复与移除已暂停。核对会重复提交同一个请求；不会生成另一批操作。离开再返回本页仍可继续核对。
      </p>
      <button class="action" :disabled="busy || loading" @click="retryPending">
        {{ busy ? '正在核对…' : '按原请求核对结果' }}
      </button>
    </div>
    <p v-if="storageWarning" class="callout warning" role="status">{{ storageWarning }}</p>
    <p v-if="mutationError" class="callout error" role="alert">{{ mutationError }}</p>
    <p v-if="notice" class="callout success" role="status" aria-live="polite">{{ notice }}</p>
    <form class="trash-search" @submit.prevent="search">
      <label class="search-field"
        ><span>搜索回收站</span
        ><input
          v-model="query"
          type="search"
          maxlength="200"
          placeholder="按原路径或文件名查找"
          :disabled="locked || loading"
      /></label>
      <label
        ><span>本页文件状态</span
        ><select v-model="availability" :disabled="locked || loading">
          <option value="all">全部状态</option>
          <option value="available">可读取</option>
          <option value="unavailable">暂不可读取</option>
        </select></label
      >
      <button class="action primary" type="submit" :disabled="locked || loading">查找</button>
      <button class="action" type="button" :disabled="locked || loading" @click="refresh">
        刷新列表
      </button>
    </form>
    <div v-if="listError" class="callout error" role="alert">
      <p>{{ listError }}</p>
      <button class="action" :disabled="locked || loading" @click="refresh">重新读取列表</button>
    </div>
    <p v-if="loading && !page" class="empty" role="status">正在读取回收站…</p>
    <template v-if="page">
      <div class="selection-bar">
        <label class="check-label"
          ><input
            type="checkbox"
            :checked="allSelected"
            :disabled="locked || loading || !selectableItems.length"
            @change="toggleAll"
          />全选本页可读取项目</label
        >
        <span class="muted">本页 {{ page.items.length }} 项 · 已选 {{ selected.length }} 项</span>
        <div class="batch-actions">
          <button
            class="action"
            :disabled="locked || loading || !selected.length"
            @click="restore(selected)"
          >
            恢复所选</button
          ><button
            class="action danger"
            :disabled="locked || loading || !selected.length"
            @click="openPurge(selected)"
          >
            永久移除所选文件
          </button>
        </div>
      </div>
      <ul v-if="visibleItems.length" class="trash-list">
        <li v-for="item in visibleItems" :key="item.id" class="trash-item">
          <label class="item-check"
            ><input
              type="checkbox"
              :aria-label="`选择 ${item.title}`"
              :checked="selected.includes(item.id)"
              :disabled="locked || loading || !item.available"
              @change="toggle(item.id, ($event.target as HTMLInputElement).checked)"
          /></label>
          <div class="item-main">
            <h2>{{ item.title }}</h2>
            <p class="original-path">
              <span class="visually-hidden">原路径：</span>{{ item.relativePath }}
            </p>
            <p class="item-meta">
              <span>{{ formatTime(item.deletedAt) }}</span
              ><span>{{ formatSize(item.sizeBytes) }}</span
              ><span v-if="!item.available" class="unavailable">暂不可读取</span>
            </p>
            <p v-if="!item.available" class="muted">
              原文件缺失、存在链接或暂时无法安全读取，请先检查服务器上的原文件。
            </p>
            <div v-if="renameOpen.includes(item.id)" class="rename-field">
              <label :for="`trash-name-${item.id}`">恢复时使用的文件名</label>
              <div class="rename-input">
                <input
                  :id="`trash-name-${item.id}`"
                  v-model="renames[item.id]"
                  :disabled="locked || loading"
                  :aria-invalid="!!fieldErrors[item.id]"
                  :aria-describedby="`trash-name-help-${item.id}`"
                  @keydown.esc.prevent="closeRename(item.id)"
                /><button
                  class="action"
                  :disabled="locked || loading"
                  @click="closeRename(item.id)"
                >
                  取消改名
                </button>
              </div>
              <p
                :id="`trash-name-help-${item.id}`"
                :class="fieldErrors[item.id] ? 'field-error' : 'muted'"
                :role="fieldErrors[item.id] ? 'alert' : undefined"
              >
                {{ fieldErrors[item.id] || '仅更改文件名，仍恢复到原目录；不会覆盖已有文件。' }}
              </p>
            </div>
          </div>
          <div class="item-actions">
            <button
              class="action primary"
              :disabled="locked || loading || !item.available"
              @click="restore([item.id], item.id)"
            >
              恢复并打开</button
            ><button
              class="action"
              :disabled="locked || loading || !item.available"
              :id="`trash-rename-trigger-${item.id}`"
              :aria-expanded="renameOpen.includes(item.id)"
              @click="beginRename(item)"
            >
              更换文件名</button
            ><button
              class="action danger quiet"
              :disabled="locked || loading || !item.available"
              @click="openPurge([item.id])"
            >
              永久移除文件
            </button>
          </div>
        </li>
      </ul>
      <div v-else-if="!loading && !listError" class="empty">
        <h2>
          {{
            page.items.length
              ? '本页没有符合状态的项目'
              : activeQuery
                ? '没有找到符合条件的项目'
                : pageIndex
                  ? '本页已无回收站项目'
                  : '回收站为空'
          }}
        </h2>
        <p class="muted">
          {{
            page.items.length
              ? '切换本页文件状态，或查看下一页。'
              : activeQuery
                ? '尝试其他文件名或原路径。'
                : pageIndex
                  ? '可以返回上一页查看其他项目。'
                  : '删除的笔记会显示在这里。'
          }}
        </p>
      </div>
      <nav class="pagination" aria-label="回收站分页">
        <button
          class="action"
          :disabled="locked || loading || pageIndex === 0"
          @click="previousPage"
        >
          上一页</button
        ><span>第 {{ pageIndex + 1 }} 页</span
        ><button class="action" :disabled="locked || loading || !page.nextCursor" @click="nextPage">
          下一页
        </button>
      </nav>
    </template>
    <section v-if="results.length" class="operation-results" aria-labelledby="trash-result-heading">
      <div class="result-heading">
        <h2 id="trash-result-heading">
          {{ lastKind === 'restore' ? '恢复' : '永久移除文件' }}结果
        </h2>
        <button
          v-if="failedIds.length"
          class="action"
          :disabled="locked || loading"
          @click="retryFailures"
        >
          {{ lastKind === 'restore' ? '仅重试本页失败项目' : '重新确认本页失败项目' }}
        </button>
      </div>
      <ul>
        <li v-for="result in results" :key="result.id">
          <span>{{ result.relativePath || resultLabels[result.id] || result.id }}</span
          ><strong :class="result.ok ? 'result-success' : 'field-error'">{{
            result.ok
              ? lastKind === 'restore'
                ? '已恢复'
                : '已移除回收站文件'
              : explain(result.code)
          }}</strong>
        </li>
      </ul>
      <p v-if="results.some((item) => !item.ok)" class="muted">
        重试只包含本页仍可读取的失败项目；已完成的项目不会再次提交。更名后再恢复会使用新的请求。
      </p>
    </section>
    <p class="retention-note muted">
      永久移除仅针对所选回收站原文件，无法在此恢复；历史版本、备份及必要的元数据仍按各自的保留规则保存。
    </p>
    <AModal
      :open="!!purgeDraft"
      title="永久移除回收站文件"
      :footer="null"
      :mask-closable="false"
      :keyboard="!busy"
      :closable="!busy"
      :destroy-on-close="true"
      @cancel="purgeDraft = undefined"
    >
      <template v-if="purgeDraft"
        ><p>将永久移除以下 {{ purgeDraft.items.length }} 个回收站原文件，无法通过回收站恢复。</p>
        <ul class="purge-items">
          <li v-for="item in purgeDraft.items" :key="item.id">{{ item.relativePath }}</li>
        </ul>
        <p>历史版本、备份及必要的元数据仍按各自保留规则保存。当前知识库中的正常笔记不会被移除。</p>
        <form class="purge-confirm" @submit.prevent="confirmPurge">
          <label for="trash-purge-confirm">输入“永久移除”确认本次所选文件</label
          ><input
            id="trash-purge-confirm"
            v-model="purgeConfirmation"
            autocomplete="off"
            :aria-invalid="!!purgeError"
            aria-describedby="trash-purge-error"
          />
          <p v-if="purgeError" id="trash-purge-error" class="field-error" role="alert">
            {{ purgeError }}
          </p>
          <div class="modal-actions">
            <button class="action" type="button" @click="purgeDraft = undefined">取消</button
            ><button class="action danger" type="submit" :disabled="busy">
              永久移除这 {{ purgeDraft.items.length }} 个文件
            </button>
          </div>
        </form></template
      >
    </AModal>
  </section>
</template>

<style scoped>
.trash-workspace {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto;
  padding: 32px clamp(18px, 4vw, 48px) 64px;
  min-width: 0;
  color: var(--text, #152c48);
  overflow-wrap: anywhere;
}
.trash-heading,
.selection-bar,
.batch-actions,
.item-actions,
.pagination,
.result-heading,
.modal-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.trash-heading {
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 24px;
}
h1,
h2,
p {
  margin: 0;
}
h1,
h2 {
  color: inherit;
}
h1 {
  font-size: 26px;
  margin: 5px 0 10px;
}
h2 {
  font-size: 16px;
  line-height: 1.5;
}
p {
  line-height: 1.75;
}
.eyebrow,
.muted,
.item-meta {
  color: var(--muted, #7188a3);
  font-size: 13px;
}
.action {
  padding: 7px 12px;
  border: 1px solid var(--border, #dae8f5);
  background: var(--panel, #fff);
  color: inherit;
  border-radius: 7px;
  min-height: 36px;
  font-size: 13px;
  white-space: nowrap;
}
.action:hover:not(:disabled) {
  border-color: var(--blue, #1688ff);
  color: var(--blue, #1688ff);
}
.action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action.primary {
  background: var(--blue, #1688ff);
  border-color: var(--blue, #1688ff);
  color: #fff;
}
.action.primary:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.06);
}
.action.danger {
  color: var(--danger, #b43e3e);
}
.action.danger:hover:not(:disabled) {
  border-color: var(--danger, #b43e3e);
  color: var(--danger, #b43e3e);
}
.action.quiet {
  border-color: transparent;
  background: transparent;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid var(--blue, #1688ff);
  outline-offset: 3px;
}
input:not([type='checkbox']),
select {
  width: 100%;
  min-width: 0;
  min-height: 38px;
  padding: 7px 10px;
  border: 1px solid var(--border, #dae8f5);
  background: var(--panel, #fff);
  color: inherit;
  border-radius: 6px;
}
input[aria-invalid='true'] {
  border-color: var(--danger, #b43e3e);
}
input[type='checkbox'] {
  accent-color: var(--blue, #1688ff);
  width: 16px;
  height: 16px;
  margin: 0;
  flex-shrink: 0;
}
.trash-search {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin: 20px 0;
}
.trash-search label {
  display: grid;
  gap: 7px;
  font-size: 12px;
}
.search-field {
  flex: 1;
}
.trash-search select {
  min-width: 145px;
}
.selection-bar {
  flex-wrap: wrap;
  padding: 14px 0;
  border-block: 1px solid var(--border, #dae8f5);
  font-size: 12px;
}
.check-label {
  display: flex;
  align-items: center;
  gap: 8px;
}
.batch-actions {
  margin-left: auto;
  flex-wrap: wrap;
}
.trash-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.trash-item {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  gap: 12px;
  padding: 22px 0;
  border-bottom: 1px solid var(--border, #dae8f5);
}
.item-check {
  padding-top: 5px;
}
.item-main {
  min-width: 0;
}
.original-path {
  font-size: 13px;
  margin: 5px 0;
  overflow-wrap: anywhere;
}
.item-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.unavailable {
  color: var(--danger, #b43e3e);
}
.item-actions {
  flex-direction: column;
  align-items: stretch;
  align-self: start;
  gap: 7px;
}
.rename-field {
  display: grid;
  gap: 7px;
  margin-top: 14px;
  font-size: 12px;
}
.rename-input {
  display: flex;
  gap: 8px;
}
.callout {
  border: 1px solid var(--border, #dae8f5);
  background: var(--surface, #f7faff);
  padding: 13px 16px;
  border-radius: 8px;
  margin: 12px 0;
  font-size: 13px;
}
.callout p {
  margin: 6px 0 10px;
}
.callout.error,
.field-error {
  color: var(--danger, #b43e3e);
}
.callout.warning {
  border-color: var(--warning, #bb8b35);
}
.success,
.result-success {
  color: var(--success, #34815a);
}
.empty {
  text-align: center;
  padding: 45px 12px;
}
.empty h2 {
  margin-bottom: 10px;
}
.pagination {
  justify-content: center;
  margin: 22px 0;
  font-size: 13px;
}
.operation-results {
  border: 1px solid var(--border, #dae8f5);
  border-radius: 8px;
  padding: 18px;
  margin-top: 20px;
}
.result-heading {
  justify-content: space-between;
  flex-wrap: wrap;
}
.operation-results ul {
  list-style: none;
  padding: 0;
  margin: 12px 0;
}
.operation-results li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(100px, 1fr);
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border, #dae8f5);
  font-size: 12px;
}
.operation-results strong {
  font-weight: 500;
}
.retention-note {
  margin-top: 24px;
}
.purge-items {
  max-height: 220px;
  overflow: auto;
  padding-left: 20px;
  overflow-wrap: anywhere;
}
.purge-confirm {
  display: grid;
  gap: 10px;
  margin-top: 18px;
  font-size: 13px;
}
.modal-actions {
  justify-content: flex-end;
  margin-top: 10px;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@media (max-width: 743px) {
  .trash-workspace {
    padding-top: 22px;
  }
  .trash-search {
    flex-wrap: wrap;
  }
  .search-field {
    flex-basis: 100%;
  }
  .trash-search label:not(.search-field) {
    flex: 1;
  }
  .batch-actions {
    margin-left: 0;
    width: 100%;
  }
  .trash-item {
    grid-template-columns: 20px minmax(0, 1fr);
  }
  .item-actions {
    grid-column: 2;
    flex-direction: row;
    flex-wrap: wrap;
  }
  .action {
    min-height: 40px;
  }
}
@media (max-width: 420px) {
  .trash-heading {
    gap: 8px;
  }
  h1 {
    font-size: 23px;
  }
  .trash-heading > .action {
    padding-inline: 8px;
  }
  .trash-search {
    gap: 8px;
  }
  .trash-search select {
    min-width: 0;
  }
  .item-actions .action {
    flex: 1;
  }
  .operation-results li {
    grid-template-columns: minmax(0, 1fr);
    gap: 4px;
  }
  .rename-input {
    flex-wrap: wrap;
  }
  .rename-input input {
    flex: 1 1 100%;
  }
  .modal-actions {
    flex-wrap: wrap;
  }
}
</style>
