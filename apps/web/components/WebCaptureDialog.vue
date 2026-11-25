<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { Alert as AAlert, Button as AButton, Input as AInput } from 'ant-design-vue';
import { NModal } from 'naive-ui';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { api } from '../api';

interface WebCapture {
  title: string;
  sourceUrl: string;
  markdown: string;
}

const emit = defineEmits<{
  close: [];
  saved: [note: { id: string; relativePath: string }];
}>();

const emptyCapture: WebCapture = { title: '', sourceUrl: '', markdown: '' };
const url = ref('');
const urlInput = ref<{ focus: (options?: { cursor: 'all' }) => void }>();
const previewHeading = ref<HTMLElement>();
const capture = ref({ ...emptyCapture });
const editing = ref(false);
const busy = ref(false);
const error = ref('');
let saveAttempt: (WebCapture & { requestId: string }) | undefined;

const markdown = new MarkdownIt({ html: false });
const preview = computed(() =>
  DOMPurify.sanitize(markdown.render(capture.value.markdown), {
    FORBID_TAGS: ['img'],
    FORBID_ATTR: ['href'],
  }),
);
const extracted = computed(() => !!capture.value.sourceUrl);
const sourceUrl = computed(() => httpUrl(capture.value.sourceUrl));
const canSubmit = computed(() =>
  extracted.value
    ? !!(capture.value.title.trim() && capture.value.markdown.trim())
    : !!url.value.trim(),
);

function httpUrl(value: string) {
  try {
    const parsed = new URL(value);
    if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password)
      return parsed.href;
  } catch {
    // Let the caller show an error for incomplete or invalid input.
  }
}

async function changeLink() {
  capture.value = { ...emptyCapture };
  editing.value = false;
  error.value = '';
  await nextTick();
  urlInput.value?.focus({ cursor: 'all' });
}

async function submit() {
  if (busy.value || !canSubmit.value) return;
  error.value = '';
  if (!extracted.value && !httpUrl(url.value.trim())) {
    error.value = '请输入完整的 HTTP 或 HTTPS 网页链接';
    return;
  }
  busy.value = true;
  try {
    if (!extracted.value) {
      capture.value = await api<WebCapture>('/api/web-capture/preview', 'POST', {
        url: url.value.trim(),
      });
      await nextTick();
      previewHeading.value?.focus();
      return;
    }
    const input = { ...capture.value, title: capture.value.title.trim() };
    if (
      !saveAttempt ||
      input.title !== saveAttempt.title ||
      input.sourceUrl !== saveAttempt.sourceUrl ||
      input.markdown !== saveAttempt.markdown
    ) {
      saveAttempt = { ...input, requestId: crypto.randomUUID() };
    }
    const note = await api<{ id: string; relativePath: string }>(
      '/api/web-capture/save',
      'POST',
      saveAttempt,
    );
    emit('saved', note);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '操作失败，请重试';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    class="dialog-card web-capture-dialog"
    title="保存网页"
    aria-label="保存网页"
    appear
    :mask-closable="false"
    :close-on-esc="!busy"
    :closable="!busy"
    @after-enter="urlInput?.focus()"
    @update:show="!$event && emit('close')"
  >
    <form :aria-busy="busy" @submit.prevent="submit">
      <AAlert v-if="error" type="error" :message="error" role="alert" />
      <template v-if="!extracted">
        <label for="web-capture-url">网页链接</label>
        <AInput
          id="web-capture-url"
          ref="urlInput"
          v-model:value="url"
          type="url"
          inputmode="url"
          placeholder="https://example.com/article"
          :maxlength="4096"
          :disabled="busy"
          @update:value="error = ''"
        />
      </template>
      <template v-else>
        <label for="web-capture-title">笔记标题</label>
        <AInput
          id="web-capture-title"
          v-model:value="capture.title"
          :maxlength="240"
          :disabled="busy"
        />
        <div class="web-capture-source">
          <span>原网页</span>
          <a v-if="sourceUrl" :href="sourceUrl" target="_blank" rel="noopener noreferrer">{{
            capture.sourceUrl
          }}</a>
          <span v-else>{{ capture.sourceUrl }}</span>
        </div>
        <div class="web-capture-preview-heading">
          <h3 id="web-capture-preview-title" ref="previewHeading" tabindex="-1">正文预览</h3>
          <AButton
            html-type="button"
            size="small"
            type="text"
            :disabled="busy"
            @click="editing = !editing"
          >
            {{ editing ? '查看预览' : '编辑 Markdown' }}
          </AButton>
        </div>
        <AInput.TextArea
          v-if="editing"
          v-model:value="capture.markdown"
          aria-label="Markdown 正文"
          class="web-capture-editor"
          :rows="8"
          :disabled="busy"
        />
        <section
          v-else
          class="markdown web-capture-preview"
          aria-labelledby="web-capture-preview-title"
          tabindex="0"
          v-html="preview"
        ></section>
      </template>
      <div class="dialog-actions">
        <AButton v-if="extracted" html-type="button" :disabled="busy" @click="changeLink"
          >更换链接</AButton
        >
        <AButton html-type="button" :disabled="busy" @click="emit('close')">取消</AButton>
        <AButton type="primary" html-type="submit" :loading="busy" :disabled="busy || !canSubmit">
          {{ extracted ? '保存到收集箱' : '提取正文' }}
        </AButton>
      </div>
    </form>
  </NModal>
</template>

<style scoped>
:global(.web-capture-dialog) {
  width: 640px;
}
.web-capture-source {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  align-items: baseline;
}
.web-capture-source > :first-child {
  flex-shrink: 0;
  color: var(--muted);
}
.web-capture-source > :last-child {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.web-capture-preview-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 14px 0 8px;
}
.web-capture-preview-heading h3 {
  margin: 0;
  font-size: 14px;
}
.web-capture-preview {
  padding: 12px 16px;
  max-height: min(40dvh, 340px);
  min-height: 92px;
  overflow: auto;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: var(--ui-radius);
}
.web-capture-preview :deep(:first-child) {
  margin-top: 0;
}
.web-capture-preview :deep(:last-child) {
  margin-bottom: 0;
}
.web-capture-editor {
  font-family: ui-monospace, monospace;
}
</style>
