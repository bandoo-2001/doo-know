<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
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
import SettingsOverlay from './settings/SettingsOverlay.vue';
import SettingsActionCard from './settings/SettingsActionCard.vue';
import {
  gitUnsaved,
  gitError,
  jobPhases,
  jobPending,
  type WorkspaceChangeDetail,
} from '../git-sync';
const props = withDefaults(
  defineProps<{ mode?: 'sync' | 'import'; timeZone?: string; inline?: boolean }>(),
  {
    mode: 'sync',
    timeZone: 'Asia/Shanghai',
    inline: false,
  },
);
const emit = defineEmits<{
  imported: [root: string];
  changed: [];
  'return-save': [];
  'busy-change': [busy: boolean];
  'dirty-change': [dirty: boolean];
}>();
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
const repositoryPending = computed(() => state.value?.code === 'WORKSPACE_BUSY');
const connection = computed(() => (repositoryPending.value ? null : state.value?.connection));
const unresolved = ref<GitJobInput>();
const importedJobs = new Set<string>();
let active = true,
  timer: ReturnType<typeof setTimeout> | undefined,
  loadEpoch = 0,
  jobIntent = 0,
  receiptEpoch = 0,
  previewGeneration = 0;
type JobOwner = { intent: number; receipt: number };
const currentOwner = (): JobOwner => ({ intent: jobIntent, receipt: receiptEpoch });
const ownsJob = (owner: JobOwner) =>
  active && owner.intent === jobIntent && owner.receipt === receiptEpoch;
function nextReceipt(): JobOwner {
  ++receiptEpoch;
  ++loadEpoch;
  loading.value = false;
  clearTimeout(timer);
  return currentOwner();
}
function nextJobIntent(): JobOwner {
  // Retry keeps its server receipt ID, but belongs to a new local attempt.
  ++jobIntent;
  return nextReceipt();
}
const endpoint = '/api/platform/git';
const overlay = ref<'connection' | 'credential' | 'review' | null>(null);
const returnToConnection = ref(false),
  discardOpen = ref(false),
  returnSavePending = ref(false),
  previewMessage = ref(''),
  reviewBaseline = ref(''),
  credentialBaseline = ref('');
let returningToSave = false;
const connectionDraft = () => ({
  url: url.value,
  branch: branch.value,
  credentialId: credentialId.value,
  authorName: authorName.value,
  authorEmail: authorEmail.value,
});
const connectionBaseline = ref(connectionDraft());
const reviewAuthorBaseline = ref({ name: '', email: '' });
const credentialDraft = () =>
  JSON.stringify([
    credentialName.value,
    credentialKind.value,
    credentialHost.value,
    username.value,
    knownHosts.value,
    trustHost.value,
    remember.value,
  ]);
const connectionDirty = computed(
  () => JSON.stringify(connectionDraft()) !== JSON.stringify(connectionBaseline.value),
);
const overlayDirty = computed(() => {
  if (overlay.value === 'connection') return connectionDirty.value;
  if (overlay.value === 'credential')
    return (
      credentialDraft() !== credentialBaseline.value ||
      !!token.value ||
      !!privateKey.value ||
      !!passphrase.value
    );
  return (
    overlay.value === 'review' &&
    !commitUnknown.value &&
    (message.value !== reviewBaseline.value ||
      authorName.value !== reviewAuthorBaseline.value.name ||
      authorEmail.value !== reviewAuthorBaseline.value.email)
  );
});
const overlayBusy = computed(() => busy.value || commitUnknown.value);
const panelDirty = computed(
  () =>
    overlayDirty.value ||
    (overlay.value === 'credential' && returnToConnection.value && connectionDirty.value),
);
const frameInline = computed(() => props.inline || (props.mode === 'import' && !overlay.value));
const overlayTitle = computed(() =>
  overlay.value === 'credential'
    ? editingCredential.value
      ? '更换凭据'
      : '添加凭据'
    : overlay.value === 'review'
      ? '确认本次提交内容'
      : '管理云端同步',
);
const previewCurrent = computed(
  () => !!preview.value && (commitUnknown.value || previewMessage.value === message.value.trim()),
);
const frameProps = computed(() =>
  frameInline.value
    ? {}
    : {
        show: !!overlay.value,
        title: overlayTitle.value,
        description:
          overlay.value === 'review'
            ? '先填写说明并预览文件，再确认提交与推送。'
            : overlay.value === 'credential'
              ? '凭据只供当前账号使用，秘密内容不会回显。'
              : '关联云端仓库，管理同步分支与认证方式。',
        icon:
          overlay.value === 'credential'
            ? 'lock'
            : overlay.value === 'review'
              ? 'commit'
              : 'refresh',
        kind: overlay.value === 'credential' ? ('modal' as const) : ('drawer' as const),
        width: overlay.value === 'credential' ? 640 : 960,
        busy: overlayBusy.value,
        dirty: overlayDirty.value,
      },
);
watch(overlayBusy, (value) => emit('busy-change', value), { immediate: true });
watch(panelDirty, (value) => emit('dirty-change', value), { immediate: true });
watch(
  message,
  () => {
    if (preview.value && !commitUnknown.value && previewMessage.value !== message.value.trim()) {
      cancelPreview();
      error.value = '提交说明已修改，请重新预览。';
    }
  },
  { flush: 'sync' },
);
function cancelPreview() {
  if (commitUnknown.value) return;
  ++previewGeneration;
  const previous = preview.value;
  preview.value = undefined;
  previewMessage.value = '';
  commitRequest.value = '';
  if (previous?.token)
    void api('/api/plugins/git/call', 'POST', {
      kind: 'command',
      id: 'git.cancelPreview',
      input: { token: previous.token },
    }).catch(() => {});
}
function openConnection() {
  if (!active || repositoryPending.value) return;
  connectionBaseline.value = connectionDraft();
  discardOpen.value = false;
  overlay.value = 'connection';
}
function openReview() {
  if (!active || busy.value || repositoryPending.value) return;
  reviewBaseline.value = message.value;
  reviewAuthorBaseline.value = { name: authorName.value, email: authorEmail.value };
  discardOpen.value = false;
  overlay.value = 'review';
}
function closeOverlay() {
  discardOpen.value = false;
  returnSavePending.value = false;
  if (overlay.value === 'credential') {
    clearSecrets();
    editorOpen.value = false;
    overlay.value = returnToConnection.value ? 'connection' : null;
    returnToConnection.value = false;
    return;
  }
  if (overlay.value === 'connection') {
    const original = connectionBaseline.value;
    url.value = original.url;
    branch.value = original.branch;
    credentialId.value = original.credentialId;
    authorName.value = original.authorName;
    authorEmail.value = original.authorEmail;
  } else if (overlay.value === 'review' && !commitUnknown.value) {
    cancelPreview();
    message.value = reviewBaseline.value;
    authorName.value = reviewAuthorBaseline.value.name;
    authorEmail.value = reviewAuthorBaseline.value.email;
  }
  overlay.value = null;
}
function requestBack() {
  if (overlayBusy.value) return;
  returnSavePending.value = false;
  if (overlayDirty.value) discardOpen.value = true;
  else closeOverlay();
}
function cancelDiscard() {
  discardOpen.value = false;
  returnSavePending.value = false;
}
function confirmDiscard() {
  if (overlayBusy.value) return;
  if (returnSavePending.value) void finishReturnSave();
  else closeOverlay();
}
function updateOverlay(show: boolean) {
  if (!show) closeOverlay();
}
function clearSecrets() {
  token.value = '';
  privateKey.value = '';
  passphrase.value = '';
}
function stopped() {
  active = false;
  ++loadEpoch;
  cancelPreview();
  clearTimeout(timer);
  clearSecrets();
}
onBeforeUnmount(() => {
  stopped();
  window.removeEventListener('dooknow-session-expired', stopped);
});
function returnSave() {
  if (!active || overlayBusy.value || returningToSave) return;
  returnSavePending.value = true;
  if (panelDirty.value) discardOpen.value = true;
  else void finishReturnSave();
}
async function finishReturnSave() {
  if (!active || overlayBusy.value || returningToSave) return;
  returningToSave = true;
  returnSavePending.value = false;
  closeOverlay();
  // A credential editor can retain a separate connection draft behind it.
  if (overlay.value) closeOverlay();
  await nextTick();
  if (active) {
    if (props.inline) emit('return-save');
    else window.dispatchEvent(new Event('dooknow-git-return-save'));
  }
  returningToSave = false;
}
function unsaved() {
  if (!gitUnsaved.value) return false;
  error.value = '当前笔记有未保存的内容，请返回笔记保存后再提交或拉取。';
  return true;
}
async function load() {
  const epoch = ++loadEpoch;
  const owner = currentOwner();
  loading.value = true;
  try {
    const [next, saved] = await Promise.all([
      api<GitRemoteStatus>(endpoint + '/status'),
      api<{ items: GitCredentialSummary[] }>(endpoint + '/credentials'),
    ]);
    if (!ownsJob(owner) || epoch !== loadEpoch) return;
    state.value = next;
    credentials.value = saved.items;
    if (!repositoryPending.value && !url.value) {
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
      if (jobPending(job.value)) schedule(owner);
    }
  } catch (e) {
    if (ownsJob(owner) && epoch === loadEpoch) error.value = gitError(e);
  } finally {
    if (ownsJob(owner) && epoch === loadEpoch) loading.value = false;
  }
}
function schedule(owner = currentOwner()) {
  if (!ownsJob(owner)) return;
  clearTimeout(timer);
  if (jobPending(job.value)) {
    const id = job.value!.id;
    timer = setTimeout(() => {
      if (ownsJob(owner) && job.value?.id === id) void poll();
    }, 500);
  }
}
async function completed(next: GitJob, owner = nextReceipt()) {
  if (!ownsJob(owner)) return;
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
              ? next.result?.indexRefreshPending
                ? '云端文件已拉取，目录与搜索索引仍待刷新。请联系部署者检查并重试索引刷新，再核对目录与搜索结果。'
                : '云端更新已拉取，目录与索引已刷新。'
              : next.kind === 'disconnect'
                ? '已解除云端关联，本地资料与历史保留。'
                : next.kind === 'check'
                  ? '云端检查完成。'
                  : '云端仓库已连接。';
      // The file mutation is confirmed; closing this panel must not cancel workspace refresh.
      if (next.kind === 'pull')
        window.dispatchEvent(
          new CustomEvent<WorkspaceChangeDetail>('dooknow-workspace-changed', {
            detail: { scope: 'workspace' },
          }),
        );
      if (next.kind === 'push') committedHead.value = '';
      if (['connect', 'clone'].includes(next.kind)) await refreshPlugins().catch(() => {});
      if (ownsJob(owner)) await load();
      // This accepted result changed the repository even if a newer panel task has started.
      if (!active) return;
      emit('changed');
      const importedRoot =
        next.kind === 'clone' && (next.result?.knowledgeRoot || next.result?.boundKnowledgeRoot);
      if (importedRoot && !importedJobs.has(next.id)) {
        importedJobs.add(next.id);
        emit('imported', importedRoot);
      }
    }
  } else if (next.status === 'failed' || next.status === 'needs_reconciliation') {
    const taskError =
      next.status === 'needs_reconciliation' && next.error === 'GIT_COMMAND_CANCELLED'
        ? '已请求取消，任务结果待核对。请先刷新任务或检查云端。'
        : gitError(next.error || 'GIT_RESULT_UNKNOWN');
    error.value = taskError;
    notice.value = '';
    await load();
    // A refresh failure must not hide the original task result.
    if (ownsJob(owner)) error.value = taskError;
  } else if (next.status === 'cancelled') {
    error.value = '';
    notice.value = '任务已取消；已有资料和已提交版本保留。';
    await load();
  }
  schedule(owner);
}
async function poll() {
  if (!active || !job.value || busy.value) return;
  const id = job.value.id;
  const owner = nextReceipt();
  try {
    const next = await api<GitJob>(endpoint + '/jobs/' + encodeURIComponent(id));
    if (!ownsJob(owner)) return;
    if (next.id !== id) throw new ApiError(409, { code: 'GIT_RESULT_UNKNOWN' });
    await completed(next, owner);
  } catch (e) {
    if (ownsJob(owner))
      error.value = gitError(e); /* Retry is explicit when receipt cannot be read. */
  }
}
async function reconcile() {
  if (!active || busy.value || !unresolved.value) return false;
  const input = unresolved.value;
  const owner = nextJobIntent();
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    const response = await api<{ items: GitJob[] }>(endpoint + '/jobs');
    if (!ownsJob(owner) || unresolved.value?.requestId !== input.requestId) return false;
    const receipt = response.items.find((entry) => entry.requestId === input.requestId);
    if (receipt) {
      unresolved.value = undefined;
      await completed(receipt, owner);
      return true;
    }
    // A successful list with no receipt proves this request was not accepted.
    unresolved.value = undefined;
    return true;
  } catch (e) {
    if (ownsJob(owner)) error.value = gitError(e);
    return false;
  } finally {
    if (ownsJob(owner)) busy.value = false;
  }
}
async function startJob(kind: GitJobKind) {
  if (running.value || repositoryPending.value || !active || (kind === 'pull' && unsaved())) return;
  if (commitUnknown.value && ['connect', 'pull', 'disconnect'].includes(kind)) {
    error.value = '请先核对上一次提交结果。';
    return;
  }
  if (unresolved.value) {
    await reconcile();
    return;
  }
  const owner = nextJobIntent();
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
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
    if (!ownsJob(owner) || unresolved.value?.requestId !== input.requestId) return;
    unresolved.value = undefined;
    if (ownsJob(owner)) {
      await completed(next, owner);
      if (ownsJob(owner) && kind === 'connect') {
        connectionBaseline.value = connectionDraft();
        overlay.value = null;
      }
    }
  } catch (e) {
    if (!ownsJob(owner)) return;
    // A definite rejection cannot have created a job. Transport loss must be reconciled.
    if (e instanceof ApiError && e.status > 0) unresolved.value = undefined;
    error.value = gitError(e);
  } finally {
    if (ownsJob(owner)) busy.value = false;
  }
}
async function retryJob() {
  if (!job.value || running.value || !active || (job.value.kind === 'pull' && unsaved())) return;
  const id = job.value.id;
  const owner = nextJobIntent();
  busy.value = true;
  error.value = '';
  try {
    const next = await api<GitJob>(
      endpoint + '/jobs/' + encodeURIComponent(id) + '/retry',
      'POST',
      {},
    );
    if (!ownsJob(owner)) return;
    if (next.id !== id) throw new ApiError(409, { code: 'GIT_RESULT_UNKNOWN' });
    await completed(next, owner);
  } catch (e) {
    if (ownsJob(owner)) error.value = gitError(e);
  } finally {
    if (ownsJob(owner)) busy.value = false;
  }
}
async function cancelJob() {
  if (!job.value || !active || busy.value) return;
  const id = job.value.id;
  const owner = nextJobIntent();
  busy.value = true;
  try {
    const next = await api<GitJob>(
      endpoint + '/jobs/' + encodeURIComponent(id) + '/cancel',
      'POST',
      {},
    );
    if (!ownsJob(owner)) return;
    if (next.id !== id) throw new ApiError(409, { code: 'GIT_RESULT_UNKNOWN' });
    await completed(next, owner);
  } catch (e) {
    if (ownsJob(owner)) error.value = gitError(e);
  } finally {
    if (ownsJob(owner)) {
      busy.value = false;
      schedule(owner);
    }
  }
}
function editCredential(entry?: GitCredentialSummary) {
  clearSecrets();
  returnToConnection.value = overlay.value === 'connection';
  discardOpen.value = false;
  overlay.value = 'credential';
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
  credentialBaseline.value = credentialDraft();
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
    overlay.value = returnToConnection.value ? 'connection' : null;
    returnToConnection.value = false;
    discardOpen.value = false;
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
    if (active) {
      await refreshPlugins();
      connectionBaseline.value.authorName = authorName.value;
      connectionBaseline.value.authorEmail = authorEmail.value;
      reviewAuthorBaseline.value = { name: authorName.value, email: authorEmail.value };
    }
  } catch (e) {
    if (active) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function previewCommit() {
  if (running.value || repositoryPending.value || !active || unsaved()) return;
  if (commitUnknown.value) {
    error.value = '上次提交结果待核对，请使用“核对提交结果”。';
    return;
  }
  if (!authorReady.value) {
    error.value = gitError('GIT_AUTHOR_REQUIRED');
    return;
  }
  if (!message.value.trim()) {
    error.value = '请填写提交说明。';
    return;
  }
  if (state.value?.changes === 0) {
    error.value = gitError('GIT_NO_CHANGES');
    return;
  }
  const generation = ++previewGeneration;
  const explanation = message.value.trim();
  const previous = preview.value;
  preview.value = undefined;
  previewMessage.value = '';
  commitRequest.value = '';
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    if (previous)
      await api('/api/plugins/git/call', 'POST', {
        kind: 'command',
        id: 'git.cancelPreview',
        input: { token: previous.token },
      });
    const next = await api<any>('/api/plugins/git/call', 'POST', {
      kind: 'command',
      id: 'git.preview',
      input: { message: explanation },
    });
    if (active && generation === previewGeneration && explanation === message.value.trim()) {
      preview.value = next;
      previewMessage.value = explanation;
      commitRequest.value = crypto.randomUUID();
    } else if (next?.token) {
      void api('/api/plugins/git/call', 'POST', {
        kind: 'command',
        id: 'git.cancelPreview',
        input: { token: next.token },
      }).catch(() => {});
    }
  } catch (e) {
    if (active && generation === previewGeneration) error.value = gitError(e);
  } finally {
    if (active) busy.value = false;
  }
}
async function confirmCommit() {
  if (!preview.value || running.value || repositoryPending.value || !active || unsaved()) return;
  if (!commitUnknown.value && previewMessage.value !== message.value.trim()) {
    error.value = '提交说明已修改，请重新预览。';
    return;
  }
  if (!commitUnknown.value && preview.value.expiresAt && preview.value.expiresAt <= Date.now()) {
    cancelPreview();
    error.value = '提交预览已过期，请重新预览。';
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
    commitRequest.value = '';
    previewMessage.value = '';
    message.value = '';
    reviewBaseline.value = '';
    overlay.value = null;
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
      cancelPreview();
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
    <header v-if="!inline || !overlay" class="remote-heading">
      <div>
        <h2>{{ mode === 'import' ? '从 GitHub／Gitee 导入' : '云端同步' }}</h2>
        <p>保存让笔记落到本机；提交记录一个版本；推送才会上传。Git 不能代替独立备份。</p>
      </div>
      <AButton :loading="loading" :disabled="running" @click="load">刷新同步状态</AButton>
    </header>
    <AAlert v-if="error" type="error" show-icon :message="error" role="alert" />
    <AAlert
      v-if="state?.code"
      :type="repositoryPending ? 'info' : 'warning'"
      show-icon
      :message="gitError(state.code)"
    />
    <AAlert
      v-if="notice"
      :type="job?.status === 'cancelled' ? 'info' : 'success'"
      show-icon
      :message="notice"
      role="status"
    />
    <AAlert
      v-if="gitUnsaved"
      type="warning"
      message="当前笔记尚未保存。请返回笔记保存后再提交或拉取。仅推送只上传已提交版本，不会上传草稿。"
      ><template #action><AButton @click="returnSave">返回笔记保存</AButton></template></AAlert
    >
    <div
      v-if="(!inline || !overlay) && state && !repositoryPending && mode !== 'import'"
      class="remote-status"
    >
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
    <SettingsActionCard
      v-if="mode !== 'import' && state && !repositoryPending && (!inline || !overlay)"
      title="云端仓库与认证"
      description="管理仓库地址、分支和登录凭据。"
      icon="refresh"
      :action-label="connection ? '管理同步' : '关联云端仓库'"
      @open="openConnection"
    />
    <div v-if="mode !== 'import' && connection && (!inline || !overlay)" class="remote-section">
      <div class="remote-actions">
        <AButton :disabled="running" @click="startJob('check')">检查云端</AButton>
        <AButton :disabled="running || commitUnknown" @click="startJob('push')">仅推送</AButton>
        <AButton :disabled="running || gitUnsaved || commitUnknown" @click="startJob('pull')"
          >拉取更新</AButton
        >
        <AButton
          :disabled="
            running || (gitUnsaved && !commitUnknown) || (state?.changes === 0 && !commitUnknown)
          "
          @click="openReview"
          >预览提交并推送</AButton
        >
      </div>
      <p>拉取仅支持无本地修改时的快进更新。有分歧时会停止。仅推送会保留本地草稿。</p>
      <p v-if="state?.changes === 0">没有未提交文件。已有本地提交时可以直接“仅推送”。</p>
      <p v-if="committedHead" class="remote-code" role="status">
        本地提交 {{ committedHead }} 已保留；推送失败时可仅推送重试。
      </p>
    </div>
    <div v-if="job && (!inline || !overlay)" class="remote-job" role="status">
      <strong>{{
        job.status === 'cancelled' ? '任务已取消' : jobPhases[job.phase] || '正在处理任务'
      }}</strong>
      <p>
        {{
          job.status === 'cancelled'
            ? '任务已取消；已有资料和已提交版本保留。'
            : job.status === 'needs_reconciliation'
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
    <div v-if="unresolved && (!inline || !overlay)" class="remote-job">
      <p>请求结果尚未确认，请先读取服务器任务回执，避免重复操作。</p>
      <AButton :disabled="running" @click="reconcile">核对请求结果</AButton>
    </div>
    <component
      :is="frameInline ? 'div' : SettingsOverlay"
      v-if="overlay || mode === 'import' || !inline"
      v-bind="frameProps"
      @update:show="updateOverlay"
    >
      <div class="git-overlay-body">
        <header v-if="inline && overlay" class="remote-heading">
          <h3>{{ overlayTitle }}</h3>
          <AButton :disabled="overlayBusy" @click="requestBack">{{
            overlay === 'credential' && returnToConnection ? '返回同步管理' : '返回同步状态'
          }}</AButton>
        </header>
        <AAlert v-if="error && !frameInline" type="error" show-icon :message="error" role="alert" />
        <AAlert
          v-if="notice && !frameInline"
          :type="job?.status === 'cancelled' ? 'info' : 'success'"
          show-icon
          :message="notice"
          role="status"
        />
        <AAlert
          v-if="gitUnsaved && !frameInline"
          type="warning"
          message="当前笔记尚未保存，请返回笔记保存后再提交或拉取。"
        >
          <template #action><AButton @click="returnSave">返回笔记保存</AButton></template>
        </AAlert>
        <AAlert
          v-if="discardOpen"
          type="warning"
          show-icon
          message="有尚未保存的修改，确定放弃吗？"
        >
          <template #action
            ><div class="remote-actions">
              <AButton @click="cancelDiscard">继续编辑</AButton
              ><AButton danger @click="confirmDiscard">放弃修改</AButton>
            </div></template
          >
        </AAlert>
        <template v-if="overlay === 'connection' || (mode === 'import' && !overlay)">
          <section aria-label="云端仓库配置">
            <p>
              此操作会安装并启用 Git
              插件。已有目录与历史会保留；不会自动合并、强推或覆盖其他远端配置。
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
              ><AButton
                :disabled="running || repositoryPending || !url.trim()"
                @click="startJob('test')"
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
                :disabled="
                  running || repositoryPending || !url.trim() || (mode === 'import' && !name.trim())
                "
                @click="startJob(mode === 'import' ? 'clone' : 'connect')"
                >{{ mode === 'import' ? '导入并继续' : '关联云端仓库' }}</AButton
              >
            </div>
          </section>
          <section class="remote-section" aria-label="管理仓库凭据">
            <h3>管理仓库凭据</h3>
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
          </section>
          <details v-if="connection && mode !== 'import'" class="disconnect">
            <summary>解除云端关联</summary>
            <p>只移除 DooKnow 的同步关联，本地原文、版本历史与 Git 远端配置会保留。</p>
            <AButton danger :disabled="running || commitUnknown" @click="startJob('disconnect')"
              >确认解除云端关联</AButton
            >
          </details>
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
        </template>
        <div v-else-if="overlay === 'credential'" class="credential-editor">
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
              ><AButton :disabled="running || repositoryPending" @click="startJob('ssh-host')"
                >读取 SSH 主机指纹</AButton
              >
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
              ><AButton :disabled="running" @click="requestBack">取消编辑凭据</AButton>
            </div>
          </form>
        </div>
        <template v-else-if="overlay === 'review'">
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
              placeholder="简述本次保存的文件变更"
          /></label>
          <p>提交包含暂存、未暂存及未忽略的新增和删除文件。请核对完整文件列表。</p>
          <div class="remote-actions">
            <AButton
              :disabled="
                running ||
                repositoryPending ||
                gitUnsaved ||
                commitUnknown ||
                !message.trim() ||
                !authorReady ||
                state?.changes === 0
              "
              @click="previewCommit"
              >{{ preview ? '重新预览本次提交' : '预览本次提交' }}</AButton
            >
          </div>
          <div v-if="preview" class="commit-preview">
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
          </div>
          <div class="remote-actions">
            <AButton
              v-if="preview"
              type="primary"
              :disabled="running || repositoryPending || gitUnsaved || !previewCurrent"
              @click="confirmCommit"
              >{{ commitUnknown ? '核对提交结果' : '确认提交并推送' }}</AButton
            >
            <AButton :disabled="overlayBusy" @click="requestBack">取消提交</AButton>
          </div>
        </template>
        <div v-if="overlay && jobPending(job)" class="remote-job" role="status">
          <strong>{{ jobPhases[job!.phase] || '正在处理任务' }}</strong>
          <p>任务在服务器上继续，可刷新查看进度。</p>
          <div class="remote-actions">
            <AButton :disabled="busy" @click="poll">刷新任务状态</AButton
            ><AButton :disabled="busy" @click="cancelJob">取消当前任务</AButton>
          </div>
        </div>
        <div v-if="overlay && unresolved" class="remote-job">
          <p>请求结果尚未确认，请先读取服务器任务回执。</p>
          <AButton :disabled="running" @click="reconcile">核对请求结果</AButton>
        </div>
      </div>
    </component>
  </section>
</template>
<style scoped>
.git-remote-panel,
.git-overlay-body {
  display: grid;
  gap: 16px;
  min-width: 0;
  color: var(--text, #262b36);
}
.git-overlay-body {
  min-width: 0;
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
  max-height: min(55vh, 600px);
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
