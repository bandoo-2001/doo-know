<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import { api } from '../../api';
import { fileBaseline } from '../../diagrams/file-baseline';
import { completeOrganizationOperation } from '../../diagrams/operation-previews';
import type { NoteInfo } from '../../../../shared/knowledge-contracts';
import type {
  OrganizationContext,
  DirectoryInfo,
  DirectoryPage,
  HistoryPage,
  OrganizationOperation,
  OrganizationReply,
  OrganizeInput,
} from '../../../../shared/organization-contracts';
import DirectoryTreeSelect from '../DirectoryTreeSelect.vue';
const emit = defineEmits<{ changed: [] }>();
const notes = ref<NoteInfo[]>([]),
  directories = ref<DirectoryInfo[]>([]),
  operations = ref<OrganizationOperation[]>([]),
  selected = ref<string[]>([]),
  folder = ref('00-Inbox'),
  busy = ref(false),
  loading = ref(false),
  error = ref(''),
  notice = ref(''),
  context = ref<OrganizationContext>();
let alive = true,
  pending: OrganizeInput | undefined,
  requestId = crypto.randomUUID();
const undoRequests = new Map<string, string>();
const folders = computed(() => [
  { label: '知识库根目录', value: '' },
  ...directories.value
    .filter((d) => d.writable && d.organizable)
    .map((d) => ({ label: d.path, value: d.path })),
]);
const locked = computed(() => busy.value || !!pending);
function status(value: string) {
  return (
    {
      queued: '等待执行',
      running: '正在整理',
      committing: '正在提交',
      awaiting_preview: '等待图形预览',
      succeeded: '已完成',
      failed: '未完成',
      cancelled: '已取消',
      needs_reconciliation: '需要核对',
    }[value] || '等待核对'
  );
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const [c, n, h] = await Promise.all([
      api<OrganizationContext>('/api/organization/context'),
      api<NoteInfo[]>('/api/notes'),
      api<HistoryPage>('/api/organization/operations?limit=20'),
    ]);
    const all: DirectoryInfo[] = [],
      parents: (string | undefined)[] = [undefined];
    for (const parent of parents) {
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({
          limit: '50',
          ...(parent ? { parentId: parent } : {}),
          ...(cursor ? { cursor } : {}),
        });
        const page = await api<DirectoryPage>('/api/organization/directories?' + q);
        if (!alive) return;
        if (page.libraryId !== c.libraryId || page.structureRevision !== c.structureRevision)
          throw Error('目录刚刚变化，请刷新后重试');
        all.push(...page.items);
        parents.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
        if (all.length > c.limits.directories) throw Error('目录较多，请缩小知识库范围后再整理');
      } while (cursor);
    }
    if (!alive) return;
    context.value = c;
    notes.value = n;
    operations.value = h.items;
    directories.value = all;
    selected.value = selected.value.filter((id) => n.some((note) => note.id === id));
  } catch (cause) {
    if (alive) error.value = (cause as Error).message;
  } finally {
    if (alive) loading.value = false;
  }
}
async function settle(reply: OrganizationReply) {
  const result = await completeOrganizationOperation(reply.operation.operationId);
  if (!alive) return;
  notice.value = '整理已完成，可从记录撤销。';
  emit('changed');
  return result;
}
async function move() {
  if (busy.value || !selected.value.length || !context.value) return;
  if (selected.value.length > context.value.limits.actions) {
    error.value = '一次最多选择 ' + context.value.limits.actions + ' 篇笔记';
    return;
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (!pending) {
      const destination = folder.value
        ? directories.value.find((d) => d.path === folder.value)
        : undefined;
      if (folder.value && !destination) throw Error('请选择已有的目标目录');
      const originals = await Promise.all(
        selected.value.map((id) => fileBaseline(id, () => alive)),
      );
      if (!alive) return;
      pending = {
        requestId,
        libraryId: context.value.libraryId,
        expectedStructureRevision: context.value.structureRevision,
        actions: originals.map((note) => {
          if (!note?.contentHash) throw Error('原文版本尚未准备好，请刷新');
          return {
            type: 'move_note' as const,
            noteId: note.id,
            toDirectoryId: destination?.id ?? null,
            fileName: note.relativePath.split('/').at(-1)!,
            expectedModifiedAt: note.modifiedAt,
            expectedContentHash: note.contentHash,
          };
        }),
      };
    }
    const reply = await api<OrganizationReply>('/api/organization/operations', 'POST', pending);
    await settle(reply);
    pending = undefined;
    requestId = crypto.randomUUID();
    selected.value = [];
    await load();
  } catch (cause) {
    if (alive) {
      const message = (cause as Error).message;
      await load();
      const known = operations.value.find(
        (operation) => operation.requestId === pending?.requestId,
      );
      if (known && ['failed', 'cancelled', 'succeeded'].includes(known.status)) {
        pending = undefined;
        requestId = crypto.randomUUID();
      }
      error.value = message;
    }
  } finally {
    if (alive) busy.value = false;
  }
}
async function resume(operation: OrganizationOperation) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await completeOrganizationOperation(operation.operationId);
    pending = undefined;
    requestId = crypto.randomUUID();
    emit('changed');
    await load();
  } catch (cause) {
    if (alive) error.value = (cause as Error).message;
  } finally {
    if (alive) busy.value = false;
  }
}
async function undo(operation: OrganizationOperation) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const id = undoRequests.get(operation.operationId) || crypto.randomUUID();
    undoRequests.set(operation.operationId, id);
    await settle(
      await api<OrganizationReply>(
        '/api/organization/operations/' + operation.operationId + '/undo',
        'POST',
        { requestId: id },
      ),
    );
    notice.value = '整理已撤销，原身份和关联仍保留。';
    await load();
  } catch (cause) {
    if (alive) error.value = (cause as Error).message;
  } finally {
    if (alive) busy.value = false;
  }
}
onMounted(() => void load());
onBeforeUnmount(() => {
  alive = false;
});
</script>
<template>
  <section class="settings-card">
    <div class="settings-item-header">
      <div>
        <h2 class="settings-section-title">批量整理</h2>
        <p>移动已保存的笔记，保留身份并更新关联链接。图形预览准备完成后才会提交。</p>
      </div>
      <AButton size="small" :disabled="busy" :loading="loading" @click="load">刷新整理记录</AButton>
    </div>
    <AAlert v-if="error" type="error" :message="error" role="alert" />
    <p v-if="notice" role="status">{{ notice }}</p>
    <details>
      <summary>选择需要移动的笔记（已选 {{ selected.length }} 篇）</summary>
      <div class="organization-notes">
        <label v-for="note in notes" :key="note.id"
          ><input
            v-model="selected"
            type="checkbox"
            :value="note.id"
            :aria-label="'选择 ' + note.relativePath"
            :disabled="locked || loading"
          />{{ note.relativePath }}</label
        >
      </div>
    </details>
    <label>整理目标目录</label
    ><DirectoryTreeSelect
      v-model:value="folder"
      :folders="folders"
      label="整理目标目录"
      :disabled="locked || loading"
    />
    <div class="dialog-actions">
      <AButton
        type="primary"
        :loading="busy"
        :disabled="busy || loading || !selected.length"
        @click="move"
        >{{ pending ? '核对上次整理' : '移动选中笔记' }}</AButton
      >
    </div>
    <ul class="organization-history">
      <li v-for="operation in operations" :key="operation.operationId">
        <span
          >{{ operation.kind === 'organization.undo' ? '撤销整理' : '移动笔记' }} ·
          {{ status(operation.status) }}</span
        ><span v-if="operation.result"> · {{ operation.result.changes.length }} 项变更</span
        ><AButton
          v-if="['queued', 'running', 'committing', 'awaiting_preview'].includes(operation.status)"
          size="small"
          :disabled="busy"
          @click="resume(operation)"
          >继续此整理</AButton
        ><AButton
          v-if="operation.status === 'succeeded' && operation.result?.undoAvailable"
          size="small"
          :disabled="busy"
          @click="undo(operation)"
          >撤销此整理</AButton
        >
      </li>
    </ul>
  </section>
</template>
<style scoped>
.organization-notes {
  max-height: 16rem;
  overflow: auto;
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.organization-notes label {
  display: flex;
  align-items: center;
  gap: 8px;
  overflow-wrap: anywhere;
}
.organization-history {
  padding-left: 20px;
  display: grid;
  gap: 8px;
}
.organization-history button {
  margin-inline-start: 10px;
}
</style>
