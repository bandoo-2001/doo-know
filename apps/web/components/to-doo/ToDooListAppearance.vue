<script setup lang="ts">
import { computed } from 'vue';
import ToDooIcon from './ToDooIcon.vue';
import ToDooListIcon from './ToDooListIcon.vue';

const props = defineProps<{ icon?: string | null; color?: string; name?: string; kind?: string }>();
const emit = defineEmits<{
  'update:icon': [value: string | null];
  'update:color': [value: string];
}>();
const mode = computed(() =>
  props.icon === 'dot' ? 'dot' : props.icon === 'folder' ? 'folder' : 'icon',
);
const icons = [
  ['💼', '工作'],
  ['📚', '阅读'],
  ['🏡', '生活'],
  ['🌱', '成长'],
  ['🎯', '目标'],
  ['💡', '灵感'],
  ['🎨', '创作'],
  ['💻', '开发'],
  ['🏃', '运动'],
  ['☕', '休闲'],
  ['✈️', '旅行'],
  ['🎵', '音乐'],
  ['🛒', '购物'],
  ['⭐', '收藏'],
];
const colors = [
  ['#647be8', '鸢蓝'],
  ['#3b82a0', '湖蓝'],
  ['#4f8c7a', '松绿'],
  ['#8f9d55', '青橄榄'],
  ['#ca8b45', '暖橙'],
  ['#bd655e', '珊瑚'],
  ['#b76a8f', '玫瑰'],
  ['#9470b8', '雾紫'],
  ['#7c879a', '岩灰'],
  ['#545c6e', '墨色'],
];
const appearance = computed(() => ({
  icon: props.icon,
  color: props.color || '#647be8',
  kind: props.kind,
}));
</script>

<template>
  <section class="todo-list-appearance" aria-label="清单外观">
    <div class="todo-list-appearance-preview">
      <span class="todo-list-appearance-tile" :style="{ '--list-color': appearance.color }">
        <ToDooListIcon :list="appearance" :size="27" />
      </span>
      <div>
        <strong>{{ name?.trim() || (kind === 'goal' ? '我的目标' : '我的清单') }}</strong>
        <span>让每份清单都有自己的样子</span>
      </div>
    </div>
    <div class="todo-list-appearance-field">
      <span class="todo-list-field-label">图标样式</span>
      <div class="todo-list-icon-modes" role="group" aria-label="图标样式">
        <button type="button" :aria-pressed="mode === 'icon'" @click="emit('update:icon', null)">
          <span aria-hidden="true">🎨</span> 彩色图标
        </button>
        <button
          type="button"
          :aria-pressed="mode === 'folder'"
          @click="emit('update:icon', 'folder')"
        >
          <ToDooIcon name="folder" :size="16" /> 文件夹
        </button>
        <button type="button" :aria-pressed="mode === 'dot'" @click="emit('update:icon', 'dot')">
          <span
            class="todo-list-mode-dot"
            :style="{ background: appearance.color }"
            aria-hidden="true"
          />
          彩色圆点
        </button>
      </div>
      <div
        v-if="mode === 'icon'"
        class="todo-list-icon-options"
        role="group"
        aria-label="选择清单图标"
      >
        <button
          type="button"
          aria-label="默认清单图标"
          :aria-pressed="!icon"
          @click="emit('update:icon', null)"
        >
          <ToDooIcon :name="kind === 'goal' ? 'overview' : 'list'" :size="21" />
        </button>
        <button
          v-for="[value, label] in icons"
          :key="value"
          type="button"
          :aria-label="label + '图标'"
          :aria-pressed="icon === value"
          @click="emit('update:icon', value)"
        >
          <span aria-hidden="true">{{ value }}</span>
        </button>
      </div>
    </div>
    <div class="todo-list-appearance-field">
      <span class="todo-list-field-label">标识颜色</span>
      <div class="todo-list-color-options" role="group" aria-label="选择清单颜色">
        <button
          v-for="[value, label] in colors"
          :key="value"
          type="button"
          :aria-label="label + '色'"
          :aria-pressed="appearance.color.toLowerCase() === value"
          :style="{ '--swatch': value }"
          @click="emit('update:color', value)"
        >
          <span aria-hidden="true">{{ appearance.color.toLowerCase() === value ? '✓' : '' }}</span>
        </button>
        <label class="todo-list-custom-color" title="自定义颜色">
          <input
            type="color"
            aria-label="自定义清单颜色"
            :value="appearance.color"
            @input="emit('update:color', ($event.target as HTMLInputElement).value)"
          />
          <ToDooIcon name="plus" :size="15" />
        </label>
      </div>
    </div>
  </section>
</template>
