<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Popconfirm as APopconfirm,
  Tag as ATag,
} from 'ant-design-vue';
import { api } from '../../api';
import { createPageWindow } from './paged-records';
import type { ManagedBackup, ManagedBackupList } from '../../../../shared/transfer-contracts';
import TransferTasks from './TransferTasks.vue';
import MaintenanceSettings from '../MaintenanceSettings.vue';
import { downloadRecoveryKey } from './download';
const emit = defineEmits<{ 'open-note': [id: string] }>();
const items = ref<ManagedBackup[]>([]),
  cursor = ref<string>(),
  loading = ref(false),
  busy = ref(''),
  error = ref(''),
  notice = ref(''),
  keyError = ref(''),
  password = ref(''),
  keyBusy = ref(false),
  uploadError = ref('');
const tasks = ref<InstanceType<typeof TransferTasks>>();
const maintenanceOpen = ref(false);
const restoreRequests = new Map<string, string>();
const backupFile = ref<File>(),
  keyFile = ref<File>(),
  backupInput = ref<HTMLInputElement>(),
  keyInput = ref<HTMLInputElement>();
let backupRequest = crypto.randomUUID(),
  uploadRequest = crypto.randomUUID();
const pageWindow = createPageWindow<ManagedBackup>((cursor) =>
  api<ManagedBackupList>(
    '/api/manage/backups' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''),
  ),
);
async function load(more = false, reset = false) {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    const data = await pageWindow.read(more, reset);
    items.value = data.items;
    cursor.value = data.nextCursor || undefined;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function create() {
  if (busy.value) return;
  busy.value = 'create';
  error.value = '';
  notice.value = '';
  try {
    await api('/api/manage/backups', 'POST', { requestId: backupRequest });
    backupRequest = crypto.randomUUID();
    notice.value = '加密备份任务已提交。完成后请下载备份，并另存恢复密钥。';
    await tasks.value?.refresh();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
async function restore(id: string) {
  if (busy.value) return;
  busy.value = id;
  error.value = '';
  notice.value = '';
  const requestId = restoreRequests.get(id) || crypto.randomUUID();
  restoreRequests.set(id, requestId);
  try {
    await api('/api/manage/restores', 'POST', { backupId: id, requestId });
    restoreRequests.delete(id);
    notice.value = '独立恢复任务已提交。校验完成后，下方会显示副本位置与启用步骤。';
    await tasks.value?.refresh();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = '';
  }
}
async function downloadKey() {
  keyError.value = '';
  if (!password.value) {
    keyError.value = '请输入当前密码以下载恢复密钥。';
    return;
  }
  keyBusy.value = true;
  try {
    await downloadRecoveryKey(password.value);
    notice.value = '恢复密钥已下载。请与备份分开、加密保存。';
  } catch (e) {
    keyError.value = (e as Error).message;
  } finally {
    password.value = '';
    keyBusy.value = false;
  }
}
function selectBackup(event: Event) {
  backupFile.value = (event.target as HTMLInputElement).files?.[0];
  uploadRequest = crypto.randomUUID();
}
function selectKey(event: Event) {
  keyFile.value = (event.target as HTMLInputElement).files?.[0];
  uploadRequest = crypto.randomUUID();
}
async function uploadRestore() {
  if (busy.value) return;
  uploadError.value = '';
  if (!backupFile.value || !keyFile.value) {
    uploadError.value = '请选择加密备份文件与对应恢复密钥。';
    return;
  }
  if (backupFile.value.size > 128 * 1024 * 1024 || keyFile.value.size > 16 * 1024) {
    uploadError.value = '备份文件最多 128 MiB，恢复密钥最多 16 KiB。';
    return;
  }
  busy.value = 'upload';
  try {
    const form = new FormData();
    form.append('backup', backupFile.value);
    form.append('key', keyFile.value);
    form.append('requestId', uploadRequest);
    await api('/api/manage/restores/upload', 'POST', form);
    uploadRequest = crypto.randomUUID();
    notice.value = '恢复文件已接收，任务会在独立位置校验。';
    await tasks.value?.refresh();
  } catch (e) {
    uploadError.value = (e as Error).message;
  } finally {
    busy.value = '';
    backupFile.value = undefined;
    keyFile.value = undefined;
    if (backupInput.value) backupInput.value.value = '';
    if (keyInput.value) keyInput.value.value = '';
  }
}
function bytes(value: number) {
  return (value / 1024 / 1024).toFixed(2) + ' MiB';
}
function taskUpdated() {
  void load();
}
onMounted(() => void load());
</script>
<template>
  <div class="settings-stack">
    <section class="settings-card">
      <h2>加密备份</h2>
      <p class="settings-muted">
        保存应用数据与当前可读取的原文。任务完成后可下载加密文件；恢复需要对应私钥，请另行受控保存。重要副本应存放到独立设备或异地。
      </p>
      <AAlert
        type="info"
        message="历史版本和同盘副本不能代替独立备份。请定期验证恢复。"
        show-icon
      /><AAlert v-if="error" type="error" :message="error" show-icon />
      <div class="settings-actions">
        <AButton type="primary" :loading="busy === 'create'" :disabled="!!busy" @click="create"
          >创建加密备份</AButton
        ><AButton :loading="loading" @click="load(false, true)">刷新备份记录</AButton>
      </div>
      <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
      <p v-if="!items.length && !error" class="settings-muted">
        {{ loading ? '正在读取备份记录…' : '尚无加密备份。' }}
      </p>
      <ul class="settings-list">
        <li v-for="item in items" :key="item.id">
          <div class="settings-item-header">
            <div>
              <strong>{{ new Date(item.createdAt).toLocaleString('zh-CN') }}</strong>
              <ATag color="blue">已加密</ATag>
              <p>
                {{ bytes(item.bytes) }} ·
                {{
                  item.knowledgeIncluded === undefined
                    ? '外部加密备份（范围待验证）'
                    : item.knowledgeIncluded
                      ? '包含原文'
                      : '未包含知识库原文'
                }}{{ item.external ? ' · 外部导入' : '' }}
              </p>
            </div>
            <div class="settings-actions" style="margin: 0">
              <AButton
                size="small"
                :href="'/api/manage/backups/' + encodeURIComponent(item.id) + '/download'"
                >下载备份</AButton
              ><APopconfirm
                v-if="!item.external"
                title="将备份恢复到新的独立副本？"
                ok-text="开始独立恢复"
                cancel-text="取消"
                @confirm="restore(item.id)"
                ><AButton size="small" :loading="busy === item.id" :disabled="!!busy"
                  >恢复到独立副本</AButton
                ></APopconfirm
              >
            </div>
          </div>
          <p v-if="item.external" class="settings-muted">
            恢复此备份需要对应私钥，请在下方「从已下载的备份恢复」中选择文件。
          </p>
          <details>
            <summary>备份编号与密钥指纹</summary>
            <p>
              备份：<code>{{ item.id }}</code>
            </p>
            <p>
              密钥指纹：<code>{{ item.keyFingerprint }}</code>
            </p>
          </details>
        </li>
      </ul>
      <AButton v-if="cursor" :loading="loading" @click="load(true)">加载更多备份</AButton>
    </section>
    <section class="settings-card">
      <h2>下载恢复密钥</h2>
      <p class="settings-muted">
        输入当前账户密码后下载私钥文件。请与备份分开保存，避免丢失后无法恢复。
      </p>
      <form class="settings-form" @submit.prevent="downloadKey">
        <div class="settings-field">
          <label for="backup-password">当前密码</label
          ><AInput.Password
            id="backup-password"
            v-model:value="password"
            autocomplete="current-password"
            :disabled="keyBusy"
            :status="keyError ? 'error' : undefined"
            :aria-invalid="!!keyError"
            aria-describedby="backup-key-error"
          />
          <p id="backup-key-error" v-if="keyError" class="settings-field-error" role="alert">
            {{ keyError }}
          </p>
        </div>
        <div><AButton html-type="submit" :loading="keyBusy">验证密码并下载密钥</AButton></div>
      </form>
    </section>
    <section class="settings-card">
      <h2>从已下载的备份恢复</h2>
      <p class="settings-muted">
        选择加密备份与对应私钥。服务会创建新的空目录执行恢复，校验后提供副本位置。当前知识库保持运行，部署切换需要核验后单独操作。
      </p>
      <div class="settings-form">
        <div class="settings-field">
          <label for="restore-backup-file">加密备份（最多 128 MiB）</label
          ><input
            ref="backupInput"
            id="restore-backup-file"
            type="file"
            :disabled="!!busy"
            @change="selectBackup"
          />
        </div>
        <div class="settings-field">
          <label for="restore-key-file">恢复私钥（最多 16 KiB）</label
          ><input
            ref="keyInput"
            id="restore-key-file"
            type="file"
            :disabled="!!busy"
            @change="selectKey"
          />
        </div>
      </div>
      <AAlert v-if="uploadError" type="error" :message="uploadError" show-icon />
      <div class="settings-actions">
        <APopconfirm
          title="上传文件并恢复到独立副本？"
          ok-text="开始独立恢复"
          cancel-text="取消"
          @confirm="uploadRestore"
          ><AButton :loading="busy === 'upload'" :disabled="!!busy || !backupFile || !keyFile"
            >上传并恢复独立副本</AButton
          ></APopconfirm
        >
      </div>
      <details>
        <summary>大文件与部署切换帮助</summary>
        <p>超过上传限制时，在服务器使用管理命令恢复到新的空目录：</p>
        <pre><code>dooknow restore --source /备份目录/备份.dooknow \
  --key-file /受控目录/backup-key.pem --profile /新配置目录/profile.json \
  --data-root /新数据目录 --knowledge-root /新知识库目录</code></pre>
        <p>
          使用独立端口检查恢复副本，核对原文、附件与历史，再按部署方式更新绑定并切换服务。恢复操作不会替你修改正在生效的部署配置。
        </p>
      </details>
    </section>
    <TransferTasks
      ref="tasks"
      :kinds="['backup', 'restore']"
      @updated="taskUpdated"
      @open-note="emit('open-note', $event)"
    />
    <details
      class="settings-card"
      @toggle="maintenanceOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>异常写入恢复</summary>
      <MaintenanceSettings v-if="maintenanceOpen" @resolved="emit('open-note', $event.noteId)" />
    </details>
  </div>
</template>

<style scoped src="./file-input.css"></style>
