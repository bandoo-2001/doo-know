<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton, Input as AInput } from 'ant-design-vue';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import {
  toDooLocalDate,
  toDooPriorityLabels,
  toDooStatusLabels,
  type ToDooWorkbench,
} from '../../to-doo-workbench';
defineOptions({ name: 'ToDooFilterGroup' });
import type {
  ToDooFilterCondition as Leaf,
  ToDooFilterGroup as Group,
} from '../../../../shared/to-doo-contracts';
type Field = Leaf['field'];
type Operator = Leaf['operator'];
const props = withDefaults(
  defineProps<{ modelValue: Group; model: ToDooWorkbench; depth?: number; total?: number }>(),
  { depth: 1, total: 0 },
);
const emit = defineEmits<{ 'update:modelValue': [group: Group]; remove: [] }>();
const fields: Record<Field, string> = {
  query: '任务内容',
  listId: '目标或清单',
  tagId: '标签',
  status: '任务状态',
  priority: '优先级',
  importance: '重要程度',
  dueDate: '截止日期',
  plannedDate: '计划日期',
  createdDate: '创建日期',
  completedDate: '完成日期',
  hasEvidence: '有成果证据',
  isLeaf: '是叶子任务',
  isUnscheduled: '未安排时间',
};
const labels: Record<Operator, string> = {
  contains: '包含',
  not_contains: '不包含',
  is: '是',
  is_not: '不是',
  in: '是其中之一',
  not_in: '不在这些选项中',
  before: '早于',
  on: '在这一天',
  after: '晚于',
  between: '在日期之间',
  is_empty: '未设置',
  not_empty: '已设置',
};
const dateFields = ['dueDate', 'plannedDate', 'createdDate', 'completedDate'],
  boolFields = ['hasEvidence', 'isLeaf', 'isUnscheduled'];
const count = (group: Group): number =>
  group.conditions.reduce((n, c) => n + ('conditions' in c ? count(c) : 1), 0);
const leafCount = computed(() => props.total || count(props.modelValue));
function operators(field: Field): Operator[] {
  return field === 'query'
    ? ['contains', 'not_contains']
    : dateFields.includes(field)
      ? ['before', 'on', 'after', 'between', 'is_empty', 'not_empty']
      : boolFields.includes(field)
        ? ['is']
        : ['is', 'is_not', 'in', 'not_in'];
}
function options(field: Field): [string, string][] {
  return field === 'listId'
    ? props.model.state.snapshot?.lists
        .filter((l) => !l.deletedAt)
        .map((l) => [l.id, l.name] as [string, string]) || []
    : field === 'tagId'
      ? props.model.state.snapshot?.tags
          .filter((t) => !t.deletedAt)
          .map((t) => [t.id, t.name] as [string, string]) || []
      : field === 'status'
        ? Object.entries(toDooStatusLabels)
        : field === 'priority'
          ? Object.entries(toDooPriorityLabels)
          : field === 'importance'
            ? [
                ['normal', '普通'],
                ['important', '重要'],
              ]
            : [];
}
function replace(i: number, value: Leaf | Group) {
  emit('update:modelValue', {
    ...props.modelValue,
    conditions: props.modelValue.conditions.map((c, j) => (j === i ? value : c)),
  });
}
function remove(i: number) {
  emit('update:modelValue', {
    ...props.modelValue,
    conditions: props.modelValue.conditions.filter((_, j) => j !== i),
  });
}
function field(i: number, value: Field) {
  replace(i, {
    field: value,
    operator: operators(value)[0]!,
    value: dateFields.includes(value)
      ? toDooLocalDate()
      : boolFields.includes(value)
        ? true
        : options(value)[0]?.[0] || '',
  });
}
function operator(i: number, leaf: Leaf, value: Operator) {
  const { value: old, ...rest } = leaf;
  replace(i, {
    ...rest,
    operator: value,
    ...(['is_empty', 'not_empty'].includes(value)
      ? {}
      : {
          value:
            value === 'between'
              ? [toDooLocalDate(), toDooLocalDate()]
              : value === 'in' || value === 'not_in'
                ? Array.isArray(old)
                  ? old
                  : old
                    ? [String(old)]
                    : []
                : Array.isArray(old)
                  ? old[0] || ''
                  : (old ?? ''),
        }),
  });
}
function add(group = false) {
  if (leafCount.value >= 30) return;
  emit('update:modelValue', {
    ...props.modelValue,
    conditions: [
      ...props.modelValue.conditions,
      group
        ? { operator: 'and', conditions: [{ field: 'query', operator: 'contains', value: '' }] }
        : { field: 'query', operator: 'contains', value: '' },
    ],
  });
}
</script>
<template>
  <section class="todo-filter-group" :aria-label="'第 ' + depth + ' 层筛选条件组'">
    <div class="todo-between">
      <label class="todo-inline-label"
        >满足<ToDooSelect
          :value="modelValue.operator"
          aria-label="条件组匹配方式"
          @change="emit('update:modelValue', { ...modelValue, operator: $event as 'and' | 'or' })"
        >
          <option value="and">以下所有条件</option>
          <option value="or">以下任一条件</option>
        </ToDooSelect></label
      >
      <AButton
        v-if="depth > 1"
        class="todo-link todo-danger"
        type="link"
        danger
        html-type="button"
        @click="emit('remove')"
        >移除组</AButton
      >
    </div>
    <div
      v-for="(condition, index) in modelValue.conditions"
      :key="index"
      class="todo-filter-condition"
    >
      <ToDooFilterGroup
        v-if="'conditions' in condition"
        :model-value="condition"
        :model="model"
        :depth="depth + 1"
        :total="leafCount"
        @update:model-value="replace(index, $event)"
        @remove="remove(index)"
      />
      <div v-else class="todo-condition-controls">
        <ToDooSelect
          :value="condition.field"
          aria-label="筛选字段"
          @change="field(index, $event as Field)"
        >
          <option v-for="(name, key) in fields" :key="key" :value="key">{{ name }}</option>
        </ToDooSelect>
        <ToDooSelect
          :value="condition.operator"
          aria-label="筛选比较方式"
          @change="operator(index, condition, $event as Operator)"
        >
          <option v-for="op in operators(condition.field)" :key="op" :value="op">
            {{ labels[op] }}
          </option>
        </ToDooSelect>
        <template v-if="!['is_empty', 'not_empty'].includes(condition.operator)">
          <ToDooSelect
            v-if="boolFields.includes(condition.field)"
            :value="condition.value"
            aria-label="筛选值"
            @change="replace(index, { ...condition, value: $event as boolean })"
          >
            <option :value="true">是</option>
            <option :value="false">否</option>
          </ToDooSelect>
          <template v-else-if="condition.operator === 'between'">
            <ToDooDateField
              type="date"
              :value="(condition.value as string[])?.[0] || ''"
              aria-label="筛选开始日期"
              @change="
                replace(index, {
                  ...condition,
                  value: [$event, (condition.value as string[])?.[1] || toDooLocalDate()],
                })
              "
            />
            <ToDooDateField
              type="date"
              :value="(condition.value as string[])?.[1] || ''"
              aria-label="筛选结束日期"
              @change="
                replace(index, {
                  ...condition,
                  value: [(condition.value as string[])?.[0] || toDooLocalDate(), $event],
                })
              "
            />
          </template>
          <ToDooDateField
            v-else-if="dateFields.includes(condition.field)"
            type="date"
            :value="condition.value as string"
            aria-label="筛选日期"
            @change="replace(index, { ...condition, value: $event })"
          />
          <AInput
            v-else-if="condition.field === 'query'"
            :value="condition.value as string"
            aria-label="筛选关键词"
            @update:value="replace(index, { ...condition, value: $event })"
          />
          <ToDooSelect
            v-else
            :multiple="['in', 'not_in'].includes(condition.operator)"
            :value="condition.value"
            aria-label="筛选选项"
            @change="replace(index, { ...condition, value: $event as string | string[] })"
          >
            <option v-for="option in options(condition.field)" :key="option[0]" :value="option[0]">
              {{ option[1] }}
            </option>
          </ToDooSelect>
        </template>
        <AButton
          class="todo-icon-button"
          type="text"
          html-type="button"
          aria-label="移除此筛选条件"
          @click="remove(index)"
          >×</AButton
        >
      </div>
    </div>
    <div class="todo-actions">
      <AButton
        class="todo-link"
        type="link"
        html-type="button"
        :disabled="leafCount >= 30"
        @click="add()"
        >＋ 添加条件</AButton
      >
      <AButton
        class="todo-link"
        type="link"
        html-type="button"
        :disabled="depth >= 3 || leafCount >= 30"
        @click="add(true)"
        >＋ 添加条件组</AButton
      >
      <small class="todo-muted">{{ leafCount }}/30 条件</small>
    </div>
  </section>
</template>
