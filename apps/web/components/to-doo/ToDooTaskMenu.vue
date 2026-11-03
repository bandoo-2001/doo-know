<script setup lang="ts">
import { computed, useSlots } from 'vue';
import { Button as AButton, Dropdown as ADropdown, Menu as AMenu, MenuItem as AMenuItem, SubMenu as ASubMenu } from 'ant-design-vue';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import { toDooPriorityLabels, toDooStatusLabels, type ToDooItem, type ToDooWorkbench } from '../../to-doo-workbench';
import { useToDooConfirm } from '../../to-doo-controls';
import { useToDooMenu } from '../../to-doo-menu';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{
  model: ToDooWorkbench;
  item: ToDooItem;
  contextMenu?: boolean;
  label?: string;
  parentDelete?: boolean;
  removeTask?: () => Promise<unknown>;
}>();
const emit = defineEmits<{
  open: [item: ToDooItem];
  child: [id: string];
  remove: [];
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
}>();
const slots = useSlots();
const confirm = useToDooConfirm();
const { open: menuOpen, trigger } = useToDooMenu();
const blocked = computed(
  () =>
    props.model.state.busy ||
    !!props.model.state.pendingMutation ||
    (props.model.state.selectedTaskId === props.item.task.id && props.model.dirty()),
);
const lists = computed(() => props.model.taskLists().filter((list) => !list.archivedAt));
async function run(operation: 'copy' | 'move' | 'archive' | 'delete', listId?: string | null) {
  if (blocked.value) return;
  const target = props.item;
  if (operation === 'delete') {
    if (props.parentDelete) {
      return props.removeTask?.();
    }
    if (!(await confirm(`将「${target.title}」及其子任务移入回收站？`, { danger: true }))) return;
  }
  await props.model.batchTasks(
    [target.task.id],
    operation === 'archive' ? 'patch' : operation,
    operation === 'move'
      ? { listId: listId ?? null }
      : operation === 'archive'
        ? { patch: { archivedAt: new Date().toISOString() } }
        : {},
  );
}
async function priority(value: string) {
  if (blocked.value) return;
  await props.model.execute(
    {
      action: 'update_task',
      payload: {
        id: props.item.task.id,
        expectedRevision: props.item.task.revision,
        patch: { priority: value as typeof props.item.task.priority },
      },
    },
    '优先级已更新',
  );
}
</script>

<template>
  <ADropdown
    v-model:open="menuOpen"
    :trigger="contextMenu ? ['contextmenu'] : ['click']"
    placement="bottomRight"
    overlay-class-name="todo-task-menu-popup todo-ant-popup"
    @open-change="$event && model.ensureListCatalog()"
  >
    <slot v-if="slots.default" />
    <AButton
      v-else
      ref="trigger"
      type="text"
      class="todo-icon-button todo-task-menu-trigger"
      :aria-label="label || '任务操作 ' + item.title"
      :disabled="model.state.busy"
      @click.stop
      ><ToDooIcon name="more" :size="16"
    /></AButton>
    <template #overlay
      ><AMenu :selectable="false" trigger-sub-menu-action="click" @click="menuOpen = false">
        <AMenuItem v-if="blocked && !model.state.busy" disabled
          >先保存更改或核对待处理操作</AMenuItem
        >
        <AMenuItem @click="emit('open', item)">打开任务详情</AMenuItem>
        <AMenuItem @click="emit('child', item.task.id)">添加子任务</AMenuItem>
        <AMenuItem
          :disabled="blocked || !item.occurrence"
          @click="
            emit('edit', 'timeBlock', undefined, {
              occurrenceId: item.occurrence?.id,
              title: item.title,
            })
          "
          >安排时间</AMenuItem
        >
        <ASubMenu
          key="priority"
          title="优先级"
          popup-class-name="todo-task-menu-popup todo-ant-popup"
          :disabled="blocked"
        >
          <AMenuItem
            v-for="(name, value) in toDooPriorityLabels"
            :key="value"
            @click="priority(value)"
            >{{ name }}{{ value === 'none' ? '' : '优先级'
            }}<span v-if="item.task.priority === value" class="todo-menu-current"
              >✓</span
            ></AMenuItem
          >
        </ASubMenu>
        <ASubMenu
          key="status"
          title="状态"
          popup-class-name="todo-task-menu-popup todo-ant-popup"
          :disabled="blocked || !item.occurrence"
        >
          <AMenuItem
            v-for="(name, value) in toDooStatusLabels"
            :key="value"
            @click="item.occurrence && model.setStatus(item.occurrence.id, value)"
            >{{ name
            }}<span v-if="item.status === value" class="todo-menu-current">✓</span></AMenuItem
          >
        </ASubMenu>
        <ASubMenu
          key="move"
          title="移动到"
          popup-class-name="todo-task-menu-popup todo-ant-popup"
          :disabled="blocked"
        >
          <AMenuItem :disabled="!item.task.listId" @click="run('move', null)">收集箱</AMenuItem>
          <AMenuItem
            v-for="list in lists"
            :key="list.id"
            :disabled="list.id === item.task.listId"
            @click="run('move', list.id)"
            >{{ list.name }}</AMenuItem
          >
        </ASubMenu>
        <AMenuItem :disabled="blocked" @click="run('copy')">创建副本</AMenuItem>
        <AMenuItem :disabled="blocked" @click="run('archive')">归档任务</AMenuItem>
        <AMenuItem :disabled="blocked" danger @click="run('delete')">{{
          parentDelete ? '删除' : '删除任务'
        }}</AMenuItem>
      </AMenu></template
    >
  </ADropdown>
</template>
