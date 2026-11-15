<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useSessionStorage } from '@vueuse/core';
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
const moduleMoreTrigger = ref<any>(), scopeMoreTrigger = ref<any>();
const split = computed(() => props.layout === 'split');
const listsExpanded = useSessionStorage('to-doo.navigation-lists-expanded.v1', true, { writeDefaults: false });
const listItemsId = 'todo-directory-lists-' + useId();
const unreadId = 'todo-navigation-unread-' + useId();

// A single label serves both rail sections. Render it outside the independently scrolling rail.
const railHint = ref<{ label: string; left: number; top: number }>();
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function cancelHintTimer() { clearTimeout(hintTimer); }
function hideRailHint() {
  cancelHintTimer();
  railHint.value = undefined;
}
function leaveRailHint() {
  cancelHintTimer();
  hintTimer = setTimeout(hideRailHint, 120);
}
function showRailHint(event: PointerEvent | FocusEvent) {
  const button = (event.target as Element).closest<HTMLButtonElement>('button[aria-label]');
  if (!button) { leaveRailHint(); return; }
  if (moduleMoreOpen.value) return;
  const pointer = 'pointerType' in event;
  if (pointer && (event.pointerType === 'touch' || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)))) return;
  if (!pointer && !button.matches(':focus-visible')) return;
  const label = button.getAttribute('aria-label')!;
  cancelHintTimer();
  if (railHint.value?.label === label) return;
  const show = () => {
    const bounds = button.getBoundingClientRect();
    if (bounds.height) railHint.value = { label, left: bounds.right, top: bounds.top + bounds.height / 2 };
  };
  if (pointer && !railHint.value) hintTimer = setTimeout(show, 260);
  else show();
}
function dismissRailHint(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !railHint.value) return;
  hideRailHint();
  event.stopPropagation();
}
function closeTransientMenus() {
  hideRailHint();
  moduleMoreOpen.value = false;
  scopeMoreOpen.value = false;
  pinOpen.value = false;
}
function resizeNavigation() {
  hideRailHint();
  // Ant realigns an open popover on resize. Keep its focused controls usable
  // while its trigger is visible, including when the viewport height changes.
  if (moduleMoreOpen.value && !moduleMoreTrigger.value?.$el?.getClientRects().length)
    moduleMoreOpen.value = false;
  if (scopeMoreOpen.value && !scopeMoreTrigger.value?.$el?.getClientRects().length)
    scopeMoreOpen.value = false;
  if (pinOpen.value && !pinTrigger.value?.$el?.getClientRects().length)
    pinOpen.value = false;
  const focused = document.activeElement;
  if (split.value && focused instanceof HTMLElement && focused.matches('.todo-navigation-split :focus-visible')) {
    const scrollArea = focused.closest<HTMLElement>('.todo-module-primary, .todo-task-scope-items, .todo-navigation-list-items');
    if (!scrollArea || !scrollArea.clientHeight) return;
    const item = focused.getBoundingClientRect(), area = scrollArea.getBoundingClientRect();
    if (item.bottom > area.bottom) scrollArea.scrollTop += item.bottom - area.bottom;
    else if (item.top < area.top) scrollArea.scrollTop += item.top - area.top;
  }
}
watch(() => [props.section, props.quickView, props.listId, props.layout], closeTransientMenus);
watch(() => props.directoryCollapsed, () => { scopeMoreOpen.value = false; });
watch(moduleMoreOpen, open => { if (!open && split.value) pinOpen.value = false; });
function closeModuleMore() {
  closeTransientMenus();
  nextTick(() => moduleMoreTrigger.value?.$el?.focus?.());
}
function closeScopeMore() {
  scopeMoreOpen.value = false;
  nextTick(() => scopeMoreTrigger.value?.$el?.focus?.());
}
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
  window.addEventListener('keydown', dismissRailHint, true);
  window.addEventListener('storage', syncPins);
  window.addEventListener('to-doo-navigation-pins', syncPins);
  window.addEventListener('resize', resizeNavigation);
});
onBeforeUnmount(() => {
  hideRailHint();
  window.removeEventListener('keydown', dismissRailHint, true);
  window.removeEventListener('storage', syncPins);
  window.removeEventListener('to-doo-navigation-pins', syncPins);
  window.removeEventListener('resize', resizeNavigation);
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
    <nav v-if="split" class="todo-module-rail" aria-label="To Doo 主菜单"
      @focusin="showRailHint" @focusout="hideRailHint" @pointerover="showRailHint" @pointerleave="leaveRailHint"
      @scroll.capture="hideRailHint" @click.capture="hideRailHint">
      <div class="todo-module-primary">
        <AButton type="text" aria-label="任务"
          :class="{ active: taskSection }" :aria-current="taskSection ? 'page' : undefined"
          @click="!taskSection && chooseModule('tasks')"><ToDooIcon name="taskModule" :size="22" /></AButton>
        <AButton v-if="taskSection && directoryCollapsed" type="text" class="todo-directory-toggle"
          aria-label="展开清单导航" :aria-expanded="false"
          @click="emit('toggle-directory', $event)"><ToDooIcon name="sidebar" :size="20" /></AButton>
        <AButton v-for="item in tools" :key="item[0]" type="text"
          :aria-label="item[1]" :class="{ active: section === item[0] }"
          :aria-current="section === item[0] ? 'page' : undefined"
          @click="chooseModule(item[0])"><ToDooIcon :name="item[0]" :size="22" /></AButton>
        <APopover v-model:open="moduleMoreOpen" trigger="click" placement="rightTop" overlay-class-name="todo-ant-popup">
          <AButton ref="moduleMoreTrigger" type="text" aria-label="更多模块" :aria-expanded="moduleMoreOpen"
            @keydown.esc.stop.prevent="closeModuleMore"
            :class="{ active: more.some(([id]) => id === section) }"><ToDooIcon name="more" :size="20" /></AButton>
          <template #content>
            <div class="todo-module-more-options" role="group" aria-label="更多模块" @keydown.esc.stop.prevent="closeModuleMore">
              <AButton v-for="item in more" :key="item[0]" type="text" :aria-label="item[1]"
                :class="{ active: section === item[0] }" :aria-current="section === item[0] ? 'page' : undefined"
                @click="chooseModule(item[0])"><ToDooIcon :name="item[0]" :size="18" />{{ item[1] }}</AButton>
              <AButton ref="pinTrigger" type="text" class="todo-module-customize" aria-label="自定义常用入口" :aria-expanded="pinOpen"
                @click="pinOpen = !pinOpen" @keydown.esc.stop.prevent="closePins"><ToDooIcon name="filter" :size="18" />自定义常用入口</AButton>
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
        <AButton type="text" aria-label="通知" :class="{ active: section === 'notifications' }" :aria-describedby="unread ? unreadId : undefined"
          :aria-current="section === 'notifications' ? 'page' : undefined" @click="chooseModule('notifications')">
          <ToDooIcon name="notifications" :size="21" /><span v-if="unread" :id="unreadId" class="todo-module-unread" :aria-label="`${unread} 条未读`">{{ unread > 99 ? '99+' : unread }}</span>
        </AButton>
        <AButton type="text" aria-label="设置" :class="{ active: section === 'settings' }"
          :aria-current="section === 'settings' ? 'page' : undefined" @click="chooseModule('settings')"><ToDooIcon name="settings" :size="21" /></AButton>
      </div>
    </nav>
    <Teleport v-if="railHint" to="body">
      <span role="tooltip" class="todo-module-hint" :style="{ left: railHint.left + 'px', top: railHint.top + 'px' }"
        @pointerenter="cancelHintTimer" @pointerleave="leaveRailHint">{{ railHint.label }}</span>
    </Teleport>
    <nav v-if="!split || taskSection" :class="{ 'todo-task-directory': split, 'todo-list-group-folded': !listsExpanded }" :aria-label="split ? 'To Doo 任务导航' : 'To Doo 导航'">
      <div v-if="split" class="todo-directory-heading">
        <span>任务</span>
        <AButton type="text" class="todo-directory-toggle" aria-label="折叠清单导航" title="折叠清单导航" :aria-expanded="true"
          @click="emit('toggle-directory', $event)"><ToDooIcon name="sidebar" :size="18" /></AButton>
      </div>
      <div :class="{ 'todo-task-scope-items': split }">
      <section class="todo-navigation-group" aria-label="我的待办">
        <AButton
          v-for="view in toDooQuickViews"
          :key="view.id"
          type="text"
          block
          :class="{ active: taskSection && !listId && quickView === view.id }"
          :data-scope="view.id"
          :aria-label="view.name"
          :title="view.name"
          :aria-current="taskSection && !listId && quickView === view.id ? 'page' : undefined"
          @click="emit('quick', view.id)"
          ><ToDooIcon :name="view.id === 'done' ? 'completed' : view.icon" :size="18" /><span>{{ view.name }}</span></AButton
        >
      </section>
      <section v-if="split && pinnedTaskScopes.length" class="todo-navigation-group todo-pinned-task-scopes" aria-label="固定任务范围">
        <AButton v-for="view in pinnedTaskScopes" :key="view.id" type="text" block
          :class="{ active: !listId && quickView === view.id }" :aria-label="view.name" :title="view.name"
          :aria-current="!listId && quickView === view.id ? 'page' : undefined" @click="chooseScope(view.id)">
          <ToDooIcon :name="view.icon" :size="18" /><span>{{ view.name }}</span>
        </AButton>
      </section>
      </div>
      <section class="todo-navigation-group todo-navigation-lists" aria-label="我的清单">
        <div class="todo-nav-section-heading">
          <AButton type="text" class="todo-list-disclosure" aria-label="我的清单" :aria-expanded="listsExpanded"
            :aria-controls="listItemsId" @click="listsExpanded = !listsExpanded">
            <ToDooIcon name="chevron" :size="14" /><span class="todo-nav-label">我的清单</span>
          </AButton>
          <AButton type="text" size="small" aria-label="新建清单" title="新建清单" @click="emit('new-list')"
            ><ToDooIcon name="plus" :size="16"
          /></AButton>
        </div>
        <div :id="listItemsId" class="todo-navigation-list-items" :hidden="!listsExpanded">
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
            ><ToDooIcon name="list" :size="18" class="todo-nav-list-icon"
              :style="{ '--todo-list-color': list.color || 'var(--todo-muted)' }" />
            <span class="todo-nav-list-name">{{ list.name }}</span></AButton
          >
          <AButton
            v-if="!split && !lists.length"
            type="text"
            block
            class="todo-nav-empty"
            @click="emit('new-list')"
            ><ToDooIcon name="plus" :size="16" />新建清单</AButton
          >
          <p v-if="split && !lists.length && !listLoading && !listError" class="todo-directory-empty">
            <ToDooIcon name="list" :size="18" />暂无清单
          </p>
          <p v-if="split && !lists.length && listLoading" class="todo-directory-empty" role="status">
            <ToDooIcon name="more" :size="18" />正在载入清单…
          </p>
          <AButton
            v-if="hasMoreLists || listError"
            class="todo-nav-load-lists"
            type="text"
            block
            :loading="listLoading"
            @click="emit('load-lists')"
            ><ToDooIcon v-if="!listLoading" :name="listError ? 'refresh' : 'more'" :size="18" />{{ listError ? '重试载入清单' : '更多清单' }}</AButton
          >
        </div>
      </section>
      <section v-if="!split" class="todo-navigation-group" aria-label="计划与执行">
        <div class="todo-nav-section-heading"><span class="todo-nav-label">常用入口</span>
          <APopover v-model:open="pinOpen" trigger="click" title="固定常用入口" placement="rightTop" overlay-class-name="todo-ant-popup">
            <AButton ref="pinTrigger" type="text" @keydown.esc.stop.prevent="closePins" size="small" aria-label="自定义常用入口" title="自定义常用入口" :aria-expanded="pinOpen"><ToDooIcon name="more" :size="18" /></AButton>
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
          <AButton ref="scopeMoreTrigger" type="text" block aria-label="更多任务范围" :aria-expanded="scopeMoreOpen"
            @keydown.esc.stop.prevent="closeScopeMore"
            :class="{ active: !listId && (moreTaskScopes.some(scope => scope.id === quickView) || ['archived', 'trash'].includes(quickView)) }">
            <ToDooIcon name="more" :size="18" /><span>更多任务范围</span>
          </AButton>
          <template #content><div class="todo-module-more-options" role="group" aria-label="更多任务范围" @keydown.esc.stop.prevent="closeScopeMore">
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
