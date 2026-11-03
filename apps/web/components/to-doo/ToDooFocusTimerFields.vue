<script setup lang="ts">
import { Input, InputNumber as AInputNumber, Segmented as ASegmented } from 'ant-design-vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import ToDooSelect from './ToDooSelect.vue';
const ATextarea = Input.TextArea;
const props = defineProps<{
  active: ToDooEntityMap['focusSession'] | null;
  taskOptions: { value: string; label: string }[];
  note: string;
  focusMinutes: number;
  breakMinutes: number;
  breakKind?: 'short' | 'long';
}>();
const mode = defineModel<'pomodoro' | 'stopwatch' | 'break'>('mode', { required: true });
const target = defineModel<number | ''>('target', { required: true });
const chosen = defineModel<string>('chosen', { required: true });
const emit = defineEmits<{ 'update:note': [value: string]; 'target-edited': [] }>();
function changeMode(value: string | number) {
  mode.value = value as typeof mode.value;
  target.value = value === 'break' ? props.breakMinutes : props.focusMinutes;
}
</script>

<template>
  <div class="todo-focus-timer-fields">
    <ASegmented
      v-if="!active"
      aria-label="计时方式"
      :value="mode"
      :options="[
        { label: '番茄钟', value: 'pomodoro' },
        { label: '正计时', value: 'stopwatch' },
        { label: '休息', value: 'break' },
      ]"
      @change="changeMode"
    />
    <label v-if="!active" class="todo-focus-task-link"
      >关联行动<ToDooSelect
        :value="chosen"
        aria-label="关联行动"
        :options="taskOptions"
        @change="chosen = $event"
    /></label>
    <label v-if="!active && mode !== 'stopwatch'" class="todo-focus-target"
      >{{ mode === 'break' ? (breakKind === 'long' ? '长休息' : '短休息') : '本次时长'
      }}<AInputNumber
        :value="target"
        :min="mode === 'break' ? 0 : 1"
        :max="1440"
        aria-label="本次时长"
        @update:value="
          target = $event === null || $event === '' ? '' : Number($event);
          emit('target-edited');
        "
      />分钟</label
    >
    <label v-if="active" class="todo-focus-note"
      >本次专注记录<ATextarea
        :value="note"
        aria-label="本次专注记录"
        :auto-size="{ minRows: 1, maxRows: 3 }"
        placeholder="完成了什么？下一步是什么？"
        @update:value="emit('update:note', $event)"
    /></label>
  </div>
</template>
