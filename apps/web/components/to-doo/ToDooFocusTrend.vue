<script setup lang="ts">
import { computed, ref } from 'vue';
import { Alert as AAlert, Button as AButton, Segmented as ASegmented } from 'ant-design-vue';
import type { ToDooFocusTrend } from '../../../../shared/to-doo-contracts';

const props = defineProps<{
  trend?: ToDooFocusTrend;
  period: ToDooFocusTrend['period'];
  date: string;
  timeZone?: string;
  loading: boolean;
  error: string;
}>();
const emit = defineEmits<{
  change: [value: { period: ToDooFocusTrend['period']; date: string }];
  retry: [];
}>();
const picked = ref('');
const cycle = computed(() => ({ week: '周', month: '月', year: '年' })[props.period]);
const rangeLabel = computed(() => {
  const trend = props.trend;
  if (!trend) return '';
  if (trend.period === 'week') return `${trend.from} — ${trend.to}`;
  const year = Number(trend.from.slice(0, 4));
  return trend.period === 'year' ? `${year}年` : `${year}年${Number(trend.from.slice(5, 7))}月`;
});
const number = (value: number) =>
  new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(value);
const duration = (minutes: number) => {
  const hours = Math.floor(minutes / 60),
    rest = Math.round((minutes - hours * 60) * 100) / 100;
  return [hours ? `${number(hours)} 小时` : '', rest || !hours ? `${number(rest)} 分钟` : '']
    .filter(Boolean)
    .join(' ');
};
const points = computed(() => props.trend?.points ?? []);
const max = computed(() =>
  Math.max(60, Math.ceil(Math.max(0, ...points.value.map((point) => point.minutes)) / 60) * 60),
);
const ticks = computed(() => [0, max.value / 2, max.value]);
const geometry = computed(() =>
  points.value.map((point, index) => ({
    ...point,
    x: 42 + (index * 358) / Math.max(1, points.value.length - 1),
    y: 84 - (point.minutes / max.value) * 60,
  })),
);
const path = computed(() => geometry.value.map((point) => `${point.x},${point.y}`).join(' '));
const selected = computed(() => geometry.value.findIndex((point) => point.date === picked.value));
const activeIndex = computed(() =>
  selected.value >= 0
    ? selected.value
    : Math.max(
        0,
        geometry.value.reduce((last, point, index) => (point.minutes > 0 ? index : last), -1),
      ),
);
const active = computed(() => geometry.value[activeIndex.value]);
const shortLabel = (date: string) =>
  props.period === 'year'
    ? `${Number(date.slice(5, 7))}月`
    : `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
const bucketLabel = (date: string) => (props.period === 'year' ? date.slice(0, 7) : date);
function move(direction: number) {
  if (!props.trend) return;
  const date = new Date(props.trend.from + 'T00:00:00Z');
  if (props.period === 'week') date.setUTCDate(date.getUTCDate() + direction * 7);
  else if (props.period === 'month') date.setUTCMonth(date.getUTCMonth() + direction);
  else date.setUTCFullYear(date.getUTCFullYear() + direction);
  const value = date.toISOString().slice(0, 10);
  if (value >= '0100-01-01' && value <= '9998-12-31')
    emit('change', { period: props.period, date: value });
}
function pointKey(event: KeyboardEvent, index: number) {
  const next =
    event.key === 'ArrowLeft'
      ? index - 1
      : event.key === 'ArrowRight'
        ? index + 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? geometry.value.length - 1
            : -1;
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const target = Math.max(0, Math.min(geometry.value.length - 1, next));
  picked.value = geometry.value[target].date;
  (event.currentTarget as SVGElement).ownerSVGElement
    ?.querySelector<SVGElement>(`[data-point-index="${target}"]`)
    ?.focus();
}
</script>

<template>
  <section class="todo-focus-trend" aria-label="专注时长趋势" :aria-busy="loading">
    <div class="todo-focus-trend-heading">
      <ASegmented
        size="small"
        :value="period"
        aria-label="专注趋势周期"
        :options="[
          { label: '周', value: 'week' },
          { label: '月', value: 'month' },
          { label: '年', value: 'year' },
        ]"
        @change="emit('change', { period: $event as ToDooFocusTrend['period'], date })"
      />
      <div v-if="trend && !loading && !error" class="todo-focus-trend-summary">
        <span>合计</span
        ><strong data-testid="focus-trend-total">{{ duration(trend.totalMinutes) }}</strong>
      </div>
    </div>
    <div class="todo-focus-trend-navigation">
      <AButton
        size="small"
        type="text"
        :aria-label="'上一' + cycle"
        :disabled="loading || !trend"
        @click="move(-1)"
        >‹</AButton
      >
      <span>{{ rangeLabel }}</span>
      <AButton
        size="small"
        type="text"
        :aria-label="'下一' + cycle"
        :disabled="loading || !trend"
        @click="move(1)"
        >›</AButton
      >
      <AButton size="small" :aria-label="'本' + cycle" @click="emit('change', { period, date: '' })"
        >本{{ cycle }}</AButton
      >
    </div>
    <AAlert v-if="error" type="error" :message="error" show-icon>
      <template #action><AButton type="link" @click="emit('retry')">重试</AButton></template>
    </AAlert>
    <p v-else-if="loading || !trend" class="todo-muted" role="status">正在载入专注趋势…</p>
    <template v-else>
      <svg
        viewBox="0 0 420 106"
        role="group"
        aria-label="专注时长折线图"
        class="todo-focus-trend-chart"
      >
        <g aria-hidden="true">
          <text x="4" y="12">分钟</text>
          <g v-for="tick in ticks" :key="tick">
            <line x1="42" x2="400" :y1="84 - (tick / max) * 60" :y2="84 - (tick / max) * 60" />
            <text x="34" :y="88 - (tick / max) * 60" text-anchor="end">{{ number(tick) }}</text>
          </g>
          <polyline :points="path" />
          <template v-for="(point, index) in geometry" :key="point.date">
            <text
              v-if="
                index % Math.max(1, Math.ceil(points.length / 6)) === 0 ||
                index === points.length - 1
              "
              :x="point.x"
              y="100"
              text-anchor="middle"
            >
              {{ shortLabel(point.date) }}
            </text>
            <circle
              :cx="point.x"
              :cy="point.y"
              :r="index === activeIndex ? 4 : 2.5"
              class="todo-focus-trend-dot"
            />
          </template>
        </g>
        <circle
          v-for="(point, index) in geometry"
          :key="point.date"
          :cx="point.x"
          :cy="point.y"
          r="9"
          class="todo-focus-trend-hit"
          :data-point-index="index"
          role="button"
          :tabindex="index === activeIndex ? 0 : -1"
          :aria-label="bucketLabel(point.date) + '：' + number(point.minutes) + ' 分钟'"
          @mouseenter="picked = point.date"
          @focus="picked = point.date"
          @click="picked = point.date"
          @keydown="pointKey($event, index)"
        />
      </svg>
      <div class="todo-focus-trend-footer">
        <p class="todo-focus-trend-readout">
          {{
            active
              ? (period === 'year' ? active.date.slice(0, 7) : active.date) +
                ' · ' +
                number(active.minutes) +
                ' 分钟'
              : ''
          }}
        </p>
        <p v-if="!trend.totalMinutes" class="todo-muted">这个周期还没有专注时长</p>
        <details class="todo-focus-trend-data">
          <summary>查看数据</summary>
          <table>
            <caption>
              {{
                rangeLabel
              }}
              ·
              {{
                timeZone
              }}
              · 单位：分钟
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ period === 'year' ? '月份' : '日期' }}</th>
                <th scope="col">专注时长</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="point in points" :key="point.date">
                <th scope="row">{{ bucketLabel(point.date) }}</th>
                <td>{{ number(point.minutes) }} 分钟</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </template>
  </section>
</template>

<style scoped>
.todo-focus-trend {
  min-width: 0;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid var(--todo-line);
  border-radius: var(--todo-radius);
}
.todo-focus-trend-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.todo-focus-trend-navigation {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
  margin-block: 4px 0;
}
.todo-focus-trend-navigation > span {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  text-align: center;
}
.todo-focus-trend-summary {
  display: flex;
  align-items: baseline;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 4px;
  color: var(--todo-muted);
  font-size: 11px;
}
.todo-focus-trend-summary strong {
  color: var(--todo-ink);
  font-size: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.todo-focus-trend-chart {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 2px;
  overflow: visible;
}
.todo-focus-trend-chart text {
  fill: var(--todo-muted);
  font-size: 11px;
}
.todo-focus-trend-chart line {
  stroke: var(--todo-line);
  stroke-dasharray: 3 3;
}
.todo-focus-trend-chart polyline {
  fill: none;
  stroke: var(--todo-accent);
  stroke-width: 2;
  stroke-linejoin: round;
}
.todo-focus-trend-dot {
  fill: var(--todo-accent);
}
.todo-focus-trend-hit {
  fill: transparent;
  cursor: pointer;
  outline: none;
}
.todo-focus-trend-hit:focus-visible {
  stroke: var(--todo-accent);
  stroke-width: 2;
}
.todo-focus-trend-readout {
  min-height: 16px;
  margin-left: auto;
  text-align: end;
  color: var(--todo-muted);
  font-size: 10px;
}
.todo-focus-trend-footer {
  display: flex;
  align-items: start;
  flex-direction: row-reverse;
  flex-wrap: wrap;
  gap: 2px 8px;
}
.todo-focus-trend-data {
  color: var(--todo-muted);
  font-size: 10px;
}
.todo-focus-trend-data[open] {
  width: 100%;
}
.todo-focus-trend-data summary {
  width: fit-content;
  cursor: pointer;
}
.todo-focus-trend-data summary:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 4px;
}
.todo-focus-trend-data table {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.todo-focus-trend-data caption {
  padding: 8px 0;
  text-align: start;
}
.todo-focus-trend-data th,
.todo-focus-trend-data td {
  padding: 6px;
  border-bottom: 1px solid var(--todo-line);
  text-align: start;
  font-weight: normal;
}
.todo-focus-trend-data td {
  text-align: end;
}
.todo-focus-trend-data tbody tr:last-child > * {
  border-bottom: 0;
}
</style>
