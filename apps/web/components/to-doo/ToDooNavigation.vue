<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { Button as AButton, Checkbox as ACheckbox, Popover as APopover } from 'ant-design-vue';
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
  layout?: 'combined' | 'split';
  directoryCollapsed?: boolean;
}>();
const emit = defineEmits<{
  navigate: [section: ToDooAppSection];
  quick: [view: ToDooQuickFilter];
  list: [id: string];
  'new-list': [];
  'load-lists': [];
  back: [];
  'toggle-directory': [event: MouseEvent];
}>();
const taskSection = computed(() =>
  ['tasks', 'board', 'matrix', 'timeline'].includes(props.section),
);
const availableTools = ['calendar', 'habits', 'focus', 'overview', 'stats', 'anniversaries'] as const;
const taskScopeOptions = [
  { id: 'overdue', name: '逾期', icon: 'calendar' },
  { id: 'unscheduled', name: '未安排', icon: 'inbox' },
  { id: 'blocked', name: '受阻', icon: 'tasks' },
] as const;
const availablePins = new Set<string>([...availableTools, ...taskScopeOptions.map((scope) => scope.id)]);
const defaultPins = ['calendar', 'habits', 'focus'];
const pinKey = 'to-doo.navigation-pins.v1';
function readPins(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(pinKey) || 'null');
    if (Array.isArray(saved)) {
      const valid = [...new Set(saved.filter((id): id is string => typeof id === 'string' && availablePins.has(id)))];
      // An empty selection is intentional; malformed or obsolete-only data keeps the defaults.
      if (!saved.length || valid.length) return valid;
    }
  } catch { /* Browser storage may be unavailable; navigation remains usable. */ }
  return [...defaultPins];
}
const pins = ref(readPins());
const pinOpen = ref(false), pinTrigger = ref<any>();
const moduleMoreOpen = ref(false), scopeMoreOpen = ref(false);
const split = computed(() => props.layout === 'split');
watch(() => [props.section, props.quickView, props.listId], () => {
  moduleMoreOpen.value = false;
  scopeMoreOpen.value = false;
  pinOpen.value = false;
});
watch(moduleMoreOpen, open => { if (!open && split.value) pinOpen.value = false; });
function chooseModule(section: ToDooAppSection) {
  moduleMoreOpen.value = false;
  emit('navigate', section);
}
function chooseScope(view: ToDooQuickFilter) {
  scopeMoreOpen.value = false;
  emit('quick', view);
}
function closePins() {
  pinOpen.value = false;
  nextTick(() => pinTrigger.value?.$el?.focus?.());
}
const pinOptions = computed(() => availableTools.flatMap((section) => props.items.filter(([id]) => id === section)));
function togglePin(id: string) {
  pins.value = pins.value.includes(id) ? pins.value.filter((pin) => pin !== id) : [...pins.value, id];
  try {
    localStorage.setItem(pinKey, JSON.stringify(pins.value));
    window.dispatchEvent?.(new Event('to-doo-navigation-pins'));
  } catch { /* Keep the current session preference even when persistence is denied. */ }
}
function syncPins() { pins.value = readPins(); }
onMounted(() => {
  window.addEventListener('storage', syncPins);
  window.addEventListener('to-doo-navigation-pins', syncPins);
});
onBeforeUnmount(() => {
  window.removeEventListener('storage', syncPins);
  window.removeEventListener('to-doo-navigation-pins', syncPins);
});
const tools = computed(() =>
  availableTools.filter((section) => pins.value.includes(section)).flatMap((section) =>
    props.items.filter(([id]) => id === section),
  ),
);
const more = computed(() =>
  availableTools.filter((section) => !pins.value.includes(section)).flatMap((section) =>
    props.items.filter(([id]) => id === section),
  ),
);
const pinnedTaskScopes = computed(() => taskScopeOptions.filter((scope) => pins.value.includes(scope.id)));
const moreTaskScopes = computed(() => taskScopeOptions.filter((scope) => !pins.value.includes(scope.id)));
const moreActive = computed(
  () =>
    more.value.some(([section]) => section === props.section) ||
    (taskSection.value && !props.listId &&
      (moreTaskScopes.value.some((scope) => scope.id === props.quickView) ||
        ['archived', 'trash'].includes(props.quickView))),
);
</script>

<template>
  <div class="todo-navigation-content" :class="{ 'todo-navigation-split': split }">
    <nav v-if="split" class="todo-module-rail" aria-label="To Doo 主菜单">
      <div class="todo-module-primary">
        <AButton type="text" aria-label="任务" title="任务"
          :class="{ active: taskSection }" :aria-current="taskSection ? 'page' : undefined"
          @click="chooseModule('tasks')"><ToDooIcon name="tasks" :size="20" /></AButton>
        <AButton v-if="taskSection && directoryCollapsed" type="text" class="todo-directory-toggle"
          aria-label="展开清单导航" title="展开清单导航" :aria-expanded="false"
          @click="emit('toggle-directory', $event)"><ToDooIcon name="menu" :size="18" /></AButton>
        <AButton v-for="item in tools" :key="item[0]" type="text"
          :aria-label="item[1]" :title="item[1]" :class="{ active: section === item[0] }"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="chooseModule(item[0])"><ToDooIcon :name="item[0]" :size="20" /></AButton>
        <APopover v-model:open="moduleMoreOpen" trigger="click" placement="rightTop" overlay-class-name="todo-ant-popup">
          <AButton type="text" aria-label="更多模块" title="更多模块" :aria-expanded="moduleMoreOpen"
            :class="{ active: more.some(([id]) => id === section) }"><ToDooIcon name="more" :size="20" /></AButton>
          <template #content>
            <div class="todo-module-more-options" role="group" aria-label="更多模块">
              <AButton v-for="item in more" :key="item[0]" type="text" :aria-label="item[1]"
                :class="{ active: section === item[0] }" :aria-current="section === item[0] ? 'page' : undefined"
                @click="chooseModule(item[0])"><ToDooIcon :name="item[0]" :size="18" />{{ item[1] }}</AButton>
              <AButton ref="pinTrigger" type="text" aria-label="自定义常用入口" :aria-expanded="pinOpen"
                @click="pinOpen = !pinOpen" @keydown.esc.stop.prevent="closePins">自定义常用入口</AButton>
              <div v-if="pinOpen" class="todo-navigation-pin-options" @keydown.esc.stop.prevent="closePins">
                <span class="todo-nav-label">固定到主菜单</span>
                <ACheckbox v-for="item in pinOptions" :key="item[0]" :checked="pins.includes(item[0])" @change="togglePin(item[0])">{{ item[1] }}</ACheckbox>
                <span class="todo-nav-label">固定到任务导航</span>
                <ACheckbox v-for="scope in taskScopeOptions" :key="scope.id" :checked="pins.includes(scope.id)" @change="togglePin(scope.id)">{{ scope.name }}</ACheckbox>
                <AButton type="text" @click="closePins">完成</AButton>
              </div>
            </div>
          </template>
        </APopover>
      </div>
      <div class="todo-module-utilities">
        <AButton type="text" aria-label="通知" title="通知" :class="{ active: section === 'notifications' }"
          :aria-current="section === 'notifications' ? 'page' : undefined" @click="chooseModule('notifications')">
          <ToDooIcon name="notifications" :size="20" /><span v-if="unread" class="todo-module-unread" :aria-label="`${unread} 条未读`">{{ unread > 99 ? '99+' : unread }}</span>
        </AButton>
        <AButton type="text" aria-label="设置" title="设置" :class="{ active: section === 'settings' }"
          :aria-current="section === 'settings' ? 'page' : undefined" @click="chooseModule('settings')"><ToDooIcon name="settings" :size="20" /></AButton>
      </div>
    </nav>
    <nav v-if="!split || taskSection" :class="{ 'todo-task-directory': split }" :aria-label="split ? 'To Doo 任务导航' : 'To Doo 导航'">
      <div v-if="split" class="todo-directory-heading">
        <span>任务</span>
        <AButton type="text" class="todo-directory-toggle" aria-label="折叠清单导航" title="折叠清单导航" :aria-expanded="true"
          @click="emit('toggle-directory', $event)"><ToDooIcon name="menu" :size="18" /></AButton>
      </div>
      <section class="todo-navigation-group" aria-label="我的待办">
        <AButton
          v-for="view in toDooQuickViews"
          :key="view.id"
          type="text"
          block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-label="view.name"
          :title="view.name"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"
          ><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton
        >
      </section>
      <section v-if="split && pinnedTaskScopes.length" class="todo-navigation-group todo-pinned-task-scopes" aria-label="固定任务范围">
        <AButton v-for="view in pinnedTaskScopes" :key="view.id" type="text" block
          :class="{ active: !listId && quickView === view.id }" :aria-label="view.name" :title="view.name"
          :aria-current="!listId && quickView === view.id ? 'page' : undefined" @click="chooseScope(view.id)">
          <ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span>
        </AButton>
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
            :aria-label="list.name"
            :title="list.name"
            :aria-current="taskSection && listId === list.id ? 'page' : undefined"
            @click="emit('list', list.id)"
            ><span
              class="todo-list-dot"
              :style="{ background: list.color || 'var(--todo-accent)' }"
            ></span
            ><span class="todo-nav-list-name">{{ list.name }}</span></AButton
          >
          <AButton
            v-if="!split && !lists.length"
            type="text"
            block
            class="todo-nav-empty"
            @click="emit('new-list')"
            ><ToDooIcon name="plus" :size="16" />新建清单</AButton
          >
          <p v-if="split && !lists.length && !listLoading && !listError" class="todo-directory-empty">暂无清单</p>
          <p v-if="split && !lists.length && listLoading" class="todo-directory-empty" role="status">正在载入清单…</p>
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
      <section v-if="!split" class="todo-navigation-group" aria-label="计划与执行">
        <div class="todo-nav-section-heading"><span class="todo-nav-label">常用入口</span>
          <APopover v-model:open="pinOpen" trigger="click" title="固定常用入口" placement="rightTop" overlay-class-name="todo-ant-popup">
            <AButton ref="pinTrigger" type="text" @keydown.esc.stop.prevent="closePins" size="small" aria-label="自定义常用入口" title="自定义常用入口" :aria-expanded="pinOpen">⋯</AButton>
            <template #content><div class="todo-navigation-pin-options" @keydown.esc.stop.prevent="closePins">
              <span class="todo-nav-label">模块</span>
              <ACheckbox v-for="item in pinOptions" :key="item[0]" :checked="pins.includes(item[0])" @change="togglePin(item[0])">{{ item[1] }}</ACheckbox>
              <span class="todo-nav-label">任务范围</span>
              <ACheckbox v-for="scope in taskScopeOptions" :key="scope.id" :checked="pins.includes(scope.id)" @change="togglePin(scope.id)">{{ scope.name }}</ACheckbox>
              <AButton type="text" @click="closePins">完成</AButton>
            </div></template>
          </APopover>
        </div>
        <AButton
          v-for="item in tools"
          :key="item[0]"
          type="text"
          block
          :class="{ active: section === item[0] }"
          :aria-label="item[1]"
          :title="item[1]"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="emit('navigate', item[0])"
          ><ToDooIcon :name="item[0]" :size="18" /><span>{{ item[1] }}</span></AButton
        >
        <AButton v-for="view in pinnedTaskScopes" :key="view.id" type="text" block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-label="view.name" :title="view.name"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton>
      </section>
      <details v-if="!split" class="todo-navigation-more" :open="moreActive || undefined">
        <summary>更多</summary>
        <div class="todo-nav-label">模块</div>
        <AButton
          v-for="item in more"
          :key="item[0]"
          type="text"
          block
          :class="{ active: section === item[0] }"
          :aria-label="item[1]"
          :title="item[1]"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="emit('navigate', item[0])"
          ><ToDooIcon :name="item[0]" :size="18" /><span>{{ item[1] }}</span></AButton
        >
        <div v-if="moreTaskScopes.length" class="todo-nav-label">任务范围</div>
        <AButton
          v-for="view in moreTaskScopes"
          :key="view.id"
          type="text"
          block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-label="view.name"
          :title="view.name"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"
          ><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton
        >
        <div class="todo-nav-label">历史管理</div>
        <AButton v-for="view in [{ id: 'archived' as const, name: '已归档', icon: 'archive' }, { id: 'trash' as const, name: '回收站', icon: 'trash' }]"
          :key="view.id" type="text" block :class="{ active: taskSection && !listId && quickView === view.id }"
          :aria-label="view.name" :title="view.name" :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"><ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span></AButton>
      </details>
      <div v-if="split" class="todo-task-directory-footer">
        <APopover v-model:open="scopeMoreOpen" trigger="click" placement="rightBottom" overlay-class-name="todo-ant-popup">
          <AButton type="text" block aria-label="更多任务范围" :aria-expanded="scopeMoreOpen"
            :class="{ active: !listId && (moreTaskScopes.some(scope => scope.id === quickView) || ['archived', 'trash'].includes(quickView)) }">
            <ToDooIcon name="more" :size="18" /><span>更多任务范围</span>
          </AButton>
          <template #content><div class="todo-module-more-options" role="group" aria-label="更多任务范围">
            <AButton v-for="view in moreTaskScopes" :key="view.id" type="text" :aria-label="view.name"
              :aria-current="!listId && quickView === view.id ? 'page' : undefined" @click="chooseScope(view.id)"><ToDooIcon :name="view.icon" :size="18" />{{ view.name }}</AButton>
            <AButton v-for="view in [{ id: 'archived' as const, name: '已归档', icon: 'archive' }, { id: 'trash' as const, name: '回收站', icon: 'trash' }]"
              :key="view.id" type="text" :aria-label="view.name" :aria-current="!listId && quickView === view.id ? 'page' : undefined"
              @click="chooseScope(view.id)"><ToDooIcon :name="view.icon" :size="18" />{{ view.name }}</AButton>
          </div></template>
        </APopover>
      </div>
      <section v-if="!split" class="todo-navigation-group todo-navigation-utilities" aria-label="管理">
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
