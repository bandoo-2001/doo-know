<script setup lang="ts">
import { ref } from 'vue';
import { Button as AButton, Input as AInput, Alert as AAlert } from 'ant-design-vue';
import { api, refreshCsrf } from '../api';
import Icon from './Icon.vue';
const AInputPassword = AInput.Password;
defineProps<{ compact?: boolean }>();
const emit = defineEmits<{ login: [] }>();
const username = ref(''),
  password = ref(''),
  error = ref(''),
  busy = ref(false);
async function login() {
  if (busy.value || !username.value.trim() || !password.value) return;
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
      <div class="brand"><Icon name="book" :size="30" /><strong>DooKnow</strong></div>
      <p class="login-eyebrow">你的个人知识空间</p>
    </section>
    <form class="login-card" :aria-busy="busy" @submit.prevent="login">
      <div v-if="compact" class="brand"><Icon name="book" /><strong>DooKnow</strong></div>
      <h2>{{ compact ? '登录已失效' : '登录 DooKnow' }}</h2>
      <p>{{ compact ? '重新登录后可继续编辑，未保存内容仍保留。' : '登录后访问你的私人笔记' }}</p>
      <AAlert
        v-if="error"
        id="login-error"
        type="error"
        show-icon
        role="alert"
        :message="error"
        class="login-error"
      /><label for="username">用户名</label
      ><AInput
        id="username"
        v-model:value="username"
        placeholder="请输入用户名"
        autocomplete="username"
        aria-label="用户名"
        :aria-describedby="error ? 'login-error' : undefined"
        :disabled="busy"
        required
        @input="error = ''"
      /><label for="password">密码</label
      ><AInputPassword
        id="password"
        v-model:value="password"
        placeholder="请输入密码"
        autocomplete="current-password"
        aria-label="密码"
        :aria-describedby="error ? 'login-error' : undefined"
        :disabled="busy"
        required
        @input="error = ''"
      /><AButton
        html-type="submit"
        type="primary"
        :loading="busy"
        :disabled="busy || !username.trim() || !password"
        class="login-submit"
        >登录</AButton
      >
      <div class="login-private"><Icon name="lock" />笔记默认私有，仅分享链接可公开访问</div>
    </form>
  </div>
</template>
<style scoped>
.login-page {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 24px;
  padding: 40px 20px;
  background: var(--surface, #f5f6f8);
  overflow: visible;
}
.login-page::before,
.login-page::after {
  display: none;
}
.login-story {
  width: min(400px, 100%);
  margin: 0;
}
.login-story .brand {
  justify-content: center;
  font-size: 24px;
  margin: 0;
}
.login-eyebrow {
  color: var(--muted);
  font-size: 13px;
  margin: 10px 0 0;
  text-align: center;
}
.login-card {
  width: min(400px, 100%);
  padding: 32px;
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: none;
}
.login-card h2 {
  font-size: 22px;
  margin: 0 0 8px;
  line-height: 1.4;
}
.login-card > p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--muted);
  margin: 0 0 24px;
}
.login-card label {
  display: block;
  margin: 16px 0 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text, #262b36);
}
.login-card :deep(.ant-input),
.login-card :deep(.ant-input-affix-wrapper) {
  width: 100%;
}
.login-submit {
  width: 100%;
  height: 40px !important;
  margin-top: 24px;
  font-size: 14px !important;
}
.login-private {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin-top: 20px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
}
.login-private svg {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}
.login-error {
  margin-bottom: 16px;
  overflow-wrap: anywhere;
}
.compact {
  min-height: 0;
  padding: 0;
  background: transparent;
  gap: 0;
}
.compact .login-card {
  width: 100%;
  padding: 8px 4px;
  border: 0;
}
.compact .brand {
  margin-bottom: 20px;
  font-size: 20px;
}
.compact .login-card h2 {
  margin: 0 0 8px;
}
@media (max-width: 600px) {
  .login-page {
    padding: 24px 16px;
    gap: 20px;
  }
  .login-card {
    padding: 26px 22px;
  }
  .compact {
    padding: 0;
  }
  .compact .login-card {
    padding: 8px 0;
  }
}
</style>
