<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { Button as AButton, Alert as AAlert } from 'ant-design-vue';
import type {
  GitCredentialSummary,
  GitCredentialInput,
  GitJob,
  GitJobInput,
  GitJobKind,
  GitRemoteStatus,
  GitRemoteHost,
} from '../../../shared/git-contracts';
import { api, ApiError } from '../api';
import { pluginRegistry, refreshPlugins } from '../plugins';
import { gitUnsaved, gitError, jobPhases, jobPending } from '../git-sync';
const props = withDefaults(defineProps<{ mode?: 'sync' | 'import'; timeZone?: string }>(), {
  mode: 'sync',
  timeZone: 'Asia/Shanghai',
});
const emit = defineEmits<{ imported: [root: string]; changed: []; 'return-save': [] }>();
const state = ref<GitRemoteStatus>(),
  credentials = ref<GitCredentialSummary[]>([]),
  job = ref<GitJob>();
const url = ref(''),
  branch = ref(''),
  name = ref('我的知识库'),
  parentPath = ref(''),
  credentialId = ref('');
const error = ref(''),
  notice = ref(''),
  busy = ref(false),
  loading = ref(false),
  editorOpen = ref(false);
const credentialName = ref(''),
  credentialKind = ref<'https' | 'ssh'>('https'),
  credentialHost = ref<GitRemoteHost>('github.com');
const editingCredential = ref(''),
  username = ref(''),
  token = ref(''),
  privateKey = ref(''),
  passphrase = ref(''),
  knownHosts = ref('');
const trustHost = ref(false),
  remember = ref(true),
  fingerprints = ref<string[]>([]);
const message = ref(''),
  preview = ref<any>(),
  committedHead = ref(''),
  commitRequest = ref(''),
  commitUnknown = ref(false);
const authorName = ref(''),
  authorEmail = ref('');
const gitPlugin = computed(() =>
  pluginRegistry.value.installed.find((entry) => entry.id === 'git'),
);
const authorReady = computed(
  () => !!gitPlugin.value?.config.authorName && !!gitPlugin.value?.config.authorEmail,
);
const running = computed(() => busy.value || jobPending(job.value));
const connection = computed(() => state.value?.connection);
const unresolved = ref<GitJobInput>();
let active = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  loadEpoch = 0;
const endpoint = '/api/platform/git';
function clearSecrets() {
  token.value = '';
  privateKey.value = '';
  passphrase.value = '';
}
function stopped() {
  active = false;
  clearTimeout(timer);
  clearSecrets();
}
onBeforeUnmount(() => {
  stopped();
  window.removeEventListener('dooknow-session-expired', stopped);
});
function returnSave() {
  emit('return-save');
  window.dispatchEvent(new Event('dooknow-git-return-save'));
}
function unsaved() {
  if (!gitUnsaved.value) return false;
  error.value = '当前笔记有未保存的内容，请返回笔记保存后再提交或拉取。';
  return true;
}
async function load() {
  const epoch = ++loadEpoch;
  loading.value = true;
  try {
    const [next, saved] = await Promise.all([
      api<GitRemoteStatus>(endpoint + '/status'),
      api<{ items: GitCredentialSummary[] }>(endpoint + '/credentials'),
    ]);
    if (!active || epoch !== loadEpoch) return;
    state.value = next;
    credentials.value = saved.items;
    if (!url.value) {
      url.value =
        next.connection?.url ||
        next.discoveredRemotes.find((entry) => entry.name === 'origin')?.url ||
        '';
      branch.value = next.connection?.branch || next.branch || '';
      credentialId.value = next.connection?.credentialId || '';
    }
    authorName.value ||= String(gitPlugin.value?.config.authorName || '');
    authorEmail.value ||= String(gitPlugin.value?.config.authorEmail || '');
    if (!job.value) {
      job.value =
        next.jobs.find((entry) => jobPending(entry) || entry.status === 'needs_reconciliation') ||
        next.jobs.find((entry) => entry.status === 'failed');
      if (jobPending(job.value)) schedule();
    }
  } catch (e) {
    if (active && epoch === loadEpoch) error.value = gitError(e);
  } finally {
    if (active && epoch === loadEpoch) loading.value = false;
  }
}
function schedule() {
  clearTimeout(timer);
  if (active && jobPending(job.value)) timer = setTimeout(() => void poll(), 500);
}
async function completed(next: GitJob) {
  if (!active) return;
  job.value = next;
  if (next.status === 'succeeded') {
    if (next.kind === 'ssh-host') {
      knownHosts.value = String(next.result?.knownHosts || '');
      fingerprints.value = Array.isArray(next.result?.fingerprints) ? next.result.fingerprints : [];
      trustHost.value = false;
    } else {
      notice.value =
        next.kind === 'test'
          ? '读取连接成功。这不代表拥有推送权限。'
          : next.kind === 'push'
            ? next.result?.unchanged
              ? '云端已包含此版本；读取核对不代表已验证推送权限。'
              : '已推送提交版本。'
            : next.kind === 'pull'
              ? '云端更新已拉取，目录与索引已刷新。'
              : next.kind === 'disconnect'
                ? '已解除云端关联，本地资料与历史保留。'
                : next.kind === 'check'
                  ? '云端检查完成。'
                  : '云端仓库已连接。';
      if (next.kind === 'push') committedHead.value = '';
      if (['connect', 'clone'].includes(next.kind)) await refreshPlugins().catch(() => {});
      if (!active) return;
      await load();
      if (!active) return;
      emit('changed');
      if (next.kind === 'clone' && next.result?.knowledgeRoot)
        emit('imported', next.result.knowledgeRoot);
      else if (next.kind === 'clone' && next.result?.boundKnowledgeRoot)
        emit('imported', next.result.boundKnowledgeRoot);
      if (next.kind === 'pull') window.dispatchEvent(new Event('dooknow-workspace-changed'));
    }
  } else if (next.status === 'failed' || next.status === 'needs_reconciliation')
    error.value = gitError(next.error || 'GIT_RESULT_UNKNOWN');
  schedule();
}
async function poll() {
  if (!active || !job.value) return;
  try {
    const next = await api<GitJob>(endpoint + '/jobs/' + encodeURIComponent(job.value.id));
    if (active) await completed(next);
  } catch (e) {
    if (active) error.value = gitError(e); /* Retry is explicit when receipt cannot be read. */
  }
}
async function reconcile() {
  try {
    const response = await api<{ items: GitJob[] }>(endpoint + '/jobs');
    if (!active) return false;
    const receipt = response.items.find((entry) => entry.requestId === unresolved.value?.requestId);
    if (receipt) {
      unresolved.value = undefined;
      await completed(receipt);
      return true;
    }
    // A successful list with no receipt proves this request was not accepted.
    unresolved.value = undefined;
    return true;
  } catch (e) {
    if (active) error.value = gitError(e);
    return false;
  }
}
async function startJob(kind: GitJobKind) {
  if (running.value || !active || (kind === 'pull' && unsaved())) return;
  if (commitUnknown.value && ['connect', 'pull', 'disconnect'].includes(kind)) {
    error.value = '请先核对上一次提交结果。';
    return;
  }
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    if (unresolved.value) {
      await reconcile();
      return;
    }
    const input: GitJobInput = {
      kind,
      requestId: crypto.randomUUID(),
      ...(['clone', 'connect', 'test'].includes(kind)
        ? {
            url: url.value.trim(),
            ...(branch.value.trim() ? { branch: branch.value.trim() } : {}),
            ...(credentialId.value ? { credentialId: credentialId.value } : {}),
          }
        : {}),
      ...(kind === 'clone'
        ? {
            name: name.value.trim(),
            ...(parentPath.value.trim() ? { parentPath: parentPath.value.trim() } : {}),
            timeZone: props.timeZone,
          }
        : {}),
      ...(kind === 'push' && (committedHead.value || state.value?.head)
        ? { expectedHead: committedHead.value || state.value!.head! }
        : {}),
      ...(kind === 'disconnect' ? { confirm: true } : {}),
      ...(kind === 'ssh-host' ? { host: credentialHost.value } : {}),
    };
    unresolved.value = input;
    const next = await api<GitJob>(endpoint + '/jobs', 'POST', input);
    unresolved.value = undefined;
    if (active) await completed(next);
  } catch (e) {
    if (!active) return;
    // A definite rejection cannot have created a job. Transport loss must be reconciled.
    if (e instanceof ApiError && e.status > 0) unresolved.value = undefined;
    error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function retryJob() {
  if (!job.value || running.value || !active || (job.value.kind === 'pull' && unsaved())) return;
  busy.value = true;
  error.value = '';
  try {
    const next = await api<GitJob>(
      endpoint + '/jobs/' + encodeURIComponent(job.value.id) + '/retry',
      'POST',
      {},
    );
    if (active) await completed(next);
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function cancelJob() {
  if (!job.value || !active) return;
  try {
    const next = await api<GitJob>(
      endpoint + '/jobs/' + encodeURIComponent(job.value.id) + '/cancel',
      'POST',
      {},
    );
    if (active) await completed(next);
  } catch (e) {
    if (active) error.value = gitError(e);
  }
}
function editCredential(entry?: GitCredentialSummary) {
  clearSecrets();
  editorOpen.value = true;
  editingCredential.value = entry?.id || '';
  credentialName.value = entry?.name || '';
  credentialKind.value = entry?.kind || 'https';
  credentialHost.value =
    entry?.host || (url.value.includes('gitee.com') ? 'gitee.com' : 'github.com');
  username.value = entry?.username || '';
  knownHosts.value = '';
  trustHost.value = false;
  fingerprints.value = [];
  remember.value = !entry?.temporary;
}
async function saveCredential() {
  if (running.value || !active) return;
  if (credentialKind.value === 'ssh' && (!knownHosts.value.trim() || !trustHost.value)) {
    error.value = gitError('GIT_HOST_TRUST_REQUIRED');
    return;
  }
  busy.value = true;
  error.value = '';
  const input: GitCredentialInput = {
    ...(editingCredential.value ? { id: editingCredential.value } : {}),
    name: credentialName.value.trim(),
    host: credentialHost.value,
    kind: credentialKind.value,
    remember: remember.value,
    ...(credentialKind.value === 'https'
      ? { username: username.value.trim(), ...(token.value ? { token: token.value } : {}) }
      : {
          ...(privateKey.value ? { privateKey: privateKey.value } : {}),
          ...(passphrase.value ? { passphrase: passphrase.value } : {}),
          knownHosts: knownHosts.value,
          trustHost: trustHost.value,
        }),
  };
  try {
    const saved = await api<GitCredentialSummary>(endpoint + '/credentials', 'POST', input);
    if (!active) return;
    credentials.value = [...credentials.value.filter((entry) => entry.id !== saved.id), saved];
    credentialId.value = saved.id;
    clearSecrets();
    editorOpen.value = false;
    notice.value = '凭据已保存，秘密内容不会回显。';
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function removeCredential(entry: GitCredentialSummary) {
  if (running.value || !active) return;
  busy.value = true;
  error.value = '';
  try {
    await api(endpoint + '/credentials/' + encodeURIComponent(entry.id), 'DELETE');
    if (!active) return;
    credentials.value = credentials.value.filter((saved) => saved.id !== entry.id);
    if (credentialId.value === entry.id) credentialId.value = '';
    notice.value = '凭据已移除。资料和历史保留，私有仓库需要重新认证。';
    await load();
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function saveAuthor() {
  if (running.value || !gitPlugin.value || !active) return;
  busy.value = true;
  error.value = '';
  try {
    const plugin = gitPlugin.value;
    await api('/api/platform/plugins/git/config', 'PUT', {
      values: {
        ...plugin.config,
        authorName: authorName.value.trim(),
        authorEmail: authorEmail.value.trim(),
      },
      configVersion: plugin.configVersion,
    });
    if (active) await refreshPlugins();
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function previewCommit() {
  if (running.value || !active || unsaved()) return;
  if (commitUnknown.value) {
    error.value = '上次提交结果待核对，请使用“核对提交结果”。';
    return;
  }
  if (!authorReady.value) {
    error.value = gitError('GIT_AUTHOR_REQUIRED');
    return;
  }
  if (state.value?.changes === 0) {
    error.value = gitError('GIT_NO_CHANGES');
    return;
  }
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (preview.value)
      await api('/api/plugins/git/call', 'POST', {
        kind: 'command',
        id: 'git.cancelPreview',
        input: { token: preview.value.token },
      });
    const next = await api('/api/plugins/git/call', 'POST', {
      kind: 'command',
      id: 'git.preview',
      input: { message: message.value.trim() },
    });
    if (active) {
      preview.value = next;
      commitRequest.value = crypto.randomUUID();
    }
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function confirmCommit() {
  if (!preview.value || running.value || !active || unsaved()) return;
  if (
    !commitUnknown.value &&
    preview.value.message &&
    preview.value.message !== message.value.trim()
  ) {
    error.value = '提交说明已修改，请重新预览。';
    return;
  }
  busy.value = true;
  error.value = '';
  commitUnknown.value = true;
  let pushed = false;
  try {
    const result = await api<{ commit: string; needsReconciliation?: boolean }>(
      '/api/plugins/git/call',
      'POST',
      {
        kind: 'command',
        id: 'git.commit',
        input: { token: preview.value.token, requestId: commitRequest.value },
      },
    );
    if (!active) return;
    committedHead.value = result.commit;
    commitUnknown.value = false;
    preview.value = undefined;
    if (result.needsReconciliation) {
      error.value = '提交已保留，本地状态待核对。请在版本记录中核对后仅推送。';
      return;
    }
    notice.value = '本地提交已完成，正在准备推送。';
    pushed = true;
  } catch (e) {
    if (!active) return;
    if (e instanceof ApiError && e.data.publication === 'not_published') {
      commitUnknown.value = false;
      preview.value = undefined;
    }
    error.value = commitUnknown.value
      ? '提交结果尚未确认，请核对提交结果。重试会使用同一次提交请求。'
      : gitError(e);
  } finally {
    if (active) busy.value = false;
  }
  if (pushed && active) {
    await startJob('push');
    await load();
  }
}
onMounted(() => {
  window.addEventListener('dooknow-session-expired', stopped);
  void load();
});
</script>
<template>
  <section class="git-remote-panel" :aria-busy="running" aria-label="云端同步面板">
    <header class="remote-heading">
      <div>
        <h2>{{ mode === 'import' ? '从 GitHub／Gitee 导入' : '云端同步' }}</h2>
        <p>保存让笔记落到本机；提交记录一个版本；推送才会上传。Git 不能代替独立备份。</p>
      </div>
      <AButton :loading="loading" :disabled="running" @click="load">刷新同步状态</AButton>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" role="alert" />
    <AAlert v-if="state?.code" type="warning" show-icon :message="gitError(state.code)" />
    <AAlert v-if="notice" type="success" show-icon :message="notice" role="status" />
    <AAlert
      v-if="gitUnsaved"
      type="warning"
      message="当前笔记尚未保存。请返回笔记保存后再提交或拉取。仅推送只上传已提交版本，不会上传草稿。"
      ><template #action><AButton @click="returnSave">返回笔记保存</AButton></template></AAlert
    >
    <div v-if="state && mode !== 'import'" class="remote-status">
      <p>
        本地分支：<strong>{{ state.branch || '尚未初始化' }}</strong> · 未提交文件：{{
          state.changes
        }}
      </p>
      <p v-if="state.head" class="remote-code">当前版本：{{ state.head }}</p>
      <template v-if="connection"
        ><p class="remote-code">云端：{{ connection.url }} · {{ connection.branch }}</p>
        <p>待推送：{{ connection.ahead ?? '未知' }} · 待拉取：{{ connection.behind ?? '未知' }}</p>
        <p>
          最近检查：{{
            connection.lastCheckedAt
              ? new Date(connection.lastCheckedAt).toLocaleString()
              : '尚未检查，云端状态未知'
          }}
        </p>
        <p>
          {{
            connection.writeVerified
              ? '曾成功推送；后续仍受云端权限及分支保护限制。'
              : '推送权限尚未验证。读取连接成功不代表可以推送。'
          }}
        </p>
        <p v-if="!connection.credentialAvailable">凭据不可用，请重新选择认证并关联。</p></template
      >
      <p v-else>尚未关联云端仓库。关联后仍需手动提交和同步。</p>
    </div>
    <details :open="mode === 'import' || !connection" class="remote-section">
      <summary>
        {{ mode === 'import' ? '仓库地址、认证与保存位置' : '关联云端仓库／更换认证' }}
      </summary>
      <p>
        此操作会安装并启用 Git 插件。已有目录与历史会保留；不会自动合并、强推或覆盖其他远端配置。
      </p>
      <label
        >仓库克隆地址<input
          v-model="url"
          aria-label="仓库克隆地址"
          placeholder="https://github.com/owner/repository.git"
          :disabled="running"
          autocomplete="off"
      /></label>
      <p>请复制仓库页面的 HTTPS 或 SSH 克隆地址。公开 HTTPS 仓库可不配置认证。</p>
      <label
        >云端分支（选填）<input
          v-model="branch"
          aria-label="云端分支（选填）"
          placeholder="留空使用默认分支"
          :disabled="running"
      /></label>
      <label
        >仓库认证<select v-model="credentialId" aria-label="仓库认证" :disabled="running">
          <option value="">不使用凭据（公开仓库读取）</option>
          <option v-for="entry in credentials" :key="entry.id" :value="entry.id">
            {{ entry.name }} · {{ entry.host }} · {{ entry.kind.toUpperCase()
            }}{{ entry.temporary ? ' · 临时' : '' }}
          </option>
        </select></label
      >
      <div class="remote-actions">
        <AButton :disabled="running" @click="editCredential()">添加凭据</AButton
        ><AButton :disabled="running || !url.trim()" @click="startJob('test')"
          >测试读取连接</AButton
        >
      </div>
      <template v-if="mode === 'import'"
        ><label
          >导入后的知识库名称<input
            v-model="name"
            aria-label="导入后的知识库名称"
            :disabled="running"
            maxlength="40" /></label
        ><label
          >导入保存位置（选填）<input
            v-model="parentPath"
            aria-label="导入保存位置（选填）"
            placeholder="留空使用推荐位置，路径位于服务器上"
            :disabled="running"
        /></label>
        <p>下载到独立的新文件夹。已有同名文件夹时会停止，请另选名称或位置。</p></template
      >
      <div class="remote-actions">
        <AButton
          type="primary"
          :disabled="running || !url.trim() || (mode === 'import' && !name.trim())"
          @click="startJob(mode === 'import' ? 'clone' : 'connect')"
          >{{ mode === 'import' ? '导入并继续' : '关联云端仓库' }}</AButton
        >
      </div>
    </details>
    <details class="remote-section">
      <summary>管理仓库凭据</summary>
      <p>凭据只供登录账号使用，秘密内容不会回显。移除凭据不会删除资料。</p>
      <ul class="credential-list">
        <li v-for="entry in credentials" :key="entry.id">
          <span
            >{{ entry.name }} · {{ entry.host }} · {{ entry.kind.toUpperCase()
            }}{{ entry.temporary ? ' · 临时 30 分钟' : '' }}</span
          ><AButton size="small" :disabled="running" @click="editCredential(entry)"
            >更换凭据 {{ entry.name }}</AButton
          ><AButton size="small" danger :disabled="running" @click="removeCredential(entry)"
            >移除凭据 {{ entry.name }}</AButton
          >
        </li>
      </ul>
      <AButton :disabled="running" @click="editCredential()">添加新的凭据</AButton>
    </details>
    <div v-if="editorOpen" class="credential-editor remote-section">
      <h3>{{ editingCredential ? '更换凭据' : '添加凭据' }}</h3>
      <form @submit.prevent="saveCredential">
        <label
          >凭据名称<input
            v-model="credentialName"
            aria-label="凭据名称"
            required
            :disabled="running"
            autocomplete="off" /></label
        ><label
          >服务平台<select
            v-model="credentialHost"
            aria-label="凭据服务平台"
            :disabled="running"
            @change="
              trustHost = false;
              knownHosts = '';
              fingerprints = [];
            "
          >
            <option value="github.com">GitHub</option>
            <option value="gitee.com">Gitee</option>
          </select></label
        ><label
          >认证方式<select v-model="credentialKind" aria-label="认证方式" :disabled="running">
            <option value="https">HTTPS 令牌（推荐）</option>
            <option value="ssh">SSH 私钥（高级）</option>
          </select></label
        >
        <template v-if="credentialKind === 'https'"
          ><label
            >仓库用户名<input
              v-model="username"
              aria-label="仓库用户名"
              autocomplete="off"
              :disabled="running" /></label
          ><label
            >访问令牌<input
              v-model="token"
              type="password"
              aria-label="访问令牌"
              autocomplete="new-password"
              :required="!editingCredential"
              :disabled="running"
              :placeholder="
                editingCredential ? '留空保留原令牌' : '填写具有仓库读写权限的访问令牌'
              " /></label
        ></template>
        <template v-else
          ><p>
            SSH 高级设置：私钥只会发给当前 DooKnow
            服务。请先与官方公布的主机指纹核对，不能仅凭扫描结果信任主机。
          </p>
          <label
            >SSH 私钥<textarea
              v-model="privateKey"
              aria-label="SSH 私钥"
              autocomplete="off"
              :disabled="running"
              :required="!editingCredential"
              :placeholder="editingCredential ? '留空保留原私钥' : '粘贴专用 SSH 私钥'"
              rows="4"
            /></label
          ><label
            >私钥口令（选填）<input
              v-model="passphrase"
              type="password"
              aria-label="私钥口令（选填）"
              autocomplete="new-password"
              :disabled="running" /></label
          ><AButton :disabled="running" @click="startJob('ssh-host')">读取 SSH 主机指纹</AButton>
          <pre v-if="fingerprints.length">{{ fingerprints.join('\n') }}</pre>
          <label
            >已核对的 known_hosts<textarea
              v-model="knownHosts"
              aria-label="已核对的 known_hosts"
              :disabled="running"
              rows="4"
              @input="trustHost = false"
            />
          </label>
          <p>扫描被网络阻止时，也可以粘贴经过核对的 known_hosts。</p>
          <label class="remote-check"
            ><input
              v-model="trustHost"
              type="checkbox"
              :disabled="running"
            />我已对照官方文档核对指纹，确认信任此主机</label
          ></template
        >
        <label class="remote-check"
          ><input
            v-model="remember"
            type="checkbox"
            :disabled="running"
          />在服务器加密保存凭据（取消后仅保留 30 分钟）</label
        >
        <div class="remote-actions">
          <AButton
            html-type="submit"
            type="primary"
            :disabled="
              running || !credentialName.trim() || (credentialKind === 'ssh' && !trustHost)
            "
            >保存仓库凭据</AButton
          ><AButton
            :disabled="running"
            @click="
              editorOpen = false;
              clearSecrets();
            "
            >取消编辑凭据</AButton
          >
        </div>
      </form>
    </div>
    <div v-if="mode !== 'import' && connection" class="remote-section">
      <div class="remote-actions">
        <AButton :disabled="running" @click="startJob('check')">检查云端</AButton
        ><AButton :disabled="running || commitUnknown" @click="startJob('push')">仅推送</AButton
        ><AButton :disabled="running || gitUnsaved || commitUnknown" @click="startJob('pull')"
          >拉取更新</AButton
        >
      </div>
      <p>拉取仅支持无本地修改时的快进更新。有分歧时会停止。仅推送会保留本地草稿。</p>
      <p v-if="committedHead" class="remote-code" role="status">
        本地提交 {{ committedHead }} 已保留；推送失败时可仅推送重试。
      </p>
      <details v-if="!authorReady" open>
        <summary>先设置版本记录的署名</summary>
        <p>署名记录在 Git 提交中，与仓库登录凭据无关。</p>
        <label
          >同步提交作者<input
            v-model="authorName"
            aria-label="同步提交作者"
            :disabled="running" /></label
        ><label
          >同步作者邮箱<input
            v-model="authorEmail"
            type="email"
            aria-label="同步作者邮箱"
            :disabled="running" /></label
        ><AButton
          :disabled="running || !authorName.trim() || !authorEmail.trim()"
          @click="saveAuthor"
          >保存同步署名</AButton
        >
      </details>
      <label
        >云端同步提交说明<input
          v-model="message"
          aria-label="云端同步提交说明"
          :disabled="running || commitUnknown"
          placeholder="简述本次保存的文件变更" /></label
      ><AButton
        :disabled="
          running ||
          gitUnsaved ||
          commitUnknown ||
          !message.trim() ||
          !authorReady ||
          state?.changes === 0
        "
        @click="previewCommit"
        >预览提交并推送</AButton
      >
      <p v-if="state?.changes === 0">没有未提交文件。已有本地提交时可以直接“仅推送”。</p>
      <div v-if="preview" class="commit-preview">
        <h3>确认本次提交内容</h3>
        <p>{{ preview.changes.length }} 项文件变更 · {{ preview.message || message }}</p>
        <p v-if="preview.partialStaging?.length">
          部分暂存文件将提交完整当前版本：{{ preview.partialStaging.join('、') }}
        </p>
        <ul>
          <li v-for="change in preview.changes" :key="change.path">
            {{ change.code || change.status }} · {{ change.path }}
          </li>
        </ul>
        <pre v-if="preview.diff">{{ preview.diff }}</pre>
        <AButton type="primary" :disabled="running || gitUnsaved" @click="confirmCommit">{{
          commitUnknown ? '核对提交结果' : '确认提交并推送'
        }}</AButton>
      </div>
      <details class="disconnect">
        <summary>解除云端关联</summary>
        <p>只移除 DooKnow 的同步关联，本地原文、版本历史与 Git 远端配置会保留。</p>
        <AButton danger :disabled="running || commitUnknown" @click="startJob('disconnect')"
          >确认解除云端关联</AButton
        >
      </details>
    </div>
    <div v-if="job" class="remote-job" role="status">
      <strong>{{ jobPhases[job.phase] || '正在处理任务' }}</strong>
      <p>
        {{
          job.status === 'needs_reconciliation'
            ? '结果待核对，请先刷新任务或检查云端。'
            : job.status === 'failed'
              ? '任务未完成；已有资料和已提交版本保留。'
              : jobPending(job)
                ? '任务在服务器上继续，刷新页面后仍可查看进度。'
                : '任务已结束。'
        }}
      </p>
      <div class="remote-actions">
        <AButton :disabled="busy" @click="poll">刷新任务状态</AButton
        ><AButton v-if="jobPending(job)" :disabled="busy" @click="cancelJob">取消当前任务</AButton
        ><AButton
          v-if="['failed', 'needs_reconciliation'].includes(job.status)"
          :disabled="running || (job.kind === 'pull' && gitUnsaved)"
          @click="retryJob"
          >核对并重试任务</AButton
        >
      </div>
    </div>
    <div v-if="unresolved" class="remote-job">
      <p>请求结果尚未确认，请先读取服务器任务回执，避免重复操作。</p>
      <AButton :disabled="running" @click="reconcile">核对请求结果</AButton>
    </div>
    <details class="remote-help">
      <summary>GitHub／Gitee 认证与 SSH 帮助</summary>
      <a
        href="https://docs.github.com/zh/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
        target="_blank"
        rel="noopener noreferrer"
        >GitHub 访问令牌教程</a
      ><a
        href="https://help.gitee.com/account/two-factor-authentication#推拉代码认证"
        target="_blank"
        rel="noopener noreferrer"
        >Gitee HTTPS 令牌认证说明</a
      ><a
        href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints"
        target="_blank"
        rel="noopener noreferrer"
        >GitHub 官方 SSH 主机指纹</a
      ><a
        href="https://help.gitee.com/account/gitees-ssh-key-fingerprints"
        target="_blank"
        rel="noopener noreferrer"
        >Gitee 官方 SSH 主机指纹</a
      >
    </details>
  </section>
</template>
<style scoped>
.git-remote-panel {
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--text, #262b36);
}
.remote-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
h2 {
  margin: 0 0 8px;
  font-size: 17px;
}
h3 {
  margin: 8px 0;
  font-size: 14px;
}
p,
li {
  margin: 8px 0;
  font-size: 13px;
  line-height: 1.8;
  overflow-wrap: anywhere;
}
p {
  color: var(--muted, #727b8b);
}
.remote-section {
  min-width: 0;
  padding-top: 14px;
  border-top: 1px solid var(--border, #e3e6ec);
}
summary {
  padding: 4px 0;
  font-size: 14px;
  cursor: pointer;
}
label {
  display: grid;
  gap: 7px;
  margin: 14px 0;
  font-size: 13px;
}
input:not([type='checkbox']),
select,
textarea {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  border: 1px solid var(--border, #d9dce5);
  border-radius: 6px;
  background: white;
  color: inherit;
  padding: 9px 11px;
  font: inherit;
}
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--focus, #4566c6);
  outline-offset: 2px;
}
.remote-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  line-height: 1.7;
}
.remote-check input {
  margin-top: 5px;
}
.remote-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}
.remote-status,
.remote-job,
.credential-editor,
.commit-preview {
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  padding: 14px;
  background: var(--surface-soft, #fafbfc);
}
.remote-code,
pre {
  overflow-wrap: anywhere;
  word-break: break-all;
  font-family: monospace;
}
pre {
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 12px;
}
.credential-list {
  padding: 0;
  list-style: none;
}
.credential-list li {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.remote-help a {
  display: block;
  margin-top: 8px;
  font-size: 13px;
}
.disconnect {
  margin-top: 20px;
}
@media (max-width: 600px) {
  .remote-heading {
    flex-direction: column;
  }
  .remote-actions > * {
    min-height: 36px;
  }
  .remote-status,
  .remote-job,
  .credential-editor,
  .commit-preview {
    padding: 12px;
  }
}
</style>
