<script setup lang="ts">
import {
  computed,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  onUpdated,
  ref,
  useAttrs,
  useId,
  type PropType,
  type Component,
  type VNode,
} from 'vue';
import { Button as AButton, Input as AInput, TreeSelect as ATreeSelect } from 'ant-design-vue';
import { PlusOutlined } from '@ant-design/icons-vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import { TO_DOO_LIST_MAX_DEPTH } from '../../../../shared/to-doo-contracts';
import {
  matchesToDooListSearch,
  toDooListSelectTree,
  toDooListSubtreeDepth,
  type ToDooListSelectNode,
  type ToDooSelectableList,
} from '../../to-doo-list-select-tree';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';
import { createToDooPopupEscapeBoundary } from '../../to-doo-controls';
import '../../to-doo-list-select.css';

// TreeSelect exposes dropdownRender as a prop; adapt it to a normal Vue slot.
const ListTreeSelect = defineComponent({
  inheritAttrs: false,
  setup:
    (_, { attrs, slots }) =>
    () =>
      h(
        ATreeSelect as unknown as Component,
        {
          ...attrs,
          dropdownRender: (value: { menuNode: VNode }) => slots.dropdownRender?.(value),
        },
        slots,
      ),
});

defineOptions({ inheritAttrs: false });
const props = withDefaults(
  defineProps<{
    model?: ToDooWorkbench;
    lists?: readonly ToDooSelectableList[];
    modelValue?: string | null;
    value?: string | null;
    disabled?: boolean;
    includeInbox?: boolean;
    excludeId?: string;
    parentMode?: boolean;
    placeholder?: string;
    allowCreate?: boolean;
    nullLabel?: string;
  }>(),
  { disabled: undefined, includeInbox: true, parentMode: false, allowCreate: true },
);
const emit = defineEmits<{
  'update:modelValue': [value: string | null];
  'update:value': [value: string | null];
  change: [value: string | null];
  created: [id: string];
  'creation-open-change': [open: boolean];
}>();
const attrs = useAttrs();
const popupEscape = createToDooPopupEscapeBoundary();
const generatedId = 'todo-list-tree-' + useId();
const emptyValue = '$dooknow-unassigned';
const state = computed(() => props.model?.state);
const open = ref(false),
  loading = ref(false),
  search = ref('');
const creating = ref(false),
  creatingId = ref(''),
  creatingParentId = ref<string | null>(null);
const name = ref(''),
  error = ref(''),
  submitting = ref(false);
const creationPanel = ref<HTMLElement>();
const creatingParentName = ref('');
let alive = true;
let submittedEntity: Record<string, unknown> | undefined;
onBeforeUnmount(() => {
  alive = false;
  if (creating.value) emit('creation-open-change', false);
});
const lists = computed(() => props.lists ?? props.model?.taskLists() ?? []);
const selected = computed(() =>
  props.modelValue !== undefined ? props.modelValue : (props.value ?? null),
);
const tree = computed(() =>
  toDooListSelectTree(lists.value, { parentMode: props.parentMode, excludeId: props.excludeId }),
);
const parentDepth = computed(() =>
  props.parentMode ? toDooListSubtreeDepth(lists.value, props.excludeId) : 0,
);
const ownPending = computed(() => {
  const pending = state.value?.pendingMutation;
  return (
    pending?.action === 'save_entity' &&
    pending.payload.kind === 'list' &&
    pending.payload.entity.id === creatingId.value
  );
});
const blocked = computed(
  () =>
    props.disabled ||
    state.value?.busy ||
    submitting.value ||
    (!!state.value?.pendingMutation && !ownPending.value),
);
const controlDisabled = computed(
  () =>
    props.disabled || (!creating.value && (state.value?.busy || !!state.value?.pendingMutation)),
);
const canCreate = computed(() => props.allowCreate && !!props.model);
const creatingParent = computed(() =>
  lists.value.find((list) => list.id === creatingParentId.value),
);
const emptyLabel = computed(
  () => props.nullLabel ?? (props.parentMode ? '无上级（顶层清单）' : '收集箱'),
);
const data = computed(() => {
  const result: any[] = [...tree.value];
  if (props.includeInbox || props.parentMode)
    result.unshift({
      key: emptyValue,
      value: emptyValue,
      title: emptyLabel.value,
      label: emptyLabel.value,
      searchText: emptyLabel.value,
    });
  const contains = (nodes: any[]): boolean =>
    nodes.some((node) => node.value === selected.value || contains(node.children || []));
  if (selected.value && !contains(result)) {
    const list = lists.value.find((list) => list.id === selected.value);
    result.push({
      key: selected.value,
      value: selected.value,
      title: list?.name || '当前清单（尚未载入）',
      label: list?.name || '当前清单（尚未载入）',
      searchText: list?.name || '',
      list,
      disabled: true,
    });
  }
  return result;
});
const value = computed(
  () => selected.value ?? (props.includeInbox || props.parentMode ? emptyValue : undefined),
);
const VNodeContent = defineComponent({
  props: { node: Object as PropType<VNode> },
  setup: (value) => () => value.node,
});
function nodeData(node: any): ToDooListSelectNode {
  return node.dataRef || node;
}
function inputId() {
  return String(attrs.id || generatedId);
}
function syncAccessibility() {
  const input = document.getElementById(inputId());
  if (!input) return;
  input.setAttribute(
    'aria-label',
    String(attrs['aria-label'] || (props.parentMode ? '上级清单' : '清单')),
  );
  for (const key of ['aria-describedby', 'aria-labelledby', 'aria-required'])
    if (attrs[key] !== undefined) input.setAttribute(key, String(attrs[key]));
}
onMounted(syncAccessibility);
onUpdated(syncAccessibility);
async function loadCatalog() {
  if (!props.model) return;
  loading.value = true;
  try {
    await props.model.ensureListCatalog();
  } finally {
    if (alive) loading.value = false;
  }
}
onMounted(() => {
  void loadCatalog();
});
function setOpen(next: boolean) {
  if (creating.value && !next) return;
  open.value = next;
  if (next) void loadCatalog();
  else search.value = '';
}
function change(next: unknown) {
  if (controlDisabled.value || creating.value) return;
  const actual = next === emptyValue || next === undefined ? null : String(next);
  emit('update:modelValue', actual);
  emit('update:value', actual);
  emit('change', actual);
  open.value = false;
  search.value = '';
}
function selectionLabel(option: any) {
  const list = lists.value.find((list) => list.id === option?.value);
  return h('span', { class: 'todo-list-tree-selection' }, [
    list
      ? h(ToDooListIcon, { list, size: 17 })
      : h(ToDooIcon, { name: props.parentMode ? 'folder' : 'inbox', size: 17 }),
    h('span', list?.name || option?.label || emptyLabel.value),
  ]);
}
async function startCreate(parent: ToDooListSelectNode | null) {
  if (!canCreate.value || blocked.value || ownPending.value || creating.value) return;
  if (
    (parent && !parent.canCreateChild) ||
    (!parent && parentDepth.value + 1 > TO_DOO_LIST_MAX_DEPTH)
  )
    return;
  creating.value = true;
  open.value = true;
  creatingId.value = crypto.randomUUID();
  creatingParentId.value = parent?.list.id || null;
  creatingParentName.value = parent?.list.name || '';
  name.value = '';
  error.value = '';
  submittedEntity = undefined;
  emit('creation-open-change', true);
  await nextTick();
  creationPanel.value?.querySelector<HTMLInputElement>('input')?.focus();
}
function cancelCreate() {
  if (submitting.value || ownPending.value) return;
  creating.value = false;
  open.value = false;
  search.value = '';
  submittedEntity = undefined;
  error.value = '';
  name.value = '';
  emit('creation-open-change', false);
  nextTick(() => document.getElementById(inputId())?.focus());
}
async function create() {
  const model = props.model;
  if (!canCreate.value || !model || blocked.value || !name.value.trim()) return;
  const datasetId = model.state.snapshot?.datasetId;
  const entity =
    ownPending.value && submittedEntity
      ? submittedEntity
      : {
          id: creatingId.value,
          name: name.value.trim(),
          kind: 'list',
          parentId: creatingParentId.value,
          color: creatingParent.value?.color || '#647be8',
          icon: null,
        };
  submittedEntity = entity;
  submitting.value = true;
  error.value = '';
  try {
    const result = await model.saveEntity('list', entity, undefined, '清单已创建');
    if (!alive || props.model !== model || model.state.snapshot?.datasetId !== datasetId) return;
    if (!result) {
      error.value = model.state.error || '暂时无法创建清单，请重试。';
      return;
    }
    const id = creatingId.value;
    creating.value = false;
    open.value = false;
    search.value = '';
    name.value = '';
    submittedEntity = undefined;
    emit('creation-open-change', false);
    emit('update:modelValue', id);
    emit('update:value', id);
    emit('change', id);
    emit('created', id);
    void loadCatalog();
    nextTick(() => document.getElementById(inputId())?.focus());
  } catch (cause) {
    if (alive) error.value = cause instanceof Error ? cause.message : '暂时无法创建清单，请重试。';
  } finally {
    if (alive) submitting.value = false;
  }
}
function creationKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    void create();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelCreate();
  }
}
function filterTreeNode(query: string, node: any) {
  return matchesToDooListSearch(query, String(node.searchText || node.label || ''));
}
</script>

<template>
  <ListTreeSelect
    v-bind="attrs"
    :id="inputId()"
    class="todo-ant-select todo-list-tree-select"
    :value="value"
    :tree-data="data"
    :disabled="controlDisabled"
    :loading="loading"
    :open="open"
    :search-value="search"
    :placeholder="placeholder || (parentMode ? '选择上级清单' : '选择清单')"
    :filter-tree-node="filterTreeNode"
    :option-label-render="selectionLabel"
    tree-node-label-prop="label"
    tree-node-filter-prop="searchText"
    popup-class-name="todo-ant-popup todo-list-tree-popup"
    show-search
    tree-default-expand-all
    :virtual="false"
    :list-height="260"
    @dropdown-visible-change="setOpen"
    @search="search = $event"
    @change="change"
    @click.prevent
    @keydown.capture="popupEscape.capture"
    @keydown="popupEscape.bubble"
  >
    <template #title="node">
      <span
        class="todo-list-tree-node"
        :class="{ 'todo-list-tree-selected-label': !node.dataRef }"
        :data-list-id="nodeData(node).list?.id"
      >
        <ToDooListIcon v-if="nodeData(node).list" :list="nodeData(node).list" :size="18" />
        <ToDooIcon v-else :name="parentMode ? 'folder' : 'inbox'" :size="18" />
        <span class="todo-list-tree-node-name" :title="nodeData(node).searchText">{{
          nodeData(node).label
        }}</span>
        <AButton
          v-if="canCreate && node.dataRef && nodeData(node).list"
          type="text"
          size="small"
          html-type="button"
          class="todo-list-tree-add"
          :disabled="blocked || !nodeData(node).canCreateChild || creating"
          :aria-label="'在 ' + nodeData(node).list.name + ' 下创建子清单'"
          title="创建子清单"
          @mousedown.stop.prevent
          @pointerdown.stop
          @click.stop.prevent="startCreate(nodeData(node))"
          @keydown.enter.stop
          @keydown.space.stop
        >
          <template #icon><PlusOutlined aria-hidden="true" /></template>
        </AButton>
      </span>
    </template>
    <template #dropdownRender="{ menuNode }">
      <div class="todo-list-tree-dropdown">
        <div class="todo-list-tree-menu"><VNodeContent :node="menuNode" /></div>
        <section
          v-if="canCreate && creating"
          ref="creationPanel"
          class="todo-list-tree-create"
          role="group"
          aria-label="新建清单"
          @mousedown.stop
          @keydown="creationKeydown"
        >
          <label
            >清单名称
            <AInput
              v-model:value="name"
              aria-label="新清单名称"
              :maxlength="256"
              :disabled="blocked || ownPending"
              placeholder="给清单起个名字"
            />
          </label>
          <span class="todo-list-tree-create-context">{{
            creatingParentId ? '创建在「' + creatingParentName + '」下' : '创建为顶层清单'
          }}</span>
          <p v-if="error" class="todo-list-tree-error" role="alert">{{ error }}</p>
          <div class="todo-list-tree-create-actions">
            <AButton
              html-type="button"
              :disabled="submitting || ownPending"
              @click.stop="cancelCreate"
              >取消</AButton
            >
            <AButton
              html-type="button"
              type="primary"
              :loading="submitting"
              :disabled="blocked || !name.trim()"
              @click.stop="create"
            >
              {{ ownPending ? '重试创建清单' : '创建清单' }}
            </AButton>
          </div>
        </section>
        <div v-else-if="canCreate" class="todo-list-tree-footer">
          <AButton
            html-type="button"
            type="text"
            block
            aria-label="创建清单"
            :disabled="blocked || parentDepth + 1 > TO_DOO_LIST_MAX_DEPTH"
            @mousedown.prevent
            @click.stop="startCreate(null)"
          >
            <template #icon><PlusOutlined aria-hidden="true" /></template>创建清单
          </AButton>
        </div>
      </div>
    </template>
  </ListTreeSelect>
</template>
