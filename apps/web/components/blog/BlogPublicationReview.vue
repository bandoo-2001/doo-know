<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import DOMPurify from 'dompurify';
import type { BlogWorkbench } from '../../blog-workbench';
const props = defineProps<{ model: BlogWorkbench; id: string }>();
const emit = defineEmits<{ 'open-note': [id: string] }>();
const state = props.model.state;
const review = computed(() => state.reviews[props.id]);
const clean = (html: string) =>
  DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['srcdoc'],
  });
function source(id: string) {
  return state.dashboard?.posts.find((post) => post.id === id)?.sourceNoteId;
}
onMounted(() => void props.model.review(props.id));
watch(
  () =>
    [
      props.id,
      state.details[props.id]?.post.sourceHash,
      state.details[props.id]?.post.version,
    ].join(':'),
  () => void props.model.review(props.id),
);
</script>
<template>
  <section class="blog-publication-review" aria-label="线上与待发版本对照">
    <div class="blog-studio-card-heading">
      <h3>发布前核对</h3>
      <button
        type="button"
        class="blog-text-button"
        :disabled="state.reviewLoading[id]"
        @click="model.review(id)"
      >
        刷新检查
      </button>
    </div>
    <p v-if="state.reviewLoading[id]" role="status" class="blog-muted">
      正在检查线上快照、原稿引用和关联文章…
    </p>
    <p v-if="state.reviewErrors[id]" role="alert" class="blog-alert error">
      {{ state.reviewErrors[id] }}
    </p>
    <template v-if="review"
      ><div class="blog-review-columns">
        <section>
          <h4>线上版本</h4>
          <div
            v-if="review.publishedHtml !== null"
            class="markdown"
            v-html="clean(review.publishedHtml)"
          ></div>
          <p v-else class="blog-muted">还没有公开版本。</p>
        </section>
        <section>
          <h4>待发布版本</h4>
          <div class="markdown" v-html="clean(review.draftHtml)"></div>
        </section>
      </div>
      <div class="blog-review-diagnostics">
        <h4>引用检查</h4>
        <p v-if="!review.warnings.length" class="blog-muted">未发现失效引用或缺失图片。</p>
        <ul v-else>
          <li v-for="(warning, index) in review.warnings" :key="index">
            <strong>{{ warning.message }}</strong
            ><code>{{ warning.target }}</code
            ><button
              type="button"
              class="blog-text-button"
              @click="emit('open-note', state.details[id]!.post.sourceNoteId)"
            >
              前往原稿修正
            </button>
          </li>
        </ul>
        <h4 v-if="review.affectedPosts.length">可能需要重新发布的关联文章</h4>
        <div v-for="post in review.affectedPosts" :key="post.id" class="blog-history-row">
          <span>{{ post.title }}</span
          ><button
            v-if="source(post.id)"
            type="button"
            class="blog-text-button"
            @click="emit('open-note', source(post.id)!)"
          >
            查看关联原稿</button
          ><button v-else type="button" class="blog-text-button" @click="model.select(post.id)">
            查看文章
          </button>
        </div>
      </div></template
    >
  </section>
</template>
