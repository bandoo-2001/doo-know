import { readFileSync } from 'node:fs';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';
import { afterEach, expect, test, vi } from 'vitest';
import * as workbench from '../apps/web/to-doo-workbench';
import * as reminders from '../apps/web/to-doo-reminders';
import * as push from '../apps/web/to-doo-push';
import * as clock from '../apps/web/to-doo-time';
import * as contracts from '../shared/to-doo-contracts';
import { toDooAntStubs, toDooBoundaryStub } from './support/to-doo-ant-stubs';

type Node = {
  tag: string;
  text: string;
  style: Record<string, any>;
  props: Record<string, any>;
  children: Node[];
  parent?: Node;
};
const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

const Disclosure = Vue.defineComponent({
  props: ['open'],
  setup(props, { slots, expose }) {
    const open = Vue.ref(!!props.open);
    Vue.watch(
      () => props.open,
      (value) => (open.value = !!value),
    );
    expose({ expand: () => (open.value = true) });
    return () =>
      Vue.h('details', { open: open.value }, [
        Vue.h('summary', slots.header?.()),
        slots.default?.(),
      ]);
  },
});
const Form = Vue.defineComponent({
  setup(_, { attrs, slots, expose }) {
    expose({ element: { querySelector: () => null } });
    return () => Vue.h('form', attrs, slots.default?.());
  },
});
function component(name: string): Vue.Component {
  const { descriptor } = parse(
    readFileSync(new URL(`../apps/web/components/to-doo/${name}.vue`, import.meta.url), 'utf8'),
  );
  const compiled = compileScript(descriptor, { id: name, inlineTemplate: true });
  const source = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const output = { exports: {} as any };
  new Function('require', 'module', 'exports', source)(
    (id: string) => {
      if (id === 'vue') return Vue;
      if (id === 'ant-design-vue')
        return {
          ...toDooAntStubs,
          Tabs: Object.assign({}, toDooAntStubs.Tabs, { TabPane: toDooAntStubs.TabPane }),
          Menu: Object.assign({}, toDooAntStubs.Menu, { Item: toDooAntStubs.MenuItem }),
        };
      if (id === '../../to-doo-workbench') return workbench;
      if (id === '../../to-doo-reminders') return reminders;
      if (id === '../../to-doo-push') return push;
      if (id === '../../to-doo-time') return clock;
      if (id === '../../../../shared/to-doo-contracts') return contracts;
      if (id === '../../to-doo-controls') return { useToDooConfirm: () => async () => true };
      if (id.endsWith('ToDooDisclosure.vue')) return { default: Disclosure };
      if (id.endsWith('ToDooFormLayout.vue')) return { default: Form };
      const boundary = toDooBoundaryStub(id);
      if (boundary) return { default: boundary };
      if (id.endsWith('.vue'))
        return { default: component(id.split('/').at(-1)!.replace('.vue', '')) };
      throw Error('Unexpected management dependency: ' + id);
    },
    output,
    output.exports,
  );
  return output.exports.default;
}
function mount(
  name: string,
  model: any,
  section?: string,
  listeners: Record<string, unknown> = {},
) {
  const node = (tag: string, text = ''): Node => ({
    tag,
    text,
    style: {},
    props: {},
    children: [],
  });
  const renderer = Vue.createRenderer<Node, Node>({
    createElement: (tag) => node(tag),
    createText: (text) => node('#text', text),
    createComment: () => node('#comment'),
    insertStaticContent(text, parent) {
      const child = node('#static', text);
      child.parent = parent;
      parent.children.push(child);
      return [child, child];
    },
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
      child.parent = parent;
      const index = anchor ? parent.children.indexOf(anchor) : -1;
      if (index < 0) parent.children.push(child);
      else parent.children.splice(index, 0, child);
    },
    remove(child) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1);
    },
    setText(child, text) {
      child.text = text;
    },
    setElementText(child, text) {
      child.text = text;
      child.children = [];
    },
    patchProp(child, key, _old, value) {
      child.props[key] = value;
    },
    parentNode: (child) => child.parent || null,
    nextSibling: (child) =>
      child.parent?.children[child.parent.children.indexOf(child) + 1] || null,
  });
  const root = node('root');
  const app = renderer.createApp(component(name), {
    model,
    ...(section ? { section } : {}),
    ...listeners,
  });
  const instance = app.mount(root);
  cleanup.push(() => app.unmount());
  const all = (parent = root): Node[] => [parent, ...parent.children.flatMap(all)];
  const text = (parent: Node = root): string => parent.text + parent.children.map(text).join('');
  const button = (name: string) =>
    all().find(
      (child) =>
        child.tag === 'button' &&
        (child.props['aria-label'] === name || text(child).trim() === name),
    )!;
  const disclosure = (name: string) =>
    all().find(
      (child) =>
        child.tag === 'details' &&
        child.children.some((header) => header.tag === 'summary' && text(header).includes(name)),
    )!;
  const visible = (child: Node): boolean =>
    child.style.display !== 'none' && (!child.parent || visible(child.parent));
  return { all, text, button, disclosure, visible, instance };
}
function model() {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  const now = new Date().toISOString();
  const stamp = { id: 'settings', revision: 'r1', createdAt: now, updatedAt: now };
  const state = Vue.reactive<any>({
    snapshot: {
      ...Object.fromEntries(Object.values(contracts.TO_DOO_COLLECTIONS).map((name) => [name, []])),
      now,
      settings: contracts.toDooEntitySchemas.settings.parse(stamp),
      statistics: { from: now.slice(0, 10), to: now.slice(0, 10), completedByDay: {}, byList: {} },
    },
    query: {},
    externalDirty: {},
    pendingOperations: [],
    operationLoading: false,
    operationError: '',
    busy: false,
    loading: false,
    error: '',
    notice: '',
  });
  const load = vi.fn(async (query?: any) => {
    if (query) state.query = query;
  });
  return {
    state,
    load,
    saveEntity: vi.fn(),
    loadPendingOperations: vi.fn(),
    request: vi.fn(
      async (url: string, _method?: string, _body?: unknown): Promise<any> =>
        url === '/api/to-doo/push'
          ? { enabled: false, ready: false, reason: 'host_inactive', devices: [] }
          : [],
    ),
  };
}

test('preset statistics keep dates out of the toolbar until custom is selected', async () => {
  const value = model(),
    view = mount('ToDooReview', value, 'stats');
  const field = () => view.all().find((row) => row.props['aria-label'] === '统计开始日期')!;
  expect(field() && view.visible(field())).toBeFalsy();
  await view.button('自定义').props.onClick();
  await Vue.nextTick();
  const from = view.all().find((row) => row.props['aria-label'] === '统计开始日期')!;
  expect(view.visible(from)).toBe(true);
  from.props.onInput({ target: { value: '2026-10-01' } });
  await view
    .all()
    .find((row) => row.tag === 'form')!
    .props.onSubmit({ preventDefault() {} });
  expect(value.load).toHaveBeenCalledWith(
    expect.objectContaining({ view: 'stats', from: '2026-10-01' }),
  );
  await view.button('近 30 天').props.onClick();
  await Vue.nextTick();
  expect(view.visible(field())).toBe(false);
});

test('existing outcomes do not display an empty-review illustration or zero evidence', () => {
  const value = model();
  value.state.snapshot.outcomes = [
    { id: 'outcome', summary: '已经交付的成果', verification: 'delivered', evidenceRefs: [] },
  ];
  const view = mount('ToDooReview', value, 'stats');
  expect(view.text()).toContain('已经交付的成果');
  expect(view.text()).not.toContain('写下做对的事与下一次调整');
  expect(view.text()).not.toContain('0 份证据');
});

test('filtered notifications keep primary actions while secondary read stays reachable', async () => {
  const value = model();
  value.state.query = { reminderStates: ['unread'] };
  value.state.snapshot.reminderEvents = [
    {
      id: 'reminder',
      sourceType: 'task',
      sourceId: 'task',
      scheduledAt: value.state.snapshot.now,
      userState: 'unread',
      title: '准备报告',
      message: '准备报告',
    },
  ];
  const view = mount('ToDooReview', value, 'notifications');
  const row = view.all().find((child) => child.props['data-reminder-id'] === 'reminder')!;
  const descendants = (parent: Node): Node[] => [parent, ...parent.children.flatMap(descendants)];
  expect(descendants(row).filter((child) => child.tag === 'p')).toHaveLength(0);
  expect(
    descendants(row).filter((child) => String(child.props.class).includes('todo-badge')),
  ).toHaveLength(0);
  expect(view.button('查看任务')).toBeDefined();
  expect(view.button('确认提醒')).toBeDefined();
  expect(view.text()).toContain('不会自动完成');
  expect(view.button('标为已读')?.props.role).toBe('menuitem');
});

test.each([
  ['habit', 'habits', '查看习惯'],
  ['anniversary', 'anniversaries', '查看纪念日'],
])(
  'notification opens its %s source with its section and original date',
  async (sourceType, section, label) => {
    const value = model();
    const source = { sourceId: 'source-1', sourceType, section, date: '2026-10-29' };
    value.state.query = { view: 'notifications' };
    value.state.snapshot.reminderEvents = [
      {
        id: 'source-reminder',
        revision: 'r1',
        sourceType,
        sourceId: 'source-1',
        scheduledAt: value.state.snapshot.now,
        userState: 'read',
        title: '原事项',
      },
    ];
    value.request.mockResolvedValue(source);
    const opened: unknown[] = [];
    const view = mount('ToDooReview', value, 'notifications', {
      onSource: (context: unknown) => opened.push(context),
    });
    const button = view.button(label);
    expect(button).toBeDefined();
    await button.props.onClick();
    expect(opened).toEqual([source]);
  },
);

test('reserved habit history summaries identify themselves and retain notification handling without a misleading habit link', () => {
  const value = model();
  value.state.snapshot.reminderEvents = [
    {
      id: 'habit-history-summary',
      revision: 'r1',
      sourceType: 'habit',
      sourceId: 'habit-1',
      occurrenceKey: 'history:2026-10-01:2026-10-28',
      ruleId: 'history_missed',
      scheduledAt: value.state.snapshot.now,
      userState: 'unread',
      title: '错过的历史周期',
    },
  ];
  const view = mount('ToDooReview', value, 'notifications');
  expect(view.button('查看习惯')).toBeUndefined();
  expect(view.text()).toContain('历史汇总提醒');
  expect(view.button('确认提醒')).toBeDefined();
  expect(view.button('标为已读')).toBeDefined();
  expect(view.button('忽略提醒')).toBeDefined();
});

test('notification history can restore a handled reminder and explicitly choose a 30-minute snooze', async () => {
  vi.stubGlobal('window', { dispatchEvent() {} });
  const value = model();
  value.state.snapshot.reminderEvents = [
    {
      id: 'handled-reminder',
      revision: 'r1',
      sourceType: 'task',
      sourceId: 'source-1',
      scheduledAt: value.state.snapshot.now,
      userState: 'dismissed',
      title: '误忽略',
    },
  ];
  const writes: any[] = [];
  value.request.mockImplementation(async (_url: string, method?: string, body?: unknown) => {
    if (method === 'POST') writes.push(body);
    return {};
  });
  const view = mount('ToDooReview', value, 'notifications');
  expect(view.button('恢复未读')).toBeDefined();
  await view.button('恢复未读').props.onClick();
  expect(writes[0]).toMatchObject({ action: 'unread', expectedRevision: 'r1' });
  expect(writes[0]).not.toHaveProperty('until');
  await Vue.nextTick();
  for (const minutes of [5, 15, 30, 60]) expect(view.button(minutes + ' 分钟后提醒')).toBeDefined();
  await view.button('30 分钟后提醒').props.onClick();
  expect(writes[1]).toMatchObject({ action: 'snooze', expectedRevision: 'r1' });
  expect(Date.parse(writes[1].until) - Date.now()).toBeGreaterThan(29.9 * 60000);
  expect(Date.parse(writes[1].until) - Date.now()).toBeLessThanOrEqual(30 * 60000);
});

test('zero completion days render the number zero without a positive bar', () => {
  const value = model();
  value.state.snapshot.statistics = {
    from: '2026-10-29',
    to: '2026-10-30',
    completedByDay: { '2026-10-30': 2 },
    byList: {},
  };
  const view = mount('ToDooReview', value, 'stats');
  const zero = view.all().find((row) => row.props.title === '2026-10-29：0项')!;
  expect(zero).toBeDefined();
  expect(zero.children.find((row) => row.tag === 'span')?.text).toBe('0');
  expect(zero.children.find((row) => row.tag === 'i')?.props.style.height).toBe('0px');
  expect(view.text()).toContain('归档');
});

test('date preferences are folded and invalid timezone reveals them before saving', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('日期与提醒')?.props.open).toBe(false);
  view
    .all()
    .find((row) => row.props['aria-label'] === '显示时区')!
    .props.onInput({ target: { value: 'Invalid/Zone' } });
  await view
    .all()
    .find((row) => row.tag === 'form')!
    .props.onSubmit();
  await Vue.nextTick();
  expect(view.disclosure('日期与提醒').props.open).toBe(true);
  expect(view.text()).toContain('请检查显示时区');
  expect(value.saveEntity).not.toHaveBeenCalled();
});

test('recovery and calendar forms are folded while drafts and pending recovery survive', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复')?.props.open).toBe(false);
  expect(view.disclosure('连接外部只读日历')?.props.open).toBe(false);
  expect(view.disclosure('创建 To Doo 只读订阅链接')?.props.open).toBe(false);
  const address = view.all().find((row) => row.tag === 'input' && row.props.type === 'url')!;
  address.props.onInput({ target: { value: 'https://example.test/draft.ics' } });
  await Vue.nextTick();
  expect(
    view.all().find((row) => row.tag === 'input' && row.props.type === 'url')!.props.value,
  ).toBe('https://example.test/draft.ics');
  value.state.pendingOperations = [
    {
      id: 'recover',
      title: '等待关联的笔记',
      state: 'note_saved',
      updatedAt: value.state.snapshot.now,
      noteId: 'note',
    },
  ];
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复').props.open).toBe(true);
  expect(view.button('核对并继续')).toBeDefined();
});

test('host and device configuration is secondary while current status and errors stay visible', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  for (let turn = 0; turn < 5; turn++) await Vue.nextTick();
  expect(view.disclosure('主机与设备管理')?.props.open).toBe(false);
  expect(view.button('启用当前设备桌面提醒')).toBeDefined();
  expect(view.text()).toContain('当前设备需要通过 HTTPS');
});

test('recovery errors reveal the section and never claim the pending records are empty', async () => {
  const value = model();
  value.state.operationError = '成果进度读取失败';
  const view = mount('ToDooSettings', value);
  await Vue.nextTick();
  expect(view.disclosure('成果笔记恢复').props.open).toBe(true);
  expect(view.button('查看进度')).toBeDefined();
  expect(view.text()).toContain('成果进度读取失败');
  expect(view.text()).not.toContain('当前已读取的记录没有待继续项');
});

// These assertions catch stale confirmation, hidden import records, wrong request
// identity, lost drafts and timezone drift through the real Settings component.
const settleSettings = async () => {
  for (let turn = 0; turn < 8; turn++) await Vue.nextTick();
};
function settingField(view: ReturnType<typeof mount>, label: string, tag = 'input') {
  return view
    .all()
    .find(
      (row) =>
        row.tag === tag &&
        (row.props['aria-label'] === label ||
          (row.parent?.tag === 'label' && view.text(row.parent).startsWith(label))),
    )!;
}
function importFixture(count = 1) {
  return {
    id: 'preview-a',
    duplicates: 0,
    batchCount: 1,
    batchSize: 200,
    warnings: [],
    items: Array.from({ length: count }, (_, i) => ({
      kind: 'task',
      entity: {
        id: 'task-' + i,
        title: '核对任务 ' + (i + 1),
        listId: 'review-list',
        due: { date: '2026-11-05', time: '09:00', timeZone: 'Asia/Shanghai' },
      },
    })),
  };
}
async function settingsImport(count = 1) {
  const value = model();
  value.state.snapshot.lists = [{ id: 'review-list', name: '核对清单' }];
  const original = value.request.getMockImplementation()!;
  value.request.mockImplementation(async (url: string, ...args: any[]) =>
    url === '/api/to-doo/import/preview' ? importFixture(count) : original(url),
  );
  const view = mount('ToDooSettings', value);
  await settleSettings();
  view
    .all()
    .find((row) => row.tag === 'textarea')!
    .props.onInput({ target: { value: '正文 A' } });
  await settleSettings();
  await view.button('预览导入').props.onClick();
  await settleSettings();
  return { value, view };
}

test.each([
  [
    '正文',
    (view: ReturnType<typeof mount>) =>
      view
        .all()
        .find((row) => row.tag === 'textarea')!
        .props.onInput({ target: { value: '正文 B' } }),
  ],
  [
    '目标清单',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '目标清单', 'select').props.onChange({ target: { value: 'review-list' } }),
  ],
  [
    '格式',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '格式', 'select').props.onChange({ target: { value: 'csv' } }),
  ],
  [
    '重复处理',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '重复处理', 'select').props.onChange({ target: { value: 'copy' } }),
  ],
  [
    '时区',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '导入时区').props.onInput({ target: { value: 'Asia/Tokyo' } }),
  ],
  [
    '内容用途',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '内容用途', 'select').props.onChange({ target: { value: 'calendar' } }),
  ],
  [
    '编码',
    (view: ReturnType<typeof mount>) =>
      settingField(view, '文件编码', 'select').props.onChange({ target: { value: 'gb18030' } }),
  ],
])('changing import %s revokes old confirmation', async (_name, edit) => {
  const { view } = await settingsImport();
  expect(!!view.button('确认导入 1 项')).toBe(true);
  edit(view);
  await settleSettings();
  expect(!!view.button('确认导入 1 项')).toBe(false);
});

test('an outstanding preview response cannot reauthorize changed input', async () => {
  const { view, value } = await settingsImport();
  let finish!: (value: any) => void;
  value.request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = view.button('预览导入').props.onClick();
  await Vue.nextTick();
  view
    .all()
    .find((row) => row.tag === 'textarea')!
    .props.onInput({ target: { value: 'new content' } });
  finish(importFixture());
  await pending;
  await settleSettings();
  expect(!!view.button('确认导入 1 项')).toBe(false);
});

test('all 23 import items can be reviewed with date, kind and destination', async () => {
  const { view } = await settingsImport(23);
  const preview = view
    .all()
    .find((row) => String(row.props.class).includes('todo-import-preview'))!;
  let reviewed = '';
  for (let page = 0; page < 3; page++) {
    reviewed += view.text(preview);
    const next = view.button('下一页预览');
    if (!next || next.props.disabled) break;
    await next.props.onClick();
    await settleSettings();
  }
  for (let i = 1; i <= 23; i++) expect(reviewed).toContain('核对任务 ' + i);
  expect(view.text(preview)).toContain('2026-11-05');
  expect(view.text(preview)).toContain('09:00');
  expect(view.text(preview)).toContain('Asia/Shanghai');
  expect(view.text(preview)).toContain('任务');
  expect(view.text(preview)).toContain('核对清单');
});

test('apply retries reuse the confirmed preview identity after a lost response', async () => {
  const { view, value } = await settingsImport();
  const applied: any[] = [];
  value.request.mockImplementation(async (url: string, _method?: string, body?: any) => {
    if (url === '/api/to-doo/import/apply') {
      applied.push(body);
      if (applied.length === 1) throw Error('response lost');
      return { jobId: 'preview-a', status: 'running', completed: 200, total: 401 };
    }
    if (url.endsWith('/status')) return { status: 'running', completed: 200, total: 401 };
    return [];
  });
  await view.button('确认导入 1 项').props.onClick();
  await settleSettings();
  expect(value.state.error).toBe('response lost');
  await view.button('确认导入 1 项').props.onClick();
  await settleSettings();
  expect(applied).toHaveLength(2);
  expect(applied[0].requestId).toBeTruthy();
  expect(applied[1]).toEqual(applied[0]);
  expect(view.text()).toContain('200 / 401');
  expect(view.button('停止后续批次')).toBeDefined();
});

test.each(['Asia/Shanghai', 'Europe/London'])(
  'display timezone changes keep quiet hours explicit (initial %s)',
  async (quietZone) => {
    const value = model();
    value.state.snapshot.settings.timeZone = 'Asia/Shanghai';
    value.state.snapshot.settings.quietHours = {
      enabled: true,
      start: '22:00',
      end: '08:00',
      timeZone: quietZone,
    };
    const view = mount('ToDooSettings', value);
    await settleSettings();
    settingField(view, '显示时区').props.onInput({ target: { value: 'Asia/Tokyo' } });
    await settleSettings();
    await view
      .all()
      .find((row) => row.tag === 'form')!
      .props.onSubmit();
    expect(value.saveEntity).toHaveBeenCalledWith(
      'settings',
      expect.objectContaining({
        timeZone: 'Asia/Tokyo',
        quietHours: expect.objectContaining({
          timeZone: quietZone === 'Asia/Shanghai' ? 'Asia/Tokyo' : 'Europe/London',
        }),
      }),
      'r1',
      '偏好已保存',
    );
    expect(view.text(view.disclosure('日期与提醒'))).toContain(
      quietZone === 'Asia/Shanghai' ? 'Asia/Tokyo' : 'Europe/London',
    );
  },
);

test.each(['来源名称', '订阅名称', '包含的清单（不选表示全部）', '包含任务说明'])(
  'settings guard protects draft %s without requiring an address',
  async (label) => {
    const value = model(),
      view = mount('ToDooSettings', value);
    await settleSettings();
    if (label === '包含的清单（不选表示全部）')
      settingField(view, label, 'select').props.onChange(['list-a']);
    else if (label === '包含任务说明') {
      const checkbox = view
        .all()
        .find(
          (row) =>
            row.tag === 'input' &&
            row.props.type === 'checkbox' &&
            view.text(row.parent).includes(label),
        )!;
      checkbox.props.onChange({ target: { checked: true } });
    } else settingField(view, label).props.onInput({ target: { value: '未提交草稿' } });
    await settleSettings();
    expect(value.state.externalDirty.settings).toBe(true);
    expect((view.instance as any).hasUnsavedChanges()).toBe(true);
  },
);

test('editing CSV mapping revokes the preview even when the text is unchanged', async () => {
  const { view } = await settingsImport();
  settingField(view, '格式', 'select').props.onChange({ target: { value: 'csv' } });
  await settleSettings();
  await view.button('预览导入').props.onClick();
  await settleSettings();
  expect(!!view.button('确认导入 1 项')).toBe(true);
  settingField(view, '任务标题列').props.onInput({ target: { value: '自定义标题' } });
  await settleSettings();
  expect(!!view.button('确认导入 1 项')).toBe(false);
});

test('successful calendar and feed submission consume their drafts without retaining phantom edits', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await settleSettings();
  settingField(view, '来源名称').props.onInput({ target: { value: '工作日历' } });
  settingField(view, 'HTTPS 日历地址').props.onInput({
    target: { value: 'https://example.test/readonly.ics' },
  });
  await settleSettings();
  await view
    .all()
    .find((row) => row.tag === 'form' && view.text(row).includes('连接日历'))!
    .props.onSubmit({ preventDefault() {} });
  await settleSettings();
  expect(settingField(view, '来源名称').props.value).toBe('');
  settingField(view, '订阅名称').props.onInput({ target: { value: '订阅草稿' } });
  settingField(view, '包含的清单（不选表示全部）', 'select').props.onChange(['list-a']);
  value.request.mockImplementationOnce(async () => ({ url: '/calendar/feed-token' }));
  vi.stubGlobal('location', { origin: 'http://localhost' });
  await view
    .all()
    .find((row) => row.tag === 'form' && view.text(row).includes('创建订阅链接'))!
    .props.onSubmit({ preventDefault() {} });
  await settleSettings();
  expect(settingField(view, '包含的清单（不选表示全部）', 'select').props.value).toEqual([]);
  expect((view.instance as any).hasUnsavedChanges()).toBe(false);
});

test('application generated import warnings identify row and action in Chinese', async () => {
  const { view, value } = await settingsImport();
  value.request.mockImplementationOnce(async () => ({
    ...importFixture(),
    warnings: [
      'Row 2: unrecognized date retained for review',
      'Row 3: empty title skipped',
      'UID a: nested alarms/components are preserved but not activated',
    ],
  }));
  await view.button('预览导入').props.onClick();
  await settleSettings();
  const preview = view
    .all()
    .find((row) => String(row.props.class).includes('todo-import-preview'))!;
  expect(view.text(preview)).toContain('第 2 行');
  expect(view.text(preview)).toContain('日期无法识别');
  expect(view.text(preview)).toContain('第 3 行');
  expect(view.text(preview)).toContain('跳过');
  expect(view.text(preview)).not.toContain('unrecognized date');
  expect(view.text(preview)).not.toContain('nested alarms');
});

test('import option drafts are protected before a file or body is supplied', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await settleSettings();
  expect((view.instance as any).hasUnsavedChanges()).toBe(false);
  settingField(view, '重复处理', 'select').props.onChange({ target: { value: 'update' } });
  await settleSettings();
  expect(value.state.externalDirty.settings).toBe(true);
  expect((view.instance as any).hasUnsavedChanges()).toBe(true);
});

test('selecting an oversized replacement file revokes the earlier confirmation', async () => {
  const { view } = await settingsImport();
  await view
    .all()
    .find((row) => row.tag === 'input' && row.props.type === 'file')!
    .props.onChange({
      target: { files: [{ name: 'too-large.csv', size: 65 * 1024 * 1024 }] },
    });
  await settleSettings();
  expect(!!view.button('确认导入 1 项')).toBe(false);
});

test('a slow file decode cannot overwrite the file selected after it', async () => {
  const { view, value } = await settingsImport();
  const chooser = view.all().find((row) => row.tag === 'input' && row.props.type === 'file')!;
  let finish!: (bytes: ArrayBuffer) => void;
  const earlier = chooser.props.onChange({
    target: {
      files: [
        {
          name: 'earlier.csv',
          size: 12,
          lastModified: 1,
          arrayBuffer: () => new Promise<ArrayBuffer>((resolve) => (finish = resolve)),
        },
      ],
    },
  });
  await chooser.props.onChange({
    target: {
      files: [
        {
          name: 'later.csv',
          size: 12,
          lastModified: 2,
          arrayBuffer: async () => new TextEncoder().encode('later content').buffer,
        },
      ],
    },
  });
  finish(new TextEncoder().encode('earlier content').buffer);
  await earlier;
  await settleSettings();
  await view.button('预览导入').props.onClick();
  const previews = value.request.mock.calls.filter(([url]) => url === '/api/to-doo/import/preview');
  expect((previews.at(-1) as any)[2]).toMatchObject({
    content: 'later content',
    name: 'later.csv',
  });
});

test('an accepted import does not discard edits entered while its response was pending', async () => {
  const { view, value } = await settingsImport();
  let finish!: (result: any) => void;
  value.request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const applying = view.button('确认导入 1 项').props.onClick();
  await Vue.nextTick();
  view
    .all()
    .find((row) => row.tag === 'textarea')!
    .props.onInput({ target: { value: '下次导入正文' } });
  finish({ transactionId: 'accepted' });
  await applying;
  await settleSettings();
  expect(view.all().find((row) => row.tag === 'textarea')!.props.value).toBe('下次导入正文');
  expect((view.instance as any).hasUnsavedChanges()).toBe(true);
});

test('calendar connection completion consumes only the submitted draft', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await settleSettings();
  settingField(view, '来源名称').props.onInput({ target: { value: '已提交名称' } });
  settingField(view, 'HTTPS 日历地址').props.onInput({
    target: { value: 'https://example.test/a.ics' },
  });
  let finish!: (result: any) => void;
  value.request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const pending = view
    .all()
    .find((row) => row.tag === 'form' && view.text(row).includes('连接日历'))!
    .props.onSubmit({ preventDefault() {} });
  await Vue.nextTick();
  settingField(view, '来源名称').props.onInput({ target: { value: '后续草稿名称' } });
  finish({});
  await pending;
  await settleSettings();
  expect(settingField(view, '来源名称').props.value).toBe('后续草稿名称');
  expect(value.state.externalDirty.settings).toBe(true);
});

test('subscription completion preserves fields edited while its request was pending', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await settleSettings();
  settingField(view, '订阅名称').props.onInput({ target: { value: '已提交订阅' } });
  let finish!: (result: any) => void;
  value.request.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  vi.stubGlobal('location', { origin: 'http://localhost' });
  const pending = view
    .all()
    .find((row) => row.tag === 'form' && view.text(row).includes('创建订阅链接'))!
    .props.onSubmit({ preventDefault() {} });
  await Vue.nextTick();
  settingField(view, '订阅名称').props.onInput({ target: { value: '后续订阅草稿' } });
  settingField(view, '包含的清单（不选表示全部）', 'select').props.onChange(['new-list']);
  finish({ url: '/calendar/feed-token' });
  await pending;
  await settleSettings();
  expect(settingField(view, '订阅名称').props.value).toBe('后续订阅草稿');
  expect(settingField(view, '包含的清单（不选表示全部）', 'select').props.value).toEqual([
    'new-list',
  ]);
  expect(value.state.externalDirty.settings).toBe(true);
});

test('task and occurrence import rows resolve their shared title, list and schedule', async () => {
  const { view, value } = await settingsImport();
  value.request.mockImplementationOnce(async () => ({
    ...importFixture(),
    items: [
      { kind: 'list', entity: { id: 'new-list', name: '来源清单' } },
      { kind: 'task', entity: { id: 'new-task', title: '从来源导入', listId: 'new-list' } },
      {
        kind: 'occurrence',
        entity: {
          id: 'new-occurrence',
          taskId: 'new-task',
          due: { date: '2026-11-07', time: '15:00', timeZone: 'Asia/Tokyo' },
        },
      },
    ],
  }));
  await view.button('预览导入').props.onClick();
  await settleSettings();
  const rows = view
    .all()
    .filter((row) => row.tag === 'li' && view.text(row).includes('从来源导入'));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(view.text(row)).toContain('来源清单');
    expect(view.text(row)).toContain('2026-11-07');
    expect(view.text(row)).toContain('Asia/Tokyo');
  }
});

test('clearing CSV mappings and restoring options removes the import draft guard', async () => {
  const value = model(),
    view = mount('ToDooSettings', value);
  await settleSettings();
  expect((view.instance as any).hasUnsavedChanges()).toBe(false);
  settingField(view, '格式', 'select').props.onChange({ target: { value: 'csv' } });
  await settleSettings();
  settingField(view, '任务标题列').props.onInput({ target: { value: '来源标题' } });
  await settleSettings();
  expect(value.state.externalDirty.settings).toBe(true);
  settingField(view, '任务标题列').props.onInput({ target: { value: '' } });
  settingField(view, '格式', 'select').props.onChange({ target: { value: 'json' } });
  await settleSettings();
  expect(value.state.externalDirty.settings).toBe(false);
  expect((view.instance as any).hasUnsavedChanges()).toBe(false);
});

test('inbox occurrence preview rows show the same destination as their related task', async () => {
  const { view, value } = await settingsImport();
  value.request.mockImplementationOnce(async () => ({
    ...importFixture(),
    items: [
      { kind: 'task', entity: { id: 'inbox-task', title: '收集箱导入任务', listId: null } },
      { kind: 'occurrence', entity: { id: 'inbox-occurrence', taskId: 'inbox-task', due: null } },
    ],
  }));
  await view.button('预览导入').props.onClick();
  await settleSettings();
  const rows = view
    .all()
    .filter((row) => row.tag === 'li' && view.text(row).includes('收集箱导入任务'));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    const summary = row.children.find((child) => child.tag === 'p')!;
    expect(view.text(summary)).toContain('收集箱');
  }
});
