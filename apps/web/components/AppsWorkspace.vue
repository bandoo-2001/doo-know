<script setup lang="ts">
import { computed, watch, ref, defineAsyncComponent } from 'vue';
import Icon from './Icon.vue';
import BlogWorkspace from './BlogWorkspace.vue';
import type { TreeEntry } from '../../../shared/contracts';
import type { BlogSection, BlogWorkbench } from '../blog-workbench';
import type { ToDooAppSection, WorkspaceRoute } from '../navigation';
import '../blog.css';
import { workspaceApps, type WorkspaceAppId } from '../app-shortcuts';
import { useWorkspaceMainMenu, type WorkspaceMainMenuDefinition } from '../workspace-main-menu';
const ToDooWorkspace = defineAsyncComponent(() => import('./ToDooWorkspace.vue'));
const GraphWorkspace = defineAsyncComponent(() => import('./GraphWorkspace.vue'));
type Selection = Pick<WorkspaceRoute, 'task' | 'list' | 'date' | 'calendarView' | 'taskFilter'>;
const toDooRef = ref<{
  hasUnsavedChanges(): boolean;
  requestLeave(): Promise<boolean>;
  requestSectionLeave?(section: ToDooAppSection): Promise<boolean>;
}>();
const graphRef = ref<InstanceType<typeof GraphWorkspace>>();
const currentApp = computed(() => props.app === 'to-doo' ? toDooRef.value : props.app === 'graph' ? graphRef.value : undefined);
const props = defineProps<{
  app?: 'blog' | 'to-doo' | 'graph';
  section: BlogSection | ToDooAppSection;
  selection?: Selection;
  tree: TreeEntry[];
  model: BlogWorkbench;
  pinnedApps: readonly WorkspaceAppId[];
}>();
const emit = defineEmits<{
  navigate: [
    app: 'blog' | 'to-doo' | 'graph' | undefined,
    section?: BlogSection | ToDooAppSection,
    selection?: Selection,
  ];
  'open-note': [id: string, line?: number];
  'note-created': [id: string];
  'toggle-pin': [app: WorkspaceAppId];
  'menu-select': [];
}>();
defineExpose({
  hasUnsavedChanges: () => !!currentApp.value?.hasUnsavedChanges(),
  requestLeave: async () => !currentApp.value || (await currentApp.value.requestLeave()),
  requestSectionLeave: async (section: ToDooAppSection) =>
    props.app !== 'to-doo' ||
    !toDooRef.value?.requestSectionLeave ||
    (await toDooRef.value.requestSectionLeave(section)),
});
const hostedNavigation = useWorkspaceMainMenu(
  computed<WorkspaceMainMenuDefinition | undefined>(() => {
    if (!props.app || props.app === 'graph') return undefined;
    if (props.app === 'to-doo') {
      const activeId = ['tasks', 'board', 'overview'].includes(props.section)
        ? 'tasks'
        : props.section === 'timeline'
          ? 'calendar'
          : props.section;
      return {
        id: 'to-doo',
        label: 'To Doo',
        icon: 'task',
        activeId,
        items: [
          { id: 'tasks', label: '任务', icon: 'task' },
          { id: 'calendar', label: '日历', icon: 'calendar' },
          { id: 'matrix', label: '四象限', icon: 'matrix' },
          { id: 'focus', label: '专注', icon: 'focus' },
          { id: 'habits', label: '习惯', icon: 'habits' },
          { id: 'anniversaries', label: '纪念日', icon: 'anniversaries' },
          { id: 'stats', label: '复盘', title: '统计与复盘', icon: 'stats' },
        ],
        utilities: [
          { id: 'notifications', label: '通知', title: '通知中心', icon: 'notifications' },
          { id: 'settings', label: '设置', title: 'To Doo 设置', icon: 'settings' },
        ],
        onSelect(id) {
          const selection: Selection = ['tasks', 'board', 'matrix', 'overview'].includes(id)
            ? { list: props.selection?.list, taskFilter: props.selection?.taskFilter }
            : ['calendar', 'timeline'].includes(id)
              ? { date: props.selection?.date, calendarView: props.selection?.calendarView }
              : {};
          emit('navigate', 'to-doo', id as ToDooAppSection, selection);
        },
      };
    }
    return {
      id: 'blog',
      label: '博客',
      icon: 'book',
      activeId: props.section,
      items: [
        { id: 'overview', label: '概览', icon: 'apps' },
        { id: 'articles', label: '文章', icon: 'file' },
        { id: 'design', label: '装修主页', icon: 'monitor' },
        { id: 'taxonomy', label: '分类与标签', icon: 'list' },
      ],
      utilities: [{ id: 'settings', label: '站点设置', icon: 'settings' }],
      onSelect: (id) => emit('navigate', 'blog', id as BlogSection),
    };
  }),
);
watch(
  () => props.app,
  (app) => {
    if (app === 'blog') void props.model.load();
  },
  { immediate: true },
);
</script>
<template>
  <BlogWorkspace
    v-if="app === 'blog'"
    :section="section as BlogSection"
    :tree="tree"
    :model="model"
    :hosted-navigation="hostedNavigation"
    @section="emit('navigate', 'blog', $event)"
    @back="emit('navigate', undefined)"
    @open-note="emit('open-note', $event)"
  />
  <ToDooWorkspace
    v-else-if="app === 'to-doo'"
    ref="toDooRef"
    :section="section as ToDooAppSection"
    :selection="selection"
    :hosted-navigation="hostedNavigation"
    :tree="tree"
    @navigate="(next, value) => emit('navigate', 'to-doo', next, value)"
    @open-note="emit('open-note', $event)"
    @back="emit('navigate', undefined)"
    @note-created="emit('note-created', $event)"
  />
  <GraphWorkspace
    v-else-if="app === 'graph'"
    ref="graphRef"
    :tree="tree"
    @menu-select="emit('menu-select')"
    @back="emit('navigate', undefined)"
    @open-note="(id, line) => emit('open-note', id, line)"
  />
  <section v-else class="apps-home" aria-labelledby="apps-title">
    <div class="apps-eyebrow">YOUR WORKSPACE, EXTENDED</div>
    <h1 id="apps-title">应用</h1>
    <p class="apps-description">让知识走得更远。为你的笔记，打开新的可能。</p>
    <div class="apps-grid">
      <div v-for="item in workspaceApps" :key="item.id" class="app-entry">
        <button
          class="app-card"
          type="button"
          @click="emit('navigate', item.id, item.id === 'to-doo' ? 'tasks' : 'overview')"
        >
          <div class="app-card-top">
            <span class="blog-app-icon"><Icon :name="item.icon" :size="28" /></span
            ><span class="app-native">原生应用</span>
          </div>
          <h2>{{ item.name }}</h2>
          <p>{{ item.description }}</p>
          <div class="app-card-preview" aria-hidden="true">
            <span class="app-preview-dot"></span><span></span><span></span>
            <div></div>
            <i></i><i></i><i></i>
          </div>
          <div class="app-card-bottom">
            <span>{{ item.summary }}</span
            ><Icon name="forward" :size="18" />
          </div>
        </button>
        <button
          class="app-pin-button"
          type="button"
          :aria-label="
            pinnedApps.includes(item.id)
              ? `将${item.name}从左侧菜单移除`
              : `将${item.name}加入左侧菜单`
          "
          :aria-pressed="pinnedApps.includes(item.id)"
          @click="emit('toggle-pin', item.id)"
        >
          <Icon :name="pinnedApps.includes(item.id) ? 'check' : 'plus'" :size="15" />
          {{ pinnedApps.includes(item.id) ? '从左侧菜单移除' : '加入左侧菜单' }}
        </button>
      </div>
    </div>
    <p class="apps-footnote">
      <Icon name="lock" :size="14" /> 资料与应用数据由你掌握，公开分享由你决定。
    </p>
  </section>
</template>
