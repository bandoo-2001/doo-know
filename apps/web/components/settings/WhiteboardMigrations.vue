<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Alert as AAlert, Button as AButton } from 'ant-design-vue';
import { api } from '../../api';
import type {
  WhiteboardMigration,
  WhiteboardMigrationPreflight,
} from '../../../../shared/whiteboard-migration';
import { continueWhiteboardMigration } from '../../diagrams/whiteboard-migration';
const emit = defineEmits<{ changed: []; 'open-note': [id: string] }>();
const jobs = ref<WhiteboardMigration[]>([]),
  candidates = ref<{ noteId: string; path: string }[]>([]),
  checked = ref<WhiteboardMigrationPreflight>(),
  busy = ref(false),
  error = ref('');
const labels: Record<string, string> = {
  planned: '等待浏览器生成预览',
  prepared: '预览已固定，等待切换',
  committing: '切换中，可续跑',
  committed: '迁移完成',
  references_pending: '主文档已迁移，引用待核对',
  'awaiting-native-previews': '等待生成关联白板预览',
  rolling_back: '回滚中',
  rolled_back: '已回滚',
};
async function run(work: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await work();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function load() {
  const state = await api<{
    jobs: WhiteboardMigration[];
    candidates: { noteId: string; path: string }[];
  }>('/api/whiteboard-migrations');
  jobs.value = state.jobs;
  candidates.value = state.candidates;
}
function inspect(noteId: string) {
  void run(async () => {
    checked.value = await api('/api/whiteboard-migrations/preflight/' + encodeURIComponent(noteId));
  });
}
function migrate() {
  if (!checked.value) return;
  const noteId = checked.value.noteId;
  void run(async () => {
    const plan = await api<WhiteboardMigration>('/api/whiteboard-migrations/plan', 'POST', {
      noteId,
      requestId: crypto.randomUUID(),
    });
    await load();
    await continueWhiteboardMigration(plan);
    checked.value = undefined;
    await load();
    emit('changed');
  });
}
function resume(job: WhiteboardMigration) {
  void run(async () => {
    await continueWhiteboardMigration(job);
    await load();
    emit('changed');
  });
}
function rollback(job: WhiteboardMigration) {
  void run(async () => {
    await api('/api/whiteboard-migrations/rollback', 'POST', {
      migrationId: job.id,
      requestId: 'migration-rollback-' + job.id,
    });
    await load();
    emit('changed');
  });
}
onMounted(() => void run(load));
</script>
<template>
  <section class="settings-card">
    <h2 class="settings-section-title">旧白板迁移</h2>
    <p>
      将旧白板转换为 Markdown 文档、源附件和 PNG，保留笔记身份及原始备份。迁移任务可关闭后续跑。
    </p>
    <AAlert v-if="error" type="error" :message="error" />
    <AButton size="small" :disabled="busy" @click="run(load)">刷新任务</AButton>
    <p v-if="!candidates.length && !jobs.length" class="settings-muted">没有需要迁移的旧白板。</p>
    <ul v-if="candidates.length">
      <li v-for="item in candidates" :key="item.noteId">
        <code>{{ item.path }}</code>
        <AButton size="small" :disabled="busy" @click="inspect(item.noteId)">预检</AButton>
      </li>
    </ul>
    <div v-if="checked" role="status">
      <p>
        <code>{{ checked.oldPath }}</code> → <code>{{ checked.newPath }}</code>
      </p>
      <p>入站引用 {{ checked.inbound.length }} 份；原件将保存在受控备份中。</p>
      <ul v-if="checked.issues.length">
        <li v-for="(issue, index) in checked.issues" :key="index">
          {{ issue.code }} {{ issue.path }}
        </li>
      </ul>
      <AButton :disabled="busy || checked.issues.length > 0" @click="migrate"
        >生成预览并迁移此白板</AButton
      >
    </div>
    <ul v-if="jobs.length">
      <li v-for="job in jobs" :key="job.id">
        <code>{{ job.oldPath }}</code> · {{ labels[job.status] || job.status }}
        <span v-if="job.nativePreviewNeeds?.length"
          >（还有 {{ job.nativePreviewNeeds.length }} 份场景预览）</span
        >
        <AButton
          v-if="!['rolled_back', 'committed'].includes(job.status)"
          size="small"
          :disabled="busy"
          @click="resume(job)"
          >续跑</AButton
        >
        <AButton
          v-if="['committed', 'references_pending'].includes(job.status)"
          size="small"
          :disabled="busy"
          @click="emit('open-note', job.noteId)"
          >打开文档</AButton
        >
        <AButton
          v-if="['committed', 'references_pending'].includes(job.status)"
          size="small"
          :disabled="busy"
          @click="rollback(job)"
          >回滚未编辑的迁移</AButton
        >
        <p
          v-for="refResult in (job.references || []).filter((r) => r.status !== 'rewritten')"
          :key="refResult.noteId"
          class="settings-muted"
        >
          引用待核对：{{ refResult.code }}
        </p>
      </li>
    </ul>
    <p v-if="busy" role="status">正在核对并生成预览，请保留此页面…</p>
  </section>
</template>
