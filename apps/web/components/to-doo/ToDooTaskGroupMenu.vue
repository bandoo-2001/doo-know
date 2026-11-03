<script setup lang="ts">
import { Button as AButton, Dropdown as ADropdown, Menu as AMenu, MenuItem as AMenuItem } from 'ant-design-vue';
import type { ToDooEntityKind, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import { moveTaskSection } from '../../to-doo-task-groups';
import { useToDooConfirm } from '../../to-doo-controls';
import { useToDooMenu } from '../../to-doo-menu';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{ model: ToDooWorkbench; section: ToDooEntityMap['section'] }>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
}>();
const confirm = useToDooConfirm();
const { open: menuOpen, trigger } = useToDooMenu();
async function move(delta: number) {
  if (props.model.state.busy || props.model.state.pendingMutation) return;
  try {
    await moveTaskSection(props.model, props.section, delta);
  } catch (cause) {
    props.model.state.error = cause instanceof Error ? cause.message : String(cause);
  }
}
async function remove() {
  const target = props.section;
  if (
    !(await confirm(`删除分组「${target.name}」？组内任务会保留，并显示在未分组中。`, {
      danger: true,
    }))
  )
    return;
  await props.model.removeEntity('section', target);
}
</script>
<template>
  <ADropdown
    v-model:open="menuOpen"
    :trigger="['click']"
    placement="bottomRight"
    overlay-class-name="todo-task-menu-popup todo-ant-popup"
  >
    <AButton
      ref="trigger"
      type="text"
      class="todo-icon-button"
      :aria-label="'分组操作 ' + section.name"
      :disabled="model.state.busy || !!model.state.pendingMutation"
      ><ToDooIcon name="more" :size="16"
    /></AButton>
    <template #overlay
      ><AMenu :selectable="false" @click="menuOpen = false">
        <AMenuItem @click="emit('edit', 'section', section)">重命名</AMenuItem>
        <AMenuItem
          @click="
            emit('edit', 'section', undefined, {
              listId: section.listId,
              sectionPlacement: { beforeId: section.id },
            })
          "
          >在上方添加分组</AMenuItem
        >
        <AMenuItem
          @click="
            emit('edit', 'section', undefined, {
              listId: section.listId,
              sectionPlacement: { afterId: section.id },
            })
          "
          >在下方添加分组</AMenuItem
        >
        <AMenuItem @click="move(-1)">上移分组</AMenuItem>
        <AMenuItem @click="move(1)">下移分组</AMenuItem>
        <AMenuItem danger @click="remove">删除分组</AMenuItem>
      </AMenu></template
    >
  </ADropdown>
</template>
