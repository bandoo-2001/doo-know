<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BlogCollection } from '../../../../shared/blog-design';
import type { BlogPost } from '../../../../shared/blog-contracts';
const props = defineProps<{ collections: BlogCollection[]; posts: BlogPost[] }>();
const query = ref('');
const published = computed(() =>
  props.posts.filter(
    (post) =>
      post.state === 'published' && post.title.toLowerCase().includes(query.value.toLowerCase()),
  ),
);
function add() {
  props.collections.push({
    id: crypto.randomUUID(),
    slug: '',
    title: '',
    description: '',
    postIds: [],
  });
}
function move(items: string[], index: number, direction: number) {
  const item = items.splice(index, 1)[0];
  if (item) items.splice(index + direction, 0, item);
}
function name(id: string) {
  return props.posts.find((post) => post.id === id)?.title || '已移除的文章';
}
</script>
<template>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <div>
        <h3>专题合集</h3>
        <p class="blog-muted">为已发布文章编排一条阅读路线。</p>
      </div>
      <button type="button" class="blog-text-button" @click="add">＋ 添加专题</button>
    </div>
    <div v-if="!collections.length" class="blog-studio-empty">
      <strong>把文章串成一个专题</strong>
      <p>从一个共同的主题开始，为已发布文章安排阅读顺序。</p>
    </div>
    <article
      v-for="(collection, collectionIndex) in collections"
      :key="collection.id"
      class="blog-edit-list-item"
    >
      <div class="blog-edit-item-heading">
        <span class="blog-item-number">{{ collectionIndex + 1 }}</span
        ><strong>{{ collection.title || '新专题' }}</strong
        ><span class="blog-badge">{{ collection.postIds.length }} 篇</span>
      </div>
      <div class="blog-form-row">
        <label>专题名称<input v-model="collection.title" maxlength="120" /></label
        ><label
          >专题路径<input
            v-model="collection.slug"
            placeholder="my-collection"
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
        /></label>
      </div>
      <label>专题介绍<textarea v-model="collection.description" rows="2" maxlength="1000" /></label>
      <p v-if="!collection.postIds.length" class="blog-muted blog-collection-empty">
        专题还没有文章，从下方的已发布文章中添加。
      </p>
      <ol class="blog-collection-order">
        <li v-for="(id, index) in collection.postIds" :key="id" :data-post-id="id">
          <span
            >{{ name(id)
            }}<small v-if="!posts.some((post) => post.id === id && post.state === 'published')">
              · 公开页不显示</small
            ></span
          >
          <div class="blog-row-actions">
            <button
              type="button"
              class="blog-text-button"
              :disabled="!index"
              :aria-label="'上移专题文章 ' + name(id)"
              @click="move(collection.postIds, index, -1)"
            >
              上移</button
            ><button
              type="button"
              class="blog-text-button"
              :disabled="index === collection.postIds.length - 1"
              :aria-label="'下移专题文章 ' + name(id)"
              @click="move(collection.postIds, index, 1)"
            >
              下移</button
            ><button
              type="button"
              class="blog-text-button"
              :aria-label="'移出专题 ' + name(id)"
              @click="collection.postIds.splice(index, 1)"
            >
              移出
            </button>
          </div>
        </li>
      </ol>
      <details>
        <summary>从已发布文章中添加</summary>
        <label>搜索文章<input v-model="query" placeholder="按文章名称搜索" /></label>
        <div class="blog-collection-picker">
          <button
            v-for="post in published"
            :key="post.id"
            type="button"
            class="blog-text-button"
            :data-post-id="post.id"
            :aria-pressed="collection.postIds.includes(post.id)"
            :disabled="collection.postIds.includes(post.id)"
            @click="collection.postIds.push(post.id)"
          >
            {{ collection.postIds.includes(post.id) ? '✓' : '＋' }} {{ post.title }}
          </button>
          <p v-if="!published.length" class="blog-muted">没有匹配的已发布文章。</p>
        </div>
      </details>
      <div class="blog-row-actions">
        <button
          type="button"
          class="blog-text-button danger"
          :aria-label="'删除专题 ' + collection.title"
          @click="collections.splice(collectionIndex, 1)"
        >
          删除专题
        </button>
      </div>
    </article>
  </section>
</template>
