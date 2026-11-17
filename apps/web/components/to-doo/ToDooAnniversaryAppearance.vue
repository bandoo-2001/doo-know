<script setup lang="ts">
import { Button as AButton } from 'ant-design-vue';
import { computed, ref, watch } from 'vue';
import type { ToDooAnniversaryImage, ToDooEntityMap } from '../../../../shared/to-doo-contracts';
import { nextToDooAnniversary } from '../../../../shared/to-doo-anniversaries';
import {
  toDooAnniversaryPalettes,
  toDooAnniversaryThemes,
} from '../../to-doo-anniversary-appearance';
import ToDooAnniversaryArt from './ToDooAnniversaryArt.vue';
import ToDooAnniversaryImageEditor from './ToDooAnniversaryImageEditor.vue';
import ToDooIcon from './ToDooIcon.vue';
import '../../to-doo-anniversary.css';

type Appearance = NonNullable<ToDooEntityMap['anniversary']['appearance']>;
type PhotoPreview = { src: string; x: number; y: number; zoom: number };
const props = defineProps<{
  modelValue?: Appearance;
  entity: Record<string, any>;
  today: string;
  upload?: (file: File) => Promise<Pick<ToDooAnniversaryImage, 'hash' | 'name' | 'mime' | 'size'>>;
}>();
const emit = defineEmits<{
  'update:modelValue': [appearance: Appearance];
  'busy-change': [busy: boolean];
  'editing-change': [editing: boolean];
}>();
const appearance = computed<Appearance>(
  () => props.modelValue || { style: 'bloom', palette: 'rose' },
);
const temporaryPreview = ref<PhotoPreview>();
const photoBusy = ref(false);
const photoEditing = ref(false);
const optionsPanel = ref<HTMLElement>();
const previewPane = ref<HTMLElement>();
const imageEditor = ref<InstanceType<typeof ToDooAnniversaryImageEditor>>();
function escapeFraming(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (!photoEditing.value && !photoBusy.value)) return;
  event.stopPropagation();
  event.preventDefault();
  imageEditor.value?.cancelFraming();
}
const selectedTheme = computed(
  () =>
    toDooAnniversaryThemes.find((theme) => theme.value === appearance.value.style) ||
    toDooAnniversaryThemes[0],
);
function showPreview() {
  previewPane.value?.scrollIntoView({ block: 'start' });
  previewPane.value?.focus({ preventScroll: true });
}
function showControls() {
  const target = photoEditing.value
    ? optionsPanel.value?.querySelector<HTMLElement>('.todo-photo-framing')
    : optionsPanel.value;
  target?.scrollIntoView({ block: 'start' });
  target?.focus({ preventScroll: true });
}
watch(
  () => appearance.value.style,
  (style) => {
    if (style !== 'photo') temporaryPreview.value = undefined;
  },
);
const photoPreview = computed<PhotoPreview | undefined>(() => {
  if (temporaryPreview.value) return temporaryPreview.value;
  const image = appearance.value.image;
  return image
    ? {
        src: '/api/to-doo/anniversary-images/' + image.hash,
        x: image.x,
        y: image.y,
        zoom: image.zoom,
      }
    : undefined;
});
function updateImage(image: ToDooAnniversaryImage | undefined) {
  emit('update:modelValue', { ...appearance.value, image });
}
function updateBusy(busy: boolean) {
  photoBusy.value = busy;
  emit('busy-change', busy);
}
function updateEditing(editing: boolean) {
  photoEditing.value = editing;
  emit('editing-change', editing);
}
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
  <section class="todo-card-customizer" aria-label="卡片外观" @keydown="escapeFraming">
    <header class="todo-card-customizer-heading">
      <div>
        <h3>卡片外观</h3>
        <p class="todo-form-help">选择主题与配色，预览会同步更新。</p>
      </div>
      <AButton html-type="button" type="text" @click="showPreview"
        >查看预览<ToDooIcon name="chevron" :size="12"
      /></AButton>
    </header>
    <div class="todo-card-customizer-workspace">
      <div ref="optionsPanel" class="todo-card-customizer-options" tabindex="-1">
        <section class="todo-card-theme-section" aria-label="选择主题">
          <h4>主题</h4>
          <div class="todo-card-style-options" role="group" aria-label="卡片样式">
            <button
              v-for="style in toDooAnniversaryThemes"
              :key="style.value"
              type="button"
              :title="style.description"
              :aria-label="style.label"
              :disabled="photoBusy || photoEditing"
              :aria-pressed="appearance.style === style.value"
              @click="emit('update:modelValue', { ...appearance, style: style.value })"
            >
              <span
                class="todo-card-style-sample"
                :data-card-style="style.value"
                :data-card-palette="appearance.palette"
                aria-hidden="true"
              >
                <ToDooAnniversaryArt
                  v-if="style.value === 'photo' && photoPreview"
                  v-bind="photoPreview"
                  eager
                />
                <span v-else-if="style.value === 'photo'" class="todo-card-photo-label"
                  >添加照片</span
                >
              </span>
              <span class="todo-card-style-label"
                >{{ style.label
                }}<span
                  class="todo-card-style-check"
                  :class="{ 'is-selected': appearance.style === style.value }"
                  aria-hidden="true"
                  ><ToDooIcon name="check" :size="12" /></span
              ></span>
            </button>
          </div>
          <p class="todo-card-style-description todo-form-help">{{ selectedTheme.description }}</p>
          <p v-if="photoEditing" class="todo-form-help">先确认或取消取景，即可切换主题。</p>
        </section>
        <section class="todo-card-theme-section" aria-label="选择配色">
          <h4>配色</h4>
          <div class="todo-card-palette-options" role="group" aria-label="卡片配色">
            <button
              v-for="palette in toDooAnniversaryPalettes"
              :key="palette.value"
              type="button"
              :aria-label="palette.label"
              :disabled="photoBusy"
              :aria-pressed="appearance.palette === palette.value"
              :style="{ '--swatch': palette.color }"
              @click="emit('update:modelValue', { ...appearance, palette: palette.value })"
            >
              <span aria-hidden="true"
                ><ToDooIcon
                  v-if="appearance.palette === palette.value"
                  name="check"
                  :size="12" /></span
              >{{ palette.label }}
            </button>
          </div>
        </section>
        <ToDooAnniversaryImageEditor
          ref="imageEditor"
          v-if="appearance.style === 'photo'"
          :model-value="appearance.image"
          :upload="upload"
          @update:model-value="updateImage"
          @busy-change="updateBusy"
          @editing-change="updateEditing"
          @preview-change="temporaryPreview = $event"
          @show-preview="showPreview"
        />
      </div>
      <aside ref="previewPane" class="todo-card-preview-pane" tabindex="-1" aria-label="卡片效果">
        <div class="todo-card-preview-heading">
          <h4>预览效果</h4>
          <span>{{ photoEditing ? '取景中' : '实时更新' }}</span>
        </div>
        <article
          class="todo-anniversary todo-panel todo-anniversary-preview"
          :data-card-style="appearance.style"
          :data-card-palette="appearance.palette"
          aria-label="卡片预览"
        >
          <div class="todo-anniversary-face">
            <ToDooAnniversaryArt
              v-if="appearance.style === 'photo' && photoPreview"
              v-bind="photoPreview"
              eager
            />
            <div class="todo-anniversary-heading">
              <span v-if="entity.category" class="todo-badge">{{ entity.category }}</span>
            </div>
            <h2 class="todo-anniversary-name">
              <span class="todo-anniversary-name-text">{{ entity.name || '我的纪念日' }}</span>
            </h2>
            <div class="todo-anniversary-distance">
              <p v-if="next?.date === today" class="todo-anniversary-today">就是今天</p>
              <p v-else-if="next" class="todo-days">
                <small>{{ next.days >= 0 ? '还有' : '已经' }}</small
                ><span>{{ days }}</span
                ><small>天</small>
              </p>
              <p v-else class="todo-muted">暂未找到下一次日期，请检查日期设置</p>
            </div>
            <div class="todo-anniversary-dates">
              <p v-if="next" class="todo-muted">
                {{ next.days < 0 || next.date === today ? '公历日期' : '下次公历' }}：{{
                  next.date
                }}
              </p>
              <p v-if="entity.calendar === 'lunar'" class="todo-muted">
                农历原日期：{{ entity.date }}{{ entity.lunarLeapMonth ? '（闰月）' : '' }}
              </p>
            </div>
            <p
              v-if="appearance.style === 'photo' && !photoPreview"
              class="todo-muted todo-card-photo-empty"
            >
              上传照片后，可在这里预览取景效果
            </p>
          </div>
        </article>
        <p class="todo-form-help">
          {{
            photoEditing
              ? '取景效果已同步。确认取景后，再保存纪念日。'
              : '保存纪念日后，将应用到列表卡片。'
          }}
        </p>
        <AButton html-type="button" class="todo-card-preview-return" @click="showControls"
          >继续调整</AButton
        >
      </aside>
    </div>
  </section>
</template>

<style scoped>
.todo-card-customizer {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.todo-card-customizer-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.todo-card-customizer-heading h3 {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}
.todo-card-customizer p {
  margin: 0;
}
.todo-card-customizer-workspace {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 24px;
  align-items: start;
  min-width: 0;
}
.todo-card-customizer-options {
  display: grid;
  gap: 20px;
  min-width: 0;
}
.todo-card-customizer-options:focus,
.todo-card-preview-pane:focus {
  outline: none;
}
.todo-card-theme-section {
  display: grid;
  gap: 10px;
  min-width: 0;
}
.todo-card-customizer h4 {
  margin: 0;
  font-size: 12px;
  font-weight: 550;
  color: var(--todo-ink);
}
.todo-card-style-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.todo-card-style-options button {
  display: grid;
  gap: 8px;
  padding: 6px 6px 8px;
  border: 1px solid var(--todo-line);
  border-radius: 8px;
  background: var(--todo-paper);
  font-size: 12px;
  color: var(--todo-ink);
  min-width: 0;
  cursor: pointer;
  text-align: start;
}
.todo-card-style-options button:focus-visible,
.todo-card-palette-options button:focus-visible {
  outline: 2px solid var(--todo-accent);
  outline-offset: 3px;
}
.todo-card-style-options button[aria-pressed='true'] {
  border-color: var(--todo-accent);
  box-shadow: 0 0 0 1px var(--todo-accent);
}
.todo-card-style-options button:disabled,
.todo-card-palette-options button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.todo-card-style-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding-inline: 3px;
}
.todo-card-style-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--todo-accent);
  color: white;
  visibility: hidden;
}
.todo-card-style-check.is-selected {
  visibility: visible;
}
.todo-card-style-sample {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: block;
  height: 56px;
  border-radius: 4px;
}
.todo-card-style-sample :deep(.todo-anniversary-art) {
  position: absolute;
  inset: 0;
  height: 100%;
  width: 100%;
  aspect-ratio: auto;
}
.todo-card-style-sample :deep(.todo-anniversary-photo-error) {
  display: none;
}
.todo-card-photo-label {
  display: grid;
  height: 100%;
  place-items: center;
  color: var(--card-ink);
  font-size: 11px;
}
.todo-card-style-description {
  min-height: 18px;
}
.todo-card-palette-options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.todo-card-palette-options button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--todo-line);
  border-radius: 8px;
  background: var(--todo-paper);
  font-size: 12px;
  color: var(--todo-ink);
  cursor: pointer;
}
.todo-card-palette-options button[aria-pressed='true'] {
  border-color: var(--todo-accent);
  background: color-mix(in srgb, var(--todo-accent) 8%, var(--todo-paper));
}
.todo-card-palette-options button > span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border-radius: 50%;
  background: var(--swatch);
  color: white;
}
.todo-card-preview-pane {
  position: sticky;
  top: 0;
  display: grid;
  gap: 12px;
  align-self: start;
  min-width: 0;
  padding: 12px;
  border: 1px solid var(--todo-line);
  border-radius: 10px;
  background: var(--todo-paper);
  scroll-margin-block: 12px;
}
.todo-card-preview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.todo-card-preview-heading > span {
  font-size: 11px;
  color: var(--todo-muted);
}
.todo-anniversary-preview {
  width: min(100%, 280px);
  min-height: 0;
  justify-self: center;
}
.todo-anniversary-preview .todo-anniversary-face {
  padding-bottom: 20px;
}
.todo-card-preview-return {
  justify-self: start;
}
@media (max-width: 800px) {
  .todo-card-customizer-workspace {
    grid-template-columns: minmax(0, 1fr);
    gap: 20px;
  }
  .todo-card-preview-pane {
    position: static;
  }
  .todo-card-style-sample {
    height: 48px;
  }
}
@media (max-width: 380px) {
  .todo-card-style-options {
    gap: 6px;
  }
  .todo-card-style-options button {
    padding: 4px 4px 6px;
  }
  .todo-card-style-sample {
    height: 40px;
  }
}
</style>
