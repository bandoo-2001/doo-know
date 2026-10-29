<script setup lang="ts">
import type { BlogDesign, BlogTemplate } from '../../../../shared/blog-design';
import BlogImageEditor from './BlogImageEditor.vue';
const props = defineProps<{ design: BlogDesign; upload: (file: File) => Promise<string> }>();
const templates: { id: BlogTemplate; title: string; description: string }[] = [
  { id: 'journal', title: '文字博客', description: '留白与时间线，让文字自然流动' },
  { id: 'magazine', title: '卡片杂志', description: '用封面与精选，呈现丰富的主题' },
  { id: 'profile', title: '个人主页', description: '从你出发，连接文章、项目与朋友' },
];
</script>
<template>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <div>
        <h3>选择一种表达</h3>
        <p class="blog-muted">从适合内容的版式开始，随时可以切换主题。</p>
      </div>
    </div>
    <div class="blog-template-options">
      <button
        v-for="template in templates"
        :key="template.id"
        type="button"
        class="blog-template-choice"
        :class="{ selected: design.template === template.id }"
        :aria-pressed="design.template === template.id"
        :aria-label="template.title + ' ' + template.description"
        @click="design.template = template.id"
      >
        <span class="blog-template-mini" :class="template.id" aria-hidden="true"
          ><i></i><i></i><i></i></span
        ><strong>{{ template.title }}</strong
        ><small>{{ template.description }}</small>
      </button>
    </div>
    <div class="blog-form-row">
      <label
        >主题色
        <div class="blog-accent-input">
          <input v-model="design.accent" type="color" aria-label="主题色" /><input
            v-model="design.accent"
            maxlength="7"
            pattern="#[0-9a-fA-F]{6}"
            aria-label="主题色值"
          /></div></label
      ><label
        >字体<select v-model="design.font">
          <option value="sans">无衬线 · 清晰简洁</option>
          <option value="serif">衬线 · 适合长文</option>
        </select></label
      >
    </div>
    <div class="blog-form-row">
      <label
        >内容宽度<select v-model="design.width">
          <option value="comfortable">舒适阅读</option>
          <option value="wide">宽屏展示</option>
        </select></label
      ><label
        >卡片样式<select v-model="design.cardStyle">
          <option value="plain">轻盈留白</option>
          <option value="bordered">细线边框</option>
        </select></label
      >
    </div>
  </section>
  <section class="blog-studio-card">
    <div class="blog-studio-card-heading">
      <div>
        <h3>让读者认识你</h3>
        <p class="blog-muted">个人资料会展示在主页介绍中。</p>
      </div>
    </div>
    <div class="blog-form-row">
      <label
        >姓名<input v-model="design.profile.name" maxlength="120" placeholder="你的名字" /></label
      ><label
        >一句话介绍<input
          v-model="design.profile.tagline"
          maxlength="200"
          placeholder="用一句话介绍这里"
      /></label>
    </div>
    <label
      >个人简介<textarea
        v-model="design.profile.bio"
        rows="4"
        maxlength="5000"
        placeholder="你在关注什么，又正在创造什么？"
      />
    </label>
    <div class="blog-profile-media">
      <div>
        <div v-if="!design.profile.avatar" class="blog-avatar-placeholder" aria-hidden="true">
          <span>你</span>
        </div>
        <img
          v-if="design.profile.avatar"
          class="blog-avatar-preview"
          :src="design.profile.avatar.replace('/blog/media/', '/api/blog/design/media/')"
          alt="当前头像"
        /><BlogImageEditor
          label="头像"
          :value="design.profile.avatar"
          :aspect="1"
          :upload="upload"
          @change="design.profile.avatar = $event"
        />
      </div>
      <div>
        <div v-if="!design.profile.cover" class="blog-banner-placeholder" aria-hidden="true">
          <span>给主页留一张风景</span>
        </div>
        <img
          v-if="design.profile.cover"
          class="blog-banner-preview"
          :src="design.profile.cover.replace('/blog/media/', '/api/blog/design/media/')"
          alt="当前横幅"
        /><BlogImageEditor
          label="主页横幅"
          :value="design.profile.cover"
          :aspect="3"
          :upload="upload"
          @change="design.profile.cover = $event"
        />
      </div>
    </div>
  </section>
</template>
