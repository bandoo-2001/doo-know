<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import DOMPurify from 'dompurify';
import Icon from './Icon.vue';
import BlogDesignStudio from './blog/BlogDesignStudio.vue';
import BlogArticleCover from './blog/BlogArticleCover.vue';
import BlogPublicationReview from './blog/BlogPublicationReview.vue';
import type { TreeEntry } from '../../../shared/contracts';
import type { BlogPost } from '../../../shared/blog-contracts';
import { blogNotePicker, type BlogSection, type BlogWorkbench } from '../blog-workbench';
const props = defineProps<{ section: BlogSection; tree: TreeEntry[]; model: BlogWorkbench }>();
const emit = defineEmits<{
  section: [section: BlogSection];
  back: [];
  'open-note': [id: string];
}>();
const state = props.model.state;
const tabs: [BlogSection, string, string][] = [
  ['overview', '概览', 'apps'],
  ['articles', '文章', 'file'],
  ['design', '装修主页', 'monitor'],
  ['taxonomy', '分类与标签', 'list'],
  ['settings', '站点设置', 'settings'],
];
const query = ref(''),
  filter = ref('all'),
  categoryFilter = ref(''),
  tagFilter = ref(''),
  picker = ref(false),
  noteQuery = ref(''),
  preview = ref(false),
  confirm = ref<'withdraw' | 'remove'>();
const pickerRoot = ref<HTMLElement>();
const confirmRoot = ref<HTMLElement>();
let pickerReturnFocus: HTMLElement | null = null;
let confirmReturnFocus: HTMLElement | null = null;
let confirmPostId = '';
watch(picker, async (shown) => {
  if (shown) {
    pickerReturnFocus = document.activeElement as HTMLElement;
    await nextTick();
    pickerRoot.value?.querySelector('input')?.focus();
  } else pickerReturnFocus?.focus();
});
function pickerKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    picker.value = false;
    event.stopPropagation();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [
    ...(pickerRoot.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled)',
    ) || []),
  ];
  const first = focusable[0],
    last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}
const selected = computed(() => state.details[state.selectedId]);
const form = computed(() => state.forms[state.selectedId]);
const posts = computed(() => state.dashboard?.posts || []);
const visiblePosts = computed(() =>
  posts.value.filter(
    (post) =>
      (filter.value === 'all' ||
        (filter.value === 'changes'
          ? post.state === 'published' && post.hasUnpublishedChanges
          : post.state === filter.value)) &&
      (!categoryFilter.value || post.category === categoryFilter.value) &&
      (!tagFilter.value || post.tags.includes(tagFilter.value)) &&
      [post.title, post.sourceTitle, post.summary, post.category, ...post.tags]
        .join(' ')
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const taxonomy = computed(() => {
  const categories = new Map<string, number>(),
    tags = new Map<string, number>();
  for (const post of posts.value) {
    if (post.category) categories.set(post.category, (categories.get(post.category) || 0) + 1);
    for (const tag of post.tags) tags.set(tag, (tags.get(tag) || 0) + 1);
  }
  return {
    categories: [...categories].sort((a, b) => b[1] - a[1]),
    tags: [...tags].sort((a, b) => b[1] - a[1]),
  };
});
const notePicker = computed(() => blogNotePicker(props.tree, noteQuery.value));
const notes = computed(() => notePicker.value.notes);
const safePreview = computed(() =>
  DOMPurify.sanitize(selected.value?.previewHtml || '', {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['srcdoc'],
  }),
);
const tagsText = ref('');
watch(
  form,
  (value) => {
    tagsText.value = value?.tags.join('，') || '';
  },
  { immediate: true },
);
watch(tagsText, (text) => {
  if (form.value)
    form.value.tags = [
      ...new Set(
        text
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
});
const published = computed(() => posts.value.filter((post) => post.state === 'published').length);
const changes = computed(
  () =>
    posts.value.filter((post) => post.state === 'published' && post.hasUnpublishedChanges).length,
);
const busy = computed(() => !!state.busy[state.selectedId]);
const reading = computed(() => !!state.reading[state.selectedId]);
const dirty = computed(() => props.model.dirty());
const selectedError = computed(() => state.errors[state.selectedId]);
const previewTitle = computed(() => form.value?.title || selected.value?.post.title || '文章预览');
const status = (post: BlogPost) =>
  post.state === 'published'
    ? post.hasUnpublishedChanges
      ? '有更新待发布'
      : '已发布'
    : post.state === 'withdrawn'
      ? '已下架'
      : '草稿';
const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '尚未发布';
async function chooseNote(id: string) {
  const existing = posts.value.find((post) => post.sourceNoteId === id);
  if (existing) {
    await props.model.select(existing.id);
    picker.value = false;
    emit('section', 'articles');
    return;
  }
  const post = await props.model.create(id);
  if (post) {
    picker.value = false;
    emit('section', 'articles');
  }
}
async function choosePost(id: string) {
  preview.value = false;
  closeConfirm(false);
  emit('section', 'articles');
  await props.model.select(id);
}
function useTaxonomy(kind: 'category' | 'tag', name: string) {
  categoryFilter.value = kind === 'category' ? name : '';
  tagFilter.value = kind === 'tag' ? name : '';
  filter.value = 'all';
  emit('section', 'articles');
}
function clearFilters() {
  categoryFilter.value = '';
  tagFilter.value = '';
  query.value = '';
  filter.value = 'all';
}
async function copyUrl() {
  const url = selected.value?.post.url;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(new URL(url, location.origin).href);
    state.notice = '文章链接已复制。';
  } catch {
    state.errors[state.selectedId] = '复制失败，请从固定链接栏手动复制。';
  }
}
async function openConfirm(action: 'withdraw' | 'remove') {
  if (busy.value || reading.value || !selected.value) return;
  confirmReturnFocus = document.activeElement as HTMLElement;
  confirmPostId = state.selectedId;
  confirm.value = action;
  await nextTick();
  if (confirmPostId === state.selectedId && confirm.value === action) {
    confirmRoot.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    confirmRoot.value?.scrollIntoView({ block: 'nearest' });
  }
}
function closeConfirm(restoreFocus = true) {
  confirm.value = undefined;
  confirmPostId = '';
  const target = confirmReturnFocus;
  confirmReturnFocus = null;
  if (restoreFocus)
    void nextTick(() => {
      if (!confirm.value && target?.isConnected && props.section === 'articles')
        target.focus({ preventScroll: true });
    });
}
function confirmKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeConfirm();
  }
}
async function confirmAction() {
  const action = confirm.value,
    id = confirmPostId,
    target = confirmReturnFocus;
  closeConfirm(false);
  if (!action || id !== state.selectedId || busy.value || reading.value) return;
  if (action === 'withdraw') await props.model.withdraw();
  else if (action === 'remove') await props.model.remove();
  if (state.selectedId === id && target?.isConnected) target.focus({ preventScroll: true });
}
watch(
  () => state.selectedId,
  () => {
    preview.value = false;
    closeConfirm(false);
  },
);
watch(
  () => props.section,
  (section) => {
    closeConfirm(false);
    if (section === 'articles' && state.selectedId) void props.model.select(state.selectedId);
  },
);
onMounted(() => {
  if (state.selectedId) void props.model.select(state.selectedId);
});
</script>
<template>
  <section class="blog-workspace" aria-labelledby="blog-title">
    <header class="blog-header">
      <div class="blog-heading">
        <button type="button" class="blog-icon-button" aria-label="返回应用" @click="emit('back')">
          <Icon name="back" /></button
        ><span class="blog-app-icon small"><Icon name="book" :size="23" /></span>
        <div>
          <h1 id="blog-title">博客</h1>
          <p>从笔记，到被看见的文字。</p>
        </div>
      </div>
      <div class="blog-header-actions">
        <a
          v-if="state.dashboard?.settings.enabled"
          class="blog-button subtle"
          href="/blog"
          target="_blank"
          rel="noopener"
          >访问站点 <Icon name="share" :size="15" /></a
        ><button type="button" class="blog-button primary" @click="picker = true">
          <Icon name="plus" :size="17" /> 选择笔记
        </button>
      </div>
    </header>
    <nav class="blog-tabs" aria-label="博客工作台">
      <button
        v-for="[id, label, icon] in tabs"
        :key="id"
        type="button"
        :aria-current="section === id ? 'page' : undefined"
        :class="{ active: section === id }"
        @click="emit('section', id)"
      >
        <Icon :name="icon" :size="17" />{{ label }}
      </button>
    </nav>
    <div v-if="state.error" class="blog-alert error" role="alert">
      {{ state.error }} <button class="blog-text-button" @click="model.load()">重试</button>
    </div>
    <div v-if="state.notice" class="blog-alert success" role="status">{{ state.notice }}</div>
    <div v-if="state.loading && !state.dashboard" class="blog-empty" role="status">
      <Icon name="refresh" :size="30" />
      <p>正在加载博客…</p>
    </div>
    <template v-else-if="state.dashboard">
      <div v-if="!state.dashboard.settings.enabled" class="blog-site-off">
        <Icon name="lock" :size="18" /><span
          >站点尚未开启。你可以先准备文章，开启后已发布内容才会公开。</span
        ><button type="button" class="blog-text-button" @click="emit('section', 'settings')">
          前往设置 <span aria-hidden="true">→</span>
        </button>
      </div>
      <div v-if="section === 'overview'" class="blog-overview">
        <div class="blog-welcome">
          <div>
            <span class="blog-eyebrow">A SPACE FOR YOUR IDEAS</span>
            <h2>写下的思考，<br />值得被更多人读到。</h2>
            <p>挑选一篇笔记，整理好标题与摘要。<br />每一次公开，都由你亲自决定。</p>
            <button type="button" class="blog-button primary" @click="picker = true">
              开始选稿 <Icon name="forward" :size="16" />
            </button>
          </div>
          <div class="blog-paper-art" aria-hidden="true">
            <span>MY JOURNAL</span><i></i><strong>思想的形状</strong><b></b><b></b><b></b
            ><em>Notes, made public.</em>
          </div>
        </div>
        <div class="blog-stats">
          <button
            @click="
              filter = 'all';
              emit('section', 'articles');
            "
          >
            <span>全部文章</span><strong>{{ posts.length }}</strong
            ><Icon name="file" /></button
          ><button
            @click="
              filter = 'published';
              emit('section', 'articles');
            "
          >
            <span>已发布</span><strong>{{ published }}</strong
            ><Icon name="check" /></button
          ><button
            @click="
              filter = 'changes';
              emit('section', 'articles');
            "
          >
            <span>待发布更新</span><strong>{{ changes }}</strong
            ><Icon name="refresh" />
          </button>
        </div>
        <div class="blog-section-title">
          <h2>最近整理</h2>
          <button class="blog-text-button" @click="emit('section', 'articles')">查看全部 →</button>
        </div>
        <div v-if="!posts.length" class="blog-empty compact">
          <Icon name="file" :size="30" />
          <h3>你的第一篇文章，从这里开始</h3>
          <p>从已有笔记中选稿，原文无需搬家。</p>
          <button class="blog-button" @click="picker = true">选择一篇笔记</button>
        </div>
        <button
          v-for="post in posts.slice(0, 4)"
          v-else
          :key="post.id"
          class="blog-recent-row"
          @click="choosePost(post.id)"
        >
          <span class="blog-post-glyph"><Icon name="file" /></span
          ><span
            ><strong>{{ post.title }}</strong
            ><small>{{ post.category || '未分类' }} · {{ date(post.updatedAt) }}</small></span
          ><span
            class="blog-badge"
            :class="[post.state, { changes: post.hasUnpublishedChanges }]"
            >{{ status(post) }}</span
          ><Icon name="chevron" :size="16" />
        </button>
      </div>
      <div v-else-if="section === 'articles'" class="blog-articles">
        <div class="blog-section-title">
          <div>
            <h2>文章</h2>
            <p>公开的是发布时的快照。编辑原稿后，手动发布更新。</p>
          </div>
          <button
            class="blog-icon-button"
            :disabled="state.loading"
            aria-label="刷新文章"
            @click="
              model.load();
              state.selectedId && model.select(state.selectedId);
            "
          >
            <Icon name="refresh" :size="18" />
          </button>
        </div>
        <div class="blog-article-layout" :class="{ 'has-selection': !!state.selectedId }">
          <aside class="blog-article-list" aria-label="博客文章列表">
            <label class="blog-search"
              ><Icon name="search" :size="16" /><input
                v-model="query"
                aria-label="搜索博客文章"
                placeholder="搜索文章…"
            /></label>
            <select v-model="filter" class="blog-state-filter" aria-label="文章状态">
              <option value="all">全部状态</option>
              <option value="draft">草稿</option>
              <option value="published">已发布</option>
              <option value="changes">待发布更新</option>
              <option value="withdrawn">已下架</option>
            </select>
            <div v-if="categoryFilter || tagFilter" class="blog-filter-chip">
              {{ categoryFilter || '#' + tagFilter
              }}<button aria-label="清除分类标签过滤" @click="clearFilters">×</button>
            </div>
            <div v-if="!visiblePosts.length" class="blog-empty compact">
              <Icon :name="posts.length ? 'search' : 'file'" :size="25" />
              <p>{{ posts.length ? '没有匹配的文章' : '还没有博客文章' }}</p>
              <button v-if="posts.length" class="blog-text-button" @click="clearFilters">
                清除搜索和筛选
              </button>
              <button v-else class="blog-text-button" @click="picker = true">从笔记中选稿 →</button>
            </div>
            <button
              v-for="post in visiblePosts"
              :key="post.id"
              class="blog-post-option"
              :class="{ selected: state.selectedId === post.id }"
              :aria-pressed="state.selectedId === post.id"
              @click="choosePost(post.id)"
            >
              <span class="blog-post-option-title"
                ><strong>{{ post.title }}</strong
                ><Icon v-if="post.pinned" name="star" :size="14" /></span
              ><span class="blog-post-summary">{{
                post.summary || '添加一段摘要，让读者更快了解文章。'
              }}</span
              ><span class="blog-post-option-footer"
                ><span
                  class="blog-badge"
                  :class="[post.state, { changes: post.hasUnpublishedChanges }]"
                  >{{ status(post) }}</span
                ><small>{{ date(post.updatedAt) }}</small></span
              ><small v-if="model.dirty(post.id)" class="blog-unsaved">文章信息未保存</small>
            </button>
          </aside>
          <section v-if="selected && form" class="blog-article-detail" aria-label="文章发布设置">
            <div class="blog-detail-heading">
              <div>
                <span class="blog-eyebrow">文章信息</span>
                <h3>{{ selected.post.title }}</h3>
              </div>
              <span
                class="blog-badge"
                :class="[selected.post.state, { changes: selected.post.hasUnpublishedChanges }]"
                >{{ status(selected.post) }}</span
              >
            </div>
            <div class="blog-source">
              <Icon name="file" :size="17" /><span
                ><small>关联原稿</small><strong>{{ selected.post.sourceTitle }}</strong></span
              ><button
                class="blog-text-button"
                @click="emit('open-note', selected.post.sourceNoteId)"
              >
                编辑原稿 <Icon name="forward" :size="14" />
              </button>
            </div>
            <p v-if="selected.post.hasUnpublishedChanges" class="blog-changes-hint">
              <Icon name="refresh" :size="15" />{{
                selected.post.state === 'published'
                  ? '原稿或文章信息已有变化，线上仍保留上次发布的版本。'
                  : '原稿和文章信息仅自己可见，确认后手动发布。'
              }}
            </p>
            <div v-if="selectedError" class="blog-alert error" role="alert">
              {{ selectedError
              }}<button
                class="blog-text-button"
                :disabled="busy"
                @click="model.select(state.selectedId)"
              >
                重新核对
              </button>
            </div>
            <p v-if="reading" class="blog-read-status" role="status">
              <Icon name="refresh" :size="15" /> 正在核对文章，当前预览与修改会保留…
            </p>
            <div class="blog-action-panel" role="group" aria-label="文章操作">
              <div class="blog-save-state" :class="{ 'blog-unsaved': dirty }" role="status">
                <Icon :name="dirty ? 'save' : 'check'" :size="14" />{{
                  dirty
                    ? '文章信息有未保存修改，请先保存后发布'
                    : '文章信息已保存，可预览并手动发布'
                }}
              </div>
              <div class="blog-publish-bar">
                <button
                  class="blog-button blog-save-button"
                  type="submit"
                  form="blog-article-form"
                  :disabled="busy || reading || !dirty"
                >
                  {{ busy ? '处理中…' : '保存文章信息' }}
                </button>
                <button
                  type="button"
                  class="blog-button"
                  :disabled="busy || reading || dirty"
                  :aria-expanded="preview"
                  aria-controls="blog-article-preview"
                  @click="preview = !preview"
                >
                  <Icon name="eye" :size="17" />{{ preview ? '收起预览' : '预览文章' }}</button
                ><button
                  type="button"
                  class="blog-button primary"
                  :disabled="busy || reading || dirty"
                  @click="model.publish()"
                >
                  <Icon name="upload" :size="17" />{{
                    busy ? '处理中…' : selected.post.state === 'published' ? '发布更新' : '发布文章'
                  }}
                </button>
              </div>
            </div>
            <form id="blog-article-form" class="blog-form" @submit.prevent="model.save()">
              <label
                >文章标题<input v-model="form.title" maxlength="200" required name="blog-title"
              /></label>
              <label
                >摘要<textarea
                  v-model="form.summary"
                  rows="3"
                  maxlength="1000"
                  placeholder="用一两句话，介绍这篇文章…"
                />
              </label>
              <div class="blog-form-row">
                <label
                  >分类<input
                    v-model="form.category"
                    list="blog-categories"
                    placeholder="例如：生活与思考"
                    maxlength="80" /><datalist id="blog-categories">
                    <option
                      v-for="[name] in taxonomy.categories"
                      :key="name"
                      :value="name"
                    /></datalist></label
                ><label
                  >标签<input v-model="tagsText" placeholder="用逗号分隔" maxlength="600"
                /></label>
              </div>
              <details class="blog-secondary-fields">
                <summary>封面、置顶与固定链接 <Icon name="chevron" :size="16" /></summary>
                <div class="blog-secondary-body">
                  <label
                    >封面图片<input
                      :value="form.cover || ''"
                      type="text"
                      placeholder="笔记中的图片路径（可选）"
                      @input="form.cover = ($event.target as HTMLInputElement).value || null"
                    /><small>发布时会固定图片副本，请使用你有权公开的图片。</small></label
                  >
                  <BlogArticleCover
                    :key="selected.post.sourceNoteId"
                    :model="model"
                    :post-id="selected.post.id"
                    :note-id="selected.post.sourceNoteId"
                    :note-path="notePicker.sourcePath(selected.post.sourceNoteId)"
                    :value="form.cover"
                    @change="model.setCover"
                  />
                  <label class="blog-checkbox"
                    ><input v-model="form.pinned" type="checkbox" />置顶文章</label
                  >
                  <label
                    >固定链接
                    <div class="blog-url">
                      <span>/blog/</span
                      ><input
                        v-model="form.slug"
                        :readonly="selected.post.publishedAt !== null"
                        pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                        aria-label="文章固定链接"
                      /><button
                        type="button"
                        class="blog-icon-button"
                        :disabled="!selected.post.url"
                        aria-label="复制文章链接"
                        @click="copyUrl"
                      >
                        <Icon name="copy" :size="16" />
                      </button>
                    </div>
                    <small>{{
                      selected.post.publishedAt
                        ? '首次公开后固定，修改标题不会改变文章地址。'
                        : '首次发布前可编辑，使用小写英文、数字与连字符。'
                    }}</small></label
                  >
                </div>
              </details>
            </form>
            <p class="blog-publish-note">
              {{
                state.dashboard.settings.enabled
                  ? '点击发布会将当前文章快照公开。'
                  : '站点尚未开启：发布后仍需在站点设置中开启公开访问。'
              }}图形预览会在发布时生成。
            </p>
            <article
              v-if="preview"
              id="blog-article-preview"
              class="blog-preview"
              aria-label="文章预览"
            >
              <div class="blog-preview-label">
                <Icon name="lock" :size="14" /> 仅自己可见的发布预览
              </div>
              <p v-if="selected.diagramNeeds.length" class="blog-publish-note">
                {{ selected.diagramNeeds.length }} 个图形将在发布时生成静态预览。
              </p>
              <h1>{{ previewTitle }}</h1>
              <p class="blog-preview-summary">{{ form.summary }}</p>
              <BlogPublicationReview
                :model="model"
                :id="state.selectedId"
                @open-note="emit('open-note', $event)"
              />
              <details class="blog-reviewed-body">
                <summary>原稿预览</summary>
                <div class="markdown" v-html="safePreview"></div>
              </details>
            </article>
            <div class="blog-danger-zone">
              <button
                v-if="selected.post.state === 'published'"
                class="blog-text-button danger"
                :disabled="busy || reading"
                @click="openConfirm('withdraw')"
              >
                下架文章</button
              ><button
                class="blog-text-button"
                :disabled="busy || reading"
                @click="openConfirm('remove')"
              >
                移除选稿</button
              ><span>{{
                selected.post.publishedAt
                  ? '上次发布于 ' + date(selected.post.publishedAt)
                  : '还未公开发布'
              }}</span>
            </div>
            <div
              v-if="confirm"
              ref="confirmRoot"
              class="blog-confirm"
              role="alertdialog"
              aria-label="确认博客操作"
              aria-describedby="blog-confirm-description"
              @keydown="confirmKeys"
            >
              <strong>{{
                confirm === 'withdraw' ? '下架这篇文章？' : '移除这篇博客选稿？'
              }}</strong>
              <p id="blog-confirm-description">公开文章将无法访问。知识库中的原笔记会保留。</p>
              <div>
                <button class="blog-button" @click="closeConfirm()">取消</button
                ><button class="blog-button danger-button" @click="confirmAction">
                  {{ confirm === 'withdraw' ? '确认下架' : '确认移除' }}
                </button>
              </div>
            </div>
          </section>
          <div
            v-else-if="state.selectedId && reading"
            class="blog-empty blog-detail-state"
            role="status"
          >
            <Icon name="refresh" :size="30" />
            <h3>正在读取文章…</h3>
            <p>正在准备原稿与发布预览。</p>
          </div>
          <div
            v-else-if="state.selectedId && selectedError"
            class="blog-empty blog-detail-state"
            role="alert"
          >
            <Icon name="file" :size="30" />
            <h3>文章详情暂时无法读取</h3>
            <p>{{ selectedError }}</p>
            <button type="button" class="blog-button" @click="model.select(state.selectedId)">
              重新读取文章
            </button>
          </div>
          <div v-else class="blog-empty blog-select-placeholder">
            <Icon name="book" :size="42" />
            <h3>为一篇好文章，留一个位置</h3>
            <p>选择左侧文章，或从知识库中选一篇笔记。</p>
            <button class="blog-button" @click="picker = true">选择笔记</button>
          </div>
        </div>
      </div>
      <BlogDesignStudio v-else-if="section === 'design'" :model="model" />
      <div v-else-if="section === 'taxonomy'" class="blog-taxonomy">
        <div class="blog-section-title">
          <div>
            <h2>分类与标签</h2>
            <p>用主题串起文章，让读者顺着兴趣探索。</p>
          </div>
        </div>
        <div class="blog-taxonomy-grid">
          <section class="blog-panel">
            <h3>
              <Icon name="folder" :size="19" />分类 <span>{{ taxonomy.categories.length }}</span>
            </h3>
            <p v-if="!taxonomy.categories.length" class="blog-muted">
              在文章信息中添加第一个分类。
            </p>
            <button
              v-for="[name, count] in taxonomy.categories"
              :key="name"
              class="blog-category"
              @click="useTaxonomy('category', name)"
            >
              <span>{{ name }}</span
              ><small>{{ count }} 篇 <span aria-hidden="true">→</span></small>
            </button>
          </section>
          <section class="blog-panel">
            <h3>
              <Icon name="list" :size="19" />标签 <span>{{ taxonomy.tags.length }}</span>
            </h3>
            <p v-if="!taxonomy.tags.length" class="blog-muted">为文章添加标签，建立更多连接。</p>
            <div class="blog-tags">
              <button
                v-for="[name, count] in taxonomy.tags"
                :key="name"
                @click="useTaxonomy('tag', name)"
              >
                <span aria-hidden="true">#</span><span class="blog-tag-name">{{ name }}</span
                ><small>{{ count }}</small>
              </button>
            </div>
          </section>
        </div>
        <p class="blog-muted">在文章中编辑分类与标签。保存后，手动发布更新才会同步至公开站点。</p>
      </div>
      <div v-else-if="section === 'settings' && state.settings" class="blog-settings">
        <div class="blog-section-title">
          <div>
            <h2>站点设置</h2>
            <p>给你的文字，一个自己的家。</p>
          </div>
        </div>
        <form class="blog-form" @submit.prevent="model.saveSettings()">
          <section class="blog-visibility">
            <div>
              <h3>公开访问</h3>
              <p>
                {{
                  state.settings.enabled
                    ? '已发布文章将在 /blog 对所有人可见。'
                    : '站点当前关闭，访客无法访问博客。'
                }}
              </p>
            </div>
            <label class="blog-toggle"
              ><input
                v-model="state.settings.enabled"
                type="checkbox"
                aria-label="开启博客站点" /><span></span
            ></label>
          </section>
          <div v-if="state.settingsError" class="blog-alert error" role="alert">
            {{ state.settingsError }}
            <button
              type="button"
              class="blog-text-button"
              :disabled="state.settingsBusy"
              @click="model.reviewSettings()"
            >
              重新核对设置
            </button>
          </div>
          <div v-if="state.settingsNotice" class="blog-alert success" role="status">
            {{ state.settingsNotice }}
          </div>
          <label
            >站点名称<input
              v-model="state.settings.title"
              required
              maxlength="120"
              placeholder="我的数字花园" /></label
          ><label
            >站点简介<textarea
              v-model="state.settings.description"
              rows="2"
              maxlength="500"
              placeholder="这里记录了什么？"
            />
          </label>
          <div class="blog-form-row">
            <label
              >作者<input
                v-model="state.settings.author"
                maxlength="120"
                placeholder="你的名字" /></label
            ><label
              >外观<select v-model="state.settings.theme">
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
              </select></label
            >
          </div>
          <label
            >公开站点地址<input
              v-model="state.settings.baseUrl"
              type="url"
              placeholder="https://example.com"
            /><small>用于订阅与站点地图中的绝对链接。</small></label
          ><label
            >关于<textarea
              v-model="state.settings.about"
              rows="6"
              maxlength="10000"
              placeholder="向读者介绍你自己和这个博客…"
            />
          </label>
          <div class="blog-settings-footer">
            <span><Icon name="lock" :size="15" />更改将在保存后生效</span
            ><button class="blog-button primary" type="submit" :disabled="state.settingsBusy">
              {{ state.settingsBusy ? '保存中…' : '保存站点设置' }}
            </button>
          </div>
        </form>
      </div>
    </template>
    <div v-if="picker" class="blog-picker-backdrop" @click.self="picker = false">
      <section
        ref="pickerRoot"
        class="blog-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="blog-picker-title"
        @keydown="pickerKeys"
      >
        <header>
          <div>
            <span class="blog-eyebrow">FROM YOUR KNOWLEDGE BASE</span>
            <h2 id="blog-picker-title">选择一篇笔记</h2>
          </div>
          <button class="blog-icon-button" aria-label="关闭选稿" @click="picker = false">
            <Icon name="close" />
          </button>
        </header>
        <p>只添加博客选稿。原稿保持原样，发布由你确认。</p>
        <label class="blog-search"
          ><Icon name="search" :size="17" /><input
            v-model="noteQuery"
            autofocus
            placeholder="搜索笔记名称或路径…"
            aria-label="搜索待选笔记"
        /></label>
        <div class="blog-picker-notes">
          <p v-if="!notes.length" class="blog-empty">没有找到 Markdown 笔记</p>
          <button
            v-for="note in notes"
            :key="note.id"
            :disabled="state.creating"
            @click="chooseNote(note.id!)"
          >
            <Icon name="file" :size="20" /><span
              ><strong>{{ note.name.replace(/\.md$/i, '') }}</strong
              ><small>{{ note.path }}</small></span
            ><span v-if="posts.some((post) => post.sourceNoteId === note.id)" class="blog-badge"
              >已选稿</span
            ><Icon v-else name="plus" :size="17" />
          </button>
        </div>
        <div v-if="state.error" class="blog-alert error" role="alert">{{ state.error }}</div>
        <footer>
          <Icon name="lock" :size="14" />{{
            state.creating ? '正在准备选稿…' : '只有手动发布的文章，才会进入公开站点。'
          }}
        </footer>
      </section>
    </div>
  </section>
</template>
