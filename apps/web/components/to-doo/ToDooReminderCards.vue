<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Button as AButton, InputNumber as AInputNumber, Select as ASelect } from 'ant-design-vue';
import { api } from '../../api';
import {
  createToDooReminderController,
  reminderIdFromUrl,
  toDooReminderMessage,
} from '../../to-doo-reminders';
import type { ToDooReminderCard } from '../../../../shared/to-doo-reminders';

const emit = defineEmits<{ open: [card?: ToDooReminderCard]; 'consume-link': [] }>();
let channel: BroadcastChannel | undefined;
const controller = createToDooReminderController(api, {
  changed() {
    window.dispatchEvent(new Event('dooknow-to-doo-changed'));
  },
});
const state = controller.state;
const current = ref(0),
  minutes = ref(15),
  amount = ref<number | undefined>(1);
const card = computed(() => state.cards[Math.min(current.value, state.cards.length - 1)]);
watch(
  () => [card.value?.event.id, card.value?.event.deliveryGeneration],
  () => {
    const habit = card.value?.habit;
    amount.value = habit ? Math.max(0.001, habit.target - habit.amount) : 1;
    minutes.value = 15;
  },
);
const clock = computed(() => {
  if (!card.value) return '';
  const date = new Date(card.value.event.snoozedUntil ?? card.value.event.scheduledAt);
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: state.timeZone,
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(date);
  } catch {
    return date.toLocaleString();
  }
});
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;
function refresh() {
  if (!stopped && document.visibilityState !== 'hidden' && navigator.onLine !== false)
    void controller.refresh();
}
function changed() {
  try {
    channel?.postMessage('updated');
  } catch {
    /* Polling remains available. */
  }
  refresh();
}
async function message(event: MessageEvent) {
  const parsed = toDooReminderMessage(event.data);
  if (!parsed || stopped) return;
  if (parsed.kind === 'update') {
    refresh();
    return;
  }
  if (parsed.id) {
    await controller.open(parsed.id);
    refresh();
  } else emit('open');
}
async function complete() {
  if (!card.value) return;
  if (card.value.completion === 'open') {
    emit('open', card.value);
    return;
  }
  if (card.value.completion === 'habit' && (!amount.value || amount.value <= 0)) {
    state.error = '请输入本次实际完成的数量';
    return;
  }
  await controller.act(
    card.value,
    card.value.completion === 'acknowledge' ? 'acknowledge' : 'complete',
    card.value.completion === 'habit' ? { amount: amount.value! } : {},
  );
}
onMounted(() => {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('dooknow.to-doo.reminders');
      channel.onmessage = refresh;
    } catch {
      /* A browser may disable cross-tab channels; polling still works. */
    }
  }
  const id = reminderIdFromUrl(location.href, location.origin);
  if (id)
    void controller.open(id).finally(() => {
      if (!stopped) {
        emit('consume-link');
        refresh();
      }
    });
  else refresh();
  timer = setInterval(refresh, 15000);
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('dooknow-to-doo-changed', changed);
  document.addEventListener('visibilitychange', refresh);
  navigator.serviceWorker?.addEventListener('message', message);
});
onBeforeUnmount(() => {
  stopped = true;
  clearInterval(timer);
  controller.dispose();
  channel?.close();
  window.removeEventListener('focus', refresh);
  window.removeEventListener('online', refresh);
  window.removeEventListener('dooknow-to-doo-changed', changed);
  document.removeEventListener('visibilitychange', refresh);
  navigator.serviceWorker?.removeEventListener('message', message);
});
</script>

<template>
  <Teleport to="body">
    <section
      v-if="card || state.error || state.missedCount"
      class="reminder-stack"
      aria-label="到点提醒"
    >
      <article v-if="card" class="reminder-card" :class="{ 'has-queue': state.cards.length > 1 }">
        <div class="reminder-meta">
          <span>◷ {{ clock }}</span>
          <AButton
            type="text"
            size="small"
            aria-label="关闭这条提醒"
            :disabled="!!state.busy"
            @click="controller.act(card, 'read')"
            >×</AButton
          >
        </div>
        <p class="reminder-kind">
          {{
            { task: '任务提醒', habit: '习惯提醒', anniversary: '纪念日提醒' }[
              card.event.sourceType
            ]
          }}
        </p>
        <h2>{{ card.event.title }}</h2>
        <p v-if="card.event.message" class="reminder-description">{{ card.event.message }}</p>
        <div v-if="card.habit" class="reminder-habit">
          <progress :value="card.habit.amount" :max="card.habit.target" aria-label="本期习惯进度" />
          <div class="reminder-progress-label">
            本期已完成 {{ card.habit.amount }} / {{ card.habit.target }} {{ card.habit.unit }}
          </div>
          <label
            >本次打卡
            <AInputNumber
              v-model:value="amount"
              :min="0.001"
              :max="1000000"
              :disabled="!!state.busy"
              aria-label="本次打卡数量"
            />
            {{ card.habit.unit }}</label
          >
        </div>
        <p v-if="state.loadError" class="reminder-warning" role="status">
          {{ state.loadError }}，恢复连接后会更新提醒。
        </p>
        <p v-if="state.error" class="reminder-error" role="alert">{{ state.error }}</p>
        <div class="reminder-actions">
          <AButton type="link" :disabled="!!state.busy" @click="emit('open', card)"
            >查看事项</AButton
          >
          <div class="reminder-snooze">
            <ASelect
              v-model:value="minutes"
              size="small"
              aria-label="稍后提醒间隔"
              :disabled="!!state.busy"
              :options="[5, 15, 30, 60].map((value) => ({ value, label: value + ' 分钟' }))"
            />
            <AButton :disabled="!!state.busy" @click="controller.act(card, 'snooze', { minutes })"
              >稍后提醒</AButton
            >
          </div>
          <AButton
            type="primary"
            :loading="state.busy === card.event.id"
            :disabled="!!state.busy"
            @click="complete"
            >{{
              { task: '完成', habit: '打卡', acknowledge: '知道了', open: '打开处理' }[
                card.completion
              ]
            }}</AButton
          >
        </div>
        <div v-if="state.cards.length > 1" class="reminder-queue">
          <AButton
            type="text"
            size="small"
            aria-label="上一条提醒"
            :disabled="!!state.busy"
            @click="
              current =
                (Math.min(current, state.cards.length - 1) + state.cards.length - 1) %
                state.cards.length
            "
            >‹</AButton
          >
          <span
            >{{ Math.min(current + 1, state.cards.length) }} / {{ state.cards.length }} 条提醒</span
          >
          <AButton
            type="text"
            size="small"
            aria-label="下一条提醒"
            :disabled="!!state.busy"
            @click="current = (current + 1) % state.cards.length"
            >›</AButton
          >
        </div>
      </article>
      <div v-else-if="state.error" class="reminder-card" role="alert">
        <div class="reminder-meta">
          <span>提醒暂时无法打开</span
          ><AButton type="text" aria-label="关闭提醒提示" @click="state.error = ''">×</AButton>
        </div>
        <p>{{ state.error }}</p>
        <AButton
          @click="
            emit('open');
            state.error = '';
          "
          >查看通知中心</AButton
        >
      </div>
      <AButton v-if="state.missedCount" class="reminder-missed" @click="emit('open')"
        >还有 {{ state.missedCount }} 条较早提醒，查看通知中心</AButton
      >
    </section>
  </Teleport>
</template>

<style scoped>
.reminder-stack {
  position: fixed;
  right: 24px;
  bottom: calc(44px + var(--workspace-bottom-inset, 0px));
  width: min(400px, calc(100vw - 32px));
  z-index: 1050;
  color: var(--text, #202534);
  font-family: inherit;
}
.reminder-card {
  position: relative;
  padding: 18px 20px 16px;
  border: 1px solid var(--border, #e8eaf0);
  border-radius: 16px;
  background: var(--panel, #fff);
  box-shadow:
    0 10px 40px #18243b26,
    0 2px 8px #18243b12;
}
.reminder-card.has-queue::before {
  content: '';
  position: absolute;
  inset: -7px 12px auto;
  height: 7px;
  border: 1px solid var(--border, #e8eaf0);
  border-bottom: none;
  border-radius: 12px 12px 0 0;
  background: var(--panel, #fff);
}
.reminder-meta,
.reminder-actions,
.reminder-queue {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.reminder-meta {
  color: var(--accent, #4b72f5);
  font-size: 13px;
}
.reminder-kind {
  color: var(--muted, #7b8394);
  font-size: 12px;
  margin: 8px 0 4px;
}
.reminder-card h2 {
  font-size: 19px;
  line-height: 1.45;
  font-weight: 600;
  margin: 0 0 12px;
  overflow-wrap: anywhere;
}
.reminder-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted, #7b8394);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 84px;
  overflow: auto;
}
.reminder-actions {
  margin-top: 18px;
  flex-wrap: wrap;
}
.reminder-actions > :first-child {
  margin-left: -12px;
}
.reminder-snooze {
  display: flex;
  gap: 4px;
  align-items: center;
  margin-left: auto;
}
.reminder-snooze :deep(.ant-select) {
  width: 88px;
}
.reminder-habit progress {
  width: 100%;
  height: 6px;
  accent-color: var(--accent, #4b72f5);
}
.reminder-progress-label {
  font-size: 12px;
  color: var(--muted, #7b8394);
  margin: 5px 0 12px;
}
.reminder-habit label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.reminder-habit :deep(.ant-input-number) {
  width: 95px;
}
.reminder-queue {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border, #e8eaf0);
  justify-content: center;
  color: var(--muted, #7b8394);
  font-size: 12px;
}
.reminder-error,
.reminder-warning {
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.reminder-error {
  color: #c93838;
}
.reminder-warning {
  color: #a06415;
}
.reminder-missed {
  width: 100%;
  margin-top: 10px;
  height: auto;
  min-height: 32px;
  white-space: normal;
  font-size: 12px;
}
@media (max-width: 600px) {
  .reminder-stack {
    right: 16px;
    bottom: calc(max(20px, env(safe-area-inset-bottom)) + var(--workspace-bottom-inset, 0px));
  }
  .reminder-card {
    padding: 14px 16px;
  }
  .reminder-actions {
    gap: 8px;
  }
}
</style>
