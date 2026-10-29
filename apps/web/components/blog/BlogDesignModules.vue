<script setup lang="ts">
import { ref } from 'vue';
import type { BlogHomeModule, BlogHomeModuleKind } from '../../../../shared/blog-design';
const props = defineProps<{ modules: BlogHomeModule[] }>();
const kinds: [BlogHomeModuleKind, string][] = [
  ['intro', '个人介绍'],
  ['featured', '精选文章'],
  ['latest', '最近更新'],
  ['collections', '专题合集'],
  ['projects', '我的项目'],
  ['links', '友情链接'],
];
const kind = ref<BlogHomeModuleKind>('latest');
function add() {
  props.modules.push({
    id: crypto.randomUUID(),
    kind: kind.value,
    title: kinds.find((item) => item[0] === kind.value)![1],
    enabled: true,
    limit: 6,
  });
}
function move(index: number, direction: number) {
  const item = props.modules.splice(index, 1)[0];
  if (item) props.modules.splice(index + direction, 0, item);
}
</script>
<template>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <div>
        <h3>首页模块</h3>
        <p class="blog-muted">按顺序组合主页；隐藏的模块仍保留设置。</p>
      </div>
    </div>
    <div v-if="!modules.length" class="blog-studio-empty">
      <strong>为主页添加第一个模块</strong>
      <p>选择下方的内容类型，开始编排你的主页。</p>
    </div>
    <div
      v-for="(module, index) in modules"
      :key="module.id"
      class="blog-edit-list-item"
      :class="{ 'blog-module-hidden': !module.enabled }"
    >
      <div class="blog-studio-card-heading">
        <div class="blog-module-identity">
          <span class="blog-item-number">{{ index + 1 }}</span
          ><span class="blog-badge">{{ kinds.find((item) => item[0] === module.kind)?.[1] }}</span
          ><span v-if="!module.enabled" class="blog-module-visibility">已隐藏</span>
        </div>
        <label class="blog-checkbox"
          ><input
            v-model="module.enabled"
            type="checkbox"
            :aria-label="'显示模块 ' + module.title"
          />显示</label
        >
      </div>
      <div class="blog-form-row">
        <label>模块标题<input v-model="module.title" maxlength="120" /></label
        ><label
          >显示数量<input v-model.number="module.limit" type="number" min="1" max="50"
        /></label>
      </div>
      <div class="blog-row-actions">
        <button
          type="button"
          class="blog-text-button"
          :disabled="!index"
          :aria-label="'上移模块 ' + module.title"
          @click="move(index, -1)"
        >
          上移</button
        ><button
          type="button"
          class="blog-text-button"
          :disabled="index === modules.length - 1"
          :aria-label="'下移模块 ' + module.title"
          @click="move(index, 1)"
        >
          下移</button
        ><button
          type="button"
          class="blog-text-button danger"
          :aria-label="'删除模块 ' + module.title"
          @click="modules.splice(index, 1)"
        >
          删除
        </button>
      </div>
    </div>
    <div class="blog-module-add">
      <label
        >新模块<select v-model="kind">
          <option v-for="[value, label] in kinds" :key="value" :value="value">{{ label }}</option>
        </select></label
      ><button type="button" class="blog-button" @click="add">添加模块</button>
    </div>
  </section>
</template>
