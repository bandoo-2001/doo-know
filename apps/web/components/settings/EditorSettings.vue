<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { Button as AButton, Select as ASelect, Switch as ASwitch } from 'ant-design-vue';
import { editorPreferences, setEditorPreferences } from '../../preferences';
import {documentEditorEnabled} from '../../editor/compatibility';
const documentEditingEnabled=documentEditorEnabled();
const emit = defineEmits<{ 'preferences-changed': [] }>();
const draft = reactive({ ...editorPreferences });
const notice = ref('');
const appearanceQuery =
  typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(appearanceQuery?.matches || false);
function updateSystemAppearance(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
appearanceQuery?.addEventListener('change', updateSystemAppearance);
onBeforeUnmount(() => appearanceQuery?.removeEventListener('change', updateSystemAppearance));
const previewTheme = computed(() =>
  draft.theme === 'system' ? (systemDark.value ? 'dark' : 'light') : draft.theme,
);
const dirty = computed(() =>
  Object.keys(draft).some(
    (key) => draft[key as keyof typeof draft] !== editorPreferences[key as keyof typeof draft],
  ),
);
const readingLabels = { comfortable: '舒适宽度', wide: '宽屏阅读', full: '铺满区域' };
const previewWidth = computed(
  () => ({ comfortable: '78%', wide: '92%', full: '100%' })[draft.readingWidth],
);
const sample =
  '把今天的想法记下来，让原文、链接和附件留在一起。调整显示方式，为下一次阅读留出舒服的空间。';
watch(
  draft,
  () => {
    notice.value = '';
  },
  { flush: 'sync' },
);
function cancel() {
  Object.assign(draft, editorPreferences);
  notice.value = '已取消未保存的更改';
}

watch(editorPreferences, (value) => Object.assign(draft, value));
function save() {
  setEditorPreferences({ ...draft, ...(!documentEditingEnabled && draft.mode === 'split' ? { editorKind: 'source' as const } : {}) });
  Object.assign(draft, editorPreferences);
  notice.value = '编辑器偏好已保存';
  emit('preferences-changed');
}
function reset() {
  Object.assign(draft, {
    editorKind: 'document',
    mode: 'edit',
    wrap: true,
    lineNumbers: false,
    fontSize: 15,
    readingWidth: 'comfortable',
    theme: 'light',
  });
  notice.value = '默认设置已载入预览，点击保存后生效。';
}
</script>
<template>
  <div class="settings-stack">
    <section class="settings-card">
      <h2>编辑与阅读</h2>
      <p class="settings-muted">
        设置保存在当前账户的这台浏览器中。保存后用于笔记显示，原文格式保持不变。
      </p>
      <form @submit.prevent="save" @change="notice = ''">
        <div v-if="documentEditingEnabled" class="settings-row"><div><label for="pref-editor-kind">默认编辑方式</label><p class="settings-muted">文档编辑直接排版，Markdown 源码适合精确编辑。</p></div><ASelect id="pref-editor-kind" aria-label="默认编辑方式" v-model:value="draft.editorKind" :options="[{label:'文档编辑',value:'document'},{label:'Markdown 源码',value:'source'}]" style="min-width:150px" /></div>
        <div class="settings-row">
          <div>
            <label for="pref-mode">默认打开方式</label>
            <p class="settings-muted">新打开笔记时使用的视图。</p>
          </div>
          <ASelect
            id="pref-mode"
            aria-label="默认打开方式"
            v-model:value="draft.mode"
            :options="[
              { label: '编辑', value: 'edit' },
              { label: '预览', value: 'preview' },
              { label: documentEditingEnabled ? '源码与预览分屏' : '分屏', value: 'split', disabled: documentEditingEnabled && draft.editorKind === 'document' },
            ]"
            style="min-width: 150px"
          />
        </div>
        <div class="settings-row">
          <div>
            <label for="pref-wrap">自动换行</label>
            <p class="settings-muted">Markdown 源码中的长段落随编辑区域宽度换行。</p>
          </div>
          <ASwitch id="pref-wrap" aria-label="自动换行" v-model:checked="draft.wrap" />
        </div>
        <div class="settings-row">
          <div>
            <label for="pref-lines">显示行号</label>
            <p class="settings-muted">在 Markdown 源码中显示行号，便于定位原文段落。</p>
          </div>
          <ASwitch id="pref-lines" aria-label="显示行号" v-model:checked="draft.lineNumbers" />
        </div>
        <div class="settings-row">
          <label for="pref-size">文字大小</label
          ><ASelect
            id="pref-size"
            aria-label="文字大小"
            v-model:value="draft.fontSize"
            :options="[14, 15, 16, 18, 20].map((value) => ({ label: value + ' px', value }))"
            style="min-width: 150px"
          />
        </div>
        <div class="settings-row">
          <label for="pref-width">阅读宽度</label
          ><ASelect
            id="pref-width"
            aria-label="阅读宽度"
            v-model:value="draft.readingWidth"
            :options="[
              { label: '舒适', value: 'comfortable' },
              { label: '宽屏', value: 'wide' },
              { label: '铺满', value: 'full' },
            ]"
            style="min-width: 150px"
          />
        </div>
        <div class="settings-row">
          <label for="pref-theme">外观</label
          ><ASelect
            id="pref-theme"
            aria-label="外观"
            v-model:value="draft.theme"
            :options="[
              { label: '跟随系统', value: 'system' },
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' },
            ]"
            style="min-width: 150px"
          />
        </div>
        <section
          class="editor-preview"
          aria-label="编辑器显示预览"
          :data-preview-theme="previewTheme"
        >
          <div class="preview-toolbar">
            <strong>显示预览</strong
            ><span
              >{{ readingLabels[draft.readingWidth] }} · {{ draft.fontSize }} px ·
              {{ previewTheme === 'dark' ? '深色' : '浅色' }}</span
            >
          </div>
          <p class="preview-caption">预览为缩略示意；点击「保存偏好」后应用到笔记。</p>
          <div
            class="preview-view"
            :class="{ 'preview-split': draft.mode === 'split' }"
            :style="{ fontSize: draft.fontSize + 'px' }"
          >
            <div v-if="draft.mode !== 'preview'" class="preview-pane preview-source">
              <div class="preview-source-line">
                <span v-if="draft.lineNumbers" class="preview-line-number" aria-hidden="true"
                  >1</span
                ><code># 阅读与记录</code>
              </div>
              <div class="preview-source-line">
                <span v-if="draft.lineNumbers" class="preview-line-number" aria-hidden="true"
                  >2</span
                ><code
                  :style="{
                    whiteSpace: draft.wrap ? 'pre-wrap' : 'pre',
                    overflowWrap: draft.wrap ? 'anywhere' : 'normal',
                  }"
                  >{{ sample }}</code
                >
              </div>
            </div>
            <div v-if="draft.mode !== 'edit'" class="preview-pane preview-reading">
              <div :style="{ width: previewWidth }" class="preview-reading-page">
                <div class="preview-title">阅读与记录</div>
                <p>{{ sample }}</p>
              </div>
            </div>
          </div>
          <p v-if="draft.mode === 'edit'" class="preview-caption">
            阅读宽度：{{ readingLabels[draft.readingWidth] }}，在预览或分屏视图中查看效果。
          </p>
        </section>
        <div class="settings-actions">
          <AButton type="primary" html-type="submit">保存偏好</AButton
          ><AButton :disabled="!dirty" @click="cancel">取消更改</AButton
          ><AButton @click="reset">恢复默认设置</AButton
          ><span class="settings-success" role="status">{{ notice }}</span>
        </div>
      </form>
    </section>
    <section class="settings-card">
      <h2>键盘操作</h2>
      <p class="settings-muted">
        <kbd>Ctrl / ⌘ + S</kbd> 保存当前笔记；<kbd>Esc</kbd>
        关闭可关闭的弹窗。笔记采用手动保存，离开前留意保存状态。
      </p>
    </section>
  </div>
</template>

<style scoped>
.editor-preview {
  --preview-bg: #fff;
  --preview-text: #293344;
  --preview-muted: #748091;
  --preview-border: #e0e5ed;
  --preview-toolbar: #f3f5f8;
  border: 1px solid var(--preview-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--preview-bg);
  color: var(--preview-text);
  margin-top: 22px;
}
.editor-preview[data-preview-theme='dark'] {
  --preview-bg: #20252e;
  --preview-text: #e1e6ef;
  --preview-muted: #a2adbd;
  --preview-border: #3a4352;
  --preview-toolbar: #292f3a;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 13px;
  background: var(--preview-toolbar);
  font-size: 12px;
  flex-wrap: wrap;
}
.preview-toolbar strong {
  font-weight: 500;
}
.preview-toolbar span {
  color: var(--preview-muted);
  font-size: 11px;
}
.settings-workspace .preview-caption {
  color: var(--preview-muted);
  font-size: 11px;
  line-height: 1.7;
  margin: 10px 13px;
}
.preview-view {
  display: grid;
  min-width: 0;
  line-height: 1.75;
}
.preview-split {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.preview-pane {
  padding: 14px;
  min-width: 0;
}
.preview-source {
  overflow-x: auto;
  min-height: 115px;
}
.preview-split .preview-source {
  border-right: 1px solid var(--preview-border);
}
.preview-source-line {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.preview-source-line code {
  font-size: inherit;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  display: block;
  min-width: 0;
}
.preview-line-number {
  flex-shrink: 0;
  width: 14px;
  color: var(--preview-muted);
  font-size: 0.8em;
  text-align: right;
  user-select: none;
}
.preview-reading-page {
  margin: 0 auto;
  min-width: 0;
}
.preview-title {
  font-size: 1.3em;
  font-weight: 600;
  line-height: 1.5;
}
.settings-workspace .preview-reading-page p {
  font-size: inherit;
  line-height: 1.75;
  margin: 8px 0;
}
.preview-reading {
  background: var(--preview-bg);
}
@media (max-width: 430px) {
  .preview-split {
    grid-template-columns: minmax(0, 1fr);
  }
  .preview-split .preview-source {
    border-right: 0;
    border-bottom: 1px solid var(--preview-border);
  }
  .preview-pane {
    padding: 12px;
  }
}
</style>
