<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import {
  Button as AButton,
  Input as AInput,
  InputNumber as AInputNumber,
  Popover as APopover,
} from 'ant-design-vue';
import { getHabitGoalMode } from '../../../../shared/to-doo-habits';
import { getHabitCheckinTargetLimit } from '../../../../shared/to-doo-contracts';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { formatHabitSchedule, HABIT_ICONS } from '../../to-doo-habit-presentation';
import ToDooSelect from './ToDooSelect.vue';
import ToDooListTreeSelect from './ToDooListTreeSelect.vue';
import type { ToDooWorkbench } from '../../to-doo-workbench';
import ToDooDateField from './ToDooDateField.vue';
import ToDooHabitReminders from './ToDooHabitReminders.vue';
import ToDooIcon from './ToDooIcon.vue';
const props = defineProps<{
  form: Record<string, any>;
  ruleChanged: boolean;
  lists?: ToDooEntityMap['list'][];
  model?: ToDooWorkbench;
}>();
const form = props.form;
const iconOpen = ref(false);
const iconTrigger = ref<any>();
function closeIcon() {
  iconOpen.value = false;
  nextTick(() => iconTrigger.value?.$el?.focus?.());
}
function iconKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !iconOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  closeIcon();
}
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
  <div class="todo-habit-editor-fields">
    <div class="todo-habit-name todo-habit-editor-name">
      <APopover
        v-model:open="iconOpen"
        trigger="click"
        placement="bottomLeft"
        overlay-class-name="todo-ant-popup"
      >
        <template #content>
          <div
            class="todo-habit-icon-options"
            role="group"
            aria-label="选择习惯图标"
            @keydown="iconKeydown"
          >
            <AButton
              v-for="icon in HABIT_ICONS"
              :key="icon"
              type="text"
              html-type="button"
              :aria-label="'选择图标 ' + icon"
              :aria-pressed="form.icon === icon"
              @click="
                form.icon = icon;
                closeIcon();
              "
              >{{ icon }}</AButton
            >
            <AButton
              type="text"
              html-type="button"
              aria-label="使用默认图标"
              @click="
                form.icon = '';
                closeIcon();
              "
              ><ToDooIcon name="habits"
            /></AButton>
          </div>
        </template>
        <AButton
          ref="iconTrigger"
          class="todo-habit-icon-picker"
          html-type="button"
          aria-label="选择习惯图标"
          :aria-expanded="iconOpen"
          @keydown="iconKeydown"
        >
          <span v-if="form.icon">{{ form.icon }}</span
          ><ToDooIcon v-else name="habits" :size="24" />
        </AButton>
      </APopover>
      <label class="todo-habit-name-field"
        ><span class="todo-habit-name-label">名称</span
        ><AInput
          v-model:value="form.name"
          required
          :maxlength="256"
          autofocus
          placeholder="例如：早睡、阅读"
      /></label>
    </div>
    <div class="todo-habit-editor-rows">
      <label class="todo-habit-field-row"
        ><span class="todo-habit-field-label">频率</span
        ><ToDooSelect
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
      <div
        v-if="cadence === 'weekdays' || (form.frequency !== 'daily' && form.weekdays?.length)"
        class="todo-habit-field-row"
      >
        <span class="todo-habit-field-label">{{
          form.frequency !== 'daily' ? '可记录日期' : '打卡日期'
        }}</span>
        <div class="todo-habit-days-control">
          <div class="todo-habit-weekdays" role="group" aria-label="选择星期">
            <AButton
              v-for="day in [1, 2, 3, 4, 5, 6, 0]"
              :key="day"
              html-type="button"
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
            html-type="button"
            class="todo-link"
            @click="form.weekdays = []"
            >允许任意一天打卡</AButton
          >
        </div>
      </div>
      <label v-if="cadence === 'interval'" class="todo-habit-field-row"
        ><span class="todo-habit-field-label">间隔天数</span
        ><AInputNumber
          :value="form.intervalDays"
          :min="2"
          :max="365"
          :precision="0"
          required
          aria-label="间隔天数"
          @update:value="form.intervalDays = $event"
      /></label>
      <label class="todo-habit-field-row"
        ><span class="todo-habit-field-label">目标</span
        ><ToDooSelect :value="mode" aria-label="目标" :show-search="false" @change="changeGoal"
          ><option value="checkin">完成后打卡</option>
          <option value="quantity">完成一定数量</option></ToDooSelect
        ></label
      >
      <div v-if="mode === 'quantity'" class="todo-habit-field-row">
        <span class="todo-habit-field-label">数量与单位</span>
        <div class="todo-habit-goal-values">
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
            >单位<AInput
              v-model:value="form.unit"
              required
              :maxlength="40"
              placeholder="次、页、分钟…"
          /></label>
        </div>
      </div>
      <label v-else-if="form.frequency !== 'daily'" class="todo-habit-field-row"
        ><span class="todo-habit-field-label">{{
          form.frequency === 'weekly' ? '每周打卡天数' : '每月打卡天数'
        }}</span
        ><AInputNumber
          :value="form.target"
          :min="1"
          :max="checkinLimit"
          :precision="0"
          required
          aria-label="打卡天数"
          @update:value="form.target = $event"
        /><small v-if="form.weekdays?.length" class="todo-muted todo-habit-row-help"
          >按所选星期，最多可打卡 {{ checkinLimit }} 天。</small
        ></label
      >
      <p
        v-if="cadence !== 'daily' || mode === 'quantity'"
        class="todo-form-help todo-habit-schedule-summary"
      >
        <ToDooIcon name="calendar" :size="14" /><span>{{ summary }}</span>
      </p>
      <label class="todo-habit-field-row"
        ><span class="todo-habit-field-label">开始日期</span
        ><ToDooDateField v-model="form.startDate" type="date" required aria-label="开始日期"
      /></label>
      <label v-if="ruleChanged" class="todo-habit-field-row"
        ><span class="todo-habit-field-label">规则生效日期</span
        ><ToDooDateField
          v-model="form.effectiveFrom"
          type="date"
          required
          aria-label="规则生效日期"
        /><small class="todo-muted todo-habit-row-help">此前的记录仍按原规则计算。</small></label
      >
      <label class="todo-habit-field-row"
        ><span class="todo-habit-field-label">关联目标或清单</span
        ><ToDooListTreeSelect
          v-model="form.listId"
          :model="model"
          :lists="lists"
          :allow-create="false"
          null-label="不关联"
          aria-label="关联目标或清单"
      /></label>
    </div>
    <section class="todo-habit-reminders-section" aria-label="习惯提醒设置">
      <ToDooHabitReminders v-model="form.reminders" />
    </section>
  </div>
</template>
<style scoped>
.todo-habit-editor-fields {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.todo-habit-editor-fields .todo-habit-editor-name {
  grid-template-columns: 44px minmax(0, 1fr);
  gap: 14px;
  align-items: center;
}
.todo-habit-editor-name .todo-habit-icon-picker.ant-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 12px;
  background: var(--todo-soft);
  font-size: 24px;
}
.todo-habit-editor-name .todo-habit-name-field {
  position: relative;
  min-width: 0;
}
.todo-habit-name-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.todo-habit-name-field :deep(.ant-input) {
  min-height: 40px;
  font-size: 15px;
}
.todo-habit-editor-rows {
  display: grid;
  gap: 14px;
  min-width: 0;
}
.todo-habit-editor-fields .todo-habit-editor-rows > .todo-habit-field-row {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  align-items: center;
  gap: 6px 14px;
  min-width: 0;
  font-size: var(--todo-caption-size);
}
.todo-habit-field-label {
  color: var(--todo-ink);
  line-height: 1.5;
}
.todo-habit-field-row > :deep(.ant-input-number),
.todo-habit-field-row > :deep(.todo-ant-date),
.todo-habit-field-row > :deep(.todo-ant-select),
.todo-habit-field-row > :deep(.todo-list-select) {
  width: 100%;
  min-width: 0;
}
.todo-habit-goal-values {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
}
.todo-habit-goal-values > label {
  min-width: 0;
}
.todo-habit-goal-values :deep(.ant-input-number) {
  width: 100%;
}
.todo-habit-days-control {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.todo-habit-days-control .todo-link {
  justify-self: start;
  height: auto;
  padding: 0;
  font-size: 12px;
  white-space: normal;
  text-align: start;
}
.todo-habit-row-help {
  grid-column: 2;
  line-height: 1.5;
}
.todo-habit-editor-fields .todo-habit-schedule-summary {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--todo-soft);
}
.todo-habit-schedule-summary > svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--todo-muted);
}
.todo-habit-reminders-section {
  min-width: 0;
  padding-top: 14px;
  border-top: 1px solid var(--todo-line);
}
@media (max-width: 480px) {
  .todo-habit-editor-fields {
    gap: 16px;
  }
  .todo-habit-editor-fields .todo-habit-editor-rows > .todo-habit-field-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 6px;
  }
  .todo-habit-row-help {
    grid-column: 1;
  }
  .todo-habit-goal-values {
    gap: 10px;
  }
  .todo-habit-weekdays {
    gap: 4px;
  }
}
</style>
