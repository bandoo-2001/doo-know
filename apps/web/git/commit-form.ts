import { defineComponent, h, ref } from 'vue';
import { NButton, NInput, NAlert } from 'naive-ui';
import { featureAction } from '../features';
import { gitError } from '../git-sync';
import { refreshGitStatus } from './status';

function gitCall(kind: 'command' | 'provider', id: string, input: unknown) {
  return featureAction('git', kind, id, input);
}

const styles = `
.dooknow-git-view { min-width: 0; color: var(--text); font-size: 13px; line-height: 1.65; }
.dooknow-git-view * { box-sizing: border-box; }
.dooknow-git-view h3 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.dooknow-git-view p { margin: 0; overflow-wrap: anywhere; }
.dooknow-git-view .git-description { margin-bottom: 16px; color: var(--muted); font-size: 12px; line-height: 1.75; }
.dooknow-git-view .git-form-label { display: block; margin-bottom: 7px; font-weight: 500; }
.dooknow-git-view .git-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dooknow-git-view .git-preview { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--border); }
.dooknow-git-view .git-preview-heading { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-bottom: 10px; }
.dooknow-git-view .git-preview-heading strong { font-size: 13px; font-weight: 600; }
.dooknow-git-view .git-expiry { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.dooknow-git-view .git-change-list { max-height: 34vh; margin-top: 10px; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border); border-radius: var(--ui-radius, 8px); background: var(--surface-soft); }
.dooknow-git-view .git-change { padding: 7px 11px; font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.dooknow-git-view .git-change + .git-change { border-top: 1px solid var(--border); }
.dooknow-git-view .git-empty { padding: 24px 16px; border: 1px dashed var(--border); border-radius: var(--ui-radius, 8px); color: var(--muted); text-align: center; font-size: 12px; }
.dooknow-git-view > .n-alert { margin-bottom: 14px; }
.dooknow-git-view .git-preview + .n-alert { margin-top: 14px; }
@media (max-width: 600px) {
  .dooknow-git-view .git-change { font-size: 11px; }
}
`;

export const GitCommitForm = defineComponent({
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
        void gitCall('command', 'git.cancelPreview', { token: previous.token }).catch(() => {});
      }
    }
    async function perform(fn: () => Promise<void>) {
      if (busy.value) return;
      busy.value = true;
      error.value = '';
      try {
        await fn();
      } catch (e) {
        error.value = gitError(e);
      } finally {
        busy.value = false;
      }
    }
    const cancel = () =>
      perform(async () => {
        if (preview.value)
          await gitCall('command', 'git.cancelPreview', { token: preview.value.token });
        preview.value = undefined;
        requestId.value = '';
      });
    const prepare = () =>
      perform(async () => {
        if (uncertain.value) throw Error('请先核对上一次提交结果');
        if (preview.value)
          await gitCall('command', 'git.cancelPreview', { token: preview.value.token });
        preview.value = await gitCall('command', 'git.preview', { message: message.value });
        requestId.value = crypto.randomUUID();
        result.value = undefined;
      });
    const confirm = () =>
      perform(async () => {
        if (!preview.value || preview.value.message !== message.value.trim())
          throw Error('提交说明已修改，请重新预览');
        uncertain.value = true;
        try {
          result.value = await gitCall('command', 'git.commit', {
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
            if (token) void gitCall('command', 'git.cancelPreview', { token }).catch(() => {});
          }
          throw e;
        }
        uncertain.value = false;
        await refreshGitStatus().catch(() => {});
        window.dispatchEvent(new CustomEvent('dooknow-workspace-changed'));
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
});
