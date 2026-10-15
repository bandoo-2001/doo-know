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
      <div class="brand"><Icon name="book" :size="43" /><strong>DooKnow</strong></div>
      <h1>私人笔记，随时记录</h1>
      <p class="lead">简单、专注、属于你自己的知识空间</p>
      <div class="login-demo" aria-hidden="true">
        <div class="demo-dots"><i></i><i></i><i></i><span>属于你的知识空间</span></div>
        <div class="demo-body">
          <div class="demo-nav">
            <b>▣ DooKnow</b>
            <p>⌕ 搜索笔记与目录</p>
            <div class="demo-new">＋ 新建笔记</div>
            <p>⌄ 个人知识管理</p>
            <p class="demo-selected">　搭建自己的知识库.md</p>
            <p>　每周回顾.md</p>
            <p>⌄ 工作记录</p>
            <p>　项目规划</p>
            <p>　会议纪要</p>
            <p>⌄ 生活笔记</p>
            <p>　旅行计划</p>
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
            <table>
              <tbody>
                <tr>
                  <th>步骤</th>
                  <th>内容</th>
                </tr>
                <tr>
                  <td>收集</td>
                  <td>记录想法</td>
                </tr>
                <tr>
                  <td>整理</td>
                  <td>建立主题</td>
                </tr>
              </tbody>
            </table>
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
