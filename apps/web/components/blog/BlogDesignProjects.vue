<script setup lang="ts">
import type { BlogProject } from '../../../../shared/blog-design';
const props = defineProps<{ projects: BlogProject[] }>();
function add() {
  props.projects.push({ id: crypto.randomUUID(), title: '', description: '', href: '' });
}
function move(index: number, direction: number) {
  const item = props.projects.splice(index, 1)[0];
  if (item) props.projects.splice(index + direction, 0, item);
}
</script>
<template>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <h3>我的项目</h3>
      <button type="button" class="blog-text-button" @click="add">＋ 添加项目</button>
    </div>
    <p v-if="!projects.length" class="blog-muted">展示正在创造的作品，或长期投入的事情。</p>
    <div v-for="(project, index) in projects" :key="project.id" class="blog-edit-list-item">
      <div class="blog-form-row">
        <label>项目名称<input v-model="project.title" maxlength="120" /></label
        ><label>项目地址<input v-model="project.href" placeholder="https://" /></label>
      </div>
      <label>项目介绍<textarea v-model="project.description" rows="2" maxlength="1000" /></label>
      <div class="blog-row-actions">
        <button
          type="button"
          class="blog-text-button"
          :disabled="!index"
          :aria-label="'上移项目 ' + project.title"
          @click="move(index, -1)"
        >
          上移</button
        ><button
          type="button"
          class="blog-text-button"
          :disabled="index === projects.length - 1"
          :aria-label="'下移项目 ' + project.title"
          @click="move(index, 1)"
        >
          下移</button
        ><button
          type="button"
          class="blog-text-button danger"
          :aria-label="'删除项目 ' + project.title"
          @click="projects.splice(index, 1)"
        >
          删除
        </button>
      </div>
    </div>
  </section>
</template>
