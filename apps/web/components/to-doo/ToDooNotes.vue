<script setup lang="ts">
import { Button as AButton, Input as AInput } from 'ant-design-vue';
import { computed, ref } from 'vue';
import type { TreeEntry } from '../../../../shared/contracts';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
type Ref = ToDooEntityMap['task']['noteRefs'][number];
const props = defineProps<{
  modelValue: Ref[];
  tree: TreeEntry[];
  role?: Ref['role'];
  label?: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: Ref[]]; 'open-note': [id: string] }>();
const query = ref(''),
  choosing = ref(false);
const notes = computed(() => {
  const walk = (items: TreeEntry[]): TreeEntry[] =>
    items.flatMap((n) => (n.type === 'folder' ? walk(n.children || []) : n.id ? [n] : []));
  return walk(props.tree);
});
const available = computed(() =>
  notes.value
    .filter(
      (n) =>
        n.path.toLowerCase().includes(query.value.toLowerCase()) &&
        !props.modelValue.some((r) => r.noteId === n.id),
    )
    .slice(0, 50),
);
function add(note: TreeEntry) {
  emit('update:modelValue', [
    ...props.modelValue,
    { noteId: note.id!, role: props.role || 'material', title: note.name },
  ]);
  choosing.value = false;
  query.value = '';
}
</script>
<template>
  <div class="todo-notes">
    <div class="todo-between">
      <h3>{{ label || '关联资料' }}</h3>
      <AButton html-type="button" class="todo-link" @click="choosing = !choosing" type="link">
        {{ choosing ? '收起' : '+ 关联资料' }}
      </AButton>
    </div>
    <div v-for="(link, i) in modelValue" :key="link.noteId" class="todo-note-row">
      <span class="todo-note-icon">▤</span
      ><AButton
        html-type="button"
        class="todo-note-name"
        type="text"
        :disabled="!notes.some((n) => n.id === link.noteId)"
        @click="emit('open-note', link.noteId)"
      >
        {{ notes.find((n) => n.id === link.noteId)?.name || link.title || '资料不可用'
        }}<small v-if="!notes.some((n) => n.id === link.noteId)">资料已移除或当前不可访问</small
        ><small v-else
          >{{
            link.role === 'source'
              ? '来源'
              : link.role === 'output'
                ? '成果证据'
                : link.role === 'review'
                  ? '复盘资料'
                  : '关联资料'
          }}
          ↗</small
        ></AButton
      ><AButton
        html-type="button"
        class="todo-icon-button"
        type="text"
        :aria-label="'解除关联 ' + (link.title || '资料')"
        @click="
          emit(
            'update:modelValue',
            modelValue.filter((_, j) => j !== i),
          )
        "
      >
        ×
      </AButton>
    </div>
    <p v-if="!modelValue.length && !choosing" class="todo-muted todo-small">还没有关联资料</p>
    <div v-if="choosing" class="todo-note-picker">
      <label>搜索资料<AInput v-model:value="query" placeholder="按资料名称或路径搜索" /></label
      ><AButton v-for="n in available" :key="n.id" html-type="button" @click="add(n)">
        {{ n.name }}<small>{{ n.path }}</small>
      </AButton>
      <p v-if="!available.length" class="todo-muted">没有可关联的资料</p>
    </div>
  </div>
</template>
