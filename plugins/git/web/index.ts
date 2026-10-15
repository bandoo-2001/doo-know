import { defineComponent, h, ref, shallowRef, onMounted, onUnmounted } from 'vue';
import { NButton, NInput, NAlert, type PluginUIApi } from '@dooknow/plugin-ui';
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
          h('div', { class: 'dooknow-git-settings' }, [
            h('h3', 'Git 仓库'),
            globalError.value && h(NAlert, { type: 'error' }, () => globalError.value),
            h(
              'p',
              state.value.repository === 'ready'
                ? '当前分支：' + state.value.branch
                : state.value.repository === 'missing'
                  ? '尚未建立 Git 仓库'
                  : state.value.repository === 'loading'
                    ? '正在检查 Git'
                    : messages[state.value.code] || state.value.code,
            ),
            state.value.repository === 'missing' &&
              h(NButton, { onClick: init, loading: busy.value }, () => '初始化 Git 仓库（main）'),
            ...(state.value.pending || []).map((p: any) =>
              h('div', { key: p.operationId }, [
                h('p', `待核对提交：${p.commit || '尚未发布'} · 请求 ${p.requestId} · ${p.phase}`),
                h('p', '请在服务器核对当前分支及暂存区。此操作只确认已核对，不修改文件或暂存区。'),
                h(NButton, { onClick: () => acknowledge(p.operationId) }, () => '已核对暂存区'),
              ]),
            ),
            h(NButton, { onClick: refresh }, () => '刷新 Git 状态'),
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
            change = rows.find((r: any) => r.path === path),
            nested = rows.some((r: any) => r.path.startsWith(path + '/'));
          return change || nested
            ? h(
                'span',
                { class: 'dooknow-git-decoration', title: change?.code || '目录包含变更' },
                change?.code || '●',
              )
            : null;
        };
      },
    }),
  );
  register(
    'git.historyAction',
    defineComponent({
      props: ['context'],
      setup: (props) => () =>
        h(
          NButton,
          { size: 'small', onClick: () => api.openPanel('git.history', props.context) },
          () => 'Git 版本',
        ),
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
        async function perform(fn: () => Promise<void>) {
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
          h('div', { class: 'dooknow-git-commit' }, [
            h(
              'p',
              '提交包含暂存、未暂存和未忽略的新增、删除。部分暂存文件使用当前工作树的完整版本。',
            ),
            error.value && h(NAlert, { type: 'error' }, () => error.value),
            h(NInput, {
              value: message.value,
              'onUpdate:value': (v) => (message.value = v),
              placeholder: '填写提交说明',
              inputProps: { 'aria-label': 'Git 提交说明' },
              type: 'textarea',
            }),
            h(NButton, { onClick: prepare, loading: busy.value }, () => '预览全部变更'),
            preview.value &&
              h('div', [
                h('p', `预览有效至 ${new Date(preview.value.expiresAt).toLocaleTimeString()}`),
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
                ...preview.value.changes.map((c: any) =>
                  h('p', { key: c.path }, c.code + ' · ' + c.path),
                ),
                h(
                  NButton,
                  { onClick: confirm, loading: busy.value, disabled: !!result.value },
                  () => (uncertain.value ? '核对提交结果' : '确认提交'),
                ),
                h(
                  NButton,
                  { onClick: cancel, disabled: busy.value || !!result.value || uncertain.value },
                  () => '取消预览',
                ),
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
        const rows = ref<any[]>([]),
          cursor = ref<string>(),
          diff = ref(''),
          error = ref(''),
          selected = ref<string>(),
          confirmRestore = ref(false),
          busy = ref(false),
          pendingRestore = ref<any>();
        const noteId = () => props.context?.note?.id || props.context?.noteId;
        async function load(next = false) {
          try {
            const result = await api.call('provider', 'git.history', {
              noteId: noteId(),
              ...(next ? { cursor: cursor.value } : {}),
            });
            rows.value = next ? [...rows.value, ...result.items] : result.items;
            cursor.value = result.nextCursor;
          } catch (e) {
            error.value = friendly(e);
          }
        }
        async function show(commit: string) {
          try {
            if (pendingRestore.value && pendingRestore.value.commit !== commit)
              throw Error('请先核对上一次恢复结果');
            selected.value = commit;
            confirmRestore.value = false;
            const result = await api.call('provider', 'git.diff', { noteId: noteId(), commit });
            diff.value = result.truncated ? '差异超过 256 KiB，请在服务器查看。' : result.diff;
          } catch (e) {
            error.value = friendly(e);
          }
        }
        async function restore() {
          busy.value = true;
          try {
            pendingRestore.value ||= {
              noteId: noteId(),
              commit: selected.value,
              expectedModifiedAt: props.context?.expectedModifiedAt,
              requestId: crypto.randomUUID(),
            };
            if (!pendingRestore.value.expectedModifiedAt) throw Error('请重新打开笔记后再恢复');
            await api.call('command', 'git.restore', pendingRestore.value);
            pendingRestore.value = undefined;
            api.notifyChanged(noteId());
            api.notify('笔记已恢复，当前编辑草稿仍保留');
            confirmRestore.value = false;
            await refresh();
          } catch (e) {
            error.value = friendly(e);
          } finally {
            busy.value = false;
          }
        }
        onMounted(() => load());
        return () =>
          h('div', { class: 'dooknow-git-history' }, [
            error.value && h(NAlert, { type: 'error' }, () => error.value),
            ...rows.value.map((r) =>
              h('div', { key: r.commit }, [
                h('p', `${r.at} · ${r.author} · ${r.message}`),
                h(NButton, { onClick: () => show(r.commit) }, () => '查看差异'),
              ]),
            ),
            cursor.value && h(NButton, { onClick: () => load(true) }, () => '更早的 Git 提交'),
            selected.value &&
              h('div', [
                h(
                  'pre',
                  {
                    style:
                      'white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto',
                  },
                  diff.value,
                ),
                h(NButton, { onClick: () => (confirmRestore.value = true) }, () => '恢复此版本'),
                confirmRestore.value &&
                  h('div', [
                    h('p', '恢复会保存为当前笔记的新版本。未保存的编辑草稿会保留，请先确认草稿。'),
                    h(NButton, { onClick: restore, loading: busy.value }, () =>
                      pendingRestore.value ? '核对恢复结果' : '确认恢复笔记',
                    ),
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
