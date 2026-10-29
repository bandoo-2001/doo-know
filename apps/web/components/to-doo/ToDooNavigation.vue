<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { ToDooAppSection } from '../../navigation';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { toDooQuickViews, type ToDooQuickFilter } from '../../to-doo-presentation';
import ToDooIcon from './ToDooIcon.vue';
import ToDooDateField from './ToDooDateField.vue';

const props = defineProps<{
  section: ToDooAppSection;
  quickView: ToDooQuickFilter;
  listId?: string;
  lists: ToDooEntityMap['list'][];
  items: [ToDooAppSection, string, string][];
  listLoading: boolean;
  listError: boolean;
  hasMoreLists: boolean;
  hostedNavigation?: boolean;
  date?: string;
  today?: string;
  calendarView?: 'week' | 'month';
}>();
const emit = defineEmits<{
  navigate: [
    section: ToDooAppSection,
    selection?: { date?: string; calendarView?: 'week' | 'month' },
  ];
  quick: [view: ToDooQuickFilter];
  list: [id: string];
  'new-list': [];
  'load-lists': [];
  back: [];
}>();
const calendarNavigation = computed(
  () => props.hostedNavigation && ['calendar', 'timeline'].includes(props.section),
);
const taskNavigation = computed(
  () => !props.hostedNavigation || ['tasks', 'board', 'overview'].includes(props.section),
);
const groups = computed(() =>
  (props.hostedNavigation
    ? [{ label: '目标', sections: ['overview'] }]
    : [
        { label: '计划与执行', sections: ['overview', 'board', 'calendar', 'timeline', 'matrix'] },
        { label: '专注与生活', sections: ['focus', 'habits', 'anniversaries'] },
        { label: '回顾与管理', sections: ['stats', 'notifications'] },
      ]
  ).map((group) => ({
    ...group,
    items: props.items.filter(([section]) => group.sections.includes(section)),
  })),
);
function calendarNavigate(section: 'calendar' | 'timeline', view = props.calendarView || 'month') {
  emit('navigate', section, { date: props.date, calendarView: view });
}
function calendarDateChanged(date: string) {
  if (date) emit('navigate', props.section, { date, calendarView: props.calendarView || 'month' });
}
</script>

<template>
  <div class="todo-navigation-content">
    <h2 v-if="hostedNavigation" class="todo-directory-title">
      {{ calendarNavigation ? '日历' : '任务' }}
    </h2>
    <div v-else class="todo-app-title">
      <span class="todo-app-mark"><ToDooIcon name="check" :size="18" /></span>
      <span>To Doo<small>把想法变成行动</small></span>
    </div>
    <nav
      :aria-label="
        hostedNavigation ? (calendarNavigation ? '日历目录' : '任务目录') : 'To Doo 导航'
      "
    >
      <section
        v-if="calendarNavigation"
        class="todo-navigation-group todo-calendar-directory"
        aria-label="日期与视图"
      >
        <label class="todo-calendar-date"
          >日期<ToDooDateField
            type="date"
            :value="date"
            :allow-clear="false"
            @change="calendarDateChanged"
        /></label>
        <AButton
          type="text"
          block
          @click="emit('navigate', section, { date: today, calendarView: calendarView || 'month' })"
          ><ToDooIcon name="calendar" :size="16" />今天</AButton
        >
        <div class="todo-nav-label">日历视图</div>
        <AButton
          type="text"
          block
          :class="{ active: section === 'calendar' && calendarView !== 'week' }"
          :aria-current="section === 'calendar' && calendarView !== 'week' ? 'page' : undefined"
          @click="calendarNavigate('calendar', 'month')"
          ><ToDooIcon name="calendar" :size="16" />月视图</AButton
        >
        <AButton
          type="text"
          block
          :class="{ active: section === 'calendar' && calendarView === 'week' }"
          :aria-current="section === 'calendar' && calendarView === 'week' ? 'page' : undefined"
          @click="calendarNavigate('calendar', 'week')"
          ><ToDooIcon name="calendar" :size="16" />周视图</AButton
        >
        <AButton
          type="text"
          block
          :class="{ active: section === 'timeline' }"
          :aria-current="section === 'timeline' ? 'page' : undefined"
          @click="calendarNavigate('timeline')"
          ><ToDooIcon name="timeline" :size="16" />时间线</AButton
        >
      </section>
      <template v-if="taskNavigation">
        <section class="todo-navigation-group" aria-label="我的待办">
          <div class="todo-nav-label">我的待办</div>
          <AButton
            v-for="view in toDooQuickViews"
            :key="view.id"
            type="text"
            block
            :class="{ active: section === 'tasks' && !listId && quickView === view.id }"
            :aria-current="
              section === 'tasks' && !listId && quickView === view.id ? 'page' : undefined
            "
            @click="emit('quick', view.id)"
            ><ToDooIcon :name="view.icon" :size="16" /><span>{{ view.name }}</span></AButton
          >
        </section>
        <section
          v-for="group in groups"
          :key="group.label"
          class="todo-navigation-group"
          :aria-label="group.label"
        >
          <div class="todo-nav-label">{{ group.label }}</div>
          <AButton
            v-for="item in group.items"
            :key="item[0]"
            type="text"
            block
            :class="{ active: section === item[0] }"
            :aria-current="section === item[0] ? 'page' : undefined"
            @click="emit('navigate', item[0])"
            ><ToDooIcon :name="item[0]" :size="16" /><span>{{ item[1] }}</span></AButton
          >
        </section>
        <section class="todo-navigation-group todo-navigation-lists" aria-label="我的清单">
          <div class="todo-nav-section-heading">
            <span class="todo-nav-label">我的清单</span>
            <AButton type="text" size="small" aria-label="新建清单" @click="emit('new-list')"
              ><ToDooIcon name="plus" :size="15"
            /></AButton>
          </div>
          <div class="todo-navigation-list-items">
            <AButton
              v-for="list in lists"
              :key="list.id"
              type="text"
              block
              :class="{ active: section === 'tasks' && listId === list.id }"
              :aria-current="section === 'tasks' && listId === list.id ? 'page' : undefined"
              @click="emit('list', list.id)"
              ><span
                class="todo-list-dot"
                :style="{ background: list.color || 'var(--todo-accent)' }"
              ></span
              ><span class="todo-nav-list-name">{{ list.name }}</span></AButton
            >
            <AButton
              v-if="!lists.length"
              type="text"
              block
              class="todo-nav-empty"
              @click="emit('new-list')"
              ><ToDooIcon name="plus" :size="15" />创建第一张清单</AButton
            >
            <AButton
              v-if="hasMoreLists || listError"
              type="text"
              block
              :loading="listLoading"
              @click="emit('load-lists')"
              >{{ listError ? '重试载入清单' : '更多清单' }}</AButton
            >
          </div>
        </section>
      </template>
      <AButton
        v-if="!hostedNavigation"
        type="text"
        block
        class="todo-navigation-settings"
        :class="{ active: section === 'settings' }"
        :aria-current="section === 'settings' ? 'page' : undefined"
        @click="emit('navigate', 'settings')"
        ><ToDooIcon name="settings" :size="16" />设置</AButton
      >
    </nav>
    <div v-if="!hostedNavigation" class="todo-sidebar-footer">
      <AButton type="text" size="small" @click="emit('back')">‹ 返回应用</AButton>
    </div>
  </div>
</template>
