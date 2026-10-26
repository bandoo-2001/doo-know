<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  Card as ACard,
  Alert as AAlert,
  Button as AButton,
  Checkbox as ACheckbox,
  Spin as ASpin,
} from 'ant-design-vue';
import { api } from '../api';
import Icon from './Icon.vue';
import { isResourceScope } from '../../../shared/authorization-scopes';
const ACheckboxGroup = ACheckbox.Group;
const props = defineProps<{ oauthQuery: string }>();
const request = ref<any>(),
  scopes = ref<string[]>([]),
  prefixes = ref<string[]>([]),
  busy = ref(false),
  error = ref('');
const labels: Record<string, string> = {
  'knowledge:read': '读取所选目录中的资料',
  'knowledge:write': '创建、修改和归档资料',
  'knowledge:index': '检查和刷新检索索引',
  'blog:publish': '将所选资料公开发布为博客，或撤下已发布文章',
  offline_access: '保持连接，允许刷新访问令牌',
};
onMounted(async () => {
  try {
    request.value = await api('/api/platform/mcp/oauth/request', 'POST', {
      oauth_query: props.oauthQuery,
    });
    scopes.value = request.value.allowedScopes.filter((s: string) =>
      ['knowledge:read', 'offline_access'].includes(s),
    );
    prefixes.value = [...request.value.allowedPrefixes];
  } catch {
    error.value = '授权请求无效或已过期，请回到连接客户端重新发起授权。';
  }
});
async function consent(accept: boolean) {
  if (
    busy.value ||
    !request.value ||
    (accept &&
      (!prefixes.value.length || !scopes.value.some(isResourceScope) || (scopes.value.includes('blog:publish') && (!scopes.value.includes('knowledge:read') || !scopes.value.includes('knowledge:write')))))
  )
    return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api('/api/platform/mcp/oauth/consent', 'POST', {
      accept,
      oauth_query: props.oauthQuery,
      scopes: scopes.value,
      allowedPrefixes: prefixes.value,
    });
    window.location.assign(result.url);
  } catch {
    error.value = '授权未完成，请重新发起连接。';
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <main class="oauth-consent">
    <header class="oauth-brand"><Icon name="book" :size="28" /><strong>DooKnow</strong></header>
    <ACard class="oauth-card">
      <template #title><h1>连接 DooKnow</h1></template>
      <template v-if="request">
        <div class="oauth-client">
          <span class="client-icon"><Icon name="lock" :size="22" /></span>
          <div>
            <p class="eyebrow">连接请求来自</p>
            <h2>{{ request.clientName }}</h2>
          </div>
        </div>
        <p class="oauth-intro">该连接请求访问你的知识库。请选择允许的操作与目录。</p>
        <fieldset>
          <legend>允许的操作</legend>
          <ACheckboxGroup v-model:value="scopes" :disabled="busy">
            <div v-for="scope in request.allowedScopes" :key="scope" class="scope-row">
              <ACheckbox :value="scope">{{ labels[scope] || scope }}</ACheckbox>
            </div>
          </ACheckboxGroup>
        </fieldset>
        <fieldset>
          <legend>允许的目录</legend>
          <ACheckboxGroup v-model:value="prefixes" :disabled="busy">
            <div
              v-for="prefix in request.allowedPrefixes"
              :key="prefix"
              class="scope-row directory-row"
            >
              <ACheckbox :value="prefix"
                ><Icon name="folder" :size="16" /><span>{{ prefix }}</span></ACheckbox
              >
            </div>
          </ACheckboxGroup>
        </fieldset>
        <p class="oauth-hint">
          <Icon name="lock" :size="15" /><span
            >未选中的目录不会开放。可随时在 MCP 插件设置中撤销连接。</span
          >
        </p>
        <footer class="oauth-actions">
          <AButton :disabled="busy" @click="consent(false)">拒绝</AButton>
          <AButton
            type="primary"
            :loading="busy"
            :disabled="busy || !prefixes.length || !scopes.some(isResourceScope) || (scopes.includes('blog:publish') && (!scopes.includes('knowledge:read') || !scopes.includes('knowledge:write')))"
            @click="consent(true)"
            >允许访问</AButton
          >
        </footer>
      </template>
      <AAlert
        v-if="error"
        class="oauth-error"
        type="error"
        show-icon
        role="alert"
        :message="error"
      />
      <div v-else-if="!request" class="oauth-loading" role="status">
        <ASpin />
        <p>正在检查授权请求…</p>
      </div>
    </ACard>
    <p class="oauth-note">仅在你确认后，连接才能访问所选资料。</p>
  </main>
</template>
<style scoped>
.oauth-consent {
  max-width: 640px;
  margin: 0 auto;
  padding: 42px 24px 28px;
  color: var(--text, #262b36);
}
.oauth-brand {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 24px;
  color: var(--blue, #4566c6);
  font-size: 23px;
  letter-spacing: -0.6px;
}
.oauth-card {
  border-color: var(--border, #e3e6ec);
  border-radius: 10px;
  background: white;
}
.oauth-card :deep(.ant-card-head) {
  min-height: 0;
  padding: 24px 30px 20px;
  border-bottom-color: var(--border, #e3e6ec);
}
.oauth-card h1 {
  margin: 0;
  line-height: 1.4;
  color: var(--text, #262b36);
  font-size: 23px;
  font-weight: 650;
}
.oauth-card :deep(.ant-card-body) {
  padding: 24px 30px 28px;
}
.oauth-client {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 7px;
  background: var(--surface-soft, #fafbfc);
}
.oauth-client > div {
  min-width: 0;
}
.client-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border: 1px solid #e3e8f6;
  border-radius: 7px;
  background: #f0f3fb;
  color: var(--blue, #4566c6);
}
.eyebrow {
  margin: 0 0 3px;
  color: var(--muted, #7a8190);
  font-size: 11px;
}
h2 {
  margin: 0;
  color: var(--text, #262b36);
  font-size: 16px;
  font-weight: 600;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.oauth-intro {
  margin: 20px 0 24px;
  color: #6c7482;
  font-size: 13px;
  line-height: 1.7;
}
.oauth-card :deep(.ant-checkbox-group) {
  display: block;
}
fieldset {
  min-inline-size: 0;
  margin: 0 0 22px;
  padding: 0;
  border: 0;
}
legend {
  margin-bottom: 10px;
  padding: 0;
  color: var(--text, #262b36);
  font-size: 13px;
  font-weight: 600;
}
.scope-row {
  display: flex;
  min-width: 0;
  padding: 9px 0;
  border-bottom: 1px solid #edf0f4;
}
.scope-row:last-child {
  border-bottom: 0;
}
.scope-row :deep(.ant-checkbox-wrapper) {
  margin: 0;
  font-weight: 400;
  min-width: 0;
  max-width: 100%;
  align-items: flex-start;
  font-size: 13px;
  line-height: 1.7;
}
.scope-row :deep(.ant-checkbox) {
  flex-shrink: 0;
  margin-top: 4px;
}
.scope-row :deep(.ant-checkbox + span) {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}
.directory-row :deep(.ant-checkbox + span) {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: #5c6574;
  font-family: 'SFMono-Regular', Consolas, monospace;
  font-size: 12px;
}
.directory-row svg {
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--muted, #7a8190);
}
.directory-row span {
  min-width: 0;
}
.oauth-hint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 24px 0 0;
  padding: 13px 14px;
  border: 1px solid var(--border, #e3e6ec);
  border-radius: 6px;
  background: var(--surface-soft, #fafbfc);
  color: var(--muted, #7a8190);
  font-size: 12px;
  line-height: 1.7;
}
.oauth-hint svg {
  flex-shrink: 0;
  margin-top: 4px;
}
.oauth-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--border, #e3e6ec);
}
.oauth-actions .ant-btn {
  min-width: 84px;
  margin: 0;
}
.oauth-error {
  margin-top: 20px;
  overflow-wrap: anywhere;
}
.oauth-loading {
  padding: 34px 0;
  color: var(--muted, #7a8190);
  font-size: 13px;
  text-align: center;
}
.oauth-loading p {
  margin: 16px 0 0;
}
.oauth-note {
  margin-top: 20px;
  color: var(--muted, #7a8190);
  font-size: 11px;
  line-height: 1.7;
  text-align: center;
}
@media (max-width: 600px) {
  .oauth-consent {
    padding: 24px 14px;
  }
  .oauth-brand {
    margin: 0 4px 20px;
    font-size: 21px;
  }
  .oauth-card {
    border-radius: 8px;
  }
  .oauth-card :deep(.ant-card-head) {
    padding: 20px;
  }
  .oauth-card h1 {
    margin: 0;
    line-height: 1.4;
    font-size: 21px;
  }
  .oauth-card :deep(.ant-card-body) {
    padding: 20px;
  }
  .oauth-client {
    padding: 13px;
  }
  .oauth-actions .ant-btn {
    flex: 1;
    min-width: 0;
  }
}
</style>
