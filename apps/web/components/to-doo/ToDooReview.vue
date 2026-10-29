<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Empty as AEmpty,
  Progress as AProgress,
  Segmented as ASegmented,
  Statistic as AStatistic,
} from 'ant-design-vue';
import ToDooDateField from './ToDooDateField.vue';
import type { ToDooEntityKind } from '../../../../shared/to-doo-contracts';
import { shiftToDooDate, toDooLocalDate, type ToDooWorkbench } from '../../to-doo-workbench';
const props = defineProps<{ model: ToDooWorkbench; section: 'stats' | 'notifications' }>();
const emit = defineEmits<{
  edit: [kind: ToDooEntityKind, entity?: Record<string, any>, seed?: Record<string, any>];
  task: [id: string];
}>();
const state = props.model.state,
  today = toDooLocalDate(new Date(), state.snapshot?.settings.timeZone),
  from = ref(shiftToDooDate(today, -6)),
  to = ref(today),
  unreadOnly = ref(false);
const customRange = ref(false);
const periodPreset = computed(() =>
  customRange.value
    ? 'custom'
    : from.value === shiftToDooDate(today, -6) && to.value === today
      ? 'week'
      : from.value === shiftToDooDate(today, -29) && to.value === today
        ? 'month'
        : 'custom',
);
async function selectPeriod(value: string | number) {
  customRange.value = value === 'custom';
  if (customRange.value) return;
  from.value = shiftToDooDate(today, value === 'month' ? -29 : -6);
  to.value = today;
  await range();
}
const lists = computed(() => state.snapshot?.lists.filter((l) => !l.deletedAt) || []);
const listProgress = (id: string) => {
  const item = state.snapshot?.statistics.byList[id];
  return item?.total ? Math.min(100, Math.round((item.completed / item.total) * 100)) : 0;
};
const reminders = computed(
  () =>
    state.snapshot?.reminderEvents
      .filter(
        (r) =>
          !r.deletedAt &&
          (r.firstRaisedAt || r.scheduledAt <= new Date().toISOString()) &&
          (!unreadOnly.value || r.userState === 'unread'),
      )
      .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)) || [],
);
const completions = computed(
  () =>
    state.snapshot?.occurrences.filter(
      (o) =>
        !o.deletedAt &&
        o.status === 'done' &&
        o.completedAt &&
        toDooLocalDate(new Date(o.completedAt), state.snapshot?.settings.timeZone) >= from.value &&
        toDooLocalDate(new Date(o.completedAt), state.snapshot?.settings.timeZone) <= to.value,
    ) || [],
);
const daily = computed(() =>
  Array.from(
    {
      length: Math.min(
        31,
        Math.max(1, Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000) + 1),
      ),
    },
    (_, i) => {
      const date = shiftToDooDate(from.value, i);
      return {
        date,
        total: completions.value.filter(
          (o) =>
            toDooLocalDate(new Date(o.completedAt!), state.snapshot?.settings.timeZone) === date,
        ).length,
      };
    },
  ),
);
const reviews = computed(() => state.snapshot?.reviews.filter((r) => !r.deletedAt) || []);
const outcomes = computed(() => state.snapshot?.outcomes.filter((r) => !r.deletedAt) || []);
async function range() {
  if (!from.value || !to.value) {
    state.error = '请选择开始日期和结束日期';
    return;
  }
  if (from.value > to.value) {
    state.error = '结束日期不能早于开始日期';
    return;
  }
  await props.model.load({
    ...state.query,
    view: 'stats',
    from: from.value,
    to: to.value,
    cursor: undefined,
  });
}
async function reminder(id: string, action: 'read' | 'acknowledge' | 'dismiss' | 'snooze') {
  const item = state.snapshot?.reminderEvents.find((r) => r.id === id);
  if (!item) return;
  state.error = '';
  state.notice = '';
  try {
    await props.model.request(
      '/api/to-doo/reminders/' + encodeURIComponent(id) + '/action',
      'POST',
      {
        action,
        requestId: crypto.randomUUID(),
        expectedRevision: item.revision,
        ...(action === 'snooze' ? { until: new Date(Date.now() + 15 * 60000).toISOString() } : {}),
      },
    );
    await props.model.load();
    state.notice = '提醒已更新';
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
  }
}
async function markAll() {
  for (const r of reminders.value.filter((r) => r.userState === 'unread')) {
    await reminder(r.id, 'read');
    if (state.error) return;
  }
}
</script>
<template>
  <template v-if="section === 'stats'"
    ><form class="todo-calendar-toolbar" @submit.prevent="range">
      <div class="todo-actions">
        <ASegmented
          :value="periodPreset"
          :options="[
            { label: '近 7 天', value: 'week' },
            { label: '近 30 天', value: 'month' },
            { label: '自定义', value: 'custom' },
          ]"
          :disabled="state.busy"
          @change="selectPeriod"
        />
        <label class="todo-inline-label"
          >从<ToDooDateField
            v-model="from"
            type="date"
            required
            aria-label="统计开始日期"
            :max="to || undefined" /></label
        ><label class="todo-inline-label"
          >到<ToDooDateField
            v-model="to"
            type="date"
            required
            aria-label="统计结束日期"
            :min="from || undefined" /></label
        ><AButton type="default" html-type="submit" class="todo-button">查看区间</AButton>
      </div>
      <AButton
        type="primary"
        class="todo-button todo-primary"
        @click="
          emit('edit', 'review', undefined, {
            from,
            to,
            metrics: {
              completed: completions.length,
              focusMinutes: state.snapshot?.statistics.focusMinutes || 0,
              outcomes: outcomes.length,
            },
          })
        "
      >
        ＋ 写一篇复盘
      </AButton>
    </form>
    <div class="todo-stats">
      <article class="todo-panel">
        <AStatistic
          title="完成行动"
          :value="state.snapshot?.statistics.completed || 0"
          suffix="项"
        />
        <p>按执行实例统计</p>
      </article>
      <article class="todo-panel">
        <AStatistic
          title="专注时间"
          :value="Math.round(state.snapshot?.statistics.focusMinutes || 0)"
          suffix="分钟"
        />
        <p>来自实际专注记录</p>
      </article>
      <article class="todo-panel">
        <AStatistic
          title="沉淀成果"
          :value="state.snapshot?.statistics.outcomes || 0"
          suffix="份"
        />
        <p>成果与完成分别记录</p>
      </article>
    </div>
    <AAlert
      type="info"
      show-icon
      :message="`上方为${state.snapshot?.statistics.scope === 'period' ? '所选日期区间' : '知识库累计'}统计。下方明细基于 ${from} — ${to} 当前载入的记录，可在页尾继续载入。`"
    />
    <div class="todo-review-grid">
      <section class="todo-panel">
        <div class="todo-panel-header">
          <h2>每天完成的行动</h2>
          <small>单位：项</small>
        </div>
        <div
          class="todo-completion-chart"
          role="img"
          :aria-label="daily.map((d) => d.date + ' ' + d.total + '项').join('，')"
        >
          <div v-for="d in daily" :key="d.date">
            <span>{{ d.total || '' }}</span
            ><i
              :style="{
                height:
                  (d.total
                    ? Math.max(6, (d.total / Math.max(1, ...daily.map((v) => v.total))) * 100)
                    : 2) + 'px',
              }"
            ></i
            ><small>{{ d.date.slice(5) }}</small>
          </div>
        </div>
        <div class="todo-panel-header"><h2>目标进展</h2></div>
        <div v-for="l in lists" :key="l.id" class="todo-progress-row">
          <div class="todo-between">
            <span>{{ l.name }}</span
            ><span
              >{{ state.snapshot?.statistics.byList[l.id]?.completed || 0 }}/{{
                state.snapshot?.statistics.byList[l.id]?.total || 0
              }}</span
            >
          </div>
          <AProgress
            :percent="listProgress(l.id)"
            :show-info="false"
            :aria-label="l.name + '完成进度'"
          />
        </div>
        <AEmpty
          v-if="!lists.length"
          class="todo-empty"
          description="创建目标后，在这里回顾进展。"
        />
      </section>
      <section class="todo-panel">
        <div class="todo-panel-header"><h2>复盘与成果</h2></div>
        <AButton
          type="text"
          v-for="r in reviews"
          :key="r.id"
          class="todo-saved-row todo-text-button"
          @click="emit('edit', 'review', r)"
        >
          <span
            ><strong>{{ r.name }}</strong
            ><small>{{ r.from }} — {{ r.to }}</small>
            <p>{{ r.content.slice(0, 160) }}</p></span
          ><span>↗</span>
        </AButton>
        <AEmpty
          v-if="!reviews.length"
          class="todo-empty"
          description="写下做对的事与下一次调整，让记录成为下一步的依据。"
        />
        <AButton
          type="text"
          v-for="o in outcomes"
          :key="o.id"
          class="todo-saved-row todo-text-button"
          @click="emit('edit', 'outcome', o)"
        >
          <span
            >{{ o.summary
            }}<small
              >{{
                {
                  self_assessed: '自评',
                  practice: '练习验证',
                  reviewed: '经过评审',
                  delivered: '已交付',
                }[o.verification]
              }}
              · {{ o.evidenceRefs.length }} 份证据</small
            ></span
          ></AButton
        ><AButton type="link" class="todo-link todo-pad" @click="emit('edit', 'record')">
          ＋ 新增推进记录
        </AButton>
      </section>
    </div></template
  >
  <template v-else
    ><div class="todo-calendar-toolbar">
      <ASegmented
        :value="unreadOnly ? 'unread' : 'all'"
        :options="[
          { label: '全部', value: 'all' },
          { label: '未读', value: 'unread' },
        ]"
        @change="unreadOnly = $event === 'unread'"
      />
      <AButton type="default" class="todo-button" @click="markAll">全部标为已读</AButton>
    </div>
    <section class="todo-panel">
      <article v-for="r in reminders" :key="r.id" class="todo-notification">
        <span class="todo-notification-icon">◷</span>
        <div>
          <div class="todo-between">
            <h2>{{ r.title || '行动提醒' }}</h2>
            <span class="todo-badge" :class="{ accent: r.userState === 'unread' }">{{
              {
                unread: '未读',
                read: '已读',
                acknowledged: '已处理',
                dismissed: '已忽略',
                snoozed: '稍后提醒',
              }[r.userState]
            }}</span>
          </div>
          <p>{{ r.message }}</p>
          <small class="todo-muted"
            >{{ new Date(r.scheduledAt).toLocaleString()
            }}{{
              r.snoozedUntil ? ' · 稍后 ' + new Date(r.snoozedUntil).toLocaleString() : ''
            }}</small
          >
          <div class="todo-actions todo-top-gap">
            <AButton
              type="link"
              v-if="r.sourceType === 'task'"
              class="todo-link"
              @click="emit('task', r.sourceId)"
            >
              查看任务</AButton
            ><AButton type="default" class="todo-button" @click="reminder(r.id, 'read')"
              >已读</AButton
            ><AButton type="default" class="todo-button" @click="reminder(r.id, 'acknowledge')">
              已处理</AButton
            ><AButton type="default" class="todo-button" @click="reminder(r.id, 'snooze')">
              15 分钟后提醒</AButton
            ><AButton type="link" class="todo-link" @click="reminder(r.id, 'dismiss')">
              忽略
            </AButton>
          </div>
        </div>
      </article>
      <AEmpty
        v-if="!reminders.length"
        class="todo-empty"
        :description="unreadOnly ? '当前没有未读提醒' : '这里暂时没有提醒'"
      >
        <p class="todo-muted">为任务、习惯或重要日子添加提醒，到时会集中显示。</p>
      </AEmpty>
    </section></template
  >
</template>
