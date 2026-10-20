import { ref } from 'vue';
import { api, ApiError } from './api';
export const gitUnsaved = ref(false);
/** Existing plugin note updates use noteId; remote pulls refresh the whole workspace. */
export interface WorkspaceChangeDetail {
  scope?: 'workspace';
  noteId?: string;
}
const messages: Record<string, string> = {
  GIT_INVALID_REMOTE: '请填写 GitHub 或 Gitee 的仓库克隆地址，地址不能包含密码、令牌或额外参数。',
  GIT_INVALID_BRANCH: '分支名称无法使用，请核对云端分支名称。',
  GIT_INVALID_CREDENTIAL: '凭据内容不完整或格式无法使用，请核对名称及认证内容。',
  GIT_SSH_TRUST_REQUIRED: '请先核对官方 SSH 主机指纹，并明确确认信任。',
  GIT_INVALID_HOST_KEY: 'SSH 主机记录格式无法使用，请粘贴经过核对的 known_hosts。',
  GIT_CREDENTIAL_UNAVAILABLE: '凭据已移除或临时凭据已过期，请重新选择认证。',
  GIT_TASK_INTERRUPTED: '任务被服务重启中断，结果待核对。请先检查状态再重试。',
  GIT_COMMAND_CANCELLED: '任务已取消，请刷新核对状态后再继续。',
  GIT_TASK_BUSY: '另一个仓库任务正在进行，请等待完成。',
  GIT_DEPENDENCY_MISSING: '系统 Git 尚未准备好，请让部署者安装 Git 2.39 或更新版本。',
  GIT_RECONCILIATION_REQUIRED: '本地提交状态待核对，请先在版本记录中完成核对再同步。',
  GIT_OPERATION_IN_PROGRESS: '本地版本操作正在进行，请等待或先核对上次操作。',
  GIT_REMOTE_ALREADY_EXISTS: '当前仓库已有不同的云端地址。请核对现有远端，不会覆盖其配置。',
  GIT_BRANCH_CHANGED: '本地分支已变化，请刷新后重新核对关联分支。',
  SOURCE_UNAVAILABLE: '原文目录暂时不可用，请检查服务器上的目录或磁盘挂载。',
  PREVIEW_STALE: '预览后文件或暂存区发生变化，请重新预览。',
  PREVIEW_EXPIRED: '预览已经过期，请重新预览。',
  UNSUPPORTED_GIT_ENTRY: '云端包含链接或子模块等不支持的文件，不会覆盖本地资料。',
  INVALID_GIT_URL: '请填写 GitHub 或 Gitee 仓库的克隆地址，地址不能包含密码或令牌。',
  GIT_INVALID_URL: '请填写 GitHub 或 Gitee 仓库的克隆地址，地址不能包含密码或令牌。',
  GIT_AUTH_FAILED: '认证失败，请检查令牌或 SSH 密钥。',
  GIT_PERMISSION_DENIED: '没有访问或推送权限，请核对仓库权限、令牌范围及分支保护。',
  GIT_NETWORK_FAILED: '网络连接失败。已提交的版本会保留，可稍后仅推送。',
  GIT_COMMAND_TIMEOUT: '连接超时。请先刷新核对任务状态，再决定是否重试。',
  GIT_REMOTE_REJECTED: '云端拒绝操作，请检查推送权限和分支保护规则。',
  GIT_HOST_KEY_CHANGED: 'SSH 主机身份与已信任记录不一致。请核对官方指纹后再更新凭据。',
  GIT_HOST_TRUST_REQUIRED: '请先核对 SSH 主机指纹，并明确确认信任。',
  GIT_UNSAFE_CONFIG: '仓库包含不受支持的 Git 配置，请先请部署者检查配置。',
  GIT_LOCAL_CHANGES: '本地存在未提交修改，请先保存并提交后再拉取。',
  GIT_DIVERGED: '本地与云端提交已分歧，需要手动处理；不会自动合并或覆盖资料。',
  GIT_BINDING_CHANGED: '知识库目录已改变，请刷新后重新核对连接。',
  GIT_CONNECTION_CHANGED: '云端关联已改变，请刷新后重新核对连接。',
  GIT_RESULT_UNKNOWN: '上次操作结果待核对，请检查云端或刷新任务，避免重复操作。',
  GIT_JOB_INTERRUPTED: '任务被服务重启中断，请先核对结果再重试。',
  GIT_JOB_CANCELLED: '任务已取消。请刷新核对本地与云端状态。',
  GIT_CREDENTIAL_NOT_FOUND: '凭据已移除或临时凭据已过期，请重新选择认证。',
  GIT_CREDENTIAL_REQUIRED: '请为这个私有仓库选择凭据。',
  GIT_AUTHOR_REQUIRED: '请先设置版本记录的提交作者和邮箱。',
  GIT_PREVIEW_CHANGED: '预览后文件发生变化，请重新预览。',
  INVALID_GIT_PREVIEW: '预览已经失效，请重新预览。',
  GIT_PREVIEW_EXPIRED: '预览已经过期，请重新预览。',
  GIT_NO_CHANGES: '没有需要提交的文件。如果已有待上传版本，请使用“仅推送”。',
  GIT_NOTHING_TO_COMMIT: '没有需要提交的文件。如果已有待上传版本，请使用“仅推送”。',
  GIT_REMOTE_NOT_EMPTY: '云端已有资料，请先导入到独立的新知识库，或手动处理双方历史。',
  GIT_REMOTE_AHEAD: '云端存在新版本，请检查云端并拉取更新。',
  GIT_BUSY: '另一个仓库任务正在进行，请等待完成。',
  GIT_JOB_BUSY: '另一个仓库任务正在进行，请等待完成。',
  GIT_NOT_INSTALLED: '系统 Git 尚未准备好，请让部署者安装 Git 2.39 或更新版本。',
  GIT_PLUGIN_DISABLED: '请先启用 Git 插件。',
  GIT_UNSUPPORTED_TREE: '云端包含链接或子模块等不支持的文件，不会覆盖本地资料。',
  DIRECTORY_EXISTS: '目标文件夹已经存在，请换一个知识库名称或保存位置。',
  INVALID_LIBRARY_NAME: '请填写知识库名称，不要包含斜杠，也不要以点开头。',
  FORBIDDEN_KNOWLEDGE_ROOT: '这个位置不能用于保存资料，请换一个保存位置。',
  PLUGIN_INSTALL_FAILED: '功能添加失败。请刷新核对安装状态后重试。',
  PLUGIN_DOWNLOAD_TIMEOUT: '下载超时，请检查部署设备的网络或下载代理，再核对安装状态。',
  PLUGIN_INSTALL_INTERRUPTED: '安装被中断，结果待核对。请刷新安装状态后重试。',
};
export function gitError(value: unknown): string {
  const code =
    typeof value === 'string'
      ? value
      : value instanceof ApiError
        ? String(value.data.code || (value.data.error as any)?.code || '')
        : '';
  if (value instanceof ApiError && value.status === 401) return '登录已过期，请重新登录后继续。';
  return messages[code] || '暂时无法完成操作，请刷新核对状态后重试。输入和已提交版本会保留。';
}
export const jobPhases: Record<string, string> = {
  queued: '等待开始',
  checking_dependency: '准备 Git 功能',
  testing_connection: '测试读取连接',
  cloning: '下载仓库资料',
  checking_files: '检查资料文件',
  publishing: '准备保存目录',
  binding: '连接知识库',
  checking_remote: '检查云端版本',
  fetching: '读取云端更新',
  pushing: '推送已提交版本',
  updating_files: '更新本地原文',
  refreshing: '刷新目录与搜索索引',
  complete: '已完成',
  downloading: '下载插件',
  verifying: '校验安装包',
  installing: '安装插件',
};
export interface PluginInstallation {
  id: string;
  pluginId: string;
  version: string;
  requestId?: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_reconciliation';
  phase: string;
  error?: string;
}
export const jobPending = (job?: { status: string } | null) =>
  !!job && ['queued', 'running'].includes(job.status);
function wait(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('已离开页面', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 450);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Check server receipts before every new install, including after a browser reload/lost response. */
export async function installPlugin(
  id: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (job: PluginInstallation) => void;
    receiptId?: string;
  } = {},
) {
  const current = () => {
    if (options.signal?.aborted) throw new DOMException('已离开页面', 'AbortError');
  };
  current();
  // Resume a known receipt directly: terminal transitions must never become a new install.
  const receipt = options.receiptId
    ? await api<PluginInstallation>(
        '/api/platform/plugin-installations/' + encodeURIComponent(options.receiptId),
      )
    : undefined;
  current();
  if (receipt && receipt.pluginId !== id)
    throw new ApiError(409, { code: 'PLUGIN_INSTALL_FAILED' });
  const list = receipt
    ? undefined
    : await api<{ items: PluginInstallation[] }>('/api/platform/plugin-installations');
  current();
  let job = receipt || list?.items.find((entry) => entry.pluginId === id && jobPending(entry));
  if (!job) {
    const requestId = crypto.randomUUID();
    try {
      job = await api<PluginInstallation>('/api/platform/plugin-installations', 'POST', {
        id,
        requestId,
      });
    } catch (error) {
      // A timed out POST may have started installation. Do not issue another POST.
      current();
      const receipt = await api<{ items: PluginInstallation[] }>(
        '/api/platform/plugin-installations',
      );
      job = receipt.items.find(
        (entry) => entry.requestId === requestId || (entry.pluginId === id && jobPending(entry)),
      );
      if (!job) throw error;
    }
  }
  while (true) {
    current();
    options.onUpdate?.(job);
    if (!jobPending(job)) {
      if (job.status !== 'succeeded')
        throw new ApiError(409, { code: job.error || 'PLUGIN_INSTALL_INTERRUPTED' });
      return job;
    }
    await wait(options.signal);
    current();
    job = await api<PluginInstallation>(
      '/api/platform/plugin-installations/' + encodeURIComponent(job.id),
    );
  }
}
