<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { Button as AButton, Input as AInput } from 'ant-design-vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';

const props = defineProps<{ model: ToDooWorkbench; disabled?: boolean }>();
const emit = defineEmits<{ created: [id: string]; 'open-change': [open: boolean] }>();
const open = ref(false),
  name = ref(''),
  listId = ref(''),
  error = ref('');
const root = ref<HTMLElement>();
let alive = true;
onBeforeUnmount(() => {
  alive = false;
});
const state = props.model.state;
const ownPending = computed(() => {
  const pending = state.pendingMutation;
  return (
    pending?.action === 'save_entity' &&
    pending.payload.kind === 'list' &&
    pending.payload.entity.id === listId.value
  );
});
const blocked = computed(
  () => props.disabled || state.busy || (!!state.pendingMutation && !ownPending.value),
);
async function start() {
  if (blocked.value) return;
  open.value = true;
  emit('open-change', true);
  listId.value = crypto.randomUUID();
  error.value = '';
  await nextTick();
  root.value?.querySelector<HTMLInputElement>('input')?.focus();
}
function cancel() {
  if (blocked.value || ownPending.value) return;
  open.value = false;
  emit('open-change', false);
  name.value = '';
  error.value = '';
}
async function create() {
  if (blocked.value || !name.value.trim()) return;
  const result = await props.model.saveEntity(
    'list',
    { id: listId.value, name: name.value.trim(), kind: 'list' },
    undefined,
    '清单已创建',
  );
  if (!alive) return;
  if (!result) {
    error.value = state.error || '暂时无法创建清单，请重试。';
    return;
  }
  emit('created', listId.value);
  open.value = false;
  emit('open-change', false);
  name.value = '';
  error.value = '';
}
function enter(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  void create();
}
function escape(event: KeyboardEvent) {
  if (event.isComposing) return;
  event.preventDefault();
  event.stopPropagation();
  cancel();
}
</script>

<template>
  <div ref="root" class="todo-inline-list-create">
    <AButton
      v-if="!open"
      html-type="button"
      type="text"
      class="todo-inline-list-trigger"
      :disabled="blocked"
      aria-label="在任务中创建清单"
      @click="start"
      >＋ 新建清单</AButton
    >
    <div v-else class="todo-inline-list-editor" role="group" aria-label="新建清单">
      <label>
        清单名称
        <AInput
          v-model:value="name"
          aria-label="新清单名称"
          placeholder="例如：工作、阅读计划"
          :maxlength="256"
          :disabled="blocked || ownPending"
          @keydown.enter="enter"
          @keydown.esc="escape"
        />
      </label>
      <p v-if="error" class="todo-inline-list-error" role="alert">{{ error }}</p>
      <div class="todo-inline-list-actions">
        <AButton html-type="button" :disabled="blocked || ownPending" @click="cancel">取消</AButton>
        <AButton
          html-type="button"
          type="primary"
          :disabled="blocked || !name.trim()"
          :loading="state.busy"
          @click="create"
          >{{ ownPending ? '重试创建清单' : '创建清单' }}</AButton
        >
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-inline-list-create {
  min-width: 0;
}
.todo-inline-list-trigger {
  color: var(--todo-accent);
  padding: 0;
  font-size: 12px;
}
.todo-inline-list-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--todo-line);
  border-radius: 8px;
  background: var(--todo-soft);
}
.todo-inline-list-editor label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--todo-muted);
  font-size: 12px;
}
.todo-inline-list-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.todo-inline-list-error {
  margin: 0;
  color: var(--todo-danger);
  font-size: 12px;
}
</style>
