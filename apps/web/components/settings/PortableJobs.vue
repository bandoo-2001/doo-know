<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import { api } from '../../api';
import type {
  PortableOwnerJob,
  PortableImportResult,
  PortableDelivery,
} from '../../../../shared/portable-delivery-contracts';
const emit = defineEmits<{
  'open-note': [id: string];
  resume: [job: PortableOwnerJob];
  changed: [];
}>();
const jobs = ref<PortableOwnerJob[]>([]),
  error = ref(''),
  busy = ref(false);
const labels = {
  running: '进行中',
  completed: '已完成',
  failed: '失败，尚未完成',
  cancelled: '已取消',
  interrupted: '已中断，尚未完成',
};
const imports = (job: PortableOwnerJob) =>
  job.kind !== 'export' ? (job.result as PortableImportResult | undefined) : undefined;
const download = (job: PortableOwnerJob) =>
  job.kind === 'export' && job.state === 'completed'
    ? (job.result as PortableDelivery | undefined)?.downloadUrl
    : undefined;
async function refresh() {
  try {
    jobs.value = await api<PortableOwnerJob[]>('/api/portable-jobs');
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function action(job: PortableOwnerJob, kind: 'cancel' | 'retry') {
  busy.value = true;
  try {
    await api('/api/portable-jobs/' + job.id + '/' + kind, 'POST', {});
    await refresh();
    emit('changed');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 2000);
});
onBeforeUnmount(() => clearInterval(timer));
defineExpose({ refresh });
</script>
<template>
  <section aria-label="便携任务与结果" class="portable-jobs">
    <h3>便携任务与结果</h3>
    <AButton size="small" @click="refresh">刷新结果</AButton>
    <AAlert v-if="error" type="error" :message="error" show-icon />
    <p v-if="!jobs.length" class="settings-muted">暂无便携任务。</p>
    <article v-for="job in jobs" :key="job.id">
      <p>
        {{
          job.kind === 'export'
            ? '便携导出'
            : job.kind === 'import-directory'
              ? '目录整包导入'
              : '归档整包导入'
        }}
        · {{ labels[job.state] }}
      </p>
      <p v-if="job.error" role="status">{{ job.error }}</p>
      <p v-if="job.needsSource" class="settings-muted">
        重新选择原始完整资料后继续。已创建的笔记保留，使用原请求继续不会重复创建。
      </p>
      <ul v-if="imports(job)?.notes.length">
        <li v-for="note in imports(job)!.notes" :key="note.noteId">
          <button type="button" @click="emit('open-note', note.noteId)">
            {{ note.relativePath }}
          </button>
        </li>
      </ul>
      <a v-if="download(job)" :href="download(job)" download>下载便携结果</a>
      <AButton v-if="job.state === 'running'" :disabled="busy" @click="action(job, 'cancel')"
        >取消任务</AButton
      >
      <AButton
        v-else-if="job.state !== 'completed' && job.kind === 'export'"
        :disabled="busy"
        @click="action(job, 'retry')"
        >重试导出</AButton
      >
      <AButton v-else-if="job.needsSource" :disabled="busy" @click="emit('resume', job)"
        >选择原资料继续</AButton
      >
    </article>
  </section>
</template>
<style scoped>
.portable-jobs article {
  border-top: 1px solid var(--border, #e3e6ec);
  padding: 12px 0;
  overflow-wrap: anywhere;
}
.portable-jobs ul {
  padding-left: 20px;
}
</style>
