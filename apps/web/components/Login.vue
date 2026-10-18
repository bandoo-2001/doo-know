<script setup lang="ts">
import { ref } from 'vue';
import { NButton, NInput, NAlert } from 'naive-ui';
import { api, refreshCsrf } from '../api';
import Icon from './Icon.vue';
defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ login: [] }>();
const username = ref(''),
  password = ref(''),
  error = ref(''),
  busy = ref(false);
async function login() {
  busy.value = true;
  error.value = '';
  try {
    await api('/api/auth/sign-in/username', 'POST', {
      username: username.value,
      password: password.value,
    });
    password.value = '';
    await refreshCsrf();
    emit('login');
  } catch (e) {
    error.value = (e as Error).message || '登录失败';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div :class="['login-page', { compact }]">
    <section v-if="!compact" class="login-story">
      <div class="brand"><Icon name="book" :size="32" /><strong>DooKnow</strong></div>
      <p class="login-eyebrow">你的个人知识空间</p>
      <h1>私人笔记，随时记录</h1>
      <p class="lead">把零散的想法留下，让值得保留的知识慢慢积累。</p>
      <div class="login-demo" aria-hidden="true">
        <div class="demo-dots"><Icon name="book" :size="14" /><span>我的知识库</span></div>
        <div class="demo-body">
          <div class="demo-nav">
            <b>笔记本</b>
            <p>⌕ 搜索笔记与目录</p>
            <div class="demo-new">＋ 新建笔记</div>
            <p>⌄ 个人知识管理</p>
            <p class="demo-selected">　搭建自己的知识库.md</p>
            <p>　每周回顾.md</p>
            <p>⌄ 工作记录</p>
            <p>　项目规划</p>
            <p>　会议纪要</p>
          </div>
          <article>
            <small>个人知识管理 / 搭建自己的知识库.md</small>
            <h2>搭建自己的知识库</h2>
            <h3>整理方法</h3>
            <ul>
              <li>收集值得保留的想法</li>
              <li>按主题整理笔记</li>
              <li>定期回顾与更新</li>
            </ul>
            <blockquote>让知识慢慢积累。</blockquote>
          </article>
        </div>
      </div>
    </section>
    <form class="login-card" @submit.prevent="login">
      <div v-if="compact" class="brand"><Icon name="book" /><strong>DooKnow</strong></div>
      <h2>{{ compact ? '登录已失效' : '登录 DooKnow' }}</h2>
      <p>{{ compact ? '重新登录后可继续编辑，未保存内容仍保留。' : '登录后访问你的私人笔记' }}</p>
      <NAlert v-if="error" type="error" class="login-error">{{ error }}</NAlert
      ><label for="username">用户名</label
      ><NInput
        id="username"
        v-model:value="username"
        placeholder="请输入用户名"
        autocomplete="username"
        :input-props="{ 'aria-label': '用户名' }"
        size="large"
      /><label for="password">密码</label
      ><NInput
        id="password"
        v-model:value="password"
        type="password"
        show-password-on="click"
        placeholder="请输入密码"
        autocomplete="current-password"
        :input-props="{ 'aria-label': '密码' }"
        size="large"
      /><NButton attr-type="submit" type="primary" size="large" :loading="busy" class="login-submit"
        >登录</NButton
      >
      <div class="login-private"><Icon name="lock" />笔记默认私有，仅分享链接可公开访问</div>
    </form>
  </div>
</template>
<style scoped>
.login-page {
  min-height: 100dvh;
  padding: 56px max(28px, calc((100vw - 1120px) / 2));
  display: grid;
  grid-template-columns: minmax(0, 1fr) 370px;
  align-items: center;
  gap: 76px;
  background: var(--surface, #f5f6f8);
  color: var(--text, #262b36);
  overflow: visible;
}
.login-page::before,
.login-page::after {
  display: none;
}
.login-story {
  min-width: 0;
  width: 100%;
}
.login-story .brand {
  margin: 0 0 52px;
  gap: 10px;
  color: var(--blue, #4566c6);
  font-size: 27px;
  letter-spacing: -0.8px;
}
.login-eyebrow {
  margin: 0 0 12px;
  color: var(--muted, #7a8190);
  font-size: 12px;
  letter-spacing: 0.12em;
}
.login-story h1 {
  margin: 0 0 14px;
  color: var(--text, #262b36);
  font-size: clamp(28px, 2.6vw, 36px);
  line-height: 1.4;
  font-weight: 650;
  letter-spacing: -1px;
}
.login-story .lead {
  margin: 0 0 30px;
  color: #687080;
  font-size: 14px;
  line-height: 1.9;
}
.login-demo {
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 8px;
  box-shadow: none;
  background: white;
  transform: none;
}
.demo-dots {
  height: 35px;
  padding: 0 14px;
  gap: 8px;
  background: white;
  color: var(--muted, #7a8190);
  border-bottom-color: var(--border, #e3e6ec);
}
.demo-dots span {
  margin: 0;
  color: inherit;
  font-size: 10px;
}
.demo-body {
  min-height: 288px;
  grid-template-columns: minmax(0, 37%) minmax(0, 1fr);
  font-size: 10px;
}
.demo-nav {
  padding: 16px 12px;
  overflow: hidden;
  background: var(--surface-soft, #fafbfc);
  color: #697181;
  border-right-color: var(--border, #e3e6ec);
}
.demo-nav b {
  color: #656d7b;
  font-size: 11px;
  font-weight: 500;
}
.demo-nav p {
  margin: 15px 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.demo-new {
  background: var(--blue, #4566c6);
  padding: 6px;
  border-radius: 4px;
}
.demo-selected {
  background: #e9edf9;
  color: var(--blue, #4566c6);
  border-radius: 4px;
}
.demo-body article {
  min-width: 0;
  padding: 22px;
}
.demo-body small {
  color: var(--muted, #7a8190);
  font-size: 8px;
}
.demo-body h2 {
  padding: 0;
  margin: 19px 0;
  border: 0;
  font-size: 17px;
  color: var(--text, #262b36);
}
.demo-body h3 {
  font-size: 12px;
  color: var(--text, #262b36);
}
.demo-body ul {
  padding-left: 18px;
  color: #656d7b;
}
.demo-body li {
  line-height: 2.1;
}
.demo-body blockquote {
  margin: 21px 0 0;
  padding: 0 0 0 10px;
  border-left: 2px solid #d9dee8;
  background: transparent;
  color: var(--muted, #7a8190);
}
.login-card {
  width: 100%;
  padding: 32px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 10px;
  box-shadow: 0 4px 18px #262b3604;
}
.login-card h2 {
  margin: 0 0 9px;
  color: var(--text, #262b36);
  font-size: 23px;
  font-weight: 650;
}
.login-card > p {
  margin: 0 0 28px;
  color: #727a88;
  font-size: 13px;
  line-height: 1.8;
}
.login-card label {
  margin: 20px 0 8px;
  font-size: 13px;
  font-weight: 500;
}
.login-card .n-input {
  height: 42px;
  font-size: 14px;
}
.login-submit {
  margin-top: 26px;
  height: 42px !important;
  font-size: 14px !important;
  font-weight: 500;
}
.login-private {
  justify-content: flex-start;
  align-items: flex-start;
  gap: 7px;
  padding-top: 20px;
  margin-top: 24px;
  border-top: 1px solid var(--border, #e3e6ec);
  color: var(--muted, #7a8190);
  font-size: 11px;
  line-height: 1.8;
  white-space: normal;
}
.login-private svg {
  flex: 0 0 14px;
  width: 14px;
  height: 18px;
}
.login-error {
  margin-bottom: 20px;
  overflow-wrap: anywhere;
}
.login-page.compact {
  min-height: 0;
  display: block;
  padding: 0;
  background: transparent;
}
.compact .login-card {
  padding: 8px 4px;
  border: 0;
  border-radius: 0;
  box-shadow: none;
}
.compact .brand {
  gap: 8px;
  color: var(--blue, #4566c6);
  font-size: 21px;
}
.compact .login-card h2 {
  margin-top: 24px;
  font-size: 22px;
}
@media (max-width: 960px) {
  .login-page {
    grid-template-columns: minmax(0, 1fr) 340px;
    padding: 40px 32px;
    gap: 36px;
  }
  .login-story .brand {
    margin-bottom: 40px;
  }
  .demo-body {
    min-height: 250px;
  }
  .demo-body article {
    padding: 16px;
  }
  .demo-body h2 {
    font-size: 15px;
  }
}
@media (max-width: 720px) {
  .login-page {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    justify-content: center;
    gap: 26px;
    padding: 36px max(22px, calc((100vw - 420px) / 2));
  }
  .login-story .brand {
    margin-bottom: 32px;
    font-size: 25px;
  }
  .login-story h1 {
    font-size: 28px;
  }
  .login-story .lead {
    margin: 0;
    font-size: 13px;
  }
  .login-eyebrow,
  .login-demo {
    display: none;
  }
  .login-card {
    padding: 26px 24px;
    border-radius: 9px;
  }
  .login-card h2 {
    font-size: 22px;
  }
  .login-card > p {
    margin-bottom: 22px;
  }
}
</style>
