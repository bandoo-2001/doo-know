<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import type { CollectionKind, CollectionNote } from '../../../shared/collection-contracts';
import type { TreeEntry } from '../../../shared/contracts';
import type { CollectionFeed } from '../collection-feed';
import { collectionWindow, COLLECTION_CARD_HEIGHT } from '../collection-window';

const props = defineProps<{
  kind: CollectionKind;
  feed: CollectionFeed;
  favoriteBusy: boolean;
  menuPath: string;
}>();
const emit = defineEmits<{
  select: [entry: TreeEntry];
  menu: [entry: TreeEntry, event: MouseEvent | KeyboardEvent];
  favorite: [note: CollectionNote];
  create: [];
}>();
const scroll = ref<HTMLElement>(),
  sentinel = ref<HTMLElement>();
const width = ref(960),
  height = ref(640),
  position = ref(0);
let resize: ResizeObserver | undefined,
  intersection: IntersectionObserver | undefined,
  frame = 0;
const items = computed(() => props.feed.items.value);
const total = computed(() => props.feed.total.value);
const loading = computed(() => props.feed.loading.value);
const error = computed(() => props.feed.error.value);
const updated = computed(() => props.feed.updated.value);
const nextCursor = computed(() => props.feed.nextCursor.value);
const heading = computed(() => (props.kind === 'recent' ? '最近' : '收藏'));
const window = computed(() =>
  collectionWindow({
    count: items.value.length,
    width: width.value,
    height: height.value,
    scrollTop: position.value,
  }),
);
const visible = computed(() => items.value.slice(window.value.start, window.value.end));
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${window.value.columns}, minmax(0, 1fr))`,
  '--collection-card-height': `${COLLECTION_CARD_HEIGHT}px`,
}));
const entry = (note: CollectionNote): TreeEntry => ({
  id: note.id,
  path: note.path,
  name: note.name,
  type: 'note',
  updatedAt: note.updatedAt || undefined,
  favorite: note.favorite,
});
function date(value: string | null) {
  if (!value) return '修改时间未知';
  const time = new Date(value);
  return Number.isFinite(time.getTime())
    ? time.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '修改时间未知';
}
function parent(path: string) {
  return path.split('/').slice(0, -1).join(' / ') || '知识库根目录';
}
function keyMenu(note: CollectionNote, event: KeyboardEvent) {
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
    event.preventDefault();
    emit('menu', entry(note), event);
  }
}
function measure() {
  if (!scroll.value) return;
  const styles = getComputedStyle(scroll.value);
  width.value = Math.max(
    0,
    scroll.value.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight),
  );
  height.value = scroll.value.clientHeight;
}
function recordScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    position.value = scroll.value?.scrollTop || 0;
    props.feed.rememberScroll(position.value);
  });
}
async function restorePosition() {
  await nextTick();
  measure();
  position.value = props.feed.scrollTop.value;
  await nextTick();
  if (scroll.value) scroll.value.scrollTop = position.value;
}
async function refresh() {
  await props.feed.refresh();
  await restorePosition();
}
async function more() {
  if (!error.value && !updated.value && !loading.value) await props.feed.loadMore();
}
watch(() => props.kind, restorePosition);
onMounted(async () => {
  await restorePosition();
  if (scroll.value) {
    resize = new ResizeObserver(measure);
    resize.observe(scroll.value);
    intersection = new IntersectionObserver(
      (entries) => {
        if (entries.some((item) => item.isIntersecting)) void more();
      },
      { root: scroll.value, rootMargin: '320px 0px' },
    );
    if (sentinel.value) intersection.observe(sentinel.value);
  }
});
onBeforeUnmount(() => {
  if (scroll.value) props.feed.rememberScroll(scroll.value.scrollTop);
  cancelAnimationFrame(frame);
  resize?.disconnect();
  intersection?.disconnect();
});
</script>

<template>
  <section
    class="collection-workspace"
    role="region"
    :aria-label="`${heading}笔记`"
    :aria-busy="loading"
  >
    <header class="collection-heading">
      <div>
        <p class="collection-eyebrow">我的笔记</p>
        <h1>{{ heading }}</h1>
        <p class="collection-count">{{ total }} 篇笔记<span>按最近修改排序</span></p>
      </div>
      <div class="collection-heading-actions">
        <button
          class="collection-refresh"
          type="button"
          :aria-label="`刷新${heading}`"
          :title="`刷新${heading}`"
          :disabled="loading"
          @click="refresh"
        >
          <Icon name="refresh" :size="16" />
        </button>
        <button class="collection-create" type="button" @click="emit('create')">
          <Icon name="plus" :size="15" />新建笔记
        </button>
      </div>
    </header>
    <div v-if="updated" class="collection-update" role="status">
      <span>笔记列表有更新</span
      ><button type="button" :disabled="loading" @click="refresh">刷新列表</button>
    </div>
    <div
      ref="scroll"
      class="collection-scroll"
      tabindex="0"
      :aria-label="`${heading}笔记列表`"
      @scroll.passive="recordScroll"
    >
      <div
        v-if="loading && !items.length"
        class="collection-card-grid collection-skeletons"
        :style="gridStyle"
        aria-hidden="true"
      >
        <div v-for="index in 6" :key="index" class="collection-skeleton">
          <i></i><i></i><i></i><i></i>
        </div>
      </div>
      <div v-else-if="!items.length && !error" class="collection-empty">
        <Icon :name="kind === 'favorites' ? 'star' : 'clock'" :size="32" />
        <h2>{{ kind === 'favorites' ? '把值得回看的笔记收藏在这里' : '从第一篇笔记开始' }}</h2>
        <p>
          {{
            kind === 'favorites'
              ? '在笔记或卡片上点击星标，就能在这里快速找到。'
              : '新建笔记后，这里会按最近修改时间显示内容摘要。'
          }}
        </p>
      </div>
      <div v-if="items.length" role="list" :aria-label="`${heading}笔记卡片`">
        <div :style="{ height: window.top + 'px' }" aria-hidden="true"></div>
        <div class="collection-card-grid" :style="gridStyle">
          <article
            v-for="(item, index) in visible"
            :key="item.id"
            role="listitem"
            :aria-posinset="window.start + index + 1"
            :aria-setsize="total"
            :class="['collection-card', { 'menu-open': menuPath === item.path }]"
            @contextmenu.prevent.stop="emit('menu', entry(item), $event)"
            @keydown="keyMenu(item, $event)"
          >
            <button
              type="button"
              class="collection-card-open"
              :aria-label="`打开 ${item.name}`"
              @click="emit('select', entry(item))"
            >
              <h2>{{ item.title || item.name.replace(/\.md$/i, '') }}</h2>
              <p
                :class="[
                  'collection-card-summary',
                  { 'summary-empty': item.summaryState !== 'ready' || !item.summary },
                ]"
              >
                {{
                  item.summary ||
                  (item.summaryState === 'pending'
                    ? '摘要正在准备…'
                    : item.summaryState === 'unavailable'
                      ? '暂时无法预览，可打开笔记查看。'
                      : '这篇笔记还没有正文。')
                }}
              </p>
              <div class="collection-card-meta">
                <span class="collection-card-path" :title="item.path"
                  ><Icon name="folder" :size="13" />{{ parent(item.path) }}</span
                ><time
                  :datetime="item.updatedAt || undefined"
                  :title="
                    item.updatedAt ? new Date(item.updatedAt).toLocaleString('zh-CN') : undefined
                  "
                  >{{ date(item.updatedAt) }}</time
                >
              </div>
            </button>
            <div class="collection-card-actions">
              <button
                type="button"
                :class="['collection-card-star', { active: item.favorite }]"
                :aria-label="item.favorite ? '取消收藏' : '收藏'"
                :aria-pressed="item.favorite"
                :title="item.favorite ? '取消收藏' : '收藏'"
                :disabled="favoriteBusy"
                @click="emit('favorite', item)"
              >
                <Icon name="star" :size="16" />
              </button>
              <button
                type="button"
                :aria-label="`${item.name} 的更多操作`"
                aria-haspopup="menu"
                :aria-expanded="menuPath === item.path"
                :title="`${item.name} 的更多操作`"
                @click="emit('menu', entry(item), $event)"
              >
                <Icon name="more" :size="17" />
              </button>
            </div>
          </article>
        </div>
        <div :style="{ height: window.bottom + 'px' }" aria-hidden="true"></div>
      </div>
      <div ref="sentinel" class="collection-sentinel" aria-hidden="true"></div>
      <div v-if="error" class="collection-load-error" role="alert">
        <p>{{ error }}</p>
        <button type="button" :disabled="loading" @click="feed.retry()">重新加载</button>
      </div>
      <footer v-if="items.length" class="collection-page-footer">
        <span class="collection-progress">已加载 {{ items.length }} / {{ total }} 篇</span>
        <button
          v-if="nextCursor && !updated"
          class="collection-load-more"
          type="button"
          :disabled="loading || !!error"
          @click="feed.loadMore()"
        >
          {{ loading ? '正在加载…' : '加载更多笔记' }}
        </button>
        <span v-else-if="!updated && !loading">已经到底了</span>
      </footer>
    </div>
  </section>
</template>

<style scoped>
.collection-workspace {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  background: var(--workbench-paper, #fcfdff);
}
.collection-heading {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 30px 32px 24px;
  border-bottom: 1px solid var(--workbench-line, #edf0f5);
}
.collection-eyebrow {
  margin: 0 0 4px;
  color: var(--muted);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.collection-heading h1 {
  margin: 0;
  font-size: 26px;
  font-weight: 650;
  letter-spacing: -0.03em;
  line-height: 1.35;
}
.collection-count {
  display: flex;
  align-items: center;
  gap: 13px;
  margin: 7px 0 0;
  color: var(--muted);
  font-size: 12px;
}
.collection-count span {
  padding-left: 13px;
  border-left: 1px solid var(--border);
}
.collection-heading-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.collection-heading-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 31px;
  border-radius: 5px;
  font-size: 12px;
}
.collection-refresh {
  width: 31px;
  padding: 0;
  border: 1px solid var(--border);
  background: #fff;
  color: var(--muted);
}
.collection-create {
  padding: 5px 11px;
  border: 1px solid var(--blue);
  background: var(--blue);
  color: #fff;
}
.collection-scroll {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-anchor: none;
  padding: 24px 32px 18px;
  scrollbar-gutter: stable;
  outline-offset: -3px;
}
.collection-card-grid {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.collection-card {
  position: relative;
  min-width: 0;
  height: var(--collection-card-height);
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 9px;
  background: #fff;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.collection-card:hover,
.collection-card:focus-within,
.collection-card.menu-open {
  border-color: #b9c7e8;
  box-shadow: 0 3px 12px #283c6408;
}
.collection-card-open {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: 19px 19px 16px;
  border: 0;
  border-radius: inherit;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.collection-card h2 {
  display: -webkit-box;
  overflow: hidden;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  margin: 0;
  font-size: 15px;
  font-weight: 550;
  line-height: 22px;
  overflow-wrap: anywhere;
}
.collection-card-summary {
  display: -webkit-box;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  margin: 0;
  color: #657083;
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
.collection-card-summary.summary-empty {
  color: #9aa3b1;
}
.collection-card-meta {
  display: grid;
  flex: 0 0 auto;
  gap: 4px;
  min-width: 0;
  color: #929baa;
  font-size: 10px;
  line-height: 15px;
}
.collection-card-path {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.collection-card-path svg {
  flex-shrink: 0;
}
.collection-card-meta time {
  max-width: calc(100% - 48px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.collection-card-actions {
  position: absolute;
  right: 11px;
  bottom: 12px;
  display: flex;
  gap: 1px;
}
.collection-card-actions button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 27px;
  height: 27px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: #fff;
  color: #9ba5b4;
}
.collection-card-actions button:hover {
  background: var(--blue-soft);
  color: var(--blue);
}
.collection-card-star.active {
  color: #d1a137;
}
.collection-card-star.active :deep(svg) {
  fill: #eed08d;
}
.collection-update {
  display: flex;
  flex: 0 0 auto;
  justify-content: space-between;
  align-items: center;
  padding: 8px 32px;
  background: var(--blue-soft);
  color: var(--blue);
  font-size: 12px;
}
.collection-update button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
}
.collection-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 320px;
  padding: 24px;
  text-align: center;
  color: #a9b4c5;
}
.collection-empty h2 {
  margin: 18px 0 6px;
  color: var(--text);
  font-size: 16px;
  font-weight: 500;
}
.collection-empty p {
  margin: 0;
  color: var(--muted);
  font-size: 12px;
}
.collection-sentinel {
  height: 1px;
}
.collection-page-footer {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 15px;
  min-height: 66px;
  color: #929baa;
  font-size: 11px;
}
.collection-load-more,
.collection-load-error button {
  padding: 7px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: #fff;
  color: var(--blue);
  font-size: 12px;
}
.collection-load-error {
  margin: 18px 0;
  padding: 14px;
  border: 1px solid #edd6d6;
  border-radius: 7px;
  background: #fff8f8;
  color: #a24a4a;
  font-size: 12px;
}
.collection-skeleton {
  height: var(--collection-card-height);
  padding: 20px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--panel, #fff);
}
.collection-skeleton i {
  display: block;
  height: 10px;
  margin-bottom: 15px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--muted, #7a8190) 12%, transparent);
  animation: collection-skeleton-pulse 1.7s ease-in-out infinite alternate;
}
.collection-skeleton i:nth-child(2) { animation-delay: 80ms; }
.collection-skeleton i:nth-child(3) { animation-delay: 160ms; }
.collection-skeleton i:nth-child(4) { animation-delay: 240ms; }
@keyframes collection-skeleton-pulse {
  from { opacity: 0.45; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .collection-skeleton i { animation: none; }
}
.collection-skeleton i:first-child {
  width: 65%;
  height: 15px;
  margin-bottom: 28px;
}
.collection-skeleton i:last-child {
  width: 50%;
}
@media (max-width: 600px) {
  .collection-heading {
    padding: 22px 20px 19px;
    gap: 12px;
  }
  .collection-heading h1 {
    font-size: 23px;
  }
  .collection-scroll {
    padding: 18px 18px 12px;
  }
  .collection-update {
    padding-inline: 20px;
  }
  .collection-heading-actions {
    gap: 8px;
  }
  .collection-count {
    gap: 9px;
    font-size: 11px;
  }
  .collection-count span {
    padding-left: 9px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .collection-card {
    transition: none;
  }
}
</style>
