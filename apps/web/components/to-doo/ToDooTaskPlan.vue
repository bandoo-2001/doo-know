<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import type { ToDooTaskDraft, ToDooWorkbench } from '../../to-doo-workbench';
import { shiftToDooDate, toDooDisplayTime, toDooLocalDate } from '../../to-doo-workbench';
import { toDooDateLabel } from '../../to-doo-presentation';
import ToDooDateField from './ToDooDateField.vue';
const props = defineProps<{ model: ToDooWorkbench; draft: ToDooTaskDraft }>();
const emit = defineEmits<{ edit: [block?: ToDooEntityMap['timeBlock']] }>();
const blocks = computed(() => props.draft.blocks.filter((block) => !block.deletedAt));
const primary = computed(() => blocks.value[0]);
const zone = computed(() => props.model.state.snapshot?.settings.timeZone || 'UTC');
const disabled = computed(
  () => props.model.state.busy || !!props.model.state.pendingMutation || !props.draft.occurrence,
);
function setDate(date: string) {
  if (disabled.value || blocks.value.length > 1 || !props.draft.occurrence) return;
  const block =
    primary.value || props.draft.blocks.find((entry) => entry.deletedAt && entry.revision);
  if (!date) {
    if (!block) return;
    if (block.revision) block.deletedAt = new Date().toISOString();
    else props.draft.blocks = props.draft.blocks.filter((entry) => entry.id !== block.id);
    return;
  }
  if (block) {
    if (block.dateEndExclusive) {
      const delta = Math.round(
        (Date.parse(date + 'T12:00:00Z') - Date.parse(block.start.date + 'T12:00:00Z')) / 86400000,
      );
      block.dateEndExclusive = shiftToDooDate(block.dateEndExclusive, delta);
    }
    block.start.date = date;
    block.deletedAt = null;
    return;
  }
  const now = new Date().toISOString();
  props.draft.blocks.push({
    id: 'plan-' + crypto.randomUUID(),
    revision: '',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    occurrenceId: props.draft.occurrence.id,
    title: '',
    start: { date, time: null, timeZone: zone.value },
    durationMinutes: props.model.state.snapshot?.settings.defaultDurationMinutes || 30,
    allDay: false,
    dateEndExclusive: null,
  });
}
function label(block: ToDooEntityMap['timeBlock']) {
  const shown = toDooDisplayTime(block.start, zone.value);
  return (
    toDooDateLabel(shown.date, toDooLocalDate(new Date(), zone.value)) +
    (shown.time ? ' ' + shown.time : '')
  );
}
</script>
<template>
  <div class="todo-plan-control">
    <template v-if="blocks.length <= 1">
      <ToDooDateField
        type="date"
        aria-label="计划日期"
        :value="primary?.start.date || ''"
        :disabled="disabled"
        @change="setDate"
      />
      <small v-if="primary?.start.time && primary.start.timeZone !== zone" class="todo-muted"
        >按 {{ primary.start.timeZone }} 填写</small
      >
      <AButton
        type="text"
        class="todo-plan-time"
        :disabled="disabled"
        :aria-label="primary ? '调整时间安排：' + label(primary) : '设置具体时间'"
        @click="emit('edit', primary)"
      >
        {{
          primary?.allDay
            ? '全天安排'
            : primary?.start.time
              ? primary.start.time + ' · ' + primary.durationMinutes + ' 分钟'
              : '具体时间'
        }}
      </AButton>
    </template>
    <template v-else>
      <AButton
        v-for="block in blocks"
        :key="block.id"
        type="text"
        class="todo-plan-time"
        :disabled="disabled"
        :aria-label="'调整时间安排：' + label(block)"
        @click="emit('edit', block)"
      >
        {{ label(block) }} · {{ block.allDay ? '全天' : block.durationMinutes + ' 分钟' }}
      </AButton>
      <AButton
        type="text"
        class="todo-plan-time"
        :disabled="disabled"
        aria-label="添加时间安排"
        @click="emit('edit')"
        >＋ 添加一段时间</AButton
      >
    </template>
  </div>
</template>
<style scoped>
.todo-plan-control {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.todo-plan-control :deep(.todo-ant-date) {
  width: 100%;
}
.todo-plan-time.ant-btn {
  align-self: flex-start;
  height: auto;
  min-height: 28px;
  max-width: 100%;
  padding: 3px 0;
  color: var(--todo-muted);
  font-size: 12px;
  text-align: left;
  white-space: normal;
}
</style>
