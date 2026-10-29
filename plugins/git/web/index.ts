import {
  defineAsyncComponent,
  defineComponent,
  h,
  ref,
  shallowRef,
  onMounted,
  onUnmounted,
} from 'vue';
import { NButton, NInput, NAlert, type PluginUIApi } from '@dooknow/plugin-ui';
import { gitDecoration } from './decoration';
import { createGitHistoryModel, gitRestoreMessages } from '../../../packages/plugin-ui/git-history';

const RawDiffFallback = defineComponent({
  props: ['diff', 'truncated', 'error'],
  setup: (props) => () =>
    h('div', [
      !props.truncated &&
        h(
          'p',
          { role: 'status' },
          props.error ? '差异视图加载失败，已保留原始差异。' : '正在准备差异视图…',
        ),
      h('pre', props.truncated ? '差异超过 256 KiB，请在服务器查看。' : props.diff),
    ]),
});

const GitDiffView = defineAsyncComponent({
  loader: () => import('./diff-view').then((module) => module.GitDiffView),
  loadingComponent: RawDiffFallback,
  errorComponent: RawDiffFallback,
  delay: 0,
});

const styles = `
.dooknow-git-view { min-width: 0; color: var(--text, #262b36); font-size: 13px; line-height: 1.65; }
.dooknow-git-view * { box-sizing: border-box; }
.dooknow-git-view h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.dooknow-git-view p { margin: 0; overflow-wrap: anywhere; }
.dooknow-git-view .git-description { margin-bottom: 16px; color: var(--muted, #7a8190); font-size: 12px; line-height: 1.75; }
.dooknow-git-view .git-repository { margin: 10px 0 14px; padding: 11px 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); }
.dooknow-git-view .git-pending { margin: 12px 0; padding: 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; }
.dooknow-git-view .git-pending .git-description { margin: 5px 0 10px; }
.dooknow-git-view .git-form-label { display: block; margin-bottom: 7px; font-weight: 500; }
.dooknow-git-view .git-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dooknow-git-view .git-preview { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border, #e3e6ec); }
.dooknow-git-view .git-preview-heading { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
.dooknow-git-view .git-preview-heading strong { font-size: 13px; font-weight: 600; }
.dooknow-git-view .git-expiry { color: var(--muted, #7a8190); font-size: 11px; font-variant-numeric: tabular-nums; }
.dooknow-git-view .git-change-list { max-height: 34vh; margin-top: 10px; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); }
.dooknow-git-view .git-change { padding: 7px 11px; font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.dooknow-git-view .git-change + .git-change { border-top: 1px solid var(--border, #e3e6ec); }
.dooknow-git-view .git-history-list { display: grid; gap: 8px; }
.dooknow-git-view .git-history-entry { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 12px 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; }
.dooknow-git-view .git-history-entry.selected { border-color: var(--blue, #4566c6); background: var(--surface-soft, #fafbfc); }
.dooknow-git-view .git-history-entry > div { min-width: 0; }
.dooknow-git-view .git-history-summary { font-weight: 500; }
.dooknow-git-view .git-history-meta { display: flex; flex-wrap: wrap; gap: 3px 10px; margin-top: 4px; color: var(--muted, #7a8190); font-size: 11px; font-variant-numeric: tabular-nums; }
.dooknow-git-view .git-history-meta code { font-size: 11px; }
.dooknow-git-view .git-history-entry > .n-button { flex-shrink: 0; }
.dooknow-git-view .git-diff { min-width: 0; margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border, #e3e6ec); }
.dooknow-git-view .git-diff-label { margin-bottom: 8px; color: var(--muted, #7a8190); font-size: 12px; }
.dooknow-git-view .git-diff pre { max-height: 45vh; margin: 0 0 12px; padding: 14px; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); color: var(--text, #262b36); font: 12px/1.75 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.dooknow-git-view .git-restore-confirm { margin-top: 12px; padding: 13px; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; background: var(--surface-soft, #fafbfc); }
.dooknow-git-view .git-restore-confirm p { margin-bottom: 10px; font-size: 12px; }
.dooknow-git-view .git-empty { padding: 24px 16px; border: 1px dashed var(--border, #e3e6ec); border-radius: 6px; color: var(--muted, #7a8190); text-align: center; font-size: 12px; }
.dooknow-git-view > .n-alert { margin-bottom: 14px; }
.dooknow-git-view .git-preview + .n-alert { margin-top: 14px; }
@media (max-width: 600px) {
  .dooknow-git-view .git-history-entry { align-items: flex-start; gap: 8px; padding: 11px; }
  .dooknow-git-view .git-diff pre { padding: 11px; font-size: 11px; }
  .dooknow-git-view .git-change { font-size: 11px; }
}
`;

export function activate(api: PluginUIApi) {
  const state = shallowRef<any>({ repository: 'loading', changes: [] }),
    globalError = ref('');
  let loading: Promise<void> | undefined;
  const messages: Record<string, string> = {
    GIT_AUTHOR_REQUIRED: '请先配置提交作者和邮箱',
    PREVIEW_STALE: '预览后文件或暂存区发生变化，请重新预览',
    GIT_NOTHING_TO_COMMIT: '没有需要提交的变更',
    GIT_RECONCILIATION_REQUIRED: '先核对上一次提交和暂存区',
    GIT_PENDING_OPERATION_REQUIRES_RETRY: '上次提交尚未确认，请按原请求核对',
    GIT_DEPENDENCY_MISSING: '需要安装系统 Git 2.39 或更新版本',
    UNTRUSTED_GIT_FILTER: '仓库存在外部过滤器，暂停写操作',
    UNSUPPORTED_GIT_ENTRY: '仓库包含软链接或子模块，请先在服务器核对后再提交',
    GIT_CONFLICT: '仓库有未解决的冲突，请先在服务器处理',
    VERSION_CONFLICT: '文件已更新，请保留草稿后重新核对',
    WORKSPACE_BUSY: '工作区正在写入，请稍后重试',
  };
  const restoreLimits = gitRestoreMessages;
  const friendly = (e: any) => messages[e.code || e.message] || e.message;
  function refresh() {
    if (loading) return loading;
    loading = api
      .call('provider', 'git.status', {})
      .then((v) => {
        state.value = v;
        globalError.value = '';
      })
      .catch((e) => {
        globalError.value = friendly(e);
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }
  const timer = setInterval(refresh, 10000);
  void refresh();
  const releases: (() => void)[] = [];
  const register = (id: string, component: any) =>
    releases.push(api.registerComponent(id, component));
  register(
    'git.settings',
    defineComponent({
      setup() {
        const busy = ref(false);
        async function init() {
          busy.value = true;
          try {
            await api.call('command', 'git.initialize', { requestId: crypto.randomUUID() });
            await refresh();
            api.notify('Git 仓库已初始化');
          } catch (e) {
            globalError.value = friendly(e);
          } finally {
            busy.value = false;
          }
        }
        async function acknowledge(operationId: string) {
          try {
            await api.call('command', 'git.acknowledge', { operationId, confirm: true });
            await refresh();
          } catch (e) {
            globalError.value = friendly(e);
          }
        }
        return () =>
          h('div', { class: 'dooknow-git-settings dooknow-git-view' }, [
            h('style', styles),
            h('h3', 'Git 仓库'),
            globalError.value && h(NAlert, { type: 'error' }, () => globalError.value),
            h(
              'p',
              { class: 'git-repository' },
              state.value.repository === 'ready'
                ? '当前分支：' + state.value.branch
                : state.value.repository === 'missing'
                  ? '尚未建立 Git 仓库'
                  : state.value.repository === 'loading'
                    ? '正在检查 Git'
                    : messages[state.value.code] || state.value.code,
            ),
            state.value.repository === 'missing' &&
              h(
                NButton,
                { size: 'small', onClick: init, loading: busy.value },
                () => '初始化 Git 仓库（main）',
              ),
            ...(state.value.pending || []).map((p: any) =>
              h('div', { key: p.operationId, class: 'git-pending' }, [
                h('p', `待核对提交：${p.commit || '尚未发布'} · 请求 ${p.requestId} · ${p.phase}`),
                h(
                  'p',
                  { class: 'git-description' },
                  '请在服务器核对当前分支及暂存区。此操作只确认已核对，不修改文件或暂存区。',
                ),
                h(
                  NButton,
                  { size: 'small', onClick: () => acknowledge(p.operationId) },
                  () => '已核对暂存区',
                ),
              ]),
            ),
            h('div', { class: 'git-actions' }, [
              h(NButton, { size: 'small', onClick: refresh }, () => '刷新 Git 状态'),
            ]),
          ]);
      },
    }),
  );
  register(
    'git.decoration',
    defineComponent({
      props: ['context'],
      setup(props) {
        return () => {
          const path = props.context?.relativePath,
            rows = state.value.changes || [],
            decoration = path ? gitDecoration(rows, path) : undefined;
          return decoration
            ? h('span', {
                class: 'dooknow-git-decoration',
                title: decoration.title,
                role: 'img',
                'aria-label': decoration.title,
                style: `display:inline-block;width:8px;height:8px;border-radius:50%;background:${decoration.color};margin:0 4px;flex-shrink:0`,
              })
            : null;
        };
      },
    }),
  );
  register(
    'git.commitAction',
    defineComponent({
      setup: () => () =>
        h(NButton, { onClick: () => api.openPanel('git.commitPanel') }, () => '提交全部变更'),
    }),
  );
  register(
    'git.commitPanel',
    defineComponent({
      setup() {
        const message = ref(''),
          preview = ref<any>(),
          result = ref<any>(),
          error = ref(''),
          busy = ref(false),
          requestId = ref(''),
          uncertain = ref(false);
        function updateMessage(value: string) {
          if (busy.value || uncertain.value) return;
          message.value = value;
          const previous = preview.value;
          if (previous && previous.message !== value.trim()) {
            preview.value = undefined;
            requestId.value = '';
            result.value = undefined;
            void api
              .call('command', 'git.cancelPreview', { token: previous.token })
              .catch(() => {});
          }
        }
        async function perform(fn: () => Promise<void>) {
          if (busy.value) return;
          busy.value = true;
          error.value = '';
          try {
            await fn();
          } catch (e) {
            error.value = friendly(e);
          } finally {
            busy.value = false;
          }
        }
        const cancel = () =>
          perform(async () => {
            if (preview.value)
              await api.call('command', 'git.cancelPreview', { token: preview.value.token });
            preview.value = undefined;
            requestId.value = '';
          });
        const prepare = () =>
          perform(async () => {
            if (uncertain.value) throw Error('请先核对上一次提交结果');
            if (preview.value)
              await api.call('command', 'git.cancelPreview', { token: preview.value.token });
            preview.value = await api.call('command', 'git.preview', { message: message.value });
            requestId.value = crypto.randomUUID();
            result.value = undefined;
          });
        const confirm = () =>
          perform(async () => {
            if (!preview.value || preview.value.message !== message.value.trim())
              throw Error('提交说明已修改，请重新预览');
            uncertain.value = true;
            try {
              result.value = await api.call('command', 'git.commit', {
                token: preview.value.token,
                requestId: requestId.value,
              });
            } catch (e) {
              const response = e as any;
              if ((response.data?.publication || response.publication) === 'not_published') {
                const token = preview.value?.token;
                uncertain.value = false;
                preview.value = undefined;
                requestId.value = '';
                if (token) void api.call('command', 'git.cancelPreview', { token }).catch(() => {});
              }
              throw e;
            }
            uncertain.value = false;
            await refresh();
            api.notifyChanged();
          });
        return () =>
          h('div', { class: 'dooknow-git-commit dooknow-git-view' }, [
            h('style', styles),
            h(
              'p',
              { class: 'git-description' },
              '提交包含暂存、未暂存和未忽略的新增、删除。部分暂存文件使用当前工作树的完整版本。',
            ),
            error.value && h(NAlert, { type: 'error' }, () => error.value),
            h('label', { class: 'git-form-label', for: 'git-commit-message' }, '提交说明'),
            h(NInput, {
              value: message.value,
              'onUpdate:value': updateMessage,
              disabled: busy.value || uncertain.value,
              placeholder: '填写提交说明',
              inputProps: { id: 'git-commit-message', 'aria-label': 'Git 提交说明' },
              type: 'textarea',
              autosize: { minRows: 3, maxRows: 6 },
            }),
            h('div', { class: 'git-actions' }, [
              h(
                NButton,
                { type: 'primary', secondary: true, onClick: prepare, loading: busy.value },
                () => '预览全部变更',
              ),
            ]),
            preview.value &&
              h('div', { class: 'git-preview' }, [
                h('div', { class: 'git-preview-heading' }, [
                  h('strong', `${preview.value.changes.length} 项文件变更`),
                  h(
                    'span',
                    { class: 'git-expiry' },
                    `预览有效至 ${new Date(preview.value.expiresAt).toLocaleTimeString()}`,
                  ),
                ]),
                ...(preview.value.partialStaging.length
                  ? [
                      h(
                        NAlert,
                        { type: 'warning' },
                        () =>
                          '以下部分暂存文件将提交完整当前版本：' +
                          preview.value.partialStaging.join('、'),
                      ),
                    ]
                  : []),
                h(
                  'div',
                  { class: 'git-change-list' },
                  preview.value.changes.map((c: any) =>
                    h('p', { key: c.path, class: 'git-change' }, c.code + ' · ' + c.path),
                  ),
                ),
                h('div', { class: 'git-actions' }, [
                  h(
                    NButton,
                    {
                      type: 'primary',
                      onClick: confirm,
                      loading: busy.value,
                      disabled: !!result.value,
                    },
                    () => (uncertain.value ? '核对提交结果' : '确认提交'),
                  ),
                  h(
                    NButton,
                    { onClick: cancel, disabled: busy.value || !!result.value || uncertain.value },
                    () => '取消预览',
                  ),
                ]),
              ]),
            result.value &&
              h(
                NAlert,
                { type: result.value.needsReconciliation ? 'warning' : 'success' },
                () =>
                  `提交 ${result.value.commit} ${result.value.needsReconciliation ? '已生成，暂存区需在服务器核对' : '已完成'}`,
              ),
          ]);
      },
    }),
  );
  register(
    'git.history',
    defineComponent({
      props: ['context'],
      setup(props) {
        const model = createGitHistoryModel({
          call: (kind, id, input) => api.call(kind, id, input),
          context: () => ({
            noteId: props.context?.note?.id || props.context?.noteId,
            expectedModifiedAt: props.context?.expectedModifiedAt,
          }),
          friendlyError: friendly,
          onRestored: async (noteId) => {
            api.notifyChanged(noteId);
            api.notify('笔记已恢复，当前编辑草稿仍保留');
            await refresh();
          },
        });
        const {
          rows,
          cursor,
          diff,
          diffTruncated,
          diffCommit,
          diffLoading,
          error,
          selected,
          confirmRestore,
          restoreNeedsReload,
          restoreBlockedCode,
          busy,
          pendingRestore,
          load,
          show,
          restore,
          cancelRestore,
        } = model;
        onMounted(() => load());
        onUnmounted(() => model.dispose());
        return () =>
          h('div', { class: 'dooknow-git-history dooknow-git-view' }, [
            h('style', styles),
            error.value && h(NAlert, { type: 'error' }, () => error.value),
            restoreNeedsReload.value &&
              h(
                NAlert,
                { type: 'warning' },
                () =>
                  '恢复未执行。请关闭此面板，保留当前编辑草稿并重新读取笔记后，再打开 Git 版本恢复。',
              ),
            restoreBlockedCode.value &&
              h(
                NAlert,
                { type: 'warning' },
                () =>
                  restoreLimits[restoreBlockedCode.value] || restoreLimits.GIT_RESTORE_UNSUPPORTED,
              ),
            h(
              'div',
              { class: 'git-history-list' },
              rows.value.length
                ? rows.value.map((r) =>
                    h(
                      'div',
                      {
                        key: r.commit,
                        class: ['git-history-entry', { selected: selected.value === r.commit }],
                      },
                      [
                        h('div', [
                          h('p', { class: 'git-history-summary' }, `${r.author} · ${r.message}`),
                          h('div', { class: 'git-history-meta' }, [
                            h('span', r.at),
                            h('code', { title: r.commit }, r.commit.slice(0, 8)),
                          ]),
                        ]),
                        h(
                          NButton,
                          { size: 'small', disabled: busy.value, onClick: () => show(r.commit) },
                          () => '查看差异',
                        ),
                      ],
                    ),
                  )
                : [h('p', { class: 'git-empty' }, '暂无 Git 提交记录。')],
            ),
            cursor.value &&
              h('div', { class: 'git-actions' }, [
                h(NButton, { size: 'small', onClick: () => load(true) }, () => '更早的 Git 提交'),
              ]),
            selected.value &&
              h('div', { class: 'git-diff' }, [
                h('p', { class: 'git-diff-label' }, `版本差异 · ${selected.value.slice(0, 12)}`),
                diffLoading.value && h('p', { role: 'status' }, '正在读取版本差异…'),
                diffCommit.value === selected.value &&
                  h(GitDiffView, {
                    key: diffCommit.value,
                    diff: diff.value,
                    truncated: diffTruncated.value,
                  }),
                diffCommit.value === selected.value &&
                  h(
                    NButton,
                    {
                      size: 'small',
                      disabled:
                        busy.value || restoreNeedsReload.value || !!restoreBlockedCode.value,
                      onClick: () => (confirmRestore.value = true),
                    },
                    () => '恢复此版本',
                  ),
                confirmRestore.value &&
                  h('div', { class: 'git-restore-confirm' }, [
                    h('p', '恢复会保存为当前笔记的新版本。未保存的编辑草稿会保留，请先确认草稿。'),
                    h('div', { class: 'git-actions' }, [
                      h(
                        NButton,
                        {
                          size: 'small',
                          disabled: busy.value || !!pendingRestore.value,
                          onClick: cancelRestore,
                        },
                        () => '取消恢复',
                      ),
                      h(
                        NButton,
                        { type: 'primary', size: 'small', onClick: restore, loading: busy.value },
                        () => (pendingRestore.value ? '核对恢复结果' : '确认恢复笔记'),
                      ),
                    ]),
                  ]),
              ]),
          ]);
      },
    }),
  );
  const changed = () => {
    void refresh();
  };
  window.addEventListener('dooknow-workspace-changed', changed);
  return () => {
    clearInterval(timer);
    window.removeEventListener('dooknow-workspace-changed', changed);
    for (const release of releases.reverse()) release();
  };
}
