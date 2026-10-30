<script setup lang="ts">
import Icon from '../Icon.vue';
import { computed, defineComponent, h, ref, watch } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Select as ASelect,
} from 'ant-design-vue';
import { api } from '../../api';
import type { TreeEntry } from '../../../../shared/contracts';
import type {
  ImportEntry,
  ImportPreview,
  TransferTask,
} from '../../../../shared/transfer-contracts';
import DirectoryTreeSelect from '../DirectoryTreeSelect.vue';
import { encodeImportFile, importPath } from './transfer-files';
import SettingsActionCard from './SettingsActionCard.vue';
import SettingsOverlay from './SettingsOverlay.vue';
import TransferTasks from './TransferTasks.vue';

const props = withDefaults(
  defineProps<{ folderPath?: string; showExport?: boolean; inline?: boolean }>(),
  { folderPath: '00-Inbox', showExport: true, inline: false },
);
const emit = defineEmits<{
  'open-note': [id: string];
  changed: [];
  busy: [value: boolean];
}>();
const importOpen = ref(false),
  exportOpen = ref(false),
  step = ref<1 | 2 | 3>(1),
  folder = ref(props.folderPath),
  collision = ref<'skip' | 'rename'>('skip'),
  entries = ref<ImportEntry[]>([]),
  selectedBytes = ref(0),
  preview = ref<ImportPreview>(),
  error = ref(''),
  busy = ref(false),
  importNotice = ref(''),
  notice = ref(''),
  exportScope = ref<'library' | 'folder'>('library'),
  exportFolder = ref(''),
  exportBusy = ref(false),
  exportError = ref(''),
  availableFolders = ref<{ label: string; value: string }[]>([]),
  foldersLoading = ref(false),
  foldersError = ref('');
const tasks = ref<InstanceType<typeof TransferTasks>>();
const importDirty = computed(
  () => entries.value.length > 0 || folder.value !== props.folderPath || collision.value !== 'skip',
);
const previewCounts = computed(() => ({
  create: preview.value?.items.filter((item) => item.decision === 'create').length || 0,
  rename: preview.value?.items.filter((item) => item.decision === 'rename').length || 0,
  skip: preview.value?.items.filter((item) => item.decision === 'skip').length || 0,
}));
let requestId = crypto.randomUUID(),
  destinationEpoch = 0;

watch([busy, exportBusy], ([importing, exporting]) => emit('busy', importing || exporting));
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
    const hadPreview = !!preview.value;
    invalidatePreview();
    error.value = '';
    importNotice.value = busy.value
      ? '导入设置已改变。正在处理的请求仍使用原位置，完成后请重新预览。'
      : hadPreview
        ? '导入设置已改变，原预览已失效，请重新预览。'
        : '';
  },
  { flush: 'sync' },
);
function invalidatePreview() {
  destinationEpoch++;
  preview.value = undefined;
  step.value = 1;
  requestId = crypto.randomUUID();
}
function clearSelection() {
  invalidatePreview();
  entries.value = [];
  selectedBytes.value = 0;
  error.value = '';
  importNotice.value = '';
}
function resetImport() {
  clearSelection();
  folder.value = props.folderPath;
  collision.value = 'skip';
  importNotice.value = '';
}
function editSelection() {
  invalidatePreview();
  error.value = '';
  importNotice.value = '返回修改后需要重新预览，确认最新的导入位置与处理方式。';
}
async function select(event: Event, directory = false) {
  if (busy.value) return;
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  clearSelection();
  busy.value = true;
  try {
    if (files.length > 200) throw Error('每批最多 200 个文件，请分批导入。');
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    if (totalBytes > 20 * 1024 * 1024) throw Error('每批最多 20 MiB，请分批导入。');
    const result: ImportEntry[] = [];
    for (const file of files) {
      const path = importPath(directory ? file.webkitRelativePath : file.name, directory);
      const limit = /\.excalidraw$/i.test(path)
        ? 8 * 1024 * 1024
        : /\.md$/i.test(path)
          ? 1024 * 1024
          : 10 * 1024 * 1024;
      if (file.size > limit)
        throw Error(
          path + ' 超出单文件大小限制。Markdown 最多 1 MiB，白板最多 8 MiB，附件最多 10 MiB。',
        );
      result.push(await encodeImportFile(file, path));
    }
    entries.value = result;
    selectedBytes.value = totalBytes;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
    input.value = '';
  }
}
async function inspect() {
  if (busy.value || !entries.value.length) return;
  const epoch = destinationEpoch;
  busy.value = true;
  error.value = '';
  importNotice.value = '';
  try {
    const result = await api<ImportPreview>('/api/manage/import/preview', 'POST', {
      entries: entries.value,
      folderPath: folder.value,
      collision: collision.value,
    });
    if (epoch === destinationEpoch) {
      preview.value = result;
      step.value = 2;
    }
  } catch (e) {
    if (epoch === destinationEpoch) error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function execute() {
  if (busy.value || !preview.value || step.value !== 3) return;
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
      clearSelection();
      importOpen.value = false;
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
watch([exportFolder, exportScope], () => {
  exportRequest = crypto.randomUUID();
});
watch(
  [importOpen, exportOpen, () => props.inline],
  ([importing, exporting, inline]) => {
    if (importing || exporting || inline) void loadFolders();
  },
  { immediate: true },
);
async function loadFolders() {
  if (foldersLoading.value) return;
  foldersLoading.value = true;
  foldersError.value = '';
  try {
    const tree = await api<TreeEntry[]>('/api/tree');
    const collect = (items: TreeEntry[]): { label: string; value: string }[] =>
      items.flatMap((item) =>
        item.type === 'folder'
          ? [{ label: item.path, value: item.path }, ...collect(item.children || [])]
          : [],
      );
    availableFolders.value = collect(tree);
  } catch (e) {
    foldersError.value = (e as Error).message;
  } finally {
    foldersLoading.value = false;
  }
}
function resetExport() {
  exportScope.value = 'library';
  exportFolder.value = '';
  exportError.value = '';
}
async function exportLibrary() {
  if (exportBusy.value || (exportScope.value === 'folder' && !exportFolder.value)) return;
  exportBusy.value = true;
  exportError.value = '';
  try {
    await api<TransferTask>('/api/manage/export', 'POST', {
      ...(exportScope.value === 'folder' ? { folderPath: exportFolder.value } : {}),
      requestId: exportRequest,
    });
    exportRequest = crypto.randomUUID();
    notice.value = '导出任务已提交，完成后可在下方下载归档。';
    exportOpen.value = false;
    await tasks.value?.refresh();
  } catch (e) {
    exportError.value = (e as Error).message;
  } finally {
    exportBusy.value = false;
  }
}

// Workspace supplies its own modal; reuse the form there without a second overlay.
const ImportContainer = defineComponent({
  name: 'TransferImportContainer',
  setup(_, { slots }) {
    return () =>
      props.inline
        ? h('section', { class: 'transfer-import-inline settings-workspace' }, [
            slots.default?.(),
            h('div', { class: 'settings-actions' }, slots.footer?.({ close: clearSelection })),
          ])
        : h(
            SettingsOverlay,
            {
              show: importOpen.value,
              title: '批量导入',
              description: '先选择资料，再检查预览，最后确认导入。',
              icon: 'folder',
              kind: 'drawer',
              width: 840,
              busy: busy.value,
              dirty: importDirty.value,
              'onUpdate:show': (value: boolean) => (importOpen.value = value),
              onAfterLeave: resetImport,
            },
            slots,
          );
  },
});
</script>
<template>
  <div class="settings-stack transfer-panel">
    <div v-if="!inline" class="transfer-action-grid">
      <SettingsActionCard
        title="批量导入"
        description="导入 Markdown、Excalidraw 白板与附件，支持保留目录结构。"
        icon="upload"
        action-label="批量导入"
        @open="importOpen = true"
      />
      <SettingsActionCard
        v-if="showExport"
        title="导出资料"
        description="将整个知识库或指定目录打包，方便迁移原文。"
        icon="download"
        action-label="导出资料"
        @open="exportOpen = true"
      />
    </div>

    <ImportContainer>
      <template #default>
        <div v-if="inline || importOpen" class="transfer-import-flow">
          <ol class="transfer-steps" aria-label="批量导入步骤">
            <li :class="{ active: step === 1 }" :aria-current="step === 1 ? 'step' : undefined">
              <span>1</span>选择资料
            </li>
            <li :class="{ active: step === 2 }" :aria-current="step === 2 ? 'step' : undefined">
              <span>2</span>检查预览
            </li>
            <li :class="{ active: step === 3 }" :aria-current="step === 3 ? 'step' : undefined">
              <span>3</span>确认导入
            </li>
          </ol>

          <template v-if="step === 1">
            <h3>选择资料与导入位置</h3>
            <p class="settings-muted">
              选择 Markdown、Excalidraw 白板与附件，或选择整个目录保留目录内结构。每批最多 200
              个文件、合计 20 MiB。选择后先预览。
            </p>
            <div class="settings-form transfer-form">
              <div class="settings-field">
                <label for="import-files">选择文件</label>
                <input
                  id="import-files"
                  type="file"
                  multiple
                  :disabled="busy"
                  @change="select($event)"
                />
              </div>
              <div class="settings-field">
                <label for="import-directory">选择目录（保留目录内结构）</label>
                <input
                  id="import-directory"
                  type="file"
                  multiple
                  webkitdirectory
                  :disabled="busy"
                  @change="select($event, true)"
                />
              </div>
              <div class="settings-field">
                <label>选择已有目录（可选）</label>
                <DirectoryTreeSelect
                  v-model:value="folder"
                  :folders="availableFolders"
                  label="选择已有目录（可选）"
                  root-label="保留完整分类路径"
                  :disabled="busy || foldersLoading"
                />
                <span v-if="foldersLoading" class="settings-muted">正在读取目录…</span>
                <AAlert v-if="foldersError" type="error" :message="foldersError" show-icon>
                  <template #action>
                    <AButton size="small" :loading="foldersLoading" @click="loadFolders"
                      >重新读取目录</AButton
                    >
                  </template>
                </AAlert>
              </div>
              <div class="settings-field">
                <label for="import-destination">导入到知识库目录</label>
                <AInput
                  id="import-destination"
                  v-model:value="folder"
                  placeholder="例如 00-Inbox；留空保留完整分类路径"
                  :disabled="busy"
                />
                <span class="settings-muted"
                  >可选择已有目录，也可填写新的相对目录。留空适用于从完整导出恢复目录结构。</span
                >
              </div>
              <div class="settings-field">
                <label for="import-collision">遇到同名文件</label>
                <ASelect
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
            <details v-if="entries.length" class="transfer-selection">
              <summary>
                已选择 {{ entries.length }} 个文件 · {{ (selectedBytes / 1024).toFixed(1) }} KiB
              </summary>
              <ul>
                <li v-for="entry in entries" :key="entry.path">{{ entry.path }}</li>
              </ul>
            </details>
          </template>

          <template v-else-if="step === 2 && preview">
            <h3>检查导入预览</h3>
            <p class="settings-muted">
              以下是知识库返回的预览。请检查导入位置与同名文件的处理方式。
            </p>
            <div class="settings-table-scroll">
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
                    <td>
                      {{ { create: '新建', skip: '跳过', rename: '使用新名称' }[item.decision] }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="settings-muted">
              {{ preview.items.length }} 个文件 · 合计
              {{ (preview.totalBytes / 1024).toFixed(1) }} KiB
            </p>
          </template>

          <template v-else-if="step === 3 && preview">
            <h3>确认本次导入</h3>
            <dl class="transfer-review">
              <div>
                <dt>导入位置</dt>
                <dd>{{ folder || '知识库根目录（保留完整分类路径）' }}</dd>
              </div>
              <div>
                <dt>资料数量</dt>
                <dd>{{ preview.items.length }} 个文件</dd>
              </div>
              <div>
                <dt>处理结果</dt>
                <dd>
                  新建 {{ previewCounts.create }} 个 · 使用新名称 {{ previewCounts.rename }} 个 ·
                  跳过 {{ previewCounts.skip }} 个
                </dd>
              </div>
              <div>
                <dt>同名处理</dt>
                <dd>{{ collision === 'skip' ? '跳过已有文件' : '自动使用新文件名' }}</dd>
              </div>
            </dl>
            <p class="settings-muted">确认后创建后台任务，关闭面板后可在「任务与结果」查看进度。</p>
          </template>

          <AAlert
            v-for="warning in preview?.warnings || []"
            :key="warning"
            type="warning"
            :message="warning"
            show-icon
          />
          <AAlert v-if="error" type="error" :message="error" show-icon />
          <p v-if="importNotice" class="settings-muted" role="status">{{ importNotice }}</p>
        </div>
      </template>
      <template #footer="{ close }">
        <AButton v-if="!inline" :disabled="busy" @click="close">取消</AButton>
        <AButton v-if="step === 1 && entries.length" :disabled="busy" @click="clearSelection"
          >清除选择</AButton
        >
        <AButton
          v-if="step === 1"
          type="primary"
          :loading="busy"
          :disabled="busy || !entries.length"
          @click="inspect"
          ><template #icon><Icon class="settings-button-icon" name="eye" :size="15" /></template
          >预览导入</AButton
        >
        <template v-else-if="step === 2">
          <AButton :disabled="busy" @click="editSelection"
            ><template #icon><Icon class="settings-button-icon" name="back" :size="15" /></template
            >返回修改</AButton
          >
          <AButton type="primary" :disabled="busy || !preview" @click="step = 3"
            ><template #icon
              ><Icon class="settings-button-icon" name="forward" :size="15" /></template
            >下一步：确认导入</AButton
          >
        </template>
        <template v-else-if="step === 3 && preview">
          <AButton :disabled="busy" @click="step = 2"
            ><template #icon><Icon class="settings-button-icon" name="back" :size="15" /></template
            >返回预览</AButton
          >
          <AButton type="primary" :loading="busy" :disabled="busy" @click="execute"
            ><template #icon
              ><Icon class="settings-button-icon" name="upload" :size="15" /></template
            >确认导入 {{ preview.items.length }} 个文件</AButton
          >
        </template>
      </template>
    </ImportContainer>

    <SettingsOverlay
      v-if="showExport && !inline"
      v-model:show="exportOpen"
      title="导出资料"
      description="选择导出范围，完成后下载资料归档。"
      icon="download"
      :width="560"
      :busy="exportBusy"
      :dirty="exportScope !== 'library' || !!exportFolder"
      @after-leave="resetExport"
    >
      <template v-if="exportOpen">
        <p class="settings-muted">
          包含 Markdown、Excalidraw
          白板、可读取的关联附件和范围清单。账户、历史版本与完整恢复请使用加密备份。
        </p>
        <div class="settings-form transfer-form">
          <div class="settings-field">
            <label for="export-scope">导出范围</label>
            <ASelect
              id="export-scope"
              v-model:value="exportScope"
              :disabled="exportBusy"
              :options="[
                { value: 'library', label: '整个知识库' },
                { value: 'folder', label: '指定目录' },
              ]"
            />
          </div>
          <div v-if="exportScope === 'folder'" class="settings-field">
            <label>仅导出指定目录</label>
            <DirectoryTreeSelect
              v-model:value="exportFolder"
              label="仅导出指定目录"
              :folders="availableFolders"
              :disabled="exportBusy || foldersLoading"
            />
            <span v-if="foldersLoading" class="settings-muted" role="status">正在读取目录…</span>
            <span v-else-if="!exportFolder" class="settings-muted">请选择需要导出的目录。</span>
          </div>
        </div>
        <AAlert
          v-if="foldersError && exportScope === 'folder'"
          type="error"
          :message="foldersError"
          show-icon
        >
          <template #action
            ><AButton size="small" :loading="foldersLoading" @click="loadFolders"
              ><template #icon
                ><Icon class="settings-button-icon" name="refresh" :size="15" /></template
              >重新读取目录</AButton
            ></template
          >
        </AAlert>
        <AAlert v-if="exportError" type="error" :message="exportError" show-icon />
        <p class="settings-muted">任务会在后台继续，导出完成后在「任务与结果」下载归档。</p>
      </template>
      <template #footer="{ close }">
        <AButton :disabled="exportBusy" @click="close">取消</AButton>
        <AButton
          type="primary"
          :loading="exportBusy"
          :disabled="exportBusy || (exportScope === 'folder' && !exportFolder)"
          @click="exportLibrary"
          ><template #icon
            ><Icon class="settings-button-icon" name="download" :size="15" /></template
          >{{ exportScope === 'folder' ? '导出此目录' : '导出整个知识库' }}</AButton
        >
      </template>
    </SettingsOverlay>

    <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
    <TransferTasks
      ref="tasks"
      :kinds="['import', 'export']"
      poll-always
      @open-note="emit('open-note', $event)"
      @changed="emit('changed')"
    />
  </div>
</template>

<style scoped src="./file-input.css"></style>
<style scoped>
.transfer-action-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  gap: 14px;
}
.transfer-import-inline.settings-workspace {
  padding: 0;
  max-width: none;
  margin: 0;
}
.transfer-import-flow {
  min-width: 0;
}
.transfer-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 0 0 22px;
  margin: 0 0 24px;
  border-bottom: 1px solid var(--border, #e3e6ec);
  list-style: none;
}
.transfer-steps li {
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--muted, #687486);
  font-size: 12px;
}
.transfer-steps li span {
  display: grid;
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  place-items: center;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 50%;
}
.transfer-steps li.active {
  color: var(--blue, #4566c6);
  font-weight: 600;
}
.transfer-steps li.active span {
  border-color: currentColor;
  background: var(--surface, #f5f6f8);
}
.transfer-form {
  max-width: none;
}
.transfer-selection ul {
  max-height: 180px;
  overflow: auto;
  padding-left: 20px;
}
.transfer-review {
  padding: 4px 18px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  background: var(--surface, #f5f6f8);
}
.transfer-review > div {
  display: grid;
  grid-template-columns: 80px minmax(0, 1fr);
  gap: 16px;
  padding: 14px 0;
  font-size: 13px;
}
.transfer-review > div + div {
  border-top: 1px solid var(--border, #e3e6ec);
}
.transfer-review dt {
  color: var(--muted, #687486);
}
.transfer-review dd {
  margin: 0;
}
@media (max-width: 560px) {
  .transfer-action-grid {
    grid-template-columns: 1fr;
  }
  .transfer-steps {
    gap: 6px;
  }
  .transfer-steps li {
    flex-direction: column;
    gap: 6px;
    text-align: center;
  }
}
</style>
