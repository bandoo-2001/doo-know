<script setup lang="ts">
import { computed } from 'vue';
import { Button as AButton } from 'ant-design-vue';
import type { ToDooAppSection } from '../../navigation';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { toDooQuickViews, type ToDooQuickFilter } from '../../to-doo-presentation';
import ToDooIcon from './ToDooIcon.vue';

const props = defineProps<{
  section: ToDooAppSection;
  quickView: ToDooQuickFilter;
  listId?: string;
  lists: ToDooEntityMap['list'][];
  items: [ToDooAppSection, string, string][];
  listLoading: boolean;
  listError: boolean;
  hasMoreLists: boolean;
  unread?: number;
  hostedNavigation?: boolean;
  date?: string;
  today?: string;
  calendarView?: 'week' | 'month';
}>();
const emit = defineEmits<{
  navigate: [section: ToDooAppSection];
  quick: [view: ToDooQuickFilter];
  list: [id: string];
  'new-list': [];
  'load-lists': [];
  back: [];
}>();
const taskSection = computed(() =>
  ['tasks', 'board', 'matrix', 'timeline'].includes(props.section),
);
const tools = computed(() =>
  ['calendar', 'habits', 'focus'].flatMap((section) =>
    props.items.filter(([id]) => id === section),
  ),
);
const more = computed(() =>
  ['overview', 'stats', 'anniversaries'].flatMap((section) =>
    props.items.filter(([id]) => id === section),
  ),
);
const moreActive = computed(
  () =>
    more.value.some(([section]) => section === props.section) ||
    ['overdue', 'unscheduled', 'blocked', 'archived', 'trash'].includes(props.quickView),
);
</script>

<template>
  <div class="todo-navigation-content">
    <nav aria-label="To Doo 导航">
      <section class="todo-navigation-group" aria-label="我的待办">
        <AButton
          v-for="view in toDooQuickViews"
          :key="view.id"
          type="text"
          block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"
          ><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton
        >
      </section>
      <section class="todo-navigation-group todo-navigation-lists" aria-label="我的清单">
        <div class="todo-nav-section-heading">
          <span class="todo-nav-label">我的清单</span>
          <AButton type="text" size="small" aria-label="新建清单" @click="emit('new-list')"
            ><ToDooIcon name="plus" :size="16"
          /></AButton>
        </div>
        <div class="todo-navigation-list-items">
          <AButton
            v-for="list in lists"
            :key="list.id"
            type="text"
            block
            :class="{ active: taskSection && listId === list.id }"
            :aria-current="taskSection && listId === list.id ? 'page' : undefined"
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
            ><ToDooIcon name="plus" :size="16" />新建清单</AButton
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
      <section class="todo-navigation-group" aria-label="计划与执行">
        <div class="todo-nav-label">计划与执行</div>
        <AButton
          v-for="item in tools"
          :key="item[0]"
          type="text"
          block
          :class="{ active: section === item[0] }"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="emit('navigate', item[0])"
          ><ToDooIcon :name="item[0]" :size="18" /><span>{{ item[1] }}</span></AButton
        >
      </section>
      <details class="todo-navigation-more" :open="moreActive || undefined">
        <summary>更多工具</summary>
        <AButton
          v-for="item in more"
          :key="item[0]"
          type="text"
          block
          :class="{ active: section === item[0] }"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="emit('navigate', item[0])"
          ><ToDooIcon :name="item[0]" :size="18" /><span>{{ item[1] }}</span></AButton
        >
        <AButton
          v-for="view in [
            { id: 'overdue' as const, name: '逾期', icon: 'calendar' },
            { id: 'unscheduled' as const, name: '未安排', icon: 'inbox' },
            { id: 'blocked' as const, name: '受阻', icon: 'tasks' },
            { id: 'archived' as const, name: '已归档', icon: 'archive' },
            { id: 'trash' as const, name: '回收站', icon: 'trash' },
          ]"
          :key="view.id"
          type="text"
          block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"
          ><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton
        >
      </details>
      <section class="todo-navigation-group todo-navigation-utilities" aria-label="管理">
        <AButton
          type="text"
          block
          aria-label="通知"
          :class="{ active: section === 'notifications' }"
          :aria-current="section === 'notifications' ? 'page' : undefined"
          @click="emit('navigate', 'notifications')"
          ><ToDooIcon name="notifications" :size="18" /><span>通知</span
          ><small v-if="unread">{{ unread }}</small></AButton
        >
        <AButton
          type="text"
          block
          :class="{ active: section === 'settings' }"
          :aria-current="section === 'settings' ? 'page' : undefined"
          @click="emit('navigate', 'settings')"
          ><ToDooIcon name="settings" :size="18" /><span>设置</span></AButton
        >
      </section>
    </nav>
  </div>
</template>
