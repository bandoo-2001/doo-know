<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Popconfirm as APopconfirm,
  Tag as ATag,
} from 'ant-design-vue';
import { api } from '../../api';
import { MIN_PASSWORD_LENGTH, PASSWORD_POLICY_MESSAGE } from '../../../../shared/password-policy';
import type { ManagementPage, ManagementSession } from '../../../../shared/management-contracts';
defineProps<{ username: string }>();
const emit = defineEmits<{ logout: [] }>();
const current = ref(''),
  password = ref(''),
  confirmation = ref(''),
  passwordBusy = ref(false),
  notice = ref(''),
  passwordError = ref('');
const fields = ref<Record<string, string>>({});
const sessions = ref<ManagementSession[]>([]),
  sessionError = ref(''),
  loading = ref(false),
  sessionBusy = ref(''),
  cursor = ref<string | null>(null);
async function changePassword() {
  fields.value = {};
  notice.value = '';
  passwordError.value = '';
  if (!current.value) fields.value.current = '请输入当前密码';
  if (password.value.length < MIN_PASSWORD_LENGTH) fields.value.password = PASSWORD_POLICY_MESSAGE;
  if (confirmation.value !== password.value || !confirmation.value)
    fields.value.confirmation = '两次输入的新密码不一致';
  if (Object.keys(fields.value).length) return;
  passwordBusy.value = true;
  try {
    await api('/api/auth/change-password', 'POST', {
      currentPassword: current.value,
      newPassword: password.value,
      revokeOtherSessions: true,
    });
    current.value = '';
    password.value = '';
    confirmation.value = '';
    notice.value = '密码已更新，其他设备的会话已退出。';
    await load();
  } catch (e) {
    passwordError.value = (e as Error).message;
  } finally {
    passwordBusy.value = false;
  }
}
async function load(more = false) {
  if (loading.value) return;
  loading.value = true;
  sessionError.value = '';
  try {
    const result = await api<ManagementPage<ManagementSession>>(
      '/api/manage/sessions' +
        (more && cursor.value ? '?cursor=' + encodeURIComponent(cursor.value) : ''),
    );
    sessions.value = more ? [...sessions.value, ...result.items] : result.items;
    cursor.value = result.nextCursor;
  } catch (e) {
    sessionError.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function revoke(id: string) {
  if (sessionBusy.value) return;
  sessionBusy.value = id;
  sessionError.value = '';
  try {
    await api('/api/manage/sessions/' + encodeURIComponent(id), 'DELETE');
    await load();
  } catch (e) {
    sessionError.value = (e as Error).message;
  } finally {
    sessionBusy.value = '';
  }
}
async function revokeOthers() {
  if (sessionBusy.value) return;
  sessionBusy.value = 'others';
  sessionError.value = '';
  try {
    await api('/api/manage/sessions/revoke-others', 'POST', {});
    await load();
  } catch (e) {
    sessionError.value = (e as Error).message;
  } finally {
    sessionBusy.value = '';
  }
}
function time(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '未知';
}
onMounted(() => void load());
</script>
<template>
  <div class="settings-stack">
    <section class="settings-card">
      <h2>当前账户</h2>
      <p>{{ username }}</p>
      <p class="settings-muted">这是知识库所有者账户。</p>
      <AButton danger @click="emit('logout')">退出当前设备</AButton>
    </section>
    <section class="settings-card">
      <h2>修改密码</h2>
      <p class="settings-muted">
        新密码至少 {{ MIN_PASSWORD_LENGTH }} 个字符。修改成功后会退出其他设备。
      </p>
      <form class="settings-form" @submit.prevent="changePassword">
        <div class="settings-field">
          <label for="current-password">当前密码</label
          ><AInput.Password
            id="current-password"
            v-model:value="current"
            autocomplete="current-password"
            :disabled="passwordBusy"
            :status="fields.current ? 'error' : undefined"
            :aria-invalid="!!fields.current"
            aria-describedby="current-password-error"
          />
          <p id="current-password-error" class="settings-field-error" role="alert">
            {{ fields.current }}
          </p>
        </div>
        <div class="settings-field">
          <label for="new-password">新密码</label
          ><AInput.Password
            id="new-password"
            v-model:value="password"
            autocomplete="new-password"
            :disabled="passwordBusy"
            :status="fields.password ? 'error' : undefined"
            :aria-invalid="!!fields.password"
            aria-describedby="new-password-error"
          />
          <p id="new-password-error" class="settings-field-error" role="alert">
            {{ fields.password }}
          </p>
        </div>
        <div class="settings-field">
          <label for="confirm-password">确认新密码</label
          ><AInput.Password
            id="confirm-password"
            v-model:value="confirmation"
            autocomplete="new-password"
            :disabled="passwordBusy"
            :status="fields.confirmation ? 'error' : undefined"
            :aria-invalid="!!fields.confirmation"
            aria-describedby="confirm-password-error"
          />
          <p id="confirm-password-error" class="settings-field-error" role="alert">
            {{ fields.confirmation }}
          </p>
        </div>
        <AAlert v-if="passwordError" type="error" :message="passwordError" show-icon />
        <div>
          <AButton type="primary" html-type="submit" :loading="passwordBusy">更新密码</AButton>
        </div>
        <p v-if="notice" class="settings-success" role="status">{{ notice }}</p>
      </form>
    </section>
    <section class="settings-card">
      <div class="settings-item-header">
        <div>
          <h2>登录设备</h2>
          <p>仅显示设备与时间信息。</p>
        </div>
        <AButton :loading="loading" @click="load(false)">刷新设备</AButton>
      </div>
      <AAlert v-if="sessionError" type="error" :message="sessionError" show-icon />
      <p v-if="loading && !sessions.length" role="status">正在读取登录设备…</p>
      <p v-else-if="!sessions.length && !sessionError" class="settings-muted">暂无登录设备。</p>
      <ul class="settings-list">
        <li v-for="session in sessions" :key="session.id">
          <div class="settings-item-header">
            <div>
              <strong>{{ session.device }}</strong>
              <ATag v-if="session.current" color="blue">当前设备</ATag>
              <p>登录于 {{ time(session.createdAt) }}</p>
              <p>最近活动 {{ time(session.updatedAt) }} · 到期 {{ time(session.expiresAt) }}</p>
            </div>
            <APopconfirm
              v-if="!session.current"
              title="退出这台设备的登录？"
              ok-text="退出设备"
              cancel-text="取消"
              @confirm="revoke(session.id)"
              ><AButton danger :loading="sessionBusy === session.id" :disabled="!!sessionBusy"
                >退出设备</AButton
              ></APopconfirm
            >
          </div>
        </li>
      </ul>
      <div class="settings-actions">
        <AButton v-if="cursor" :loading="loading" @click="load(true)">加载更多设备</AButton
        ><APopconfirm
          title="退出所有其他设备的登录？"
          ok-text="退出其他设备"
          cancel-text="取消"
          @confirm="revokeOthers"
          ><AButton :loading="sessionBusy === 'others'" :disabled="!!sessionBusy"
            >退出其他设备</AButton
          ></APopconfirm
        >
      </div>
    </section>
  </div>
</template>
