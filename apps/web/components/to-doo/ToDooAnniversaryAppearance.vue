<script setup lang="ts">
import { computed } from 'vue';
import type { ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { nextToDooAnniversary } from '../../../../shared/to-doo-anniversaries';
import '../../to-doo-anniversary.css';

type Appearance = NonNullable<ToDooEntityMap['anniversary']['appearance']>;
const props = defineProps<{
  modelValue?: Appearance;
  entity: Record<string, any>;
  today: string;
}>();
const emit = defineEmits<{ 'update:modelValue': [appearance: Appearance] }>();
const appearance = computed<Appearance>(
  () => props.modelValue || { style: 'bloom', palette: 'rose' },
);
const styles: { value: Appearance['style']; label: string }[] = [
  { value: 'bloom', label: '花间' },
  { value: 'landscape', label: '远山' },
  { value: 'orbit', label: '星轨' },
  { value: 'minimal', label: '留白' },
];
const palettes: { value: Appearance['palette']; label: string; color: string }[] = [
  { value: 'rose', label: '胭脂', color: '#b76478' },
  { value: 'sage', label: '青苔', color: '#608575' },
  { value: 'lavender', label: '暮紫', color: '#8670b0' },
  { value: 'amber', label: '暖杏', color: '#ac7b3c' },
  { value: 'ocean', label: '雾蓝', color: '#5289ab' },
];
const next = computed(() => {
  try {
    return nextToDooAnniversary(props.entity as ToDooEntityMap['anniversary'], props.today);
  } catch {
    return null;
  }
});
const days = computed(() =>
  next.value ? Math.abs(next.value.days) + (props.entity.countMode === 'include_today' ? 1 : 0) : 0,
);
</script>

<template>
  <section class="todo-card-customizer" aria-label="卡片外观">
    <div class="todo-card-customizer-label">卡片外观</div>
    <div class="todo-card-style-options" role="group" aria-label="卡片样式">
      <button
        v-for="style in styles"
        :key="style.value"
        type="button"
        :aria-pressed="appearance.style === style.value"
        @click="emit('update:modelValue', { ...appearance, style: style.value })"
      >
        <span
          class="todo-card-style-sample"
          :data-card-style="style.value"
          :data-card-palette="appearance.palette"
          aria-hidden="true"
        />
        {{ style.label }}
      </button>
    </div>
    <div class="todo-card-palette-options" role="group" aria-label="卡片配色">
      <button
        v-for="palette in palettes"
        :key="palette.value"
        type="button"
        :aria-label="palette.label"
        :aria-pressed="appearance.palette === palette.value"
        :style="{ '--swatch': palette.color }"
        @click="emit('update:modelValue', { ...appearance, palette: palette.value })"
      >
        <span aria-hidden="true">{{ appearance.palette === palette.value ? '✓' : '' }}</span
        >{{ palette.label }}
      </button>
    </div>
    <article
      class="todo-anniversary todo-panel todo-anniversary-preview"
      :data-card-style="appearance.style"
      :data-card-palette="appearance.palette"
      aria-label="卡片预览"
    >
      <span class="todo-badge">{{ entity.category || '值得记住的一天' }}</span>
      <h2>{{ entity.name || '我的纪念日' }}</h2>
      <p v-if="next?.date === today" class="todo-card-today">就是今天</p>
      <p v-else-if="next" class="todo-days">
        <small>{{ next.days >= 0 ? '还有' : '已经' }}</small
        >{{ days }}<small>天</small>
      </p>
      <p v-if="next" class="todo-muted">
        {{ next.days < 0 || next.date === today ? '公历日期' : '下次公历' }}：{{ next.date }}
      </p>
    </article>
  </section>
</template>

<style scoped>
.todo-card-customizer {
  display: grid;
  gap: 12px;
  min-width: 0;
}
.todo-card-customizer-label {
  font-weight: 550;
}
.todo-card-style-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.todo-card-style-options button {
  display: grid;
  gap: 6px;
  padding: 5px 5px 7px;
  border: 1px solid var(--todo-line);
  border-radius: 8px;
  background: var(--todo-paper);
  font-size: 12px;
}
.todo-card-style-options button[aria-pressed='true'] {
  border-color: var(--todo-accent);
  box-shadow: 0 0 0 1px var(--todo-accent);
}
.todo-card-style-sample {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: block;
  height: 48px;
  border-radius: 4px;
}
.todo-card-palette-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.todo-card-palette-options button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 20px;
  background: var(--todo-paper);
  font-size: 12px;
}
.todo-card-palette-options button[aria-pressed='true'] {
  border-color: var(--todo-accent);
}
.todo-card-palette-options span {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--swatch);
  color: white;
  font-size: 12px;
  line-height: 18px;
  text-align: center;
}
.todo-anniversary-preview {
  min-height: 200px;
}
.todo-anniversary-preview > h2,
.todo-anniversary-preview > p {
  margin: 0;
}
.todo-anniversary-preview > .todo-badge {
  align-self: flex-start;
}
.todo-card-today {
  font-size: 28px;
  font-weight: 600;
}
</style>
