<script setup lang="ts">
import type { BlogLink } from '../../../../shared/blog-design';
const props = defineProps<{ title: string; links: BlogLink[] }>();
function add() {
  props.links.push({ id: crypto.randomUUID(), label: '', href: '' });
}
function move(index: number, direction: number) {
  const item = props.links.splice(index, 1)[0];
  if (item) props.links.splice(index + direction, 0, item);
}
</script>
<template>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <div>
        <h3>{{ title }}</h3>
        <p class="blog-muted">
          {{
            title === '站点导航'
              ? '让读者从主页找到重要内容。'
              : title === '社交链接'
                ? '添加你在其他平台的公开主页。'
                : '连接值得推荐的朋友与网站。'
          }}
        </p>
      </div>
      <button type="button" class="blog-text-button" @click="add">＋ 添加链接</button>
    </div>
    <div v-if="!links.length" class="blog-studio-empty">
      <strong>还没有{{ title }}</strong>
      <p>添加名称和地址，让读者继续探索。</p>
    </div>
    <div v-for="(link, index) in links" :key="link.id" class="blog-edit-list-item">
      <div class="blog-edit-item-heading">
        <span class="blog-item-number">{{ index + 1 }}</span
        ><strong>{{ link.label || '新链接' }}</strong>
      </div>
      <div class="blog-form-row">
        <label
          >名称<input
            v-model="link.label"
            maxlength="80"
            :aria-label="title + '名称 ' + (index + 1)" /></label
        ><label
          >地址<input
            v-model="link.href"
            placeholder="https:// 或 /blog/about"
            :aria-label="title + '地址 ' + (index + 1)"
        /></label>
      </div>
      <div class="blog-row-actions">
        <button
          type="button"
          class="blog-text-button"
          :disabled="index === 0"
          :aria-label="'上移' + title + (index + 1)"
          @click="move(index, -1)"
        >
          上移</button
        ><button
          type="button"
          class="blog-text-button"
          :disabled="index === links.length - 1"
          :aria-label="'下移' + title + (index + 1)"
          @click="move(index, 1)"
        >
          下移</button
        ><button
          type="button"
          class="blog-text-button danger"
          :aria-label="'删除' + title + (index + 1)"
          @click="links.splice(index, 1)"
        >
          删除
        </button>
      </div>
    </div>
  </section>
</template>
