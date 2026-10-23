<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Modal as AModal } from 'ant-design-vue';
import type { NoteBacklink, NoteBacklinksPage } from '../../../shared/note-links';

const props = defineProps<{ noteId: string }>();
const emit = defineEmits<{ open: [noteId: string]; close: [] }>();
const matches = ref<NoteBacklink[]>([]);
const checked = ref(0);
const skipped = ref(0);
const nextCursor = ref<string>();
const busy = ref(false);
const message = ref('');
let generation = 0;
let controller: AbortController | undefined;

async function lookup(reset = false) {
  if (busy.value && !reset) return;
  controller?.abort();
  const request = ++generation,
    noteId = props.noteId;
  controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
  if (reset) {
    matches.value = [];
    checked.value = skipped.value = 0;
    nextCursor.value = undefined;
  }
  message.value = '';
  if (!noteId) {
    busy.value = false;
    return;
  }
  busy.value = true;
  try {
    const query = nextCursor.value ? '?cursor=' + encodeURIComponent(nextCursor.value) : '';
    const response = await fetch(`/api/notes/${encodeURIComponent(noteId)}/backlinks${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
    });
    const page = await response.json();
    if (request !== generation || noteId !== props.noteId) return;
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('dooknow-session-expired'));
      throw Error(typeof page.error === 'string' ? page.error : '查找未完成，请重试');
    }
    const result = page as NoteBacklinksPage;
    matches.value = [
      ...new Map([...matches.value, ...result.matches].map((match) => [match.id, match])).values(),
    ];
    checked.value += result.checked;
    skipped.value += result.skipped;
    nextCursor.value = result.nextCursor;
  } catch (cause) {
    if (request !== generation || noteId !== props.noteId) return;
    message.value = cause instanceof Error ? cause.message : '查找未完成，请重试';
  } finally {
    if (request === generation && noteId === props.noteId) busy.value = false;
  }
}

watch(
  () => props.noteId,
  () => void lookup(true),
  { immediate: true },
);
onBeforeUnmount(() => {
  generation++;
  controller?.abort();
});
</script>

<template>
  <AModal :open="true" title="提及此笔记" :width="640" :footer="null" @cancel="emit('close')">
    <div class="note-backlinks" :aria-busy="busy">
      <p class="backlinks-description">
        查找其他笔记中指向当前笔记的链接。结果分批检查，较大或暂时无法读取的笔记会跳过。
      </p>
      <p v-if="checked || skipped || !busy" class="backlinks-progress" role="status">
        已检查 {{ checked }} 篇<span v-if="skipped">，跳过 {{ skipped }} 篇</span>。
        <span v-if="nextCursor">查找尚未完成，请继续查找。</span>
        <span v-else-if="!busy && !message"
          >当前笔记清单已查完<span v-if="skipped">，跳过的笔记可能还有提及</span>。</span
        >
      </p>
      <ul v-if="matches.length" class="backlinks-list">
        <li v-for="match in matches" :key="match.id">
          <button type="button" class="backlinks-note" @click="emit('open', match.id)">
            <strong>{{ match.title }}</strong
            ><span>{{ match.relativePath }}</span>
          </button>
        </li>
      </ul>
      <p v-else-if="!busy && !message" class="backlinks-empty">
        {{ nextCursor ? '已检查的笔记中暂未找到提及。' : '已检查的笔记中未找到提及。' }}
      </p>
      <p v-if="busy" role="status" class="backlinks-description">正在查找…</p>
      <p v-if="message" role="alert" class="backlinks-error">{{ message }}</p>
      <div class="backlinks-actions">
        <button type="button" class="btn" @click="emit('close')">关闭</button>
        <button type="button" class="btn" :disabled="busy" @click="lookup(true)">重新查找</button>
        <button
          v-if="message"
          type="button"
          class="btn primary"
          :disabled="busy"
          @click="lookup(!nextCursor)"
        >
          重试本批
        </button>
        <button
          v-else-if="nextCursor"
          type="button"
          class="btn primary"
          :disabled="busy"
          @click="lookup()"
        >
          继续查找
        </button>
      </div>
    </div>
  </AModal>
</template>

<style scoped>
.note-backlinks {
  color: var(--text);
}
.backlinks-description,
.backlinks-progress,
.backlinks-empty {
  margin: 0 0 14px;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.backlinks-list {
  max-height: min(50vh, 420px);
  padding: 0;
  margin: 0 0 16px;
  overflow-y: auto;
  list-style: none;
}
.backlinks-note {
  display: grid;
  gap: 4px;
  width: 100%;
  padding: 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  text-align: left;
  color: var(--text);
  background: transparent;
  cursor: pointer;
}
.backlinks-note:hover,
.backlinks-note:focus-visible {
  background: var(--hover, rgba(127, 127, 127, 0.1));
}
.backlinks-note span {
  font-size: 11px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.backlinks-actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
}
.backlinks-error {
  color: var(--danger, #b42318);
  font-size: 12px;
}
</style>
