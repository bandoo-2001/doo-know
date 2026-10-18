<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Select as ASelect,
} from 'ant-design-vue';
import { api } from '../../api';
import type {
  ImportEntry,
  ImportPreview,
  TransferTask,
} from '../../../../shared/transfer-contracts';
import { encodeImportFile, importPath } from './transfer-files';
import TransferTasks from './TransferTasks.vue';
const props = withDefaults(defineProps<{ folderPath?: string; showExport?: boolean }>(), {
  folderPath: '00-Inbox',
  showExport: true,
});
const emit = defineEmits<{ 'open-note': [id: string]; changed: [] }>();
const folder = ref(props.folderPath),
  collision = ref<'skip' | 'rename'>('skip'),
  entries = ref<ImportEntry[]>([]),
  preview = ref<ImportPreview>(),
  error = ref(''),
  busy = ref(false),
  notice = ref(''),
  exportFolder = ref(''),
  exportBusy = ref(false),
  exportError = ref('');
const tasks = ref<InstanceType<typeof TransferTasks>>();
let requestId = crypto.randomUUID(),
  destinationEpoch = 0;
watch(
  () => props.folderPath,
  (value) => {
    folder.value = value;
  },
  { flush: 'sync' },
);
watch(
  [folder, collision],
  () => {
    destinationEpoch++;
    preview.value = undefined;
    requestId = crypto.randomUUID();
    error.value = '';
    notice.value = busy.value
      ? '导入设置已改变。正在处理的请求仍使用原位置，完成后请重新预览。'
      : '导入设置已改变，请重新预览。';
  },
  { flush: 'sync' },
);
async function select(event: Event, directory = false) {
  if (busy.value) return;
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  entries.value = [];
  preview.value = undefined;
  error.value = '';
  notice.value = '';
  requestId = crypto.randomUUID();
  if (!files.length) return;
  busy.value = true;
  try {
    if (files.length > 200) throw Error('每批最多 200 个文件，请分批导入。');
    if (files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024)
      throw Error('每批最多 20 MiB，请分批导入。');
    const result: ImportEntry[] = [];
    for (const file of files) {
      const path = importPath(directory ? file.webkitRelativePath : file.name, directory);
      const limit = /\.md$/i.test(path) ? 1024 * 1024 : 10 * 1024 * 1024;
      if (file.size > limit)
        throw Error(path + ' 超出单文件大小限制。Markdown 最多 1 MiB，附件最多 10 MiB。');
      result.push(await encodeImportFile(file, path));
    }
    entries.value = result;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
    input.value = '';
  }
}
async function inspect() {
  if (busy.value) return;
  const epoch = destinationEpoch;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await api<ImportPreview>('/api/manage/import/preview', 'POST', {
      entries: entries.value,
      folderPath: folder.value,
      collision: collision.value,
    });
    if (epoch === destinationEpoch) preview.value = result;
  } catch (e) {
    if (epoch === destinationEpoch) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function execute() {
  if (busy.value || !preview.value) return;
  const epoch = destinationEpoch,
    submittedFolder = folder.value;
  busy.value = true;
  error.value = '';
  try {
    await api<TransferTask>('/api/manage/import', 'POST', {
      entries: entries.value,
      folderPath: folder.value,
      collision: collision.value,
      requestId,
    });
    if (epoch === destinationEpoch) {
      notice.value = '导入任务已提交，可在下方查看逐项结果。';
      preview.value = undefined;
      entries.value = [];
      requestId = crypto.randomUUID();
    } else
      notice.value =
        '导入任务已按原位置「' +
        (submittedFolder || '知识库根目录') +
        '」提交。当前目标已改变，请重新预览。';
    await tasks.value?.refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
let exportRequest = crypto.randomUUID();
watch(exportFolder, () => {
  exportRequest = crypto.randomUUID();
});
async function exportLibrary() {
  exportBusy.value = true;
  exportError.value = '';
  try {
    await api<TransferTask>('/api/manage/export', 'POST', {
      ...(exportFolder.value ? { folderPath: exportFolder.value } : {}),
      requestId: exportRequest,
    });
    exportRequest = crypto.randomUUID();
    notice.value = '导出任务已提交，完成后可在下方下载归档。';
    await tasks.value?.refresh();
  } catch (e) {
    exportError.value = (e as Error).message;
  } finally {
    exportBusy.value = false;
  }
}
</script>
<template>
  <div class="settings-stack">
    <section class="settings-card">
      <h2>批量导入</h2>
      <p class="settings-muted">
        选择 Markdown 与附件，或选择整个目录保留相对路径。每批最多 200 个文件、合计 20
        MiB。先预览，再确认导入。
      </p>
      <div class="settings-form">
        <div class="settings-field">
          <label for="import-files">选择文件</label
          ><input
            id="import-files"
            type="file"
            multiple
            :disabled="busy"
            @change="select($event)"
          />
        </div>
        <div class="settings-field">
          <label for="import-directory">选择目录（保留目录内结构）</label
          ><input
            id="import-directory"
            type="file"
            multiple
            webkitdirectory
            :disabled="busy"
            @change="select($event, true)"
          />
        </div>
        <div class="settings-field">
          <label for="import-destination">导入到知识库目录</label
          ><AInput
            id="import-destination"
            v-model:value="folder"
            placeholder="例如 00-Inbox；留空保留完整分类路径"
            :disabled="busy"
          /><span class="settings-muted"
            >使用知识库内的相对目录。留空适用于从完整导出恢复目录结构。</span
          >
        </div>
        <div class="settings-field">
          <label for="import-collision">遇到同名文件</label
          ><ASelect
            id="import-collision"
            v-model:value="collision"
            :disabled="busy"
            :options="[
              { value: 'skip', label: '跳过已有文件' },
              { value: 'rename', label: '自动使用新文件名' },
            ]"
          />
        </div>
      </div>
      <AAlert v-if="error" type="error" :message="error" show-icon />
      <p v-if="entries.length" class="settings-muted" role="status">
        已选择 {{ entries.length }} 个文件。
      </p>
      <template v-if="preview"
        ><div class="settings-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">导入位置</th>
                <th scope="col">类型</th>
                <th scope="col">处理方式</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in preview.items" :key="item.path">
                <td>{{ item.targetPath }}</td>
                <td>{{ item.kind === 'note' ? '笔记' : '附件' }}</td>
                <td>{{ { create: '新建', skip: '跳过', rename: '使用新名称' }[item.decision] }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="settings-muted">合计 {{ (preview.totalBytes / 1024).toFixed(1) }} KiB。</p>
        <AAlert
          v-for="warning in preview.warnings"
          :key="warning"
          type="warning"
          :message="warning"
      /></template>
      <div class="settings-actions">
        <AButton :loading="busy" :disabled="busy || !entries.length" @click="inspect"
          >预览导入</AButton
        ><AButton v-if="preview" type="primary" :loading="busy" :disabled="busy" @click="execute"
          >确认导入 {{ preview.items.length }} 个文件</AButton
        ><AButton
          v-if="entries.length && !busy"
          @click="
            entries = [];
            preview = undefined;
          "
          >清除选择</AButton
        >
      </div>
      <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
    </section>
    <section v-if="showExport" class="settings-card">
      <h2>导出资料</h2>
      <p class="settings-muted">
        导出
        Markdown、可读取的关联附件和范围清单。导出归档适合迁移原文；账户、历史版本与完整恢复请使用加密备份。
      </p>
      <div class="settings-form">
        <div class="settings-field">
          <label for="export-folder">仅导出指定目录（可选）</label
          ><AInput
            id="export-folder"
            v-model:value="exportFolder"
            placeholder="留空导出整个知识库"
            :disabled="exportBusy"
          />
        </div>
      </div>
      <AAlert v-if="exportError" type="error" :message="exportError" show-icon />
      <div class="settings-actions">
        <AButton :loading="exportBusy" @click="exportLibrary">{{
          exportFolder ? '导出此目录' : '导出整个知识库'
        }}</AButton>
      </div>
    </section>
    <TransferTasks
      ref="tasks"
      :kinds="['import', 'export']"
      @open-note="emit('open-note', $event)"
      @changed="emit('changed')"
    />
  </div>
</template>
