<script setup lang="ts">
import { computed, ref } from 'vue';
import { Button as AButton, Input as AInput, InputNumber as AInputNumber, Popover as APopover } from 'ant-design-vue';
import { getHabitGoalMode } from '../../../../shared/to-doo-habits';
import { getHabitCheckinTargetLimit } from '../../../../shared/to-doo-contracts';
import { formatHabitSchedule, HABIT_ICONS } from '../../to-doo-habit-presentation';
import ToDooSelect from './ToDooSelect.vue';
import ToDooDateField from './ToDooDateField.vue';
import ToDooHabitReminders from './ToDooHabitReminders.vue';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{ form: Record<string, any>; ruleChanged: boolean }>();
const form = props.form;
const iconOpen = ref(false);
const mode = computed(() => getHabitGoalMode(form));
const cadence = ref(
  form.frequency !== 'daily'
    ? form.frequency
    : (form.intervalDays ?? 1) > 1
      ? 'interval'
      : form.weekdays?.length
        ? 'weekdays'
        : 'daily',
);
const summary = computed(() =>
  formatHabitSchedule({ ...form, weekdays: form.weekdays ?? [] } as any),
);
let quantityDraft: { target: number; unit: string } | undefined;
const checkinLimit = computed(() =>
  getHabitCheckinTargetLimit({ frequency: form.frequency, weekdays: form.weekdays }),
);
function changeGoal(value: string) {
  if (value === mode.value) return;
  if (value === 'checkin') {
    quantityDraft = { target: form.target, unit: form.unit };
    form.target = 1;
    form.unit = '次';
  } else if (quantityDraft) Object.assign(form, quantityDraft);
  form.goalMode = value;
}
function changeCadence(value: string) {
  cadence.value = value;
  form.frequency = ['weekly', 'monthly'].includes(value) ? value : 'daily';
  form.weekdays = value === 'weekdays' ? [1, 2, 3, 4, 5] : [];
  form.intervalDays = value === 'interval' ? 2 : 1;
  if (mode.value === 'checkin') form.target = 1;
}
function toggleDay(day: number) {
  const selected: number[] = form.weekdays ?? [];
  // Keep the schedule explicit rather than silently turning an empty selection into every day.
  if (selected.includes(day) && selected.length === 1) return;
  form.weekdays = selected.includes(day)
    ? selected.filter((value) => value !== day)
    : [...selected, day];
}
</script>

<template>
  <div class="todo-habit-name">
    <APopover
      v-model:open="iconOpen"
      trigger="click"
      placement="bottomLeft"
      overlay-class-name="todo-ant-popup"
    >
      <template #content
        ><div class="todo-habit-icon-options" role="group" aria-label="选择习惯图标">
          <AButton
            v-for="icon in HABIT_ICONS"
            :key="icon"
            type="text"
            :aria-label="'选择图标 ' + icon"
            :aria-pressed="form.icon === icon"
            @click="
              form.icon = icon;
              iconOpen = false;
            "
            >{{ icon }}</AButton
          >
          <AButton
            type="text"
            aria-label="使用默认图标"
            @click="
              form.icon = '';
              iconOpen = false;
            "
            ><ToDooIcon name="habits"
          /></AButton></div
      ></template>
      <AButton class="todo-habit-icon-picker" aria-label="选择习惯图标"
        ><span v-if="form.icon">{{ form.icon }}</span
        ><ToDooIcon v-else name="habits" :size="22"
      /></AButton>
    </APopover>
    <label
      >名称<AInput
        v-model:value="form.name"
        required
        :maxlength="256"
        autofocus
        placeholder="例如：早睡、阅读"
    /></label>
  </div>
  <label
    >目标<ToDooSelect :value="mode" aria-label="目标" :show-search="false" @change="changeGoal">
      <option value="checkin">完成后打卡</option>
      <option value="quantity">完成一定数量</option>
    </ToDooSelect></label
  >
  <label
    >频率<ToDooSelect
      :value="cadence"
      aria-label="频率"
      :show-search="false"
      @change="changeCadence"
    >
      <option value="daily">每天</option>
      <option value="weekdays">指定星期</option>
      <option value="weekly">每周累计</option>
      <option value="monthly">每月累计</option>
      <option value="interval">每隔几天</option>
    </ToDooSelect></label
  >
  <p v-if="form.frequency !== 'daily' && form.weekdays?.length" class="todo-form-help">
    可记录日期
  </p>
  <div
    v-if="cadence === 'weekdays' || (form.frequency !== 'daily' && form.weekdays?.length)"
    class="todo-habit-weekdays"
    role="group"
    aria-label="选择星期"
  >
    <AButton
      v-for="day in [1, 2, 3, 4, 5, 6, 0]"
      :key="day"
      :aria-label="'星期' + '日一二三四五六'[day]"
      :aria-pressed="form.weekdays.includes(day)"
      :type="form.weekdays.includes(day) ? 'primary' : 'default'"
      @click="toggleDay(day)"
      >{{ '日一二三四五六'[day] }}</AButton
    >
  </div>
  <AButton
    v-if="form.frequency !== 'daily' && form.weekdays?.length"
    type="link"
    class="todo-link"
    @click="form.weekdays = []"
    >允许任意一天打卡</AButton
  >
  <label v-if="cadence === 'interval'"
    >间隔天数<AInputNumber
      :value="form.intervalDays"
      :min="2"
      :max="365"
      :precision="0"
      required
      aria-label="间隔天数"
      @update:value="form.intervalDays = $event"
  /></label>
  <div v-if="mode === 'quantity'" class="todo-form-grid">
    <label
      >目标数量<AInputNumber
        :value="form.target"
        :min="0.1"
        :max="1000000"
        :step="0.1"
        required
        aria-label="目标数量"
        @update:value="form.target = $event"
    /></label>
    <label
      >单位<AInput v-model:value="form.unit" required :maxlength="40" placeholder="次、页、分钟…"
    /></label>
  </div>
  <label v-else-if="form.frequency !== 'daily'"
    >{{ form.frequency === 'weekly' ? '每周打卡天数' : '每月打卡天数'
    }}<AInputNumber
      :value="form.target"
      :min="1"
      :max="checkinLimit"
      :precision="0"
      required
      aria-label="打卡天数"
      @update:value="form.target = $event"
    /><small v-if="form.weekdays?.length" class="todo-muted"
      >按所选星期，最多可打卡 {{ checkinLimit }} 天。</small
    ></label
  >
  <p
    v-if="cadence !== 'daily' || mode === 'quantity'"
    class="todo-form-help todo-habit-schedule-summary"
  >
    {{ summary }}
  </p>
  <label
    >开始日期<ToDooDateField v-model="form.startDate" type="date" required aria-label="开始日期"
  /></label>
  <label v-if="ruleChanged"
    >规则生效日期<ToDooDateField
      v-model="form.effectiveFrom"
      type="date"
      required
      aria-label="规则生效日期"
    /><small class="todo-muted">此前的记录仍按原规则计算。</small></label
  >
  <ToDooHabitReminders v-model="form.reminders" />
</template>
