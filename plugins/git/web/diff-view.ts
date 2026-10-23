import {
  computed,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
  type PropType,
} from 'vue';
import type { DiffFile, DiffLine, OutputFormatType } from 'diff2html/lib/types';

export interface GitDiffInput {
  diff: string;
  truncated?: boolean;
}

export interface GitDiffDocument {
  status: 'loading' | 'ready' | 'empty' | 'unavailable' | 'truncated';
  files: DiffFile[];
}

// Only the provider decides whether the bounded Git output is complete. Never
// parse a partial result or fetch a larger patch to repair a truncated response.
export async function readGitDiff(input: GitDiffInput): Promise<GitDiffDocument> {
  if (input.truncated) return { status: 'truncated', files: [] };
  if (!input.diff.trim()) return { status: 'empty', files: [] };
  try {
    const { parse } = await import('diff2html');
    const files = parse(input.diff);
    if (files.length) return { status: 'ready', files };
    if (/^commit [a-f\d]{40,64}\b/m.test(input.diff)) return { status: 'empty', files: [] };
  } catch {
    // The original text remains usable if the parser chunk or parsing fails.
  }
  return { status: 'unavailable', files: [] };
}

const styles = `
.git-diff-view { min-width: 0; margin-bottom: 12px; }
.git-diff-view .git-diff-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.git-diff-view .git-diff-toolbar button { padding: 4px 10px; border: 1px solid var(--border, #d8dde6); border-radius: 5px; background: var(--surface-soft, #fafbfc); color: var(--text, #262b36); font: inherit; cursor: pointer; }
.git-diff-view .git-diff-toolbar button[aria-pressed="true"] { border-color: var(--blue, #4566c6); color: var(--blue, #4566c6); }
.git-diff-view .git-diff-toolbar button:focus-visible { outline: 2px solid var(--blue, #4566c6); outline-offset: 2px; }
.git-diff-view .git-diff-toolbar button:disabled { opacity: .5; cursor: default; }
.git-diff-view .git-diff-layout-hint, .git-diff-view .git-diff-notice { color: var(--muted, #7a8190); font-size: 12px; }
.git-diff-view .git-diff-notice { margin: 8px 0 12px; }
.git-diff-view .git-diff-files { min-width: 0; max-height: 45vh; overflow: auto; overscroll-behavior: contain; border: 1px solid var(--border, #e3e6ec); border-radius: 6px; }
.git-diff-view .git-diff-file + .git-diff-file { border-top: 1px solid var(--border, #e3e6ec); }
.git-diff-view .git-diff-file-heading { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; margin: 0; padding: 9px 11px; background: var(--surface-soft, #fafbfc); font-size: 12px; }
.git-diff-view .git-diff-file-heading strong { min-width: 0; overflow-wrap: anywhere; }
.git-diff-view .git-diff-count { color: var(--muted, #7a8190); font-size: 11px; }
.git-diff-view .git-diff-file > .git-diff-notice { padding: 0 11px; }
.git-diff-view .git-diff-table { width: 100%; border-collapse: collapse; table-layout: fixed; font: 12px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
.git-diff-view .git-diff-table th { padding: 4px; border-bottom: 1px solid var(--border, #e3e6ec); background: var(--surface-soft, #fafbfc); color: var(--muted, #7a8190); font-size: 11px; font-weight: 400; }
.git-diff-view .git-diff-table td { padding: 0 6px; vertical-align: top; }
.git-diff-view .git-diff-number { width: 48px; color: var(--muted, #7a8190); text-align: right; font-variant-numeric: tabular-nums; user-select: none; border-right: 1px solid var(--border, #e3e6ec); }
.git-diff-view .git-diff-code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.git-diff-view .git-diff-delete { background: color-mix(in srgb, #d94d4d 14%, transparent); }
.git-diff-view .git-diff-insert { background: color-mix(in srgb, #2baf74 15%, transparent); }
.git-diff-view .git-diff-hunk td { padding: 5px 8px; background: color-mix(in srgb, #5279cd 10%, transparent); color: var(--muted, #7a8190); white-space: pre-wrap; overflow-wrap: anywhere; }
.git-diff-view .git-diff-raw { margin-top: 10px; }
.git-diff-view .git-diff-raw summary { margin-bottom: 7px; color: var(--muted, #7a8190); cursor: pointer; font-size: 12px; }
@media (max-width: 600px) {
  .git-diff-view .git-diff-number { width: 34px; }
  .git-diff-view .git-diff-table { font-size: 11px; }
}
`;

function numberCell(number: number | undefined, side: '旧' | '新') {
  return h(
    'td',
    {
      class: 'git-diff-number',
      'aria-label': number === undefined ? undefined : `${side}行 ${number}`,
    },
    number === undefined ? '' : String(number),
  );
}

function codeCell(line?: DiffLine) {
  return h(
    'td',
    {
      class: ['git-diff-code', line && `git-diff-${line.type}`],
      'data-line-type': line?.type,
      'aria-label': line?.type === 'insert' ? '新增' : line?.type === 'delete' ? '删除' : undefined,
    },
    line?.content ?? '',
  );
}

function sideRows(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  let at = 0;
  while (at < lines.length) {
    if (lines[at].type === 'context') {
      rows.push({ left: lines[at], right: lines[at] });
      at++;
      continue;
    }
    const deleted: DiffLine[] = [],
      inserted: DiffLine[] = [];
    while (at < lines.length && lines[at].type !== 'context') {
      (lines[at].type === 'delete' ? deleted : inserted).push(lines[at++]);
    }
    for (let index = 0; index < Math.max(deleted.length, inserted.length); index++)
      rows.push({ left: deleted[index], right: inserted[index] });
  }
  return rows;
}

function fileName(file: DiffFile) {
  if (file.isRename || file.isCopy) return `${file.oldName} → ${file.newName}`;
  return file.isDeleted ? file.oldName : file.newName;
}

function fileTable(file: DiffFile, layout: OutputFormatType) {
  const side = layout === 'side-by-side';
  return h('section', { class: 'git-diff-file' }, [
    h('h4', { class: 'git-diff-file-heading' }, [
      h('strong', fileName(file)),
      h(
        'span',
        { class: 'git-diff-count' },
        `新增 ${file.addedLines} 行，删除 ${file.deletedLines} 行`,
      ),
    ]),
    file.isBinary
      ? h('p', { class: 'git-diff-notice' }, '二进制文件内容已变化，无法逐行显示。')
      : !file.blocks.length
        ? h('p', { class: 'git-diff-notice' }, '文件信息已变化，没有文本行差异。')
        : h('table', { class: 'git-diff-table', 'aria-label': `${fileName(file)} 的版本差异` }, [
            h(
              'colgroup',
              side
                ? [
                    h('col', { class: 'git-diff-number' }),
                    h('col'),
                    h('col', { class: 'git-diff-number' }),
                    h('col'),
                  ]
                : [
                    h('col', { class: 'git-diff-number' }),
                    h('col', { class: 'git-diff-number' }),
                    h('col'),
                  ],
            ),
            h(
              'thead',
              h(
                'tr',
                side
                  ? [
                      h('th', { scope: 'col' }, '旧行'),
                      h('th', { scope: 'col' }, '旧内容'),
                      h('th', { scope: 'col' }, '新行'),
                      h('th', { scope: 'col' }, '新内容'),
                    ]
                  : [
                      h('th', { scope: 'col' }, '旧行'),
                      h('th', { scope: 'col' }, '新行'),
                      h('th', { scope: 'col' }, '内容'),
                    ],
              ),
            ),
            ...file.blocks.map((block) =>
              h('tbody', [
                h(
                  'tr',
                  { class: 'git-diff-hunk' },
                  h('td', { colspan: side ? 4 : 3 }, block.header),
                ),
                ...(side
                  ? sideRows(block.lines).map(({ left, right }) =>
                      h(
                        'tr',
                        {
                          'data-old-line': left?.oldNumber,
                          'data-new-line': right?.newNumber,
                        },
                        [
                          numberCell(left?.oldNumber, '旧'),
                          codeCell(left),
                          numberCell(right?.newNumber, '新'),
                          codeCell(right),
                        ],
                      ),
                    )
                  : block.lines.map((line) =>
                      h(
                        'tr',
                        {
                          class: `git-diff-${line.type}`,
                          'data-line-type': line.type,
                          'data-old-line': line.oldNumber,
                          'data-new-line': line.newNumber,
                        },
                        [
                          numberCell(line.oldNumber, '旧'),
                          numberCell(line.newNumber, '新'),
                          codeCell(line),
                        ],
                      ),
                    )),
              ]),
            ),
          ]),
  ]);
}

// All filenames, hunk headers and source lines become Vue text children. The
// parser's HTML renderer is deliberately unused, including in the raw fallback.
export const GitDiffBody = defineComponent({
  name: 'GitDiffBody',
  props: {
    document: { type: Object as PropType<GitDiffDocument>, required: true },
    diff: { type: String, required: true },
    layout: { type: String as PropType<OutputFormatType>, default: 'line-by-line' },
  },
  setup(props) {
    return () => {
      const status = props.document.status;
      return h('div', { class: 'git-diff-body', 'data-diff-layout': props.layout }, [
        status === 'truncated'
          ? h(
              'p',
              { class: 'git-diff-notice', role: 'status' },
              '差异超过 256 KiB，请在服务器查看。',
            )
          : [
              status === 'loading' &&
                h('p', { class: 'git-diff-notice', role: 'status' }, '正在准备差异视图…'),
              status === 'empty' &&
                h('p', { class: 'git-diff-notice', role: 'status' }, '没有文本差异。'),
              status === 'unavailable' &&
                h(
                  'p',
                  { class: 'git-diff-notice', role: 'status' },
                  '差异对照暂不可用，已保留原始差异。',
                ),
              status === 'ready' &&
                h(
                  'div',
                  { class: 'git-diff-files' },
                  props.document.files.map((file) => fileTable(file, props.layout)),
                ),
              h(
                'details',
                { class: 'git-diff-raw', open: status === 'unavailable' || status === 'loading' },
                [h('summary', '原始差异'), h('pre', props.diff)],
              ),
            ],
      ]);
    };
  },
});

export const GitDiffView = defineComponent({
  name: 'GitDiffView',
  props: {
    diff: { type: String, required: true },
    truncated: { type: Boolean, default: false },
  },
  setup(props) {
    const host = ref<HTMLElement>();
    const document = shallowRef<GitDiffDocument>({ status: 'loading', files: [] });
    const preferredLayout = ref<OutputFormatType>('line-by-line');
    const narrow = ref(false);
    const layout = computed<OutputFormatType>(() =>
      narrow.value ? 'line-by-line' : preferredLayout.value,
    );
    let generation = 0;
    let observer: ResizeObserver | undefined;
    watch(
      () => [props.diff, props.truncated] as const,
      async () => {
        const request = ++generation;
        document.value = { status: 'loading', files: [] };
        const result = await readGitDiff({ diff: props.diff, truncated: props.truncated });
        if (request === generation) document.value = result;
      },
      { immediate: true },
    );
    const measure = () => {
      const width = host.value?.getBoundingClientRect().width;
      narrow.value = window.innerWidth < 640 || (!!width && width < 600);
    };
    onMounted(() => {
      measure();
      window.addEventListener('resize', measure);
      if (typeof ResizeObserver !== 'undefined' && host.value) {
        observer = new ResizeObserver(measure);
        observer.observe(host.value);
      }
    });
    onUnmounted(() => {
      generation++;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    });
    return () =>
      h('div', { ref: host, class: 'git-diff-view' }, [
        h('style', styles),
        document.value.status === 'ready' &&
          h('div', { class: 'git-diff-toolbar', role: 'group', 'aria-label': '差异布局' }, [
            h(
              'button',
              {
                type: 'button',
                'aria-pressed': layout.value === 'line-by-line',
                onClick: () => (preferredLayout.value = 'line-by-line'),
              },
              '逐行',
            ),
            h(
              'button',
              {
                type: 'button',
                'aria-pressed': layout.value === 'side-by-side',
                disabled: narrow.value,
                onClick: () => (preferredLayout.value = 'side-by-side'),
              },
              '左右对照',
            ),
            narrow.value && h('span', { class: 'git-diff-layout-hint' }, '窗口较窄，使用逐行视图'),
          ]),
        h(GitDiffBody, { document: document.value, diff: props.diff, layout: layout.value }),
      ]);
  },
});
